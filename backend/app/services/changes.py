"""``/changes``: what an account sees that changed since a cursor (``vertrag-block1.md``, "Abgleich: holen").

**The cursor of a thing for an account** is ``max(cursor, granted_cursor)`` of the account in the thing's space: a
member who joins gets the whole space at the cursor of its joining, without anything being renumbered. Sorted and paged
by that.

**Ties.** Everything a member found in a space when joining has the same cursor for it. A page never ends inside such a
group: it takes the whole group, even when that makes it longer than ``limit``, so that ``since=<cursor>`` never skips
a part of it. # Vertragslücke: the contract pages by ``max(cursor, granted_cursor)`` and promises that paging does not
break; with equal values that only holds when a page may run over ``limit`` at the end of such a group.

**A cursor handed out with** ``more: true`` is remembered for a day (``PageCursor``): asking on with it never answers
410, even when tombstones were cleared away meanwhile (a fetch with ``since=0`` can always page to its end).

**What went** comes from ``Gone`` (for whoever is in the space it was in) and ``Hidden`` (for one account), both only
for ``since > 0``: ``since=0`` is everything there is.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from sqlalchemy import and_, func, or_, select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session, aliased

from ..models import (
    Account,
    Attachment,
    Gone,
    Hidden,
    ListPref,
    Member,
    PageCursor,
    Reminder,
    Section,
    Space,
    SpacePref,
    TaskList,
    utcnow,
)
from . import cursor, records, visibility

DEFAULT_LIMIT = 500
MAX_LIMIT = 1000
#: The order of kinds within the same cursor (a space before its lists, a list before its reminders).
KIND_ORDER = {kind: number for number, kind in enumerate(records.KINDS)}


class Expired(Exception):
    """``since`` is older than what the server still knows, or newer than its cursor (410 ``cursor_expired``)."""


@dataclass
class Item:
    cursor: int
    kind: str
    id: str
    row: Any = None
    deleted: bool = False


_MODELS: dict[str, Any] = {
    "list": TaskList,
    "section": Section,
    "reminder": Reminder,
    "attachment": Attachment,
    "list_pref": ListPref,
    "space_pref": SpacePref,
}


def granted(db: Session, account_id: int) -> dict[str, int]:
    """The account's spaces with their ``granted_cursor``."""
    return dict(db.execute(select(Member.space_id, Member.granted_cursor).where(Member.account_id == account_id)).all())


def _live(db: Session, account_id: int, low: int, high: int, limit: int | None) -> list[Item]:
    mine = aliased(Member)
    found: list[Item] = []

    def run(kind: str, model: Any, space_column: Any, *extra: Any) -> None:
        effective = func.max(model.cursor, mine.granted_cursor)
        query = (select(model, effective.label("eff"))
                 .join(mine, and_(mine.space_id == space_column, mine.account_id == account_id))
                 .where(effective > low, effective <= high, *extra).order_by(effective))
        if limit is not None:
            query = query.limit(limit)
        for row, eff in db.execute(query):
            found.append(Item(int(eff), kind, records.entry_id(kind, row), row))

    run("space", Space, Space.id)
    others = aliased(Member)
    effective = func.max(others.cursor, mine.granted_cursor)
    query = (select(others, effective.label("eff"))
             .join(mine, and_(mine.space_id == others.space_id, mine.account_id == account_id))
             .where(effective > low, effective <= high).order_by(effective))
    if limit is not None:
        query = query.limit(limit)
    for row, eff in db.execute(query):
        found.append(Item(int(eff), "member", records.entry_id("member", row), row))
    for kind, model in _MODELS.items():
        extra = [model.account_id == account_id] if kind in records.PREF_KINDS else []
        run(kind, model, model.space_id, *extra)
    return found


def _went(db: Session, account_id: int, low: int, high: int, limit: int | None) -> list[Item]:
    mine = aliased(Member)
    effective = func.max(Gone.cursor, mine.granted_cursor)
    query = (select(Gone, effective.label("eff"))
             .join(mine, and_(mine.space_id == Gone.space_id, mine.account_id == account_id))
             .where(effective > low, effective <= high, or_(Gone.account_id == 0, Gone.account_id == account_id))
             .order_by(effective))
    if limit is not None:
        query = query.limit(limit)
    found = [Item(int(eff), row.kind, row.id, deleted=True) for row, eff in db.execute(query)]
    # A private space goes with its account only; anything else that went for everybody in a space the account
    # left meanwhile it heard of through ``Hidden``. Its own list and space settings it hears of wherever they were.
    own = select(Gone).where(Gone.account_id == account_id, Gone.cursor > low, Gone.cursor <= high,
                             Gone.space_id.not_in(select(Member.space_id).where(Member.account_id == account_id)))
    found += [Item(row.cursor, row.kind, row.id, deleted=True) for row in db.scalars(own)]
    query_hidden = (select(Hidden).where(Hidden.account_id == account_id, Hidden.cursor > low, Hidden.cursor <= high)
                    .order_by(Hidden.cursor))
    if limit is not None:
        query_hidden = query_hidden.limit(limit)
    found += [Item(row.cursor, row.kind, row.id, deleted=True) for row in db.scalars(query_hidden)]
    return found


