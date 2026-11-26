"""What the app and the web send (``/batch``): ``put``, ``delete``, ``complete``, ``position``
(``vertrag-block1.md``, "Abgleich: schicken"; the rules in ``datenmodell.md``).

**One op at a time.** Every op runs in a transaction of its own under ``cursor.WRITE_LOCK``, from its first read to
its commit: two batches on the same reminder at the same moment apply one after the other, each against what the other
wrote. A failed op holds no other up.

**The rule per field.** A value is taken when its clock is greater than the stored one, or, with the same clock, when
it is canonically greater (``services/gleichstand.py``, RFC 8785 as UTF-8 bytes). Equal values with equal clocks change
nothing. Clocks more than two seconds ahead of the server are set to the server's ``now``. What the server changes on
its own (assignees struck, a repeat moved on, subtasks taken along) it writes with the clock ``now``.

**What an op answers.** ``current`` is the thing after the op as ``/changes`` would give it to the caller, or null
when the caller does not see it (any more).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any, Self

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import SessionLocal
from ..models import (
    MANAGER,
    Account,
    Attachment,
    Comment,
    Gone,
    ListPref,
    Member,
    Reminder,
    SavedFilter,
    Section,
    Space,
    SpacePref,
    TaskList,
    TilePref,
    utcnow,
)

# ``completions`` records every completion as the session flushes (its hook); imported here, where every write runs.
# ``history`` keeps what happened to a task and who did it, by a hook of its own as well.
from . import (  # noqa: F401
    changes,
    clock,
    completions,
    cursor,
    files,
    gleichstand,
    gone,
    history,
    records,
    rotation,
    spaces,
    wiederholung,
)

logger = logging.getLogger("nextasks.sync")

#: A clock further ahead of the server than this is set to the server's ``now``.
AHEAD_MS = 2000
_MODELS: dict[str, Any] = {
    "space": Space,
    "list": TaskList,
    "section": Section,
    "reminder": Reminder,
    "list_pref": ListPref,
    "space_pref": SpacePref,
    "filter": SavedFilter,
    "tile_pref": TilePref,
    "attachment": Attachment,
    "comment": Comment,
}
#: How long the author may change the text of a comment.
EDIT_HOURS = 24


@dataclass
class Caller:
    """Who sends: the account (detached) and the device or browser session the ``op_id`` belong to."""

    account: Account
    #: ``d:<device id>`` or ``s:<session id>``.
    key: str
    #: How it writes, where not by the account's own hand: ``mcp:<key name>`` (the history shows it).
    via: str = ""

    @property
    def id(self) -> int:
        return int(self.account.id)


@dataclass
class Outcome:
    """What an op did, before it is written as a ``Result``."""

    ok: bool
    code: str | None = None
    kind: str | None = None
    item_id: str | None = None
    values: dict[str, Any] = field(default_factory=dict)
    #: The copy made by ``complete``.
    copy_id: str | None = None


class Failed(Exception):
    def __init__(self, code: str, **values: Any) -> None:
        super().__init__(code)
        self.code = code
        self.values = values


@dataclass
class Events:
    """What the notifications hear of, after the commit (``services/notify.py``)."""

    assigned: list[tuple[str, list[int]]] = field(default_factory=list)
    added: list[str] = field(default_factory=list)
    completed: list[str] = field(default_factory=list)
    #: Comments made, by id.
    comments: list[str] = field(default_factory=list)
    accounts: set[int] = field(default_factory=set)


# --- Helpers ----------------------------------------------------------------------------------------------------------


def _load(db: Session, kind: str, item_id: str, account_id: int) -> Any:
    if kind in records.PREF_KINDS or kind == "tile_pref":
        return db.get(_MODELS[kind], (account_id, item_id))
    return db.get(_MODELS[kind], item_id)


def _is_gone(db: Session, kind: str, item_id: str, account_id: int = 0) -> bool:
    accounts = [0, account_id] if kind in records.PREF_KINDS or kind in records.OWN_KINDS else [0]
    return db.scalar(select(Gone.kind).where(Gone.kind == kind, Gone.id == item_id,
                                             Gone.account_id.in_(accounts)).limit(1)) is not None


def _foreign_filter(db: Session, item_id: str, account_id: int) -> bool:
    """The id is, or was, another account's filter: for this one it does not exist, and it may not take it over."""
    row = db.get(SavedFilter, item_id)
    if row is not None:
        return row.account_id != account_id
    return db.scalar(select(Gone.kind).where(Gone.kind == "filter", Gone.id == item_id,
                                             Gone.account_id != account_id).limit(1)) is not None


