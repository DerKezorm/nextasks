"""Who sees what: members of spaces, the space "Private" of every account, and what happens when a thing moves into
another space or a member goes (``datenmodell.md``, "Mitgliedschaft"; ``vertrag-block1.md``, "Bereichswechsel").

Whoever is a member of a space sees everything in it. When an account stops seeing a thing (it left the space, was
taken out, or the thing moved into a space it is not in), the account gets a ``Hidden`` row for the thing with a new
cursor: ``/changes`` tells it ``deleted: true``. Things that move get new cursors themselves, so the members of the
new space hear of them.

Every function here runs inside the caller's transaction and under ``cursor.WRITE_LOCK``; the caller commits.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Iterable

from sqlalchemy import delete, select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from ..models import (
    MANAGER,
    Account,
    Attachment,
    Gone,
    Hidden,
    ListPref,
    Member,
    Reminder,
    Section,
    Space,
    SpacePref,
    TaskList,
    utcnow,
)
from . import cursor

logger = logging.getLogger("nextasks.spaces")

PRIVATE_NAMES = {"de": "Privat", "en": "Private"}
FIRST_LIST_NAMES = {"de": "Aufgaben", "en": "Tasks"}
FIRST_POSITION = "a0"


def language_of(account: Account) -> str:
    """``de`` or ``en`` for what the server writes for the account: its own language, else its browser's."""
    for candidate in (account.language, account.browser_language):
        if candidate and candidate.lower().startswith("de"):
            return "de"
        if candidate:
            return "en"
    return "en"


# --- Reading ----------------------------------------------------------------------------------------------------------


def role_of(db: Session, account_id: int, space_id: str) -> str | None:
    return db.scalar(select(Member.role).where(Member.space_id == space_id, Member.account_id == account_id))


def member_ids(db: Session, space_id: str) -> list[int]:
    return list(db.scalars(select(Member.account_id).where(Member.space_id == space_id).order_by(Member.account_id)))


def space_ids_of(db: Session, account_id: int) -> list[str]:
    return list(db.scalars(select(Member.space_id).where(Member.account_id == account_id).order_by(Member.space_id)))


def private_of(db: Session, account_id: int) -> Space | None:
    return db.scalar(select(Space).where(Space.private.is_(True), Space.owner_id == account_id).limit(1))


# --- Cursors ----------------------------------------------------------------------------------------------------------


def restamp(db: Session, rows: list[object]) -> None:
    """Each row a new cursor of its own, in this order."""
    if not rows:
        return
    first = cursor.take(db, len(rows))
    for offset, row in enumerate(rows):
        row.cursor = first + offset  # type: ignore[attr-defined]


def hide(db: Session, account_ids: Iterable[int], items: list[tuple[str, str]], space_id: str | None = None) -> None:
    """Tell these accounts that they do not see these things any more; ``space_id``: where they were (for API tokens
    limited to some spaces)."""
    accounts = sorted(set(account_ids))
    if not accounts or not items:
        return
    first = cursor.take(db, len(accounts) * len(items))
    now = utcnow()
    number = first
    for account_id in accounts:
        for kind, item_id in items:
            statement = sqlite_insert(Hidden).values(account_id=account_id, kind=kind, id=item_id, at=now,
                                                     cursor=number, space_id=space_id)
            db.execute(statement.on_conflict_do_update(
                index_elements=[Hidden.account_id, Hidden.kind, Hidden.id],
                set_={"cursor": statement.excluded.cursor, "at": statement.excluded.at,
                      "space_id": statement.excluded.space_id},
            ))
            number += 1


def tombstone(db: Session, kind: str, item_id: str, space_id: str, *, account_id: int = 0) -> None:
    """The thing went for good: a ``Gone`` row with a new cursor (``deleted: true`` for everybody in the space)."""
    number = cursor.take(db)
    statement = sqlite_insert(Gone).values(kind=kind, id=item_id, account_id=account_id, space_id=space_id,
                                           gone_at=utcnow(), cursor=number)
    db.execute(statement.on_conflict_do_update(
        index_elements=[Gone.kind, Gone.id, Gone.account_id],
        set_={"cursor": statement.excluded.cursor, "gone_at": statement.excluded.gone_at,
              "space_id": statement.excluded.space_id},
    ))


# --- What is inside ---------------------------------------------------------------------------------------------------


def lists_in(db: Session, space_id: str) -> list[TaskList]:
    return list(db.scalars(select(TaskList).where(TaskList.space_id == space_id).order_by(TaskList.id)))


