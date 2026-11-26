"""Accounts deleted and not yet gone for good (konten 1.1.0: 30 days to bring them back). Decided E33 and E35: they keep
their memberships and the tasks given to them, but nobody sees them: not among members, not among the assignees of a
task (``/api/app/1``, ``/api/v1``, the web), and they hear nothing. Changing a task keeps a hidden assignment; bringing
the account back shows it again; gone for good, it goes with the account (``trash.remove_account``).

The ids are read once and kept until an account is deleted or brought back (``forget``), so a page of changes does not
ask the database for every task.
"""

from __future__ import annotations

import threading

from sqlalchemy import select

_lock = threading.Lock()
_ids: frozenset[int] | None = None


def ids() -> frozenset[int]:
    """The accounts deleted and not yet gone for good."""
    global _ids
    with _lock:
        if _ids is not None:
            return _ids
    from ..db import SessionLocal
    from ..models import Account

    with SessionLocal() as db:
        found = frozenset(db.scalars(select(Account.id).where(Account.deleted_at.is_not(None))))
    with _lock:
        _ids = found
    return found


def forget() -> None:
    """After an account was deleted, brought back or removed for good (and between tests)."""
    global _ids
    with _lock:
        _ids = None


def shown(people: list[int] | None) -> list[int]:
    """``people`` without the deleted accounts, in their order."""
    hidden = ids()
    return [person for person in people or [] if person not in hidden]


def kept(before: list[int] | None, after: list[int]) -> list[int]:
    """``after`` with the deleted accounts that stood in ``before`` and are not in it: a change made by somebody who
    cannot see them keeps them."""
    hidden = ids()
    return [*after, *(person for person in before or [] if person in hidden and person not in after)]