def _space_of(kind: str, row: Any) -> str | None:
    """The space a thing lies in; None for what belongs to an account alone (``records.OWN_KINDS``)."""
    if kind in records.OWN_KINDS:
        return None
    return row.id if kind == "space" else row.space_id


def _audience(db: Session, caller: Caller, space_id: str | None) -> list[int]:
    """Who sees a change: the members of its space, or the caller alone for its own things."""
    return [caller.id] if space_id is None else spaces.member_ids(db, space_id)


def _member(db: Session, caller: Caller, space_id: str) -> Member | None:
    return db.get(Member, (space_id, caller.id))


def _capped(clocks: dict[str, int], now_ms: int) -> dict[str, int]:
    return {key: (now_ms if value > now_ms + AHEAD_MS else value) for key, value in clocks.items()}


def _target_list(db: Session, caller: Caller, list_id: str) -> TaskList:
    """A list a thing is put into: there, and seen by the caller."""
    found = db.get(TaskList, list_id)
    if found is None:
        raise Failed("gone" if _is_gone(db, "list", list_id) else "parent_missing")
    if _member(db, caller, found.space_id) is None:
        raise Failed("not_found")
    return found


def _check_parent(db: Session, parent_id: str | None, own_id: str) -> None:
    if parent_id is None:
        return
    if parent_id == own_id:
        raise Failed("invalid", fields=["parent_id"])
    if db.get(Reminder, parent_id) is None:
        raise Failed("gone" if _is_gone(db, "reminder", parent_id) else "parent_missing")


def _allowed_assignees(db: Session, space_id: str, wanted: list[int]) -> tuple[list[int], list[int]]:
    """Members of the space only, none in a private space: what stays and what was struck."""
    space = db.get(Space, space_id)
    members = set(spaces.member_ids(db, space_id))
    if space is None or space.private:
        return [], list(wanted)
    kept = [person for person in wanted if person in members]
    return kept, [person for person in wanted if person not in members]


def _is_private(db: Session, space_id: str) -> bool:
    space = db.get(Space, space_id)
    return space is None or space.private


def _set_trash(row: Any, before: str | None) -> None:
    if row.deleted_at is not None and before is None:
        row.trashed_at = utcnow()
    elif row.deleted_at is None:
        row.trashed_at = None


def _now_stamp() -> str:
    return records.format_stamp(clock.now())


# --- put --------------------------------------------------------------------------------------------------------------


def put(db: Session, caller: Caller, op: dict[str, Any], events: Events) -> Outcome:
    kind = op.get("kind")
    item_id = op.get("id")
    if kind not in records.PUT_KINDS:
        raise Failed("invalid", fields=["kind"])
    if not records.is_uuid(item_id):
        raise Failed("invalid", fields=["id"])
    if kind == "tile_pref" and item_id not in records.TILE_IDS:
        raise Failed("invalid", fields=["id"])
    try:
        incoming = records.take_apart(kind, op.get("fields"), op.get("clock"))
    except records.Invalid as exc:
        raise Failed("invalid", fields=exc.fields) from exc
    now_ms = clock.now_ms()
    incoming.clocks = _capped(incoming.clocks, now_ms)
    if kind == "filter" and _foreign_filter(db, item_id, caller.id):
        raise Failed("not_found")
    if _is_gone(db, kind, item_id, caller.id):
        raise Failed("gone")
    if kind == "list_pref" and _is_gone(db, "list", item_id):
        raise Failed("gone")
    if kind == "space_pref" and _is_gone(db, "space", item_id):
        raise Failed("gone")
    row = _load(db, kind, item_id, caller.id)
    if row is None:
        return _create(db, caller, kind, item_id, incoming, now_ms, events)
    space_id = _space_of(kind, row)
    if space_id is not None and _member(db, caller, space_id) is None:
        raise Failed("not_found")
    if incoming.missing:
        raise Failed("invalid", fields=sorted(incoming.missing))
    return _update(db, caller, kind, row, incoming, now_ms, events)


def _clock_with(kind: str, given: dict[str, int]) -> dict[str, int]:
    return {key: int(given.get(key, 0)) for key in records.clock_keys(kind)}


