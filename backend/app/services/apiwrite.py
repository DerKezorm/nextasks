"""What ``/api/v1`` changes (``docs/api.md``): make, change, tick off, reopen, trash and restore a task.

**No writing of its own.** Every change is an op of ``/batch`` (``services/sync.py``: ``put``, ``complete``), run
through ``sync.Together``: the rule per field, cursors, tombstones, repeating tasks (the completed copy with its
UUIDv5), the bin, members only in ``assignees``; afterwards the notifications and mails ("assigned") as for a change
from the app (``notify.after_op``), and everybody's ``/wait`` hears of it at once. The clock of a change is the
server's ``now``, never below the clock the field already has: a change through the API is the later one.

**What a token may touch** is checked here first, against the spaces it sees (``apiread.Sight``): a list, parent or
task outside them answers ``not_found`` like one that is not there; ``sync`` checks the membership once more.

**``external_ref``** (``ExternalRef``): a key of the program, per account. Looked up and written in the same
transaction as the task, under ``cursor.WRITE_LOCK``: two calls with the same key at the same moment make one task, the
second gets it (``200``). A task in the bin keeps its key; when it goes for good the key goes with it (the row
cascades), and the key makes a new task. A key whose task the account no longer sees at all (it left the space) is
handed to the new task; one whose task only the token does not see is refused (``409 conflict``).
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import ExternalRef, Member, Reminder, Section, Space, TaskList
from . import clock, fractional, notify, records, spaces, sync
from .apiread import Sight


class Refused(Exception):
    """An answer other than success: ``code`` and status as ``docs/api.md`` names them."""

    def __init__(self, code: str, text: str, status: int, fields: list[str] | None = None) -> None:
        super().__init__(text)
        self.code = code
        self.text = text
        self.status = status
        self.fields = fields


def invalid(*names: str) -> Refused:
    return Refused("invalid_input", "The input is not valid.", 422, sorted(set(names)))


def not_found() -> Refused:
    return Refused("not_found", "Not found.", 404)


def conflict(text: str) -> Refused:
    return Refused("conflict", text, 409)


def _from_failed(exc: sync.Failed) -> Refused:
    if exc.code == "invalid":
        return invalid(*(exc.values.get("fields") or ["body"]))
    if exc.code in ("not_found", "gone"):
        return not_found()
    if exc.code == "forbidden":
        return Refused("not_allowed", "The account may not change this.", 403)
    return conflict("The change does not fit the state of the task.")


# --- Checking what comes in -----------------------------------------------------------------------------------------

#: The fields a program may send, and the check of the data model for each.
CHECKS: dict[str, Any] = {
    "title": lambda value: records.text(value, 1, 500),
    "notes": lambda value: "" if value is None else records.text(value, 0, 20_000),
    "url": records.CHECKS["reminder"]["url"],
    "due_date": records.CHECKS["reminder"]["due_date"],
    "due_time": records.CHECKS["reminder"]["due_time"],
    "priority": lambda value: 0 if value is None else records.CHECKS["reminder"]["priority"](value),
    "flagged": lambda value: False if value is None else records.CHECKS["reminder"]["flagged"](value),
    "tags": lambda value: [] if value is None else records.CHECKS["reminder"]["tags"](value),
    "assignees": lambda value: [] if value is None else records.CHECKS["reminder"]["assignees"](value),
    "list_id": records.uuid_or_none,
    "section_id": records.uuid_or_none,
    "parent_id": records.uuid_or_none,
}


def clean(body: dict[str, Any]) -> dict[str, Any]:
    """The fields sent, checked; ``invalid_input`` names every one that is wrong."""
    out: dict[str, Any] = {}
    bad: list[str] = []
    for name, value in body.items():
        check = CHECKS.get(name)
        if check is None:
            out[name] = value
            continue
        try:
            out[name] = check(value)
        except (TypeError, ValueError):
            bad.append(name)
    if bad:
        raise invalid(*bad)
    return out


@dataclass
class Done:
    """What a change did: the task to answer with, and for a repeating task ticked off the open occurrence and the
    completed copy."""

    task_id: str
    created: bool = False
    next_id: str | None = None
    copy_id: str | None = None
    notes: list[str] = field(default_factory=list)


# --- Helpers inside the transaction ---------------------------------------------------------------------------------


def _seen_list(db: Session, sight: Sight, list_id: str) -> TaskList:
    found = db.get(TaskList, list_id)
    if found is None or found.space_id not in sight.space_ids or db.get(Member, (found.space_id,
                                                                                   sight.account_id)) is None:
        raise not_found()
    return found


def _seen_task(db: Session, sight: Sight, task_id: str) -> Reminder:
    row = db.get(Reminder, task_id) if records.is_uuid(task_id) else None
    if row is None or row.space_id not in sight.space_ids or db.get(Member, (row.space_id,
                                                                            sight.account_id)) is None:
        raise not_found()
    return row


def _effective_parent(db: Session, row: Reminder) -> Reminder | None:
    if not row.parent_id:
        return None
    parent = db.get(Reminder, row.parent_id)
    if parent is None or parent.parent_id or parent.list_id != row.list_id:
        return None
    return parent


def _section_of(db: Session, list_id: str, section_id: str | None) -> str | None:
    if section_id is None:
        return None
    section = db.get(Section, section_id)
    if section is None or section.list_id != list_id:
        raise conflict("The section is not one of this list.")
    return section_id


def _in_bin(db: Session, row: Reminder) -> bool:
    return notify.in_bin(db, row)


def _key_at_end(db: Session, list_id: str, section_id: str | None, parent_id: str | None,
                without: str | None = None) -> str:
    """After the last of the tasks that share the place, as the interface puts a new task (``keyAtEnd``)."""
    query = select(Reminder).where(Reminder.list_id == list_id)
    if parent_id is not None:
        query = query.where(Reminder.parent_id == parent_id)
    else:
        query = query.where(Reminder.parent_id.is_(None))
        query = query.where(Reminder.section_id == section_id) if section_id else query.where(
            Reminder.section_id.is_(None))
    last: str | None = None
    for row in db.scalars(query):
        if row.id == without or _in_bin(db, row) or not records.valid_key(row.position):
            continue
        if last is None or row.position > last:
            last = row.position
    return fractional.key_between(last, None)


def _assignees(db: Session, space_id: str, wanted: list[int]) -> list[int]:
    """Only in shared spaces, only members: anything else is refused, not struck quietly."""
    if not wanted:
        return []
    space = db.get(Space, space_id)
    if space is None or space.private or not set(wanted) <= set(spaces.member_ids(db, space_id)):
        raise invalid("assignees")
    return wanted


def _clock(row: Reminder | None, key: str, now_ms: int) -> int:
    """Now, and never below the clock the field has: the change through the API is the later one."""
    stored = int((row.clock or {}).get(key, 0)) if row is not None else 0
    return max(now_ms, stored + 1)


def _put(change: sync.Together, row: Reminder | None, item_id: str, fields: dict[str, Any]) -> None:
    now_ms = clock.now_ms()
    clocks: dict[str, int] = {}
    for name in fields:
        if name in ("created_at",):
            continue
        key = records.key_of("reminder", name)
        clocks[key] = _clock(row, key, now_ms)
    try:
        change.run({"type": "put", "kind": "reminder", "id": item_id, "fields": fields, "clock": clocks})
    except sync.Failed as exc:
        raise _from_failed(exc) from exc


def _today(sight: Sight) -> str:
    return sight.today().isoformat()


def _now_stamp() -> str:
    return records.format_stamp(clock.now())


# --- Make -----------------------------------------------------------------------------------------------------------


def create(caller: sync.Caller, sight: Sight, body: dict[str, Any], default_list: str | None) -> Done:
    """``POST /api/v1/tasks``. ``body``: the fields sent (checked by ``clean``); ``default_list``: where the task goes
    without ``list_id`` (``apiread.World.default_list``)."""
    key = body.pop("external_ref", None)
    if key is not None and (not isinstance(key, str) or not 1 <= len(key) <= 200 or "\x00" in key):
        raise invalid("external_ref")
    if "title" not in body:
        raise invalid("title")
    with sync.Together(caller) as change:
        db = change.db
        if key is not None:
            ref = db.get(ExternalRef, (caller.id, key))
            if ref is not None:
                existing = db.get(Reminder, ref.reminder_id)
                if existing is not None and db.get(Member, (existing.space_id, caller.id)) is not None:
                    if existing.space_id not in sight.space_ids:
                        raise conflict("A task with this external_ref lies in a space this token does not see.")
                    return Done(task_id=existing.id)
                # The account does not see that task any more: the key belongs to the one made now.
                db.delete(ref)
                db.flush()
        parent: Reminder | None = None
        if body.get("parent_id") is not None:
            parent = _seen_task(db, sight, body["parent_id"])
            if parent.parent_id:
                raise conflict("A subtask cannot have subtasks.")
            if body.get("list_id") is not None and body["list_id"] != parent.list_id:
                raise conflict("The parent lies in another list.")
            if body.get("section_id") is not None:
                raise conflict("A subtask has no section.")
            target = _seen_list(db, sight, parent.list_id)
        elif body.get("list_id") is not None:
            target = _seen_list(db, sight, body["list_id"])
        elif default_list is not None:
            target = _seen_list(db, sight, default_list)
        else:
            raise Refused("invalid_input", "Name a list: this token has no list a task would go to by default.",
                          422, ["list_id"])
        section_id = _section_of(db, target.id, body.get("section_id")) if parent is None else None
        if body.get("due_time") is not None and body.get("due_date") is None:
            raise invalid("due_time")
        assignees = _assignees(db, target.space_id, body.get("assignees") or [])
        task_id = str(uuid.uuid4())
        fields: dict[str, Any] = {
            "list_id": target.id, "section_id": section_id, "parent_id": parent.id if parent else None,
            "position": _key_at_end(db, target.id, section_id, parent.id if parent else None),
            "title": body["title"], "created_at": _now_stamp(),
        }
        for name in ("notes", "url", "priority", "flagged", "tags"):
            if name in body:
                fields[name] = body[name]
        if assignees:
            fields["assignees"] = assignees
        if body.get("due_date") is not None:
            fields.update(due_date=body["due_date"], due_time=body.get("due_time"), repeat=None, repeat_from="due")
        _put(change, None, task_id, fields)
        if key is not None:
            db.add(ExternalRef(account_id=caller.id, key=key, reminder_id=task_id))
            db.flush()
    notify.after_op(change.events, caller.id)
    return Done(task_id=task_id, created=True)


# --- Change ---------------------------------------------------------------------------------------------------------


def change_task(caller: sync.Caller, sight: Sight, task_id: str, body: dict[str, Any]) -> Done:
    """``PATCH /api/v1/tasks/{id}``: the fields in one put (each group whole), then ticking off or reopening."""
    completed = body.pop("completed", None)
    trashed = body.pop("trashed", None)
    if completed is not None and not isinstance(completed, bool):
        raise invalid("completed")
    if trashed is not None and trashed is not False:
        # Into the bin goes through DELETE; here only back out of it.
        raise invalid("trashed")
    if "title" in body and body["title"] is None:
        raise invalid("title")
    done = Done(task_id=task_id)
    with sync.Together(caller) as change:
        db = change.db
        row = _seen_task(db, sight, task_id)
        fields: dict[str, Any] = {}
        for name in ("title", "notes", "url", "priority", "flagged", "tags"):
            if name in body and body[name] != getattr(row, name):
                fields[name] = body[name]
        if "due_date" in body or "due_time" in body:
            due_date = body.get("due_date", row.due_date)
            if due_date is None:
                due = {"due_date": None, "due_time": None, "repeat": None, "repeat_from": "due"}
            else:
                due_time = body.get("due_time", row.due_time if row.due_date else None)
                due = {"due_date": due_date, "due_time": due_time,
                       "repeat": row.repeat if row.due_date else None,
                       "repeat_from": row.repeat_from if row.due_date else "due"}
            if body.get("due_time") is not None and due_date is None:
                raise invalid("due_time")
            if any(due[name] != getattr(row, name) for name in due):
                fields.update(due)
        if "list_id" in body and body["list_id"] is None:
            raise invalid("list_id")
        target = _seen_list(db, sight, body.get("list_id") or row.list_id)
        moving = target.id != row.list_id
        parent = _effective_parent(db, row)
        if moving:
            section_id = _section_of(db, target.id, body.get("section_id"))
            fields.update(list_id=target.id, section_id=section_id, parent_id=None,
                          position=_key_at_end(db, target.id, section_id, None, row.id))
        elif "section_id" in body and body["section_id"] != (None if parent else row.section_id):
            if parent is not None:
                raise conflict("A subtask has no section.")
            section_id = _section_of(db, row.list_id, body["section_id"])
            fields.update(list_id=row.list_id, section_id=section_id, parent_id=row.parent_id,
                          position=_key_at_end(db, row.list_id, section_id, None, row.id))
        if "assignees" in body and body["assignees"] != list(row.assignees or []):
            fields["assignees"] = _assignees(db, target.space_id, body["assignees"])
        if trashed is False and row.deleted_at is not None:
            fields["deleted_at"] = None
        if completed is False and row.completed_at is not None:
            fields.update(completed_at=None, completed_by=None)
        if fields:
            _put(change, row, row.id, fields)
        if completed is True and row.completed_at is None:
            try:
                outcome = change.run({"type": "complete", "id": row.id, "occurrence": row.due_date,
                                      "at": _now_stamp(), "on": _today(sight)})
            except sync.Failed as exc:
                if exc.code != "already_done":
                    raise _from_failed(exc) from exc
            else:
                if outcome.copy_id:
                    done.next_id = row.id
                    done.copy_id = outcome.copy_id
    notify.after_op(change.events, caller.id)
    return done


def trash(caller: sync.Caller, sight: Sight, task_id: str) -> None:
    """``DELETE /api/v1/tasks/{id}``: into the bin, with its subtasks (they are in it through their parent)."""
    with sync.Together(caller) as change:
        row = _seen_task(change.db, sight, task_id)
        if row.deleted_at is None:
            _put(change, row, row.id, {"deleted_at": _now_stamp()})
    notify.after_op(change.events, caller.id)
