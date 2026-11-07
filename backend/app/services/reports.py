"""The reports: "My day" every day and "The week" once a week, at the time each person chose, in their own zone.

* **My day** (``daily``): my overdue tasks, those due today, and those newly assigned to me since the last report.
  "Mine" is whom a due task rings for (``notify.recipients``): the assignees, or whoever made it when nobody is
  assigned. Nothing in it: no mail.
* **The week** (``weekly``): everything done in the last seven days in the spaces I am in, by anybody; everything due
  in the next seven days there (today included). Nothing in it: no mail.

A report is due when its moment (day, time, for the week also the weekday, in ``Account.timezone`` or the server's)
has come and is at most ``GRACE`` old: a server that was down longer skips it rather than sending yesterday's day.
``NotifySchedule.last_period`` holds the day (``2026-11-07``) or week (``2026-W45``) made last, written in the same
transaction that queues the message (``outbox.enqueue``, unique key): after a restart nothing goes twice.

By mail a report is the full list; on the push channels (browsers, app) it is short: the title and one line ("3 due
today, 1 overdue"), and a click opens "Today".
"""

from __future__ import annotations

import logging
from datetime import date, datetime, time, timedelta

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from ..db import SessionLocal
from ..models import Account, AssignedLog, NotifyRoute, NotifySchedule, Reminder, TaskList
from . import clock, messages, notify, notifyprefs, spaces, visibility
from .channels import Message
from .messages import Item
from .records import format_stamp

logger = logging.getLogger("nextasks.notify")

GRACE = timedelta(hours=6)


def period_of(report: str, day: date) -> str:
    if report == "daily":
        return day.isoformat()
    year, week, _ = day.isocalendar()
    return f"{year}-W{week:02d}"


def moment_of(row: NotifySchedule, account: Account, now: datetime) -> tuple[datetime, str] | None:
    """The moment of the report that is due for this account right now, with its period; None when none is."""
    zone = clock.zone_of(account.timezone)
    local = now.astimezone(zone)
    hours, minutes = (int(part) for part in (row.time or "07:00").split(":"))
    for back in (0, 1):
        day = local.date() - timedelta(days=back)
        if row.report == "weekly" and day.weekday() != row.weekday:
            continue
        moment = datetime.combine(day, time(hours, minutes), tzinfo=zone)
        if moment <= local < moment + GRACE:
            return moment, period_of(row.report, day)
    return None


def _link(base: str, row: Reminder) -> str:
    return f"{base}/lists/{row.list_id}?reminder={row.id}"


def _name(db: Session, viewer_id: int, account_id: int | None, language: str) -> str:
    """The name of ``account_id`` as ``viewer_id`` may learn it (``services/visibility``); a former member for one
    deleted since or sharing no space with the reader any more."""
    row = db.get(Account, account_id) if account_id and visibility.sees(db, viewer_id, account_id) else None
    if row is None:
        return visibility.former(language)
    return row.display_name or row.name


def _open_rows(db: Session, space_ids: list[str]) -> list[Reminder]:
    if not space_ids:
        return []
    return [row for row in db.scalars(select(Reminder).where(
        Reminder.space_id.in_(space_ids), Reminder.completed_at.is_(None), Reminder.deleted_at.is_(None),
        Reminder.due_date.is_not(None))) if not notify.in_bin(db, row)]


def _order(row: Reminder) -> tuple[str, int, str, str]:
    return (row.due_date or "9999", 1 if row.due_time else 0, row.due_time or "", row.title.casefold())