def _create(db: Session, caller: Caller, kind: str, item_id: str, incoming: records.Incoming, now_ms: int,
            events: Events) -> Outcome:
    values = incoming.values
    missing = [name for name in records.REQUIRED[kind] if name not in values and name not in incoming.fixed]
    if missing:
        raise Failed("invalid", fields=missing)
    data = {**records.DEFAULTS[kind], **values}
    clocks = _clock_with(kind, incoming.clocks)
    applied = sorted(incoming.clocks)
    dropped: list[int] = []
    if kind == "space":
        row: Any = Space(id=item_id, name=data["name"], color=data["color"], icon=data["icon"], private=False,
                         deleted_at=data["deleted_at"], clock=clocks, created_at=utcnow())
        if row.deleted_at is not None:
            row.trashed_at = utcnow()
        spaces.restamp(db, [row])
        db.add(row)
        db.flush()
        spaces.join(db, row, caller.id, MANAGER)
    elif kind == "list":
        space = db.get(Space, data["space_id"])
        if space is None:
            raise Failed("gone" if _is_gone(db, "space", data["space_id"]) else "parent_missing")
        if _member(db, caller, space.id) is None:
            raise Failed("not_found")
        row = TaskList(id=item_id, space_id=space.id, name=data["name"], color=data["color"], icon=data["icon"],
                       view=data["view"], position=data["position"], deleted_at=data["deleted_at"], clock=clocks,
                       created_at=utcnow())
        _set_trash(row, None)
        spaces.restamp(db, [row])
        db.add(row)
    elif kind == "section":
        target = _target_list(db, caller, data["list_id"])
        row = Section(id=item_id, list_id=target.id, space_id=target.space_id, name=data["name"],
                      position=data["position"], clock=clocks)
        spaces.restamp(db, [row])
        db.add(row)
    elif kind == "reminder":
        target = _target_list(db, caller, data["list_id"])
        _check_parent(db, data["parent_id"], item_id)
        kept, dropped = _allowed_assignees(db, target.space_id, data["assignees"])
        turn, _struck = _allowed_assignees(db, target.space_id, data["rotation"])
        created = incoming.created_at
        if created is None or records.ms(records.parse_stamp(created)) > now_ms + AHEAD_MS:
            created = _now_stamp()
        row = Reminder(
            id=item_id, list_id=target.id, space_id=target.space_id, section_id=data["section_id"],
            parent_id=data["parent_id"], position=data["position"], title=data["title"], notes=data["notes"],
            url=data["url"], due_date=data["due_date"], due_time=data["due_time"], repeat=data["repeat"],
            repeat_from=data["repeat_from"], location=data["location"], flagged=data["flagged"],
            priority=data["priority"], tags=data["tags"], assignees=kept, rotation=turn,
            completed_at=data["completed_at"],
            # Moved over from elsewhere already done: whoever moved it is named.
            completed_by=caller.id if data["completed_at"] is not None else None,
            created_by=caller.id, created_at=created, deleted_at=data["deleted_at"], clock=clocks,
        )
        _set_trash(row, None)
        rotation.settle(row, _is_private(db, target.space_id), now_ms)
        spaces.restamp(db, [row])
        db.add(row)
        new = [person for person in (row.assignees or []) if person != caller.id]
        if new:
            events.assigned.append((item_id, new))
        if row.parent_id is None and row.completed_at is None:
            events.added.append(item_id)
    elif kind == "list_pref":
        target = _target_list(db, caller, item_id)
        row = ListPref(account_id=caller.id, list_id=target.id, space_id=target.space_id,
                       show_completed=data["show_completed"], notify_changes=data["notify_changes"], clock=clocks)
        spaces.restamp(db, [row])
        db.add(row)
    elif kind == "space_pref":
        space = db.get(Space, item_id)
        if space is None:
            raise Failed("gone" if _is_gone(db, "space", item_id) else "parent_missing")
        if _member(db, caller, space.id) is None:
            raise Failed("not_found")
        row = SpacePref(account_id=caller.id, space_id=space.id, hidden=data["hidden"], clock=clocks)
        spaces.restamp(db, [row])
        db.add(row)
    elif kind == "filter":
        row = SavedFilter(id=item_id, account_id=caller.id, name=data["name"], color=data["color"], icon=data["icon"],
                          position=data["position"], rules=data["rules"], hidden=data["hidden"], clock=clocks)
        spaces.restamp(db, [row])
        db.add(row)
    elif kind == "comment":
        row = _create_comment(db, caller, item_id, incoming, data, clocks, now_ms)
        events.comments.append(item_id)
    else:  # tile_pref
        row = TilePref(account_id=caller.id, tile_id=item_id, hidden=data["hidden"], clock=clocks)
        spaces.restamp(db, [row])
        db.add(row)
    db.flush()
    events.accounts.update(_audience(db, caller, _space_of(kind, row)))
    return Outcome(True, kind=kind, item_id=item_id,
                   values={"applied": applied, "ignored": sorted(set(incoming.ignored)), "dropped_assignees": dropped})


