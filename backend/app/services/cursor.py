"""The server's one change counter (``/api/app/1/changes``).

Every change of a thing gets a cursor of its own: the next number of ``sync_state.last``, handed out in the same
transaction as the change. Every writer of things holds ``WRITE_LOCK`` from reading what it changes until its commit
(``services/sync.py``): one process serves nextasks, so changes commit in the order of their numbers and whoever reads
``last`` sees every change up to it. Two batches on the same reminder at the same moment therefore apply one after the
other, each against what the other wrote.

``oldest`` rises when tombstones and hidden entries are cleared away after 90 days: an app that asks from before that
starts over (410 ``cursor_expired``).

Every handing out also notes its time (``CursorTime``): ``after`` turns a time into a cursor for
``/api/v1/tasks?updated_since=``.

``moved`` grows with every commit that handed out numbers, per account it concerns: ``/wait`` looks at it instead of at
the database.
"""

from __future__ import annotations

import threading
from collections import defaultdict
from collections.abc import Iterable
from datetime import datetime

from sqlalchemy import func, select, update
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from ..models import CursorTime, SyncState
from . import clock

ROW = 1

#: Held by every writer of things from its first read to its commit.
WRITE_LOCK = threading.RLock()

_moved_lock = threading.Lock()
#: Grows with every commit that changed something an account sees; ``-1`` stands for "everybody".
_moved: dict[int, int] = defaultdict(int)
EVERYBODY = -1


def _ensure(db: Session) -> None:
    db.execute(sqlite_insert(SyncState).values(id=ROW, last=0, oldest=0).on_conflict_do_nothing())


def take(db: Session, count: int = 1) -> int:
    """``count`` new cursors in the caller's transaction; returns the first."""
    _ensure(db)
    last = db.execute(
        update(SyncState).where(SyncState.id == ROW).values(last=SyncState.last + count).returning(SyncState.last)
    ).scalar_one()
    first = int(last) - count + 1
    # When: ``/api/v1/tasks?updated_since=`` asks by the time the server got a change (``CursorTime``).
    db.execute(sqlite_insert(CursorTime).values(cursor=first, at=clock.now()).on_conflict_do_nothing())
    return first


def after(db: Session, moment: datetime) -> int:
    """The highest cursor handed out before ``moment``: everything with a greater cursor came at or after it. 0 when
    the server cannot tell (``moment`` lies before the oldest time it kept, or it kept none yet): then everything
    counts."""
    oldest = db.scalar(select(func.min(CursorTime.at)))
    if oldest is None or moment < oldest:
        return 0
    first = db.scalar(select(func.min(CursorTime.cursor)).where(CursorTime.at >= moment))
    if first is None:
        return state(db)[0]
    return int(first) - 1


def state(db: Session) -> tuple[int, int]:
    """``(last, oldest)`` as committed."""
    row = db.execute(select(SyncState.last, SyncState.oldest).where(SyncState.id == ROW)).first()
    return (int(row.last), int(row.oldest)) if row is not None else (0, 0)


def raise_oldest(db: Session, number: int) -> None:
    _ensure(db)
    db.execute(update(SyncState).where(SyncState.id == ROW, SyncState.oldest < number).values(oldest=number))


def touched(account_ids: Iterable[int]) -> None:
    """After a commit: these accounts have something new (``/wait``)."""
    with _moved_lock:
        for account_id in set(account_ids):
            _moved[account_id] += 1


def touched_everybody() -> None:
    touched([EVERYBODY])


def mark(account_id: int) -> tuple[int, int]:
    """What ``/wait`` compares: the account's count and everybody's."""
    with _moved_lock:
        return _moved[account_id], _moved[EVERYBODY]
