"""What ``/api/v1`` reads (``docs/api.md``): spaces, lists, tasks and the numbers of a dashboard, as a token sees them.

**What a token sees** is the intersection of two things: the spaces its account is a member of, and the spaces chosen
for the token (``Account.key_spaces``; all of them when none were chosen). Everything else answers like something
that does not exist. A space the account hid for itself (``space_pref.hidden``) is still seen; it carries
``hidden: true``, does not count in the dashboard and is never the list a task goes to by default.

**Read as the interface reads** (``datenmodell.md``, "Lesen: was gilt"; the web's ``sync/view.ts``): a parent that
has a parent itself, is missing or lies in another list counts as none; a subtask has no section; a section of another
list counts as none; time and repeat without a date count as none. A task is in the bin when it, its parent, its list
or its space is. Order as the sidebar: the own order of spaces, "Private" first, then by name; lists and sections by
their keys.

**Days** (``today``, ``overdue``, ``upcoming``) are those of the account's time zone (``Account.timezone``, else the
server's): a due date floats, it is the day the person sees on the wall.

**What changed since a moment** (``updated_since``) is told by cursors, not by the clocks of the devices: an iPhone that
ticked a task off offline yesterday and sends it today has a clock of yesterday, but a cursor of today. The moment
becomes a cursor through ``cursor.after``, a minute earlier for changes that took their cursor before and committed
after; what went comes from the tombstones (``Gone``) and from what the account no longer sees (``Hidden``).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, tzinfo
from typing import Any

from sqlalchemy import and_, func, select
from sqlalchemy.orm import Session, aliased

from ..db import sort_key
from ..models import (
    Account,
    CursorTime,
    ExternalRef,
    Gone,
    Hidden,
    Member,
    Reminder,
    Section,
    Space,
    SpacePref,
    TaskList,
)
from . import clock, notetext, records, settings_service, spaces

#: Changes that took their cursor shortly before a moment and were committed after it still count for it.
MARGIN = timedelta(minutes=1)
#: "upcoming": the days after today.
UPCOMING_DAYS = 7


@dataclass
class Sight:
    """What one token sees, and in which time zone and language its account lives."""

    account_id: int
    #: The spaces seen: member of, and chosen for the token.
    space_ids: list[str]
    #: The token's own choice; None: every space of the account, later ones too.
    chosen: frozenset[str] | None
    roles: dict[str, str]
    positions: dict[str, str | None]
    granted: dict[str, int]
    hidden: set[str]
    language: str
    zone_name: str
    zone: tzinfo

    def today(self) -> date:
        return clock.now().astimezone(self.zone).date()


def sight_of(db: Session, account: Account) -> Sight:
    """``account`` is the detached account a token acts as (``key_spaces`` set for a token limited to some)."""
    row = db.get(Account, account.id)
    assert row is not None
    chosen = account.key_spaces
    members = [member for member in db.scalars(select(Member).where(Member.account_id == account.id))
               if chosen is None or member.space_id in chosen]
    ids = sorted(member.space_id for member in members)
    hidden = set(db.scalars(select(SpacePref.space_id).where(
        SpacePref.account_id == account.id, SpacePref.hidden.is_(True), SpacePref.space_id.in_(ids)))) if ids else set()
    return Sight(
        account_id=account.id, space_ids=ids, chosen=chosen,
        roles={member.space_id: member.role for member in members},
        positions={member.space_id: member.position for member in members},
        granted={member.space_id: int(member.granted_cursor) for member in members},
        hidden=hidden, language=spaces.language_of(row), zone_name=row.timezone or clock.zone_name(),
        zone=clock.zone_of(row.timezone),
    )


@dataclass
class Task:
    """A reminder as it reads (the rules above)."""

    row: Reminder
    list_id: str
    section_id: str | None
    parent_id: str | None
    due_time: str | None
    repeat: str | None
    #: When it went into the bin (its own deletion or that of the parent, list or space); None outside.
    trashed_at: str | None = None

    @property
    def id(self) -> str:
        return self.row.id

    @property
    def open(self) -> bool:
        return self.row.completed_at is None


@dataclass
class World:
    """Everything a token sees, read once per request."""

    db: Session
    sight: Sight
    spaces: dict[str, Space] = field(default_factory=dict)
    lists: dict[str, TaskList] = field(default_factory=dict)
    sections: dict[str, Section] = field(default_factory=dict)
    tasks: dict[str, Task] = field(default_factory=dict)
    children: dict[str, list[Task]] = field(default_factory=dict)
    space_order: dict[str, int] = field(default_factory=dict)
    list_order: dict[str, int] = field(default_factory=dict)
    section_order: dict[str, int] = field(default_factory=dict)
    refs: dict[str, str] = field(default_factory=dict)
    base: str = ""
    _people: dict[int, Account | None] = field(default_factory=dict)

    # --- Reading -------------------------------------------------------------------------------------------------

    @classmethod
    def read(cls, db: Session, sight: Sight) -> World:
        world = cls(db=db, sight=sight)
        ids = sight.space_ids
        world.base = settings_service.public_url(db)
        if not ids:
            return world
        world.spaces = {row.id: row for row in db.scalars(select(Space).where(Space.id.in_(ids)))}
        world.lists = {row.id: row for row in db.scalars(select(TaskList).where(TaskList.space_id.in_(ids)))}
        world.sections = {row.id: row for row in db.scalars(select(Section).where(Section.space_id.in_(ids)))}
        raw = {row.id: row for row in db.scalars(select(Reminder).where(Reminder.space_id.in_(ids)))}
        for row in raw.values():
            if row.list_id not in world.lists:
                continue
            parent = raw.get(row.parent_id) if row.parent_id else None
            parent_id = parent.id if parent is not None and not parent.parent_id and parent.list_id == row.list_id \
                else None
            section_id = None
            if parent_id is None and row.section_id:
                section = world.sections.get(row.section_id)
                section_id = row.section_id if section is not None and section.list_id == row.list_id else None
            world.tasks[row.id] = Task(row=row, list_id=row.list_id, section_id=section_id, parent_id=parent_id,
                                       due_time=row.due_time if row.due_date else None,
                                       repeat=row.repeat if row.due_date else None)
        for task in world.tasks.values():
            task.trashed_at = world._bin_of(task)
            if task.parent_id:
                world.children.setdefault(task.parent_id, []).append(task)
        for group in world.children.values():
            group.sort(key=lambda task: (task.row.position, task.id))
        ordered = sorted(
            (space for space in world.spaces.values() if space.deleted_at is None),
            key=lambda space: (
                0 if sight.positions.get(space.id) else 1, sight.positions.get(space.id) or "",
                0 if space.private else 1, sort_key(space.name), space.id))
        world.space_order = {space.id: number for number, space in enumerate(ordered)}
        number = 0
        for space in ordered:
            for list_row in world.lists_of(space.id):
                world.list_order[list_row.id] = number
                number += 1
        for list_id in world.lists:
            for index, section in enumerate(world.sections_of(list_id)):
                world.section_order[section.id] = index
        world.refs = {reminder_id: key for reminder_id, key in db.execute(select(
            ExternalRef.reminder_id, ExternalRef.key).where(ExternalRef.account_id == sight.account_id))}
        return world

    def _bin_of(self, task: Task) -> str | None:
        if task.row.deleted_at:
            return task.row.deleted_at
        if task.parent_id:
            parent = self.tasks[task.parent_id].row if task.parent_id in self.tasks else None
            if parent is not None and parent.deleted_at:
                return parent.deleted_at
        list_row = self.lists[task.list_id]
        if list_row.deleted_at:
            return list_row.deleted_at
        space = self.spaces.get(list_row.space_id)
        return space.deleted_at if space is not None else None

    def lists_of(self, space_id: str) -> list[TaskList]:
        return sorted((row for row in self.lists.values() if row.space_id == space_id and row.deleted_at is None),
                      key=lambda row: (row.position, row.id))

    def sections_of(self, list_id: str) -> list[Section]:
        return sorted((row for row in self.sections.values() if row.list_id == list_id),
                      key=lambda row: (row.position, row.id))

    def list_shown(self, list_id: str) -> bool:
        """The list is there, outside the bin."""
        list_row = self.lists.get(list_id)
        if list_row is None or list_row.deleted_at is not None:
            return False
        space = self.spaces.get(list_row.space_id)
        return space is not None and space.deleted_at is None

    def space_of(self, task: Task) -> str:
        return self.lists[task.list_id].space_id

    def counted(self, task: Task) -> bool:
        """Open, outside the bin, and not in a space the account hid: what the dashboard counts."""
        return task.open and task.trashed_at is None and self.space_of(task) not in self.sight.hidden

    def default_list(self) -> TaskList | None:
        """Where a new task goes when no list is named, as the interface picks it: the first list of "Private",
        otherwise the first list of the first space in the sidebar; never one in a hidden space."""
        shown = sorted((space for space in self.spaces.values()
                        if space.deleted_at is None and space.id not in self.sight.hidden),
                       key=lambda space: (0 if space.private else 1, self.space_order.get(space.id, 9999)))
        for space in shown:
            found = self.lists_of(space.id)
            if found:
                return found[0]
        return None

    # --- Order ---------------------------------------------------------------------------------------------------

    def by_place(self, task: Task) -> tuple[Any, ...]:
        """By space, list, section ("without section" first), position; a subtask right under its parent."""
        anchor = self.tasks.get(task.parent_id) if task.parent_id else None
        anchor = anchor or task
        section = self.section_order.get(anchor.section_id, -1) if anchor.section_id else -1
        return (self.space_order.get(self.space_of(anchor), 9999), self.list_order.get(anchor.list_id, 99999),
                section, anchor.row.position, anchor.id, 0 if anchor is task else 1, task.row.position, task.id)

    @staticmethod
    def by_due(task: Task) -> tuple[Any, ...]:
        """Due date (none last), without a time before with one, the time, position, id."""
        row = task.row
        return (0 if row.due_date else 1, row.due_date or "", 1 if task.due_time else 0, task.due_time or "",
                row.position, row.id)

    # --- Out -----------------------------------------------------------------------------------------------------

    def person(self, account_id: int | None) -> dict[str, Any] | None:
        if account_id is None:
            return None
        if account_id not in self._people:
            self._people[account_id] = self.db.get(Account, account_id)
        row = self._people[account_id]
        if row is None:
            # An account deleted since: named as a former member by whoever shows it.
            return {"id": account_id, "name": None, "display_name": None}
        return {"id": row.id, "name": row.name, "display_name": row.display_name or row.name}

    def link(self, task: Task) -> str | None:
        return f"{self.base}/lists/{task.list_id}?task={task.id}" if self.base else None

    def updated_at(self, task: Task) -> str:
        """When the server last got a change of it (the time of its cursor); for a task from before the server
        kept those times, the newest of its clocks."""
        moment = self.db.scalar(select(CursorTime.at).where(CursorTime.cursor <= task.row.cursor)
                                .order_by(CursorTime.cursor.desc()).limit(1))
        if moment is not None:
            return records.format_stamp(moment)
        newest = max([int(value) for value in (task.row.clock or {}).values() if isinstance(value, int)] or [0])
        created = records.ms(records.parse_stamp(task.row.created_at))
        return records.format_stamp(datetime.fromtimestamp(max(newest, created) / 1000, tz=clock.now().tzinfo))

    def subtasks(self, task: Task) -> list[Task]:
        """The subtasks, without those put into the bin on their own."""
        return [child for child in self.children.get(task.id, []) if not child.row.deleted_at]

    def out(self, task: Task, *, items: bool = False) -> dict[str, Any]:
        row = task.row
        children = self.subtasks(task)
        subtasks: dict[str, Any] = {"open": sum(1 for child in children if child.open), "total": len(children)}
        if items:
            subtasks["items"] = [self.out(child) for child in children]
        return {
            "id": row.id, "list_id": task.list_id, "section_id": task.section_id, "parent_id": task.parent_id,
            "title": row.title, "notes": row.notes or "", "notes_text": notetext.plain(row.notes or "",
                                                                                     self.sight.language),
            "url": row.url, "due_date": row.due_date, "due_time": task.due_time, "repeat": task.repeat,
            "flagged": bool(row.flagged), "priority": int(row.priority or 0), "tags": list(row.tags or []),
            "assignees": [self.person(person) for person in (row.assignees or [])],
            "completed": row.completed_at is not None, "completed_at": row.completed_at,
            "completed_by": self.person(row.completed_by) if row.completed_at is not None else None,
            "trashed": task.trashed_at is not None, "trashed_at": task.trashed_at,
            "subtasks": subtasks,
            "external_ref": self.refs.get(row.id),
            "created_at": row.created_at, "updated_at": self.updated_at(task),
            "link": self.link(task),
        }


# --- Filters --------------------------------------------------------------------------------------------------------


@dataclass
class Query:
    """``GET /api/v1/tasks``: all filters, combined with "and"."""

    list_id: str | None = None
    space_id: str | None = None
    state: str | None = None
    include_trashed: bool | None = None
    due: str | None = None
    due_before: str | None = None
    due_after: str | None = None
    assigned: int | None = None
    flagged: bool | None = None
    ids: list[str] | None = None
    external_ref: str | None = None
    updated_since: datetime | None = None
    subtasks: bool = False

    @property
    def any_state(self) -> bool:
        """``ids``, ``external_ref`` and ``updated_since`` look at every state, the bin included."""
        return self.ids is not None or self.external_ref is not None or self.updated_since is not None


def _window(world: World, due: str) -> tuple[str | None, str | None, bool]:
    """``(after, until, none)`` for a ``due`` word: due date > after and <= until; ``none``: without one."""
    today = world.sight.today()
    if due == "overdue":
        return None, (today - timedelta(days=1)).isoformat(), False
    if due == "today":
        return (today - timedelta(days=1)).isoformat(), today.isoformat(), False
    if due == "upcoming":
        return today.isoformat(), (today + timedelta(days=UPCOMING_DAYS)).isoformat(), False
    return None, None, True


def due_in(world: World, task: Task, due: str) -> bool:
    after, until, none = _window(world, due)
    day = task.row.due_date
    if none:
        return day is None
    return day is not None and (after is None or day > after) and (until is None or day <= until)


def changed_since(db: Session, world: World, moment: datetime) -> tuple[set[str], list[str]]:
    """The tasks seen that changed since ``moment``, and the ids of those gone since (for good, or out of sight)."""
    sight = world.sight
    low = 0 if moment is None else _low(db, moment)

    def fresh(row: Any, space_id: str) -> bool:
        return max(int(row.cursor), sight.granted.get(space_id, 0)) > low

    changed = {task.id for task in world.tasks.values() if fresh(task.row, task.row.space_id)}
    # What went into the bin (or out of it) with its list, its space or its parent: their own change counts. Only
    # those that were ever in the bin carry a clock for it.
    moved_lists = {row.id for row in world.lists.values()
                   if fresh(row, row.space_id) and int((row.clock or {}).get("deleted_at", 0))}
    moved_spaces = {row.id for row in world.spaces.values()
                    if fresh(row, row.id) and int((row.clock or {}).get("deleted_at", 0))}
    for task in world.tasks.values():
        parent = world.tasks.get(task.parent_id) if task.parent_id else None
        if (task.list_id in moved_lists or world.space_of(task) in moved_spaces
                or (parent is not None and parent.id in changed
                    and int((parent.row.clock or {}).get("deleted_at", 0)))):
            changed.add(task.id)
    gone: list[str] = []
    if sight.space_ids:
        mine = aliased(Member)
        effective = func.max(Gone.cursor, mine.granted_cursor)
        gone += list(db.scalars(
            select(Gone.id).join(mine, and_(mine.space_id == Gone.space_id, mine.account_id == sight.account_id))
            .where(Gone.kind == "reminder", Gone.account_id == 0, Gone.space_id.in_(sight.space_ids),
                   effective > low).order_by(effective, Gone.id)))
    hidden = select(Hidden.id, Hidden.space_id).where(Hidden.account_id == sight.account_id,
                                                      Hidden.kind == "reminder", Hidden.cursor > low)
    for item_id, space_id in db.execute(hidden.order_by(Hidden.cursor, Hidden.id)):
        # A token limited to some spaces hears only of those; a row from before the space was kept says nothing.
        if sight.chosen is not None and (space_id is None or space_id not in sight.chosen):
            continue
        gone.append(item_id)
    seen = set(world.tasks)
    out: list[str] = []
    for item_id in gone:
        if item_id not in seen and item_id not in out:
            out.append(item_id)
    return changed, out


def _low(db: Session, moment: datetime) -> int:
    from . import cursor

    return cursor.after(db, moment - MARGIN)


def select_tasks(world: World, query: Query) -> tuple[list[Task], list[str]]:
    """The tasks a query finds, in order, and the ids to answer as gone."""
    tasks = list(world.tasks.values())
    gone: list[str] = []
    state = query.state or ("all" if query.any_state else "open")
    trashed = query.include_trashed if query.include_trashed is not None else query.any_state
    if query.ids is not None:
        wanted = set(query.ids)
        tasks = [task for task in tasks if task.id in wanted]
        # Gone for good, out of sight, or never there: the same answer, so that nothing tells them apart.
        gone += [item_id for item_id in query.ids if item_id not in world.tasks]
    elif not query.subtasks:
        tasks = [task for task in tasks if task.parent_id is None]
    if query.external_ref is not None:
        found = [reminder_id for reminder_id, key in world.refs.items() if key == query.external_ref]
        tasks = [task for task in tasks if task.id in found]
    if query.updated_since is not None:
        changed, went = changed_since(world.db, world, query.updated_since)
        tasks = [task for task in tasks if task.id in changed]
        gone += [item_id for item_id in went if item_id not in gone]
    if query.list_id is not None:
        tasks = [task for task in tasks if task.list_id == query.list_id]
    if query.space_id is not None:
        tasks = [task for task in tasks if world.space_of(task) == query.space_id]
    if state == "open":
        tasks = [task for task in tasks if task.open]
    elif state == "completed":
        tasks = [task for task in tasks if not task.open]
    if not trashed:
        tasks = [task for task in tasks if task.trashed_at is None]
    if query.due is not None:
        tasks = [task for task in tasks if due_in(world, task, query.due)]
    if query.due_before is not None:
        tasks = [task for task in tasks if task.row.due_date is not None and task.row.due_date < query.due_before]
    if query.due_after is not None:
        tasks = [task for task in tasks if task.row.due_date is not None and task.row.due_date > query.due_after]
    if query.assigned is not None:
        tasks = [task for task in tasks if query.assigned in (task.row.assignees or [])]
    if query.flagged:
        tasks = [task for task in tasks if task.row.flagged]
    by_due = query.due is not None or query.due_before is not None or query.due_after is not None
    tasks.sort(key=world.by_due if by_due else world.by_place)
    return tasks, gone


# --- Dashboard ------------------------------------------------------------------------------------------------------


def dashboard(world: World, limit: int) -> dict[str, Any]:
    counted = sorted((task for task in world.tasks.values() if world.counted(task)), key=world.by_due)
    me = world.sight.account_id
    groups = {name: [task for task in counted if due_in(world, task, name)]
              for name in ("overdue", "today", "upcoming")}
    return {
        "counts": {
            "overdue": len(groups["overdue"]), "today": len(groups["today"]), "upcoming": len(groups["upcoming"]),
            "assigned_to_me": sum(1 for task in counted if me in (task.row.assignees or [])),
            "flagged": sum(1 for task in counted if task.row.flagged),
            "open": len(counted),
        },
        **{name: [world.out(task) for task in found[:limit]] for name, found in groups.items()},
        "link": f"{world.base}/today" if world.base else None,
        "time_zone": world.sight.zone_name,
        "as_of": records.format_stamp(clock.now()),
    }