def _create_comment(db: Session, caller: Caller, item_id: str, incoming: records.Incoming, data: dict[str, Any],
                    clocks: dict[str, int], now_ms: int) -> Comment:
    """A comment under a task the caller sees, never in a space "Private"; a text or a picture (an attachment of the
    same task) it must have. People it names who are no members drop out quietly."""
    reminder_id = incoming.fixed.get("reminder_id")
    if reminder_id is None:
        raise Failed("invalid", fields=["reminder_id"])
    task = db.get(Reminder, reminder_id)
    if task is None:
        raise Failed("gone" if _is_gone(db, "reminder", reminder_id) else "parent_missing")
    if _member(db, caller, task.space_id) is None:
        raise Failed("not_found")
    space = db.get(Space, task.space_id)
    if space is None or space.private:
        raise Failed("forbidden")
    attachment_id = incoming.fixed.get("attachment_id")
    if attachment_id is not None:
        picture = db.get(Attachment, attachment_id)
        if picture is None or picture.reminder_id != task.id:
            raise Failed("invalid", fields=["attachment_id"])
    if not data["text"] and attachment_id is None:
        raise Failed("invalid", fields=["text"])
    created = incoming.created_at
    if created is None or records.ms(records.parse_stamp(created)) > now_ms + AHEAD_MS:
        created = _now_stamp()
    members = set(spaces.member_ids(db, task.space_id))
    row = Comment(id=item_id, reminder_id=task.id, space_id=task.space_id, author_id=caller.id, text=data["text"],
                  mentions=[person for person in data["mentions"] if person in members], attachment_id=attachment_id,
                  created_at=created, clock=clocks, via=caller.via)
    spaces.restamp(db, [row])
    db.add(row)
    return row


def _may_edit(caller: Caller, row: Comment) -> bool:
    """The author, for a day after it was made (by the server's clock), and never once it was removed."""
    if row.author_id != caller.id or row.removed_at is not None:
        return False
    try:
        made = records.parse_stamp(row.created_at)
    except ValueError:
        return False
    return clock.now() - made <= timedelta(hours=EDIT_HOURS)


