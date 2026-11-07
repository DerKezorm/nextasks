"""What goes for good (``datenmodell.md``, "Papierkorb und Grabsteine").

* A space, list or reminder lies in the bin 30 days from the moment the server received its deletion
  (``trashed_at``), then it goes with everything in it. A space without members goes 30 days after the last one left.
* What goes for good leaves a tombstone (``Gone``) per thing; tombstones and hidden entries go after 90 days, and the
  cursor below which the server cannot tell what went (``oldest``) rises with them (410 ``cursor_expired``).
* The answers to ``op_id`` go after seven days, sent due notifications after three.

Every function runs under ``cursor.WRITE_LOCK`` in the caller's transaction, ``run_once`` excepted.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import timedelta

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from ..db import SessionLocal
from ..models import (
    MANAGER,
    AppOp,
    AppPairing,
    Attachment,
    ChangeBundle,
    CursorTime,
    Gone,
    Hidden,
    ListPref,
    Member,
    NotifySent,
    PageCursor,
    Reminder,
    SavedFilter,
    Space,
    SpacePref,
    TaskList,
    TilePref,
    utcnow,
)
from . import clock, cursor, files, spaces

logger = logging.getLogger("nextasks.trash")

BIN_DAYS = 30
TOMBSTONE_DAYS = 90
OP_DAYS = 7
SENT_DAYS = 3
INTERVAL_SECONDS = 3600


def _tomb(db: Session, items: list[tuple[str, str, int]], space_id: str) -> None:
    for kind, item_id, account_id in items:
        spaces.tombstone(db, kind, item_id, space_id, account_id=account_id)


def _reminder_items(db: Session, reminders: list[Reminder]) -> tuple[list[tuple[str, str, int]], set[str]]:
    ids = [row.id for row in reminders]
    attachments = list(db.scalars(select(Attachment).where(Attachment.reminder_id.in_(ids)))) if ids else []
    items = [("reminder", row.id, 0) for row in reminders] + [("attachment", row.id, 0) for row in attachments]
    return items, {row.hash for row in attachments}


def purge_reminder(db: Session, reminder: Reminder) -> None:
    """The reminder with its subtasks and attachments."""
    family = [reminder, *db.scalars(select(Reminder).where(Reminder.parent_id == reminder.id))]
    items, hashes = _reminder_items(db, family)
    for row in family:
        db.delete(row)
    db.flush()
    _tomb(db, items, reminder.space_id)
    for digest in hashes:
        files.forget_if_unused(db, digest)


def purge_list(db: Session, list_row: TaskList) -> None:
    sections, reminders, _attachments = spaces.contents_of_list(db, list_row.id)
    items, hashes = _reminder_items(db, reminders)
    items = [("list", list_row.id, 0)] + [("section", row.id, 0) for row in sections] + items
    items += [("list_pref", list_row.id, owner) for owner in db.scalars(
        select(ListPref.account_id).where(ListPref.list_id == list_row.id))]
    space_id = list_row.space_id
    db.delete(list_row)
    db.flush()
    _tomb(db, items, space_id)
    for digest in hashes:
        files.forget_if_unused(db, digest)


def purge_space(db: Session, space: Space) -> None:
    """The space with everything in it. Whoever is still a member hears it went (``Hidden``); the tombstones refuse
    further changes."""
    members = spaces.member_ids(db, space.id)
    for account_id in members:
        spaces.hide(db, [account_id], spaces.items_of_space(db, space.id, account_id), space.id)
    items: list[tuple[str, str, int]] = [("space", space.id, 0)]
    items += [("member", f"{space.id}:{account_id}", 0) for account_id in members]
    items += [("space_pref", space.id, owner) for owner in db.scalars(
        select(SpacePref.account_id).where(SpacePref.space_id == space.id))]
    hashes: set[str] = set()
    for list_row in spaces.lists_in(db, space.id):
        sections, reminders, _attachments = spaces.contents_of_list(db, list_row.id)
        found, more = _reminder_items(db, reminders)
        items += [("list", list_row.id, 0)] + [("section", row.id, 0) for row in sections] + found
        items += [("list_pref", list_row.id, owner) for owner in db.scalars(
            select(ListPref.account_id).where(ListPref.list_id == list_row.id))]
        hashes |= more
    space_id = space.id
    db.delete(space)
    db.flush()
    _tomb(db, items, space_id)
    for digest in hashes:
        files.forget_if_unused(db, digest)
    logger.info("Space gone for good space_id=%s", space_id)


def leave_with_successor(db: Session, space: Space, account_id: int) -> None:
    """The account goes; a space must keep a manager: the member who joined first becomes one."""
    member = db.get(Member, (space.id, account_id))
    if member is None:
        return
    if member.role == MANAGER:
        others = list(db.scalars(select(Member).where(Member.space_id == space.id, Member.account_id != account_id)
                                 .order_by(Member.joined_at, Member.account_id)))
        if others and not any(other.role == MANAGER for other in others):
            spaces.set_role(db, others[0], MANAGER)
    spaces.leave(db, space, account_id, now_ms=clock.now_ms(), tell=False)


def remove_account(db: Session, account_id: int) -> None:
    """Before an account is deleted: its space "Private" goes for good, it leaves every other space, its filters and
    tile settings go. Nobody else ever saw those, so no tombstone is needed; its own tombstones of filters go too."""
    for space_id in spaces.space_ids_of(db, account_id):
        space = db.get(Space, space_id)
        if space is None:
            continue
        if space.private and space.owner_id == account_id:
            db.execute(delete(Member).where(Member.space_id == space.id))
            purge_space(db, space)
        else:
            leave_with_successor(db, space, account_id)
    # Gone by the foreign keys as well; said here, so that it does not hang on PRAGMA foreign_keys.
    db.execute(delete(SavedFilter).where(SavedFilter.account_id == account_id))
    db.execute(delete(TilePref).where(TilePref.account_id == account_id))
    db.execute(delete(Gone).where(Gone.kind == "filter", Gone.account_id == account_id))
    db.flush()


def run_once() -> None:
    now = utcnow()
    limit = now - timedelta(days=BIN_DAYS)
    with cursor.WRITE_LOCK, SessionLocal() as db:
        for space in db.scalars(select(Space).where((Space.trashed_at < limit) | (Space.orphaned_at < limit))):
            purge_space(db, space)
        for list_row in db.scalars(select(TaskList).where(TaskList.trashed_at < limit)):
            purge_list(db, list_row)
        for reminder in db.scalars(select(Reminder).where(Reminder.trashed_at < limit)):
            if db.get(Reminder, reminder.id) is not None:
                purge_reminder(db, reminder)
        old = now - timedelta(days=TOMBSTONE_DAYS)
        highest = max(
            int(db.scalar(select(func.coalesce(func.max(Gone.cursor), 0)).where(Gone.gone_at < old)) or 0),
            int(db.scalar(select(func.coalesce(func.max(Hidden.cursor), 0)).where(Hidden.at < old)) or 0),
        )
        if highest:
            cursor.raise_oldest(db, highest)
            db.execute(delete(Gone).where(Gone.gone_at < old))
            db.execute(delete(Hidden).where(Hidden.at < old))
        # The times of cursors as long as tombstones: an older ``updated_since`` gets everything there is.
        db.execute(delete(CursorTime).where(CursorTime.at < old))
        db.execute(delete(AppOp).where(AppOp.created_at < now - timedelta(days=OP_DAYS)))
        db.execute(delete(PageCursor).where(PageCursor.issued_at < now - timedelta(days=1)))
        db.execute(delete(NotifySent).where(NotifySent.sent_at < now - timedelta(days=SENT_DAYS)))
        db.execute(delete(AppPairing).where(AppPairing.expires_at < now - timedelta(days=1)))
        db.execute(delete(ChangeBundle).where(ChangeBundle.opened_at < now - timedelta(days=1)))
        db.commit()
        files.sweep(db)
    cursor.touched_everybody()


async def run_forever(stop: asyncio.Event) -> None:
    while not stop.is_set():
        try:
            await asyncio.to_thread(run_once)
        except Exception:
            logger.exception("Emptying the bin failed")
        try:
            await asyncio.wait_for(stop.wait(), timeout=INTERVAL_SECONDS)
            return
        except TimeoutError:
            pass