def _daily_parts(db: Session, account: Account, *, base: str, today: date,
                 since: datetime) -> tuple[list[Item], list[Item], list[Item]]:
    """Overdue, due today, newly assigned since the last report."""
    language = spaces.language_of(account)
    mine = [row for row in _open_rows(db, spaces.space_ids_of(db, account.id))
            if account.id in notify.recipients(db, row)]
    day = today.isoformat()
    words = messages.words(language)
    # Newly assigned since the last report, by whom; a task that is overdue or due today shows there once, marked.
    given: dict[str, str] = {}
    for log in db.scalars(select(AssignedLog).where(AssignedLog.account_id == account.id, AssignedLog.at > since)
                          .order_by(AssignedLog.at)):
        given[log.reminder_id] = _name(db, account.id, log.by_id, language)

    def item(row: Reminder, late: bool = False) -> Item:
        by = given.get(row.id)
        return Item(title=row.title, list_name=_list_name(db, row), link=_link(base, row), due_date=row.due_date,
                    due_time=row.due_time, late=late, who=words["new_from"].format(name=by) if by else "")

    overdue = [item(row, True) for row in sorted(mine, key=_order) if (row.due_date or "") < day]
    due_today = [item(row) for row in sorted(mine, key=_order) if row.due_date == day]
    shown = {row.id for row in mine if (row.due_date or "") <= day}
    new: list[Item] = []
    for reminder_id, by in given.items():
        row = db.get(Reminder, reminder_id)
        if (row is None or reminder_id in shown or row.completed_at is not None or notify.in_bin(db, row)
                or account.id not in (row.assignees or [])):
            continue
        new.append(Item(title=row.title, list_name=_list_name(db, row), link=_link(base, row), due_date=row.due_date,
                        due_time=row.due_time, who=words["from"].format(name=by)))
    return overdue, due_today, new


def daily(db: Session, account: Account, *, base: str, today: date, since: datetime,
          unsubscribe: str) -> Message | None:
    overdue, due_today, new = _daily_parts(db, account, base=base, today=today, since=since)
    return messages.daily(spaces.language_of(account), base=base, day=today, overdue=overdue, today=due_today,
                          assigned=new, unsubscribe=unsubscribe)


def _list_name(db: Session, row: Reminder) -> str:
    found = db.get(TaskList, row.list_id)
    return found.name if found else ""


def _weekly_parts(db: Session, account: Account, *, base: str, today: date,
                  now: datetime) -> tuple[list[Item], list[Item]]:
    """Done in the last seven days, due in the next seven."""
    language = spaces.language_of(account)
    space_ids = spaces.space_ids_of(db, account.id)
    if not space_ids:
        return [], []
    words = messages.words(language)
    since = format_stamp(now - timedelta(days=7))
    done_rows = [row for row in db.scalars(select(Reminder).where(
        Reminder.space_id.in_(space_ids), Reminder.completed_at.is_not(None), Reminder.completed_at >= since,
        Reminder.deleted_at.is_(None)).order_by(Reminder.completed_at.desc())) if not notify.in_bin(db, row)]
    done = [Item(title=row.title, list_name=_list_name(db, row), link=_link(base, row),
                 who=words["done_by"].format(name=_name(db, account.id, row.completed_by, language))
                 if row.completed_by else "")
            for row in done_rows]
    last = (today + timedelta(days=6)).isoformat()
    upcoming_rows = [row for row in _open_rows(db, space_ids) if today.isoformat() <= (row.due_date or "") <= last]
    upcoming = []
    for row in sorted(upcoming_rows, key=_order):
        people = [_name(db, account.id, person, language) for person in (row.assignees or [])]
        upcoming.append(Item(title=row.title, list_name=_list_name(db, row), link=_link(base, row),
                             due_date=row.due_date, due_time=row.due_time,
                             who=words["for"].format(names=", ".join(people)) if people else ""))
    return done, upcoming


def weekly(db: Session, account: Account, *, base: str, today: date, now: datetime, unsubscribe: str) -> Message | None:
    done, upcoming = _weekly_parts(db, account, base=base, today=today, now=now)
    return messages.weekly(spaces.language_of(account), base=base, done=done, upcoming=upcoming,
                           unsubscribe=unsubscribe)