def _update(db: Session, caller: Caller, kind: str, row: Any, incoming: records.Incoming, now_ms: int,
            events: Events) -> Outcome:
    if kind == "space":
        member = _member(db, caller, row.id)
        if member is None or member.role != MANAGER:
            raise Failed("forbidden")
        if row.private and incoming.values.get("deleted_at") is not None:
            raise Failed("forbidden")
    if kind == "reminder" and incoming.values.get("completed_at") is not None:
        # Completing goes through ``complete`` only; a put may reopen.
        raise Failed("invalid", fields=["completed_at"])
    if kind == "comment":
        # The task and the picture stay what they were made with.
        incoming.ignored.extend(incoming.fixed)
        if incoming.clocks and not _may_edit(caller, row):
            raise Failed("forbidden")
    stored = records.data_of(kind, row) if kind != "space" else records.data_of(kind, row, role=None)
    stored_clock = records.clock_of(kind, row)
    proposed = {**stored, **incoming.values}
    taken: list[str] = []
    kept_keys: list[str] = list(incoming.ignored)
    for key in sorted(incoming.clocks):
        verdict = gleichstand.merge(records.value_of(kind, key, stored), stored_clock.get(key, 0),
                                    records.value_of(kind, key, proposed), incoming.clocks[key])
        (taken if verdict == "take" else kept_keys).append(key)
    if not taken:
        return Outcome(True, kind=kind, item_id=records.entry_id(kind, row),
                       values={"applied": [], "ignored": sorted(set(kept_keys)), "dropped_assignees": []})
    fields = [name for key in taken for name in records.fields_of(kind, key) if name in incoming.values]
    if kind == "reminder" and "completion" in taken:
        fields.append("completed_by")
    old_space = _space_of(kind, row)
    old_list = getattr(row, "list_id", None)
    new_space = old_space
    # Where it goes, checked before anything changes.
    if kind == "list" and "space_id" in taken and incoming.values["space_id"] != row.space_id:
        target_space = db.get(Space, incoming.values["space_id"])
        if target_space is None:
            raise Failed("gone" if _is_gone(db, "space", incoming.values["space_id"]) else "parent_missing")
        if _member(db, caller, target_space.id) is None:
            raise Failed("not_found")
        new_space = target_space.id
    if kind in ("section", "reminder") and ("list_id" in fields) and incoming.values["list_id"] != row.list_id:
        new_space = _target_list(db, caller, incoming.values["list_id"]).space_id
    if kind == "reminder" and "parent_id" in fields:
        _check_parent(db, incoming.values["parent_id"], row.id)
    dropped: list[int] = []
    before_assignees = list(row.assignees or []) if kind == "reminder" else []
    before_rotation = list(row.rotation or []) if kind == "reminder" else []
    before_deleted = getattr(row, "deleted_at", None)
    for name in fields:
        if name == "completed_by":
            row.completed_by = None
            continue
        setattr(row, name, incoming.values[name])
    clocks = dict(row.clock or {})
    for key in taken:
        clocks[key] = incoming.clocks[key]
    row.clock = clocks
    if hasattr(row, "trashed_at"):
        _set_trash(row, before_deleted)
    if kind in ("section", "reminder", "list_pref") and new_space != old_space:
        row.space_id = new_space
    if kind == "reminder" and "assignees" in taken:
        kept, dropped = _allowed_assignees(db, new_space, list(row.assignees or []))
        # An assignment of a deleted account nobody sees stays while the task keeps its space (decided E35).
        row.assignees = gone.kept(before_assignees, kept) if new_space == old_space else kept
    if kind == "reminder" and "rotation" in taken:
        turn, _struck = _allowed_assignees(db, new_space, list(row.rotation or []))
        row.rotation = gone.kept(before_rotation, turn) if new_space == old_space else turn
    if kind == "reminder":
        # Whose turn it is stands in ``assignees`` alone; ``_filter_assignees`` keeps it so when the space changes.
        rotation.settle(row, _is_private(db, new_space), now_ms, before_assignees)
    if kind == "comment":
        if not row.text and row.attachment_id is None:
            raise Failed("invalid", fields=["text"])
        members = set(spaces.member_ids(db, row.space_id))
        row.mentions = [person for person in (row.mentions or []) if person in members]
        row.edited_at = _now_stamp()
    spaces.restamp(db, [row])
    db.flush()
    if kind == "list" and new_space != old_space:
        spaces.move_list(db, row, old_space, now_ms)
    elif kind == "section" and new_space != old_space:
        spaces.hide(db, set(spaces.member_ids(db, old_space)) - set(spaces.member_ids(db, new_space)),
                    [("section", row.id)], old_space)
    elif kind == "reminder" and old_list != row.list_id:
        spaces.move_reminder(db, row, old_list, old_space, now_ms)
    if kind == "reminder":
        new = [person for person in (row.assignees or []) if person not in before_assignees and person != caller.id]
        if new:
            events.assigned.append((row.id, new))
    events.accounts.update(_audience(db, caller, old_space))
    events.accounts.update(_audience(db, caller, new_space))
    return Outcome(True, kind=kind, item_id=records.entry_id(kind, row),
                   values={"applied": sorted(taken), "ignored": sorted(set(kept_keys)), "dropped_assignees": dropped})


# --- delete -----------------------------------------------------------------------------------------------------------


def delete(db: Session, caller: Caller, op: dict[str, Any], events: Events) -> Outcome:
    kind = op.get("kind")
    item_id = op.get("id")
    if kind not in ("section", "attachment", "filter", "comment"):
        raise Failed("invalid", fields=["kind"])
    if not records.is_uuid(item_id):
        raise Failed("invalid", fields=["id"])
    if kind == "filter":
        return _delete_filter(db, caller, item_id, events)
    if kind == "comment":
        return _remove_comment(db, caller, item_id, events)
    row = db.get(_MODELS[kind], item_id)
    if row is None:
        # Vertragslücke: "already gone: ok" is read as "a tombstone is there"; an id the server never had is
        # ``not_found``.
        if _is_gone(db, kind, item_id):
            return Outcome(True, kind=kind, item_id=item_id)
        raise Failed("not_found")
    if _member(db, caller, row.space_id) is None:
        raise Failed("not_found")
    space_id = row.space_id
    digest = row.hash if kind == "attachment" else None
    db.delete(row)
    db.flush()
    spaces.tombstone(db, kind, item_id, space_id)
    if digest is not None:
        files.forget_if_unused(db, digest)
    events.accounts.update(spaces.member_ids(db, space_id))
    return Outcome(True, kind=kind, item_id=item_id)