def _gather(db: Session, account_id: int, low: int, high: int, limit: int | None) -> list[Item]:
    items = _live(db, account_id, low, high, limit)
    if low > 0:
        items += _went(db, account_id, low, high, limit)
    items.sort(key=lambda item: (item.cursor, KIND_ORDER.get(item.kind, 99), item.id))
    return items


def has_news(db: Session, account_id: int, since: int) -> bool:
    last, _oldest = cursor.state(db)
    return since < last and bool(_gather(db, account_id, since, last, 1))


@dataclass
class Page:
    cursor: int
    more: bool
    space_ids: list[str]
    people: list[dict[str, Any]]
    items: list[dict[str, Any]]


def page(db: Session, account_id: int, since: int, limit: int = DEFAULT_LIMIT) -> Page:
    last, oldest = cursor.state(db)
    if since and (since > last or (since < oldest and db.get(PageCursor, (account_id, since)) is None)):
        raise Expired
    spaces = granted(db, account_id)
    items = _gather(db, account_id, since, last, limit + 1)
    more = len(items) > limit
    if more:
        end = items[limit - 1].cursor
        items = _gather(db, account_id, since, end, None)
        next_cursor = end
        db.execute(sqlite_insert(PageCursor).values(account_id=account_id, cursor=end, issued_at=utcnow())
                   .on_conflict_do_nothing())
        db.commit()
    else:
        next_cursor = last
    # Of one thing only the newest state.
    newest: dict[tuple[str, str], Item] = {}
    for item in items:
        newest[(item.kind, item.id)] = item
    chosen = sorted(newest.values(), key=lambda item: (item.cursor, KIND_ORDER.get(item.kind, 99), item.id))
    roles = dict(db.execute(select(Member.space_id, Member.role).where(Member.account_id == account_id)).all())
    out = []
    for item in chosen:
        if item.deleted:
            out.append(records.deleted_entry(item.kind, item.id, item.cursor))
        elif item.kind == "space":
            out.append(records.entry("space", item.row, item.cursor, role=roles.get(item.row.id)))
        elif item.kind == "member":
            out.append(records.entry("member", item.row, item.cursor, own_member=item.row.account_id == account_id))
        else:
            out.append(records.entry(item.kind, item.row, item.cursor))
    return Page(cursor=next_cursor, more=more, space_ids=sorted(spaces), people=people(db, account_id, spaces),
                items=out)


def people(db: Session, account_id: int, spaces: dict[str, int] | None = None) -> list[dict[str, Any]]:
    """The account itself, everybody it shares a space with, and every account named in ``created_by``,
    ``completed_by`` or ``assignees`` of what it sees. Name and picture only of the first two
    (``services/visibility``): one named in what it sees but sharing no space with it any more is given like a
    deleted account, ``name`` and ``avatar_hash`` null (a former member)."""
    spaces = granted(db, account_id) if spaces is None else spaces
    space_ids = list(spaces)
    wanted: set[int] = {account_id}
    if space_ids:
        wanted |= set(db.scalars(select(Member.account_id).where(Member.space_id.in_(space_ids))))
        for created, completed, assignees in db.execute(
            select(Reminder.created_by, Reminder.completed_by, Reminder.assignees)
            .where(Reminder.space_id.in_(space_ids))
        ):
            wanted |= {value for value in (created, completed) if isinstance(value, int)}
            wanted |= {value for value in assignees or [] if isinstance(value, int)}
        wanted |= {value for value in db.scalars(select(Attachment.created_by).where(
            Attachment.space_id.in_(space_ids))) if isinstance(value, int)}
    seen = visibility.seen_by(db, account_id)
    known = {row.id: row for row in db.scalars(select(Account).where(Account.id.in_(wanted & seen)))}
    return [
        {"id": person, "name": (known[person].display_name or known[person].name) if person in known else None,
         "avatar_hash": (known[person].avatar_hash or None) if person in known else None}
        for person in sorted(wanted)
    ]


def entry_for(db: Session, account_id: int, kind: str, row: Any) -> dict[str, Any] | None:
    """A thing as ``/changes`` would give it to this account now, or None when the account does not see it."""
    if row is None:
        return None
    space_id = row.id if kind == "space" else row.space_id
    member = db.get(Member, (space_id, account_id))
    if member is None:
        return None
    if kind in records.PREF_KINDS and row.account_id != account_id:
        return None
    effective = max(int(row.cursor), int(member.granted_cursor))
    if kind == "space":
        return records.entry("space", row, effective, role=member.role)
    if kind == "member":
        return records.entry("member", row, effective, own_member=row.account_id == account_id)
    return records.entry(kind, row, effective)


def gone_entry(db: Session, account_id: int, kind: str, item_id: str) -> dict[str, Any] | None:
    found = db.scalar(select(Gone).where(Gone.kind == kind, Gone.id == item_id,
                                         Gone.account_id.in_([0, account_id])).order_by(Gone.cursor.desc()).limit(1))
    return records.deleted_entry(kind, item_id, found.cursor) if found is not None else None
