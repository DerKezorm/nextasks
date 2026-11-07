"""Notifications (``datenmodell.md``, "Mitteilungen"; ``vertrag-block1.md``, "Mitteilungen").

* **Due with a time**: to the assignees who are members, else to whoever made it (if a member). The moment is
  ``due_date`` + ``due_time`` in the person's own ``timezone``: in the gap of summer time as much later as the gap is
  long (02:30 becomes 03:30), in the doubled hour the first time (``fold=0`` of ``zoneinfo`` gives both). The planner
  looks every half minute for moments in the last five minutes: a reminder made, assigned or changed more than five
  minutes after its moment does not ring, a new moment in the future does. Every person and moment once
  (``NotifySent``, key ``<reminder_id>:<due_date>T<due_time>``, also the ``apns-collapse-id``).
* **Assigned**: at once, to everybody newly in ``assignees`` but the account of the change; not for done reminders or
  those in the bin.
* **Changes by others** (``notify_changes`` of the list): made (without subtasks) and completed count. The first
  change opens ten minutes, at their end one notification tells all of them.

Done reminders and those in the bin (themselves, their parent, list or space) never ring. Every notification goes to
the channels the person has it on for (``services/notifyprefs.py``): the app through the relay (``services/push.py``)
and the browsers (``services/webpush.py``) are on from the start for these three, as before there were choices, and
are tried in the moment; mail is off from the start. An assignment is noted for the report "My day" as well
(``AssignedLog``).
"""

from __future__ import annotations

import asyncio
import logging
import threading
from datetime import date, datetime, time, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from ..db import SessionLocal
from ..models import Account, AssignedLog, ChangeBundle, ListPref, Member, NotifySent, Reminder, Space, TaskList
from . import channels, clock, messages, notetext, notifyprefs, push, spaces

logger = logging.getLogger("nextasks.notify")

#: How far back the planner looks: a moment more than this long past does not ring any more.
LATE = timedelta(minutes=5)
WINDOW = timedelta(minutes=10)
INTERVAL_SECONDS = 30
#: True in the tests: notifications go out within the request instead of a thread of their own.
INLINE = False

TEXTS: dict[str, dict[str, str]] = {
    "de": {
        "assigned": "{name} hat dir eine Aufgabe zugewiesen",
        "added_one": "{name} hat {n} Aufgabe hinzugefügt",
        "added_many": "{name} hat {n} Aufgaben hinzugefügt",
        "completed_one": "{name} hat {n} Aufgabe abgehakt",
        "completed_many": "{name} hat {n} Aufgaben abgehakt",
        "others_added": "{name} und andere haben {n} Aufgaben hinzugefügt",
        "others_completed": "{name} und andere haben {n} Aufgaben abgehakt",
        "mixed": "{n} Änderungen in {list}",
        "former": "Ehemaliges Mitglied",
    },
    "en": {
        "assigned": "{name} assigned a task to you",
        "added_one": "{name} added {n} task",
        "added_many": "{name} added {n} tasks",
        "completed_one": "{name} completed {n} task",
        "completed_many": "{name} completed {n} tasks",
        "others_added": "{name} and others added {n} tasks",
        "others_completed": "{name} and others completed {n} tasks",
        "mixed": "{n} changes in {list}",
        "former": "Former member",
    },
}


def _text(language: str, key: str, **values: Any) -> str:
    return TEXTS.get(language, TEXTS["en"])[key].format(**values)


def _name(db: Session, account_id: int, language: str) -> str:
    row = db.get(Account, account_id)
    return (row.display_name or row.name) if row is not None else _text(language, "former")


def in_bin(db: Session, row: Reminder) -> bool:
    if row.deleted_at is not None:
        return True
    if row.parent_id:
        parent = db.get(Reminder, row.parent_id)
        if parent is not None and parent.deleted_at is not None and parent.list_id == row.list_id:
            return True
    list_row = db.get(TaskList, row.list_id)
    space = db.get(Space, row.space_id)
    return (list_row is not None and list_row.deleted_at is not None) or (space is not None
                                                                         and space.deleted_at is not None)


def with_note(text: str, row: Reminder, language: str) -> str:
    """The text of a notification with the start of the note below it, as plain text (never Markdown)."""
    note = " ".join(notetext.plain(row.notes or "", language).split())
    return f"{text}\n{note}" if note else text


def short(message: push.Message, link: str) -> notifyprefs.Short:
    """The push of an event for the browsers and the app: the text is written in the person's language already."""

    def make(language: str) -> channels.Message:
        return channels.Message(title=message.title, text=message.text, link=link, language=language,
                                data={"type": message.type, "reminder_id": message.reminder_id,
                                      "list_id": message.list_id, "collapse": message.collapse})

    return make