def _remove_comment(db: Session, caller: Caller, item_id: str, events: Events) -> Outcome:
    """Not for good: the comment stays as "message removed", its text, the people it named and its picture go. Its
    author may, and every manager of the space. Removed already: ok."""
    row = db.get(Comment, item_id)
    if row is None:
        if _is_gone(db, "comment", item_id):
            return Outcome(True, kind="comment", item_id=item_id)
        raise Failed("not_found")
    member = _member(db, caller, row.space_id)
    if member is None:
        raise Failed("not_found")
    if row.removed_at is not None:
        return Outcome(True, kind="comment", item_id=item_id)
    if row.author_id != caller.id and member.role != MANAGER:
        raise Failed("forbidden")
    now_ms = clock.now_ms()
    row.removed_at = _now_stamp()
    row.text = ""
    row.mentions = []
    clocks = dict(row.clock or {})
    clocks["text"] = max(now_ms, int(clocks.get("text", 0)) + 1)
    row.clock = clocks
    picture = db.get(Attachment, row.attachment_id) if row.attachment_id else None
    row.attachment_id = None
    spaces.restamp(db, [row])
    if picture is not None:
        digest = picture.hash
        db.delete(picture)
        db.flush()
        spaces.tombstone(db, "attachment", picture.id, picture.space_id)
        files.forget_if_unused(db, digest)
    events.accounts.update(spaces.member_ids(db, row.space_id))
    return Outcome(True, kind="comment", item_id=item_id)


def _delete_filter(db: Session, caller: Caller, item_id: str, events: Events) -> Outcome:
    """For good, no bin: the tombstone names the owner, so only its devices hear of it (``changes._went``)."""
    if _foreign_filter(db, item_id, caller.id):
        raise Failed("not_found")
    row = db.get(SavedFilter, item_id)
    if row is None:
        if _is_gone(db, "filter", item_id, caller.id):
            return Outcome(True, kind="filter", item_id=item_id)
        raise Failed("not_found")
    db.delete(row)
    db.flush()
    # A filter lies in no space: the empty ``space_id`` matches no membership, the owner hears of it as its own.
    spaces.tombstone(db, "filter", item_id, "", account_id=caller.id)
    events.accounts.add(caller.id)
    return Outcome(True, kind="filter", item_id=item_id)


# --- complete ---------------------------------------------------------------------------------------------------------


def _complete_row(row: Reminder, at: str, by: int | None, at_ms: int) -> None:
    row.completed_at = at
    row.completed_by = by
    clocks = dict(row.clock or {})
    clocks["completion"] = max(at_ms, int(clocks.get("completion", 0)))
    row.clock = clocks


def _subtasks(db: Session, row: Reminder) -> list[Reminder]:
    return list(db.scalars(select(Reminder).where(Reminder.parent_id == row.id, Reminder.list_id == row.list_id)
                           .order_by(Reminder.id)))