def contents_of_list(db: Session, list_id: str) -> tuple[list[Section], list[Reminder], list[Attachment]]:
    sections = list(db.scalars(select(Section).where(Section.list_id == list_id).order_by(Section.id)))
    reminders = list(db.scalars(select(Reminder).where(Reminder.list_id == list_id).order_by(Reminder.id)))
    attachments = list(db.scalars(select(Attachment).where(
        Attachment.reminder_id.in_([row.id for row in reminders])).order_by(Attachment.id))) if reminders else []
    return sections, reminders, attachments


def items_of_space(db: Session, space_id: str, account_id: int) -> list[tuple[str, str]]:
    """Everything an account sees in a space, as ``(kind, id)``: the space, its members, lists, sections,
    reminders, attachments and the account's own list and space settings."""
    items: list[tuple[str, str]] = [("space", space_id)]
    items += [("member", f"{space_id}:{other}") for other in member_ids(db, space_id)]
    for list_row in lists_in(db, space_id):
        items.append(("list", list_row.id))
    items += [("section", row) for row in db.scalars(select(Section.id).where(Section.space_id == space_id))]
    items += [("reminder", row) for row in db.scalars(select(Reminder.id).where(Reminder.space_id == space_id))]
    items += [("attachment", row) for row in db.scalars(select(Attachment.id).where(Attachment.space_id == space_id))]
    items += [("list_pref", row) for row in db.scalars(select(ListPref.list_id).where(
        ListPref.space_id == space_id, ListPref.account_id == account_id))]
    if db.get(SpacePref, (account_id, space_id)) is not None:
        items.append(("space_pref", space_id))
    return items


# --- Members ----------------------------------------------------------------------------------------------------------


def join(db: Session, space: Space, account_id: int, role: str) -> Member:
    """The account becomes a member: it gets the whole space through ``granted_cursor`` (``/changes``); the others
    see the new member."""
    number = cursor.take(db)
    db.execute(delete(Gone).where(Gone.kind == "member", Gone.id == f"{space.id}:{account_id}"))
    member = Member(space_id=space.id, account_id=account_id, role=role, joined_at=utcnow(), granted_cursor=number,
                    cursor=number)
    db.add(member)
    space.orphaned_at = None
    db.flush()
    return member


def set_role(db: Session, member: Member, role: str) -> None:
    member.role = role
    restamp(db, [member])


def leave(db: Session, space: Space, account_id: int, *, now_ms: int, tell: bool = True) -> None:
    """The account is no member any more: it hears that everything of the space went, the others that the member
    went, and it falls out of every ``assignees`` of the space. Its reminders stay. Without members the space waits
    30 days, then it goes for good."""
    member = db.get(Member, (space.id, account_id))
    if member is None:
        return
    if tell:
        hide(db, [account_id], items_of_space(db, space.id, account_id), space.id)
    # Hidden or not was the member's own choice: whoever joins again sees the space anew.
    db.execute(delete(SpacePref).where(SpacePref.space_id == space.id, SpacePref.account_id == account_id))
    db.delete(member)
    db.flush()
    tombstone(db, "member", f"{space.id}:{account_id}", space.id)
    drop_assignees(db, space.id, {account_id}, now_ms=now_ms, everyone=False)
    if not member_ids(db, space.id):
        space.orphaned_at = utcnow()
        logger.info("Space without members, gone in 30 days space_id=%s", space.id)


def drop_assignees(db: Session, space_id: str, gone: set[int], *, now_ms: int, everyone: bool,
                   only: Iterable[Reminder] | None = None) -> list[Reminder]:
    """Takes accounts out of ``assignees`` (all of them with ``everyone``), written by the server with the clock
    ``now`` and a new cursor."""
    rows = list(only) if only is not None else list(db.scalars(select(Reminder).where(Reminder.space_id == space_id)))
    changed = []
    for row in rows:
        current = list(row.assignees or [])
        kept = [] if everyone else [person for person in current if person not in gone]
        if kept != current:
            row.assignees = kept
            clock = dict(row.clock or {})
            clock["assignees"] = max(now_ms, int(clock.get("assignees", 0)))
            row.clock = clock
            changed.append(row)
    restamp(db, changed)
    return changed