def reminder_path(row: Reminder) -> str:
    return f"/lists/{row.list_id}?reminder={row.id}"


# --- Due ----------------------------------------------------------------------------------------------------------


def moment(due_date: str, due_time: str, zone_name: str) -> datetime:
    """The moment of a floating due date and time for a person (``fold=0``: the gap later, the doubled hour first)."""
    day = date.fromisoformat(due_date)
    hours, minutes = (int(part) for part in due_time.split(":"))
    return datetime.combine(day, time(hours, minutes), tzinfo=clock.zone_of(zone_name))


def recipients(db: Session, row: Reminder) -> list[int]:
    members = set(spaces.member_ids(db, row.space_id))
    wanted = [person for person in (row.assignees or []) if person in members]
    if wanted:
        return wanted
    return [row.created_by] if row.created_by in members else []


def due_round(now: datetime | None = None) -> int:
    """One look at the moments of the last five minutes. Returns how many notifications went out.
    # Vertragslücke: "more than five minutes past when made, assigned or changed" is read as "rings only within
    # five minutes after its moment"; a server that was down longer does not ring late."""
    now = now or clock.now()
    sent = 0
    with SessionLocal() as db:
        low = (now - timedelta(days=2)).date().isoformat()
        high = (now + timedelta(days=2)).date().isoformat()
        rows = list(db.scalars(select(Reminder).where(
            Reminder.due_date >= low, Reminder.due_date <= high, Reminder.due_time.is_not(None),
            Reminder.completed_at.is_(None), Reminder.deleted_at.is_(None))))
        for row in rows:
            if row.due_date is None or row.due_time is None or in_bin(db, row):
                continue
            key = f"{row.id}:{row.due_date}T{row.due_time}"
            for account_id in recipients(db, row):
                account = db.get(Account, account_id)
                if account is None or account.blocked_at is not None:
                    continue
                when = moment(row.due_date, row.due_time, account.timezone)
                if not now - LATE < when <= now:
                    continue
                taken = db.execute(sqlite_insert(NotifySent).values(account_id=account_id, key=key, sent_at=now)
                                   .on_conflict_do_nothing()).rowcount
                db.commit()
                if not taken:
                    continue
                list_row = db.get(TaskList, row.list_id)
                text = " · ".join(part for part in ((list_row.name if list_row else ""), row.due_time) if part)
                text = with_note(text, row, spaces.language_of(account))
                # Vertragslücke: the contract names no texts for ``due``; title = the reminder, text = list and time.
                pushed = push.Message(title=row.title, text=text, reminder_id=row.id, list_id=row.list_id, type="due",
                                      collapse=key)
                notifyprefs.dispatch(db, account, "due", key, _due_mail(row, list_row),
                                     short(pushed, reminder_path(row)), at_once=True)
                db.commit()
                sent += 1
    return sent


def item_of(row: Reminder, list_row: TaskList | None, base: str, who: str = "") -> messages.Item:
    return messages.Item(title=row.title, list_name=list_row.name if list_row else "",
                         link=f"{base}/lists/{row.list_id}?reminder={row.id}", due_date=row.due_date,
                         due_time=row.due_time, who=who)


def _due_mail(row: Reminder, list_row: TaskList | None) -> notifyprefs.Maker:
    def make(language: str, base: str, unsubscribe: str) -> messages.Message:
        return messages.due(language, base=base, item=item_of(row, list_row, base), unsubscribe=unsubscribe)

    return make


# --- After a change -----------------------------------------------------------------------------------------------


def _assigned(db: Session, reminder_id: str, people: list[int], actor_id: int) -> None:
    row = db.get(Reminder, reminder_id)
    if row is None or row.completed_at is not None or in_bin(db, row):
        return
    members = set(spaces.member_ids(db, row.space_id))
    for account_id in people:
        account = db.get(Account, account_id)
        if account_id == actor_id or account_id not in members or account is None or account.blocked_at:
            continue
        language = spaces.language_of(account)
        text = with_note(_text(language, "assigned", name=_name(db, actor_id, language)), row, language)
        # Vertragslücke: a collapse id is named for ``due`` only; ``assigned:<id>`` and ``changed:<list>`` here.
        pushed = push.Message(title=row.title, text=text, reminder_id=row.id, list_id=row.list_id, type="assigned",
                              collapse=f"assigned:{row.id}")
        now = clock.now()
        by = _name(db, actor_id, language)
        list_row = db.get(TaskList, row.list_id)

        def make(language: str, base: str, unsubscribe: str, by: str = by,
                 list_row: TaskList | None = list_row) -> messages.Message:
            return messages.assigned(language, base=base, by=by, item=item_of(row, list_row, base),
                                     unsubscribe=unsubscribe)

        notifyprefs.dispatch(db, account, "assigned", f"{row.id}:{int(now.timestamp() * 1000)}", make,
                             short(pushed, reminder_path(row)), at_once=True)
        db.execute(sqlite_insert(AssignedLog).values(account_id=account_id, reminder_id=row.id, at=now, by_id=actor_id)
                   .on_conflict_do_update(index_elements=["account_id", "reminder_id"],
                                          set_={"at": now, "by_id": actor_id}))
        db.commit()