def complete(db: Session, caller: Caller, op: dict[str, Any], events: Events) -> Outcome:
    item_id = op.get("id")
    if not records.is_uuid(item_id):
        raise Failed("invalid", fields=["id"])
    bad = []
    try:
        occurrence = None if op.get("occurrence") is None else records.day(op.get("occurrence"))
    except ValueError:
        bad.append("occurrence")
    try:
        at = records.stamp(op.get("at"))
    except ValueError:
        bad.append("at")
    try:
        on = records.day(op.get("on"))
    except ValueError:
        bad.append("on")
    if bad:
        raise Failed("invalid", fields=bad)
    at_moment = records.parse_stamp(at)
    if abs(date.fromisoformat(on) - at_moment.date()) > timedelta(days=1):
        raise Failed("invalid", fields=["on"])
    if _is_gone(db, "reminder", item_id):
        raise Failed("gone")
    row = db.get(Reminder, item_id)
    if row is None or _member(db, caller, row.space_id) is None:
        raise Failed("not_found")
    now_ms = clock.now_ms()
    at_ms = min(records.ms(at_moment), now_ms)
    existing: set[str] = set()
    if occurrence is not None and row.due_date and row.repeat:
        copy_id = wiederholung.copy_id(row.id, occurrence)
        if db.get(Reminder, copy_id) is not None or _is_gone(db, "reminder", copy_id):
            existing.add(copy_id)
    plan = wiederholung.complete(records.data_of("reminder", row), occurrence, at, on, caller.id, existing)
    result = plan["result"]
    if result in ("already_done", "due_changed"):
        raise Failed(result)
    if result == "completed":
        _complete_row(row, at, caller.id, at_ms)
        changed = [row]
        for sub in _subtasks(db, row):
            if sub.completed_at is None:
                _complete_row(sub, at, caller.id, at_ms)
                changed.append(sub)
        spaces.restamp(db, changed)
        events.completed.append(row.id)
        events.accounts.update(spaces.member_ids(db, row.space_id))
        return Outcome(True, kind="reminder", item_id=row.id, values={"copy_id": None, "next_due": None})
    copy = plan["copy"]
    copy_row: Reminder | None = None
    # The history tells this as done for the date, not as a new date and a new task (``services/history.py``).
    db.info.setdefault(history.COMPLETING, {})[row.id] = occurrence
    if copy is not None:
        db.info.setdefault(history.COPIES, set()).add(copy["id"])
    # ``moved_on``: the copy of this occurrence is there already, only the original moves on (no copy in the plan).
    if copy is not None:
        copy_row = Reminder(
            id=copy["id"], list_id=row.list_id, space_id=row.space_id, section_id=row.section_id, parent_id=None,
            position=row.position, title=row.title, notes=row.notes, url=row.url, due_date=copy["due_date"],
            due_time=row.due_time, repeat=None, repeat_from="due", location=row.location, flagged=row.flagged,
            priority=row.priority, tags=list(row.tags or []), assignees=list(row.assignees or []),
            rotation=list(row.rotation or []), completed_at=at, completed_by=caller.id, created_by=row.created_by,
            created_at=row.created_at, deleted_at=row.deleted_at,
            clock={key: at_ms for key in records.clock_keys("reminder")},
        )
        _set_trash(copy_row, None)
        db.add(copy_row)
    original = plan["original"]
    row.due_date = original["due_date"]
    row.due_time = original["due_time"]
    row.repeat = original["repeat"]
    row.repeat_from = original["repeat_from"]
    clocks = dict(row.clock or {})
    # Vertragslücke: the data model sets the clock of ``due`` to the moment of completing; a clock that was later
    # already stays (a clock never goes back, or an older change sent again would undo the moving on).
    clocks["due"] = max(at_ms, int(clocks.get("due", 0)))
    row.clock = clocks
    if copy_row is not None:
        _take_turns(db, row, caller.id, now_ms, events)
    changed = [copy_row, row] if copy_row is not None else [row]
    for sub in _subtasks(db, row):
        if sub.completed_at is not None:
            sub.completed_at = None
            sub.completed_by = None
            sub_clock = dict(sub.clock or {})
            sub_clock["completion"] = max(at_ms, int(sub_clock.get("completion", 0)))
            sub.clock = sub_clock
            changed.append(sub)
    spaces.restamp(db, changed)
    db.flush()
    events.completed.append(row.id)
    events.accounts.update(spaces.member_ids(db, row.space_id))
    return Outcome(True, kind="reminder", item_id=row.id, copy_id=plan["copy_id"],
                   values={"copy_id": plan["copy_id"], "next_due": plan["next_due"]})


def _take_turns(db: Session, row: Reminder, by: int, now_ms: int, events: Events) -> None:
    """After a completion that made a copy: the next one in the rotation is in charge of the original
    (``services/rotation.py``). The copy keeps whose turn it was; the new one hears "assigned to you"."""
    turn = list(row.rotation or [])
    if not rotation.active(turn, row.repeat, row.due_date, _is_private(db, row.space_id)):
        return
    members = set(spaces.member_ids(db, row.space_id))
    turn = [person for person in turn if person in members]
    if not turn:
        return
    following = rotation.after_completion(turn, list(row.assignees or []), by)
    if list(row.assignees or []) == [following]:
        return
    row.assignees = [following]
    rotation.bump(row, "assignees", now_ms)
    if following != by:
        events.assigned.append((row.id, [following]))


# --- position ---------------------------------------------------------------------------------------------------------


def set_position(db: Session, caller: Caller, op: dict[str, Any], events: Events) -> Outcome:
    space_id = op.get("space_id")
    if not records.is_uuid(space_id):
        raise Failed("not_found")
    member = _member(db, caller, space_id)
    if member is None:
        raise Failed("not_found")
    value = op.get("position")
    # Vertragslücke: ``position`` may be null (back to "Private first, the rest by name").
    if value is not None and not records.valid_key(value):
        raise Failed("invalid", fields=["position"])
    if member.position != value:
        member.position = value
        spaces.restamp(db, [member])
    events.accounts.add(caller.id)
    return Outcome(True, kind="member", item_id=f"{space_id}:{caller.id}")