def ensure_private(db: Session, account: Account) -> Space:
    """The space "Private" of the account with its first list, made once (with the clocks 0 of defaults)."""
    found = private_of(db, account.id)
    if found is not None:
        return found
    language = language_of(account)
    space = Space(id=str(uuid.uuid4()), name=PRIVATE_NAMES[language], private=True, owner_id=account.id,
                  clock={}, created_at=utcnow())
    restamp(db, [space])
    db.add(space)
    db.flush()
    join(db, space, account.id, MANAGER)
    first = TaskList(id=str(uuid.uuid4()), space_id=space.id, name=FIRST_LIST_NAMES[language],
                     position=FIRST_POSITION, clock={}, created_at=utcnow())
    restamp(db, [first])
    db.add(first)
    db.flush()
    logger.info("Private space made account_id=%s", account.id)
    return space


def create(db: Session, account: Account, name: str) -> Space:
    """A shared space made by the server (tests, sample data): the account is its manager."""
    space = Space(id=str(uuid.uuid4()), name=name, clock={}, created_at=utcnow())
    restamp(db, [space])
    db.add(space)
    db.flush()
    join(db, space, account.id, MANAGER)
    return space


def first_list_of_private(db: Session, account_id: int) -> TaskList | None:
    space = private_of(db, account_id)
    if space is None:
        return None
    return db.scalar(select(TaskList).where(TaskList.space_id == space.id, TaskList.deleted_at.is_(None))
                     .order_by(TaskList.position, TaskList.id).limit(1))


# --- Moving between spaces --------------------------------------------------------------------------------------------


def _losing(db: Session, old_space: str, new_space: str) -> set[int]:
    return set(member_ids(db, old_space)) - set(member_ids(db, new_space))


def _assignee_rule(db: Session, new_space: str) -> tuple[set[int], bool]:
    target = db.get(Space, new_space)
    members = set(member_ids(db, new_space))
    return members, bool(target is not None and target.private)


def _filter_assignees(rows: list[Reminder], members: set[int], private: bool, now_ms: int) -> None:
    for row in rows:
        current = list(row.assignees or [])
        kept = [] if private else [person for person in current if person in members]
        if kept != current:
            row.assignees = kept
            clock = dict(row.clock or {})
            clock["assignees"] = max(now_ms, int(clock.get("assignees", 0)))
            row.clock = clock


def move_list(db: Session, list_row: TaskList, old_space: str, now_ms: int) -> None:
    """The list is in ``list_row.space_id`` now: its sections, reminders, attachments and list settings follow with
    new cursors; who saw it in the old space and is not in the new one hears it went."""
    new_space = list_row.space_id
    sections, reminders, attachments = contents_of_list(db, list_row.id)
    prefs = list(db.scalars(select(ListPref).where(ListPref.list_id == list_row.id).order_by(ListPref.account_id)))
    losing = _losing(db, old_space, new_space)
    items = [("list", list_row.id)] + [("section", row.id) for row in sections]
    items += [("reminder", row.id) for row in reminders] + [("attachment", row.id) for row in attachments]
    hide(db, losing, items, old_space)
    hide_prefs = [pref.account_id for pref in prefs if pref.account_id in losing]
    for account_id in hide_prefs:
        hide(db, [account_id], [("list_pref", list_row.id)], old_space)
    members, private = _assignee_rule(db, new_space)
    _filter_assignees(reminders, members, private, now_ms)
    for row in [*sections, *reminders, *attachments, *prefs]:
        row.space_id = new_space  # type: ignore[union-attr]
    restamp(db, [list_row, *sections, *reminders, *attachments, *prefs])


def move_reminder(db: Session, reminder: Reminder, old_list: str, old_space: str, now_ms: int) -> list[Reminder]:
    """The reminder is in ``reminder.list_id`` now: its subtasks come along (written by the server with the clock
    ``now``), its attachments follow; into another space as a list does. Returns the subtasks moved."""
    subtasks = list(db.scalars(select(Reminder).where(Reminder.parent_id == reminder.id,
                                                      Reminder.list_id == old_list).order_by(Reminder.id)))
    for row in subtasks:
        row.list_id = reminder.list_id
        clock = dict(row.clock or {})
        clock["place"] = max(now_ms, int(clock.get("place", 0)))
        row.clock = clock
    new_space = reminder.space_id
    moved = [reminder, *subtasks]
    attachments = list(db.scalars(select(Attachment).where(
        Attachment.reminder_id.in_([row.id for row in moved])).order_by(Attachment.id)))
    if new_space != old_space:
        losing = _losing(db, old_space, new_space)
        hide(db, losing, [("reminder", row.id) for row in moved] + [("attachment", row.id) for row in attachments],
             old_space)
        members, private = _assignee_rule(db, new_space)
        _filter_assignees(moved, members, private, now_ms)
        for row in [*subtasks, *attachments]:
            row.space_id = new_space
        restamp(db, attachments)
    restamp(db, subtasks)
    return subtasks