def _bundle(db: Session, reminder_id: str, kind: str, actor_id: int) -> None:
    row = db.get(Reminder, reminder_id)
    if row is None:
        return
    members = set(spaces.member_ids(db, row.space_id))
    followers = db.scalars(select(ListPref.account_id).where(ListPref.list_id == row.list_id,
                                                             ListPref.notify_changes.is_(True)))
    for account_id in followers:
        if account_id == actor_id or account_id not in members:
            continue
        bundle = db.get(ChangeBundle, (account_id, row.list_id))
        event = {"by": actor_id, "type": kind, "reminder_id": row.id}
        if bundle is None:
            db.add(ChangeBundle(account_id=account_id, list_id=row.list_id, opened_at=clock.now(), events=[event]))
        else:
            bundle.events = [*list(bundle.events or []), event]
    db.commit()


def handle(events: Any, actor_id: int) -> None:
    with SessionLocal() as db:
        for reminder_id, people in events.assigned:
            _assigned(db, reminder_id, people, actor_id)
        for reminder_id in events.added:
            _bundle(db, reminder_id, "added", actor_id)
        for reminder_id in events.completed:
            _bundle(db, reminder_id, "completed", actor_id)


def after_op(events: Any, actor_id: int) -> None:
    """After an op is committed: what it means for notifications, off the request (``INLINE`` in the tests)."""
    if not (events.assigned or events.added or events.completed):
        return
    if INLINE:
        handle(events, actor_id)
        return

    def work() -> None:
        try:
            handle(events, actor_id)
        except Exception:
            logger.exception("Notifications after a change failed")

    threading.Thread(target=work, name="notify", daemon=True).start()


def bundle_text(db: Session, account: Account, list_row: TaskList | None, events: list[dict[str, Any]]) -> str:
    language = spaces.language_of(account)
    count = len(events)
    kinds = {event.get("type") for event in events}
    people = list(dict.fromkeys(int(event.get("by", 0)) for event in events))
    if len(kinds) > 1:
        return _text(language, "mixed", n=count, list=list_row.name if list_row else "")
    kind = kinds.pop() if kinds else "added"
    name = _name(db, people[0], language) if people else _text(language, "former")
    if len(people) > 1:
        return _text(language, f"others_{kind}", name=name, n=count)
    return _text(language, f"{kind}_{'one' if count == 1 else 'many'}", name=name, n=count)


def bundle_round(now: datetime | None = None) -> int:
    """Bundles whose ten minutes are over go out."""
    now = now or clock.now()
    sent = 0
    with SessionLocal() as db:
        for bundle in db.scalars(select(ChangeBundle).where(ChangeBundle.opened_at <= now - WINDOW)).all():
            account = db.get(Account, bundle.account_id)
            list_row = db.get(TaskList, bundle.list_id)
            events = list(bundle.events or [])
            db.delete(bundle)
            db.commit()
            if account is None or list_row is None or not events or account.blocked_at is not None:
                continue
            if db.get(Member, (list_row.space_id, account.id)) is None:
                continue
            text = bundle_text(db, account, list_row, events)
            pushed = push.Message(title=list_row.name, text=text, reminder_id=None, list_id=list_row.id,
                                  type="changed", collapse=f"changed:{list_row.id}")

            def make(language: str, base: str, unsubscribe: str, list_row: TaskList = list_row,
                     text: str = text) -> messages.Message:
                return messages.changed(language, base=base, list_name=list_row.name, summary=text,
                                        link=f"{base}/lists/{list_row.id}", unsubscribe=unsubscribe)

            opened = bundle.opened_at
            notifyprefs.dispatch(db, account, "changed", f"{list_row.id}:{int(opened.timestamp() * 1000)}", make,
                                 short(pushed, f"/lists/{list_row.id}"), at_once=True)
            db.commit()
            sent += 1
    return sent


async def run_forever(stop: asyncio.Event) -> None:
    while not stop.is_set():
        try:
            await asyncio.to_thread(due_round)
            await asyncio.to_thread(bundle_round)
        except Exception:
            logger.exception("The notification round failed")
        try:
            await asyncio.wait_for(stop.wait(), timeout=INTERVAL_SECONDS)
            return
        except TimeoutError:
            pass
