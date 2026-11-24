"""What happened to a task and who did it (``models.TaskEvent``), for the history under its comments in the web.

**One place.** Every write of a task goes through the ORM in ``services/sync.py`` (``/api/app/1`` from app and web,
``/api/v1`` through ``sync.Together``), and those sessions name their account in ``session.info[ACTOR]``. A
``before_flush`` hook watches the tasks there, as ``services/completions.py`` does for the record of completions:

* made (``created``), a completed copy of a repeating task excepted;
* done or opened again (``completion``, ``old``/``new`` true or false);
* a repeating task done for one date (``occurrence``, ``new`` = that date; ``sync.complete`` names it in
  ``session.info[COMPLETING]``): its moving on is no change of the date;
* the date or time (``due``, ``{"due_date", "due_time"}``), the assignees, the priority, another list (``list``, the
  ids), another title.

A session without an actor (the server on its own: a member who left falls out of the assignees, the bin) writes
nothing.

**Ten minutes.** One person's changes of one field are one row while nobody else changed that field in between and
ten minutes have not passed since the row began: ``new`` follows, ``old`` stays. Is it back where it began, the row
goes. What the maker of a task sets in the ten minutes after making it belongs to making it and is not told apart
(ticking off excepted).
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import event, inspect, select
from sqlalchemy.orm import Session

from ..models import Member, Reminder, TaskEvent, TaskList
from . import clock

#: ``session.info`` key: the account a session writes for.
ACTOR = "nextasks.actor"
#: ``session.info`` key: ``{reminder id: occurrence}`` of repeating tasks completed in this session.
COMPLETING = "nextasks.completing"
#: ``session.info`` key: the ids of the completed copies made for them.
COPIES = "nextasks.copies"
WINDOW = timedelta(minutes=10)
#: Fields that are told apart from making a task even right after it.
ALWAYS = ("completion", "occurrence")


def _before(row: Reminder, name: str) -> tuple[Any, bool]:
    """The value before this flush and whether it changed."""
    history = inspect(row).attrs[name].history
    if not history.has_changes():
        return getattr(row, name), False
    return (history.deleted[0] if history.deleted else None), True


def _due(date: Any, time: Any) -> dict[str, Any]:
    return {"due_date": date, "due_time": time if date else None}


def _changes(row: Reminder, completing: dict[str, str | None]) -> list[tuple[str, Any, Any]]:
    out: list[tuple[str, Any, Any]] = []
    if row.id in completing:
        out.append(("occurrence", None, completing[row.id]))
    old_done, moved = _before(row, "completed_at")
    if moved and bool(old_done) != bool(row.completed_at):
        out.append(("completion", bool(old_done), bool(row.completed_at)))
    old_date, date_moved = _before(row, "due_date")
    old_time, time_moved = _before(row, "due_time")
    if (date_moved or time_moved) and row.id not in completing:
        before, after = _due(old_date, old_time), _due(row.due_date, row.due_time)
        if before != after:
            out.append(("due", before, after))
    for name, field in (("assignees", "assignees"), ("priority", "priority"), ("list_id", "list"),
                        ("title", "title")):
        old, changed = _before(row, name)
        new = getattr(row, name)
        if name == "assignees":
            old, new = list(old or []), list(new or [])
        if changed and old != new:
            out.append((field, old, new))
    return out


def _note(session: Session, reminder_id: str, actor: int, field: str, old: Any, new: Any, now: datetime) -> None:
    if field != "occurrence":
        last = session.scalar(select(TaskEvent).where(TaskEvent.reminder_id == reminder_id, TaskEvent.field == field)
                              .order_by(TaskEvent.at.desc(), TaskEvent.id.desc()).limit(1))
        if last is not None and last.actor_id == actor and now - last.first_at <= WINDOW:
            if last.old == new:
                session.delete(last)
            else:
                last.new = new
                last.at = now
            return
    session.add(TaskEvent(reminder_id=reminder_id, actor_id=actor, field=field, old=old, new=new, first_at=now,
                          at=now))


def _just_made(session: Session, reminder_id: str, actor: int, now: datetime) -> bool:
    """Made by ``actor`` less than ten minutes ago."""
    found = session.scalar(select(TaskEvent).where(TaskEvent.reminder_id == reminder_id, TaskEvent.field == "created")
                           .limit(1))
    return found is not None and found.actor_id == actor and now - found.first_at <= WINDOW


@event.listens_for(Session, "before_flush")
def _record(session: Session, _context: Any, _instances: Any) -> None:
    actor = session.info.get(ACTOR)
    if actor is None:
        return
    made = [item for item in session.new if isinstance(item, Reminder)]
    changed = [item for item in session.dirty if isinstance(item, Reminder)]
    if not made and not changed:
        return
    completing: dict[str, str | None] = session.info.get(COMPLETING, {})
    copies: set[str] = session.info.get(COPIES, set())
    now = clock.now()
    with session.no_autoflush:
        for row in made:
            if row.id in copies:
                continue
            session.add(TaskEvent(reminder_id=row.id, actor_id=actor, field="created", old=None, new=None,
                                  first_at=now, at=now))
        for row in changed:
            if not session.is_modified(row):
                continue
            notes = _changes(row, completing)
            fresh = bool(notes) and _just_made(session, row.id, actor, now)
            for field, old, new in notes:
                if fresh and field not in ALWAYS:
                    continue
                _note(session, row.id, actor, field, old, new, now)
    completing.clear()
    copies.clear()


# --- Reading ----------------------------------------------------------------------------------------------------------


def _list_name(session: Session, viewer_id: int, list_id: Any) -> str | None:
    """A list's name, when the viewer sees it now; else None ("another list")."""
    if not isinstance(list_id, str):
        return None
    row = session.get(TaskList, list_id)
    if row is None or session.get(Member, (row.space_id, viewer_id)) is None:
        return None
    return row.name


def read(session: Session, viewer_id: int, reminder_id: str) -> list[dict[str, Any]]:
    """The events of a task, oldest first; a list as ``{"id", "name"}`` (``name`` null where the viewer does not see
    it)."""
    out: list[dict[str, Any]] = []
    for row in session.scalars(select(TaskEvent).where(TaskEvent.reminder_id == reminder_id)
                               .order_by(TaskEvent.at, TaskEvent.id)):
        old, new = row.old, row.new
        if row.field == "list":
            old = {"id": old, "name": _list_name(session, viewer_id, old)}
            new = {"id": new, "name": _list_name(session, viewer_id, new)}
        out.append({"id": row.id, "field": row.field, "by": row.actor_id, "at": row.at, "old": old, "new": new})
    return out
