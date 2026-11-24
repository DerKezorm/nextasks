"""The record of completions (``models.Completion``): what the review counts, kept apart from the reminders so that it
outlives "delete completed", the bin and the end of a reminder.

**One place.** Every write of a reminder goes through the ORM (``services/sync.py``: ``/api/app/1`` from app and web,
``/api/v1`` through ``sync.Together``). A ``before_flush`` hook of the session watches ``completed_at`` there:

* it becomes set (completing, a completed copy of a repeating reminder, a reminder made already done): the row is
  written, or rewritten when one is there already (one row per reminder, nothing counts twice);
* it becomes null (opened again): the row goes;
* a done reminder moves (list, section, space): its row follows, so that only the members of its space see it.

Nothing else touches the record but ``trash.purge_space`` (a space that goes takes its rows along) and ``fill_once``.

**Series.** A completed copy has the id UUIDv5(original, occurrence) (``wiederholung.copy_id``) and no rule of its own.
Its series is the reminder whose id gives the copy's id with the copy's due date: looked for among the reminders the
session holds (``sync.complete`` holds the original) and then among the repeating reminders of the same list. A
repeating reminder completed itself (its rule ended) is its own series.

**Filled once.** At the first start with this table, every reminder that is done already gets its row
(``fill_once``, under the setting ``completions_filled``): the same rules, the series found the same way.
"""

from __future__ import annotations

import logging
from datetime import date
from typing import Any

from sqlalchemy import delete, event, inspect, select
from sqlalchemy.dialects.sqlite import insert
from sqlalchemy.orm import Session

from ..models import Account, Completion, Reminder, Setting
from . import clock, records, wiederholung

logger = logging.getLogger("nextasks.completions")

FILLED = "completions_filled"
#: Fields of a done reminder its row follows.
PLACE = ("space_id", "list_id", "section_id", "parent_id")


def on_time(completed_at: str, due_date: str | None, zone_name: str) -> bool | None:
    """Done on or before the due day, in ``zone_name`` (the completer's zone); None without a due date."""
    if not due_date:
        return None
    try:
        day = records.parse_stamp(completed_at).astimezone(clock.zone_of(zone_name)).date()
        return day <= date.fromisoformat(due_date)
    except ValueError:
        return None


def _zone_of(session: Session, account_id: int | None) -> str:
    account = session.get(Account, account_id) if account_id else None
    return account.timezone if account is not None else ""


def _is_copy_of(original_id: str, copy: Reminder) -> bool:
    try:
        return wiederholung.copy_id(original_id, copy.due_date or "") == copy.id
    except ValueError:
        return False


def series_of(session: Session, row: Reminder) -> str | None:
    """The repeating reminder ``row`` belongs to (see above), or None."""
    if row.repeat:
        return row.id
    if not row.due_date:
        return None
    held = [item for item in (*session.identity_map.values(), *session.new) if isinstance(item, Reminder)]
    for other in held:
        if other.id != row.id and _is_copy_of(other.id, row):
            return other.id
    for other_id in session.scalars(select(Reminder.id).where(Reminder.list_id == row.list_id,
                                                              Reminder.repeat.is_not(None), Reminder.id != row.id)):
        if _is_copy_of(other_id, row):
            return other_id
    return None


def values_of(session: Session, row: Reminder, series_id: str | None) -> dict[str, Any]:
    assert row.completed_at is not None
    return {
        "reminder_id": row.id, "series_id": series_id, "space_id": row.space_id, "list_id": row.list_id,
        "section_id": row.section_id, "parent_id": row.parent_id, "title": row.title,
        "completed_at": row.completed_at, "completed_by": row.completed_by, "due_date": row.due_date,
        "due_time": row.due_time, "created_at": row.created_at,
        "on_time": on_time(row.completed_at, row.due_date, _zone_of(session, row.completed_by)),
        "logged_at": clock.now(),
    }


def _write(session: Session, row: Reminder) -> None:
    values = values_of(session, row, series_of(session, row))
    found = session.scalar(select(Completion).where(Completion.reminder_id == row.id))
    if found is None:
        session.add(Completion(**values))
        return
    for name, value in values.items():
        setattr(found, name, value)


def _follow(session: Session, row: Reminder) -> None:
    found = session.scalar(select(Completion).where(Completion.reminder_id == row.id))
    if found is None:
        return
    for name in PLACE:
        setattr(found, name, getattr(row, name))


@event.listens_for(Session, "before_flush")
def _record(session: Session, _context: Any, _instances: Any) -> None:
    made = [item for item in session.new if isinstance(item, Reminder)]
    changed = [item for item in session.dirty if isinstance(item, Reminder)]
    if not made and not changed:
        return
    with session.no_autoflush:
        for row in made:
            if row.completed_at is not None:
                _write(session, row)
        for row in changed:
            state = inspect(row)
            if state.attrs.completed_at.history.has_changes():
                if row.completed_at is None:
                    session.execute(delete(Completion).where(Completion.reminder_id == row.id))
                else:
                    _write(session, row)
            elif row.completed_at is not None and any(state.attrs[name].history.has_changes() for name in PLACE):
                _follow(session, row)


def fill(session: Session) -> int:
    """A row for every done reminder that has none (a row there stays as it is). Returns how many were written."""
    done = list(session.scalars(select(Reminder).where(Reminder.completed_at.is_not(None))))
    if not done:
        return 0
    known = set(session.scalars(select(Completion.reminder_id)))
    # The originals a copy may belong to: every repeating reminder, by space (a copy may have moved lists since).
    originals: dict[str, list[str]] = {}
    for original_id, space_id in session.execute(select(Reminder.id, Reminder.space_id)
                                                 .where(Reminder.repeat.is_not(None))):
        originals.setdefault(space_id, []).append(original_id)
    zones = {account_id: zone or "" for account_id, zone in session.execute(select(Account.id, Account.timezone))}
    written = 0
    for row in done:
        if row.id in known:
            continue
        series_id: str | None = row.id if row.repeat else None
        if series_id is None and row.due_date:
            series_id = next((other for other in originals.get(row.space_id, ())
                              if other != row.id and _is_copy_of(other, row)), None)
        values = {
            "reminder_id": row.id, "series_id": series_id, "space_id": row.space_id, "list_id": row.list_id,
            "section_id": row.section_id, "parent_id": row.parent_id, "title": row.title,
            "completed_at": row.completed_at, "completed_by": row.completed_by, "due_date": row.due_date,
            "due_time": row.due_time, "created_at": row.created_at,
            "on_time": on_time(row.completed_at or "", row.due_date, zones.get(row.completed_by or 0, "")),
            "logged_at": clock.now(),
        }
        session.execute(insert(Completion).values(**values).on_conflict_do_nothing(index_elements=["reminder_id"]))
        written += 1
    return written


def fill_once() -> None:
    """At start: fills the record from the done reminders, once (``FILLED``). Safe to run again."""
    from ..db import SessionLocal

    with SessionLocal() as session:
        if session.get(Setting, FILLED) is not None:
            return
        written = fill(session)
        session.add(Setting(key=FILLED, value=True))
        session.commit()
    if written:
        logger.info("Record of completions filled rows=%s", written)