SHORT: dict[str, dict[str, str]] = {
    "de": {"daily": "Mein Tag", "weekly": "Die Woche", "today": "{n} heute fällig", "overdue": "{n} überfällig",
           "new": "{n} neu zugewiesen", "done": "{n} erledigt", "upcoming": "{n} in den nächsten 7 Tagen fällig"},
    "en": {"daily": "My day", "weekly": "The week", "today": "{n} due today", "overdue": "{n} overdue",
           "new": "{n} newly assigned", "done": "{n} done", "upcoming": "{n} due in the next 7 days"},
}


def short(db: Session, account: Account, report: str, *, now: datetime, since: datetime | None) -> Message | None:
    """The report for the push channels: title and one line, a click opens "Today" (``None``: nothing in it)."""
    language = spaces.language_of(account)
    words = SHORT.get(language, SHORT["en"])
    today = now.astimezone(clock.zone_of(account.timezone)).date()
    if report == "daily":
        overdue, due_today, new = _daily_parts(db, account, base="", today=today,
                                               since=since or now - timedelta(days=1))
        counts = (("today", len(due_today)), ("overdue", len(overdue)), ("new", len(new)))
    else:
        done, upcoming = _weekly_parts(db, account, base="", today=today, now=now)
        counts = (("done", len(done)), ("upcoming", len(upcoming)))
    line = ", ".join(words[key].format(n=count) for key, count in counts if count)
    if not line:
        return None
    return Message(title=words[report], text=line, link="/today", language=language,
                   data={"type": report, "reminder_id": None, "list_id": None, "collapse": f"{report}"})


def make(db: Session, account: Account, report: str, *, now: datetime, since: datetime | None, base: str,
         unsubscribe: str) -> Message | None:
    """The report as it would go out now (``None``: nothing in it)."""
    today = now.astimezone(clock.zone_of(account.timezone)).date()
    if report == "daily":
        return daily(db, account, base=base, today=today, since=since or now - timedelta(days=1),
                     unsubscribe=unsubscribe)
    return weekly(db, account, base=base, today=today, now=now, unsubscribe=unsubscribe)


def report_round(now: datetime | None = None) -> int:
    """Makes the reports that are due. Returns how many were queued."""
    now = now or clock.now()
    queued = 0
    with SessionLocal() as db:
        # Reports are off on every channel from the start: a stored "on" is the only way to one.
        wanted = db.execute(select(NotifyRoute.account_id, NotifyRoute.event).where(
            NotifyRoute.event.in_(notifyprefs.REPORTS), NotifyRoute.enabled.is_(True)).distinct()).all()
        for account_id, report in wanted:
            account = db.get(Account, account_id)
            if account is None or account.blocked_at is not None:
                continue
            row = notifyprefs.schedule_row(db, account_id, report)
            db.commit()
            found = moment_of(row, account, now)
            if found is None or row.last_period == found[1]:
                continue
            period = found[1]
            # Read before the claim: the update below also refreshes ``row``.
            since = row.last_at
            # Claimed in the same transaction that queues: one report per period, also with two rounds at once.
            claimed = db.execute(update(NotifySchedule).where(
                NotifySchedule.account_id == account_id, NotifySchedule.report == report,
                NotifySchedule.last_period != period).values(last_period=period, last_at=now)).rowcount
            if not claimed:
                db.rollback()
                continue

            def build(_language: str, base: str, unsubscribe: str, account: Account = account,
                      report: str = report, since: datetime | None = since) -> Message | None:
                return make(db, account, report, now=now, since=since, base=base, unsubscribe=unsubscribe)

            def brief(_language: str, account: Account = account, report: str = report,
                      since: datetime | None = since) -> Message | None:
                return short(db, account, report, now=now, since=since)

            count = notifyprefs.dispatch(db, account, report, period, build, brief)
            db.commit()
            queued += count
            logger.info("Report made report=%s account_id=%s period=%s queued=%s", report, account_id, period, count)
    return queued