RUN = {"put": put, "delete": delete, "complete": complete, "position": set_position}


# --- Running one op ---------------------------------------------------------------------------------------------------


def current_of(db: Session, caller: Caller, kind: str | None, item_id: str | None) -> dict[str, Any] | None:
    """The thing as the caller sees it now: an entry, a deleted entry for a tombstone, or None."""
    if kind is None or item_id is None:
        return None
    if kind == "member":
        space_id, _, account = item_id.partition(":")
        row: Any = db.get(Member, (space_id, int(account))) if account.isdigit() else None
    elif kind in _MODELS and (records.is_uuid(item_id)):
        row = _load(db, kind, item_id, caller.id)
    else:
        return None
    if row is None:
        return changes.gone_entry(db, caller.id, kind, item_id)
    return changes.entry_for(db, caller.id, kind, row)


def target_of(op: dict[str, Any]) -> tuple[str | None, str | None]:
    """The thing an op is about, for ``current``."""
    kind = op.get("type")
    if kind in ("put", "delete"):
        target = op.get("kind"), op.get("id")
    elif kind == "complete":
        target = "reminder", op.get("id")
    elif kind == "position":
        target = None, None
    else:
        target = None, None
    return (target[0] if isinstance(target[0], str) else None, target[1] if isinstance(target[1], str) else None)


def apply(caller: Caller, op: dict[str, Any]) -> tuple[dict[str, Any], Events]:
    """One op in a transaction of its own. The result without ``current`` (that is read fresh, ``answer``)."""
    events = Events()
    runner = RUN.get(op.get("type"))  # type: ignore[arg-type]
    if runner is None:
        return {"op_id": op.get("op_id"), "ok": False, "code": "invalid", "fields": ["type"]}, events
    with cursor.WRITE_LOCK, SessionLocal() as db:
        db.info[history.ACTOR] = caller.id
        db.info[history.VIA] = caller.via
        try:
            outcome = runner(db, caller, op, events)
            db.commit()
        except Failed as exc:
            db.rollback()
            events = Events()
            result = {"op_id": op.get("op_id"), "ok": False, "code": exc.code, **exc.values}
            return result, events
    cursor.touched_everybody()
    result = {"op_id": op.get("op_id"), "ok": True, **outcome.values}
    if op.get("type") == "position":
        result["_target"] = [outcome.kind, outcome.item_id]
    return result, events


class Together:
    """Several ops as one change, all or none (``/api/v1``: a task made with its key, a change of several fields at
    once). The same runners as ``/batch`` in one transaction under ``cursor.WRITE_LOCK``; what to send may be read
    from ``db`` first, inside the lock. A ``Failed`` op undoes the others. After the commit everybody's ``/wait``
    hears of it; the caller hands ``events`` to the notifications::

        with sync.Together(caller) as change:
            change.run({"type": "put", ...})
        notify.after_op(change.events, caller.id)
    """

    def __init__(self, caller: Caller) -> None:
        self.caller = caller
        self.events = Events()
        self.outcomes: list[Outcome] = []

    def __enter__(self) -> Self:
        cursor.WRITE_LOCK.acquire()
        self.db = SessionLocal()
        self.db.info[history.ACTOR] = self.caller.id
        self.db.info[history.VIA] = self.caller.via
        return self

    def run(self, op: dict[str, Any]) -> Outcome:
        outcome = RUN[op["type"]](self.db, self.caller, op, self.events)
        self.outcomes.append(outcome)
        return outcome

    def __exit__(self, exc_type: type[BaseException] | None, _exc: BaseException | None, _trace: object) -> None:
        try:
            if exc_type is None:
                self.db.commit()
            else:
                self.db.rollback()
                self.events = Events()
        finally:
            self.db.close()
            cursor.WRITE_LOCK.release()
        if exc_type is None:
            cursor.touched_everybody()


def answer(caller: Caller, op: dict[str, Any], stored: dict[str, Any]) -> dict[str, Any]:
    """The stored result with ``current`` (and ``copy``) as the caller sees them now."""
    out = {key: value for key, value in stored.items() if key != "_target"}
    kind, item_id = target_of(op)
    if "_target" in stored:
        kind, item_id = stored["_target"]
    with SessionLocal() as db:
        out["current"] = current_of(db, caller, kind, item_id)
        if stored.get("copy_id"):
            out["copy"] = current_of(db, caller, "reminder", stored["copy_id"])
    return out
