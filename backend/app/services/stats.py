"""The review ("Rückblick"): numbers from the record of completions (``services/completions.py``) for the web page,
the right column of "Today", the weekly mail and ``/api/v1/stats/summary``.

**Rights.** Every number comes from the spaces the viewer is a member of (for a token: those it may see), never from a
space in the bin; a space "Private" has only its owner as member. Names follow ``services/visibility.py``: somebody
who shares no space with the viewer any more counts as a former member (``id`` null), like an account deleted since.

**Counting.** A completion is one task done: subtasks done along with their task are not counted (their row has a
``parent_id``). Days, weeks, hours and "today" are the viewer's, in the account's time zone (as the reports).
"Late" and "on time" were settled when it was done, in the zone of whoever did it: on time is on or before the due day.

**Series** (the pulse of repeating tasks). A repeating reminder that is still there (not in the bin) with the rows of
its completed copies. Each slot is an occurrence: ``on_time`` or ``late`` when it was done; ``skipped`` when the series
passed it without anybody doing it. Skipped is only told for rules that repeat from the due date (fixed
occurrences): every occurrence the rule gives after a done one and before the next done one (or before the
occurrence that is open now) was skipped; the series moved on over it, by hand or by being done later. A rule that
repeats from completion has no fixed occurrences, so nothing of it is ever skipped.
"""

from __future__ import annotations

import re
import statistics
import unicodedata
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, tzinfo
from itertools import pairwise
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Account, Completion, Member, Reminder, Section, Space, TaskList
from . import clock, records, spaces, visibility, wiederholung
from .messages import WEEKDAY_NAMES

HEATMAP_DAYS = 371
SUMMARY_DAYS = 365
PULSE_SLOTS = 16
PULSE_SERIES = 24
LONG_OPEN_DAYS = 30
STALE_DAYS = 14
STEADY_DAYS = 28
STEADY_MIN = 3
MILESTONES = (100, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000)
RANGES = {"week": 7, "month": 30, "year": 365}


# --- Who looks, at what ----------------------------------------------------------------------------------------------


@dataclass
class Scope:
    viewer_id: int
    language: str
    zone: tzinfo
    zone_name: str
    today: date
    #: The spaces counted: of the viewer, not in the bin, in the order of their names.
    spaces: list[Space]
    #: ``all`` or the one space asked for.
    wanted: str
    #: Members per space.
    members: dict[str, set[int]]
    #: Whose name the viewer may learn.
    seen: set[int]

    @property
    def space_ids(self) -> list[str]:
        return [space.id for space in self.spaces]

    @property
    def alone(self) -> bool:
        """No space counted has another member: the parts about other people are left out."""
        return all(members <= {self.viewer_id} for members in self.members.values())

    def person(self, account_id: int | None) -> int | None:
        """The id as the viewer may learn it; None for a former member."""
        return account_id if account_id is not None and account_id in self.seen else None

    def local(self, stamp: str) -> datetime:
        return records.parse_stamp(stamp).astimezone(self.zone)


def scope_of(db: Session, account_id: int, wanted: str = "all", allowed: list[str] | None = None, *,
             today: date | None = None) -> Scope | None:
    """The scope of ``account_id``: every space it is in (``allowed``: of those, only these), or one of them.
    None when the one asked for is not there for it. ``today``: the account's day (a report made for a moment)."""
    account = db.get(Account, account_id)
    assert account is not None
    ids = set(spaces.space_ids_of(db, account_id))
    if allowed is not None:
        ids &= set(allowed)
    rows = [row for row in (db.get(Space, space_id) for space_id in ids) if row is not None and row.deleted_at is None]
    if wanted != "all":
        rows = [row for row in rows if row.id == wanted]
        if not rows:
            return None
    rows.sort(key=lambda row: (not row.private, row.name.casefold(), row.id))
    members: dict[str, set[int]] = {row.id: set() for row in rows}
    if rows:
        for space_id, member in db.execute(select(Member.space_id, Member.account_id)
                                           .where(Member.space_id.in_(list(members)))):
            members[space_id].add(member)
    zone = clock.zone_of(account.timezone)
    return Scope(viewer_id=account_id, language=spaces.language_of(account), zone=zone,
                 zone_name=account.timezone or clock.zone_name(), today=today or clock.now().astimezone(zone).date(),
                 spaces=rows, wanted=wanted, members=members, seen=visibility.seen_by(db, account_id))


@dataclass
class Done:
    """One counted completion, read in the viewer's zone."""

    row: Completion
    at: datetime
    person: int | None

    @property
    def day(self) -> date:
        return self.at.date()


@dataclass
class Data:
    """What the numbers are made of: the completions of the scope (oldest first), the open tasks, the lists."""

    scope: Scope
    done: list[Done]
    open: list[Reminder]
    #: Tasks put in the bin without being done (they left their list all the same).
    binned: list[Reminder]
    lists: dict[str, TaskList | None] = field(default_factory=dict)

    def done_between(self, first: date, last: date) -> list[Done]:
        return [item for item in self.done if first <= item.day <= last]


def load(db: Session, scope: Scope) -> Data:
    ids = scope.space_ids
    if not ids:
        return Data(scope, [], [], [])
    rows = db.scalars(select(Completion).where(Completion.space_id.in_(ids), Completion.parent_id.is_(None))
                      .order_by(Completion.completed_at, Completion.id))
    done = [Done(row, scope.local(row.completed_at), scope.person(row.completed_by)) for row in rows]
    lists = {row.id: row for row in db.scalars(select(TaskList).where(TaskList.space_id.in_(ids)))}
    binned_lists = {list_id for list_id, row in lists.items() if row.deleted_at is not None}
    open_rows: list[Reminder] = []
    binned: list[Reminder] = []
    for row in db.scalars(select(Reminder).where(Reminder.space_id.in_(ids), Reminder.parent_id.is_(None),
                                                 Reminder.completed_at.is_(None))):
        if row.deleted_at is not None or row.list_id in binned_lists:
            binned.append(row)
        else:
            open_rows.append(row)
    for item in done:
        lists.setdefault(item.row.list_id, None)
    return Data(scope, done, open_rows, binned, lists)


# --- Pieces ----------------------------------------------------------------------------------------------------------


def _pct(part: int, whole: int) -> float | None:
    return round(100 * part / whole, 1) if whole else None


def _days(first: date, last: date) -> list[date]:
    return [first + timedelta(days=offset) for offset in range((last - first).days + 1)]


def _runs(days: set[date]) -> list[tuple[date, date]]:
    """Runs of consecutive days, oldest first."""
    out: list[tuple[date, date]] = []
    for day in sorted(days):
        if out and out[-1][1] == day - timedelta(days=1):
            out[-1] = (out[-1][0], day)
        else:
            out.append((day, day))
    return out


def streak(done: list[Done], today: date) -> dict[str, Any]:
    """Days with at least one completion: the run that is still alive (it may end today or yesterday: today is not
    over) and the longest ever."""
    runs = _runs({item.day for item in done})
    current = next((run for run in reversed(runs) if run[1] in (today, today - timedelta(days=1))), None)
    best = max(runs, key=lambda run: ((run[1] - run[0]).days, run[1]), default=None)
    return {
        "current": (current[1] - current[0]).days + 1 if current else 0,
        "since": current[0].isoformat() if current else None,
        "done_today": bool(current and current[1] == today),
        "record": (best[1] - best[0]).days + 1 if best else 0,
        "record_from": best[0].isoformat() if best else None,
        "record_to": best[1].isoformat() if best else None,
    }


def daily_counts(done: list[Done], first: date, last: date) -> list[int]:
    per_day = Counter(item.day for item in done if first <= item.day <= last)
    return [per_day.get(day, 0) for day in _days(first, last)]


def _list_brief(data: Data, list_id: str) -> dict[str, Any]:
    row = data.lists.get(list_id)
    return {"id": list_id, "name": row.name if row else None, "color": row.color if row else None,
            "icon": row.icon if row else None, "space_id": row.space_id if row else None,
            "deleted": row is None or row.deleted_at is not None}


def people(db: Session, data: Data) -> list[dict[str, Any]]:
    """Everybody the numbers may name: the members of the spaces counted and whoever completed something there."""
    scope = data.scope
    ids = {person for members in scope.members.values() for person in members}
    ids |= {item.row.completed_by for item in data.done if item.row.completed_by is not None}
    shown = {scope.person(person) for person in ids}
    out = []
    for person in sorted(item for item in shown if item is not None):
        account = db.get(Account, person)
        if account is None:
            shown.add(None)
            continue
        out.append({"id": person, "name": account.display_name or account.name, "me": person == scope.viewer_id,
                    "former": False})
    out.sort(key=lambda entry: (not entry["me"], entry["name"].casefold()))
    if None in shown:
        out.append({"id": None, "name": visibility.former(scope.language), "me": False, "former": True})
    return out


def _duration_days(item: Done) -> float | None:
    """Made to done, in days; only for tasks that never repeated (a copy carries the original's moment of making)."""
    if item.row.series_id is not None or not item.row.created_at:
        return None
    seconds = (records.parse_stamp(item.row.completed_at) - records.parse_stamp(item.row.created_at)).total_seconds()
    return max(seconds, 0) / 86400


def records_of(done: list[Done], today: date) -> dict[str, Any]:
    """Best day, best week (Monday to Sunday), longest run, the milestones reached and the next one."""
    per_day = Counter(item.day for item in done)
    best_day = max(per_day.items(), key=lambda pair: (pair[1], pair[0]), default=None)
    per_week = Counter(item.day - timedelta(days=item.day.weekday()) for item in done)
    best_week = max(per_week.items(), key=lambda pair: (pair[1], pair[0]), default=None)
    run = streak(done, today)
    total = len(done)
    reached = [{"count": mark, "date": done[mark - 1].day.isoformat()} for mark in MILESTONES if mark <= total]
    upcoming = next((mark for mark in MILESTONES if mark > total), None)
    return {
        "total": total,
        "best_day": {"date": best_day[0].isoformat(), "count": best_day[1]} if best_day else None,
        "best_week": {"from": best_week[0].isoformat(), "to": (best_week[0] + timedelta(days=6)).isoformat(),
                      "count": best_week[1]} if best_week else None,
        "longest_streak": {"days": run["record"], "from": run["record_from"], "to": run["record_to"]}
        if run["record"] else None,
        "milestones": reached,
        "next_milestone": {"count": upcoming, "missing": upcoming - total} if upcoming else None,
    }


# --- The pulse of repeating tasks ------------------------------------------------------------------------------------


_END = re.compile(r";?(COUNT|UNTIL)=[^;]*")


def _occurrences_after(rule: str, start: str, before: str, limit: int) -> list[str]:
    """The occurrences the rule gives after ``start`` and before ``before`` (repeating from the due date), at most
    ``limit`` (the latest ones)."""
    endless = _END.sub("", rule)
    out: list[str] = []
    current = start
    for _ in range(2000):
        try:
            following = wiederholung.next_due(endless, "due", current, None)
        except ValueError:
            return []
        if following is None:
            break
        current = following.isoformat()
        if current >= before:
            break
        out.append(current)
    return out[-limit:]


def pulse(data: Data) -> list[dict[str, Any]]:
    scope = data.scope
    by_series: dict[str, list[Done]] = defaultdict(list)
    for item in data.done:
        if item.row.series_id:
            by_series[item.row.series_id].append(item)
    out = []
    for original in data.open:
        if not original.repeat:
            continue
        logged = sorted(by_series.get(original.id, []), key=lambda item: (item.row.due_date or "", item.at))
        slots: list[dict[str, Any]] = []
        fixed = original.repeat_from == "due"
        for index, item in enumerate(logged):
            if fixed and index > 0 and logged[index - 1].row.due_date and item.row.due_date:
                for day in _occurrences_after(original.repeat, logged[index - 1].row.due_date or "",
                                              item.row.due_date or "", PULSE_SLOTS):
                    slots.append({"due_date": day, "status": "skipped", "by": None, "done_on": None})
            slots.append({"due_date": item.row.due_date, "status": "late" if item.row.on_time is False else "on_time",
                          "by": item.person, "done_on": item.day.isoformat()})
        if fixed and logged and logged[-1].row.due_date and original.due_date:
            for day in _occurrences_after(original.repeat, logged[-1].row.due_date or "", original.due_date,
                                          PULSE_SLOTS):
                slots.append({"due_date": day, "status": "skipped", "by": None, "done_on": None})
        last_activity = logged[-1].at.isoformat() if logged else ""
        out.append({
            "series_id": original.id, "title": original.title, "list": _list_brief(data, original.list_id),
            "repeat": original.repeat, "repeat_from": original.repeat_from, "slots": slots[-PULSE_SLOTS:],
            "next": {"due_date": original.due_date, "due_time": original.due_time,
                     "overdue": bool(original.due_date and original.due_date < scope.today.isoformat())},
            "_last": last_activity,
        })
    out.sort(key=lambda entry: (entry["_last"], entry["title"].casefold()), reverse=True)
    for entry in out:
        del entry["_last"]
    return out[:PULSE_SERIES]


# --- The week in sentences -------------------------------------------------------------------------------------------


def _emptied(data: Data, first: date, last: date) -> list[dict[str, Any]]:
    """How often each list became empty in these days by a completion: every task the server knows of counts from
    its making until it was done or put in the bin."""
    events: dict[str, list[tuple[datetime, int, bool]]] = defaultdict(list)
    for item in data.done:
        # Never made after it was done (a clock that was off, a task brought in already done).
        made = min(data.scope.local(item.row.created_at), item.at) if item.row.created_at else item.at
        events[item.row.list_id].append((made, 1, False))
        events[item.row.list_id].append((item.at, -1, True))
    for row in data.open:
        events[row.list_id].append((data.scope.local(row.created_at), 1, False))
    for row in data.binned:
        if row.deleted_at:
            events[row.list_id].append((data.scope.local(row.created_at), 1, False))
            events[row.list_id].append((data.scope.local(row.deleted_at), -1, False))
    out = []
    for list_id, happened in events.items():
        level = 0
        times = 0
        # Made before done at the same moment: a list that gains and loses at once is not empty.
        for moment, step, by_completion in sorted(happened, key=lambda event: (event[0], -event[1])):
            level += step
            if level == 0 and by_completion and first <= moment.date() <= last:
                times += 1
        if times:
            out.append({"list": _list_brief(data, list_id), "times": times})
    out.sort(key=lambda entry: (-entry["times"], entry["list"]["name"] or ""))
    return out


def week_facts(data: Data) -> dict[str, Any]:
    """The last seven days before today, against the seven before them."""
    scope = data.scope
    last = scope.today - timedelta(days=1)
    first = last - timedelta(days=6)
    week = data.done_between(first, last)
    before = data.done_between(first - timedelta(days=7), first - timedelta(days=1))
    per_day = Counter(item.day for item in week)
    strongest = max(per_day.items(), key=lambda pair: (pair[1], pair[0]), default=None)
    by_list: dict[str, list[Done]] = defaultdict(list)
    for item in week:
        by_list[item.row.list_id].append(item)
    lists = []
    for list_id, items in sorted(by_list.items(), key=lambda pair: -len(pair[1])):
        counted = Counter(item.person for item in items)
        lists.append({"list": _list_brief(data, list_id), "count": len(items),
                      "people": [{"id": person, "count": count} for person, count in counted.most_common()]})
    steady = []
    if not scope.alone:
        recent: dict[str, list[Done]] = defaultdict(list)
        for item in data.done_between(scope.today - timedelta(days=STEADY_DAYS), last):
            if item.row.series_id:
                recent[item.row.series_id].append(item)
        for items in recent.values():
            who = {item.person for item in items}
            if len(items) >= STEADY_MIN and len(who) == 1 and None not in who:
                steady.append({"title": items[-1].row.title, "person": items[-1].person, "count": len(items),
                               "days": STEADY_DAYS})
    long_open = sorted(
        ({"id": row.id, "title": row.title, "list": _list_brief(data, row.list_id),
          "days": (scope.today - scope.local(row.created_at).date()).days}
         for row in data.open if not row.repeat),
        key=lambda entry: -entry["days"])
    titles: dict[str, list[Done]] = defaultdict(list)
    for item in week:
        # What is bought or done again by choice: a repeating task comes back by its rule anyway.
        if item.row.series_id is None:
            titles[title_key(item.row.title)].append(item)
    frequent = sorted(({"title": plain_title(items[-1].row.title), "count": len(items)}
                       for items in titles.values() if len(items) >= 2), key=lambda entry: -entry["count"])
    return {
        "from": first.isoformat(), "to": last.isoformat(),
        "count": len(week), "previous": len(before), "difference": len(week) - len(before),
        "strongest_day": {"date": strongest[0].isoformat(), "weekday": strongest[0].weekday(),
                          "count": strongest[1]} if strongest else None,
        "lists": lists,
        "steady": steady,
        "long_open": [entry for entry in long_open if entry["days"] > LONG_OPEN_DAYS][:5],
        "emptied": _emptied(data, first, last),
        "frequent": frequent[:5],
    }


SENTENCES: dict[str, dict[str, str]] = {
    "de": {
        "count_one": "1 Aufgabe erledigt", "count": "{n} Aufgaben erledigt",
        "mine_one": "Du hast 1 Aufgabe erledigt", "mine": "Du hast {n} Aufgaben erledigt",
        "more": "{head}, {d} mehr als in der Woche davor.", "fewer": "{head}, {d} weniger als in der Woche davor.",
        "same": "{head}, genauso viele wie in der Woche davor.", "plain": "{head}.",
        "none": "In dieser Woche wurde nichts erledigt.", "none_mine": "Du hast in dieser Woche nichts erledigt.",
        "strongest": "Der stärkste Tag war {day} mit {n}.", "strongest_mine": "Dein stärkster Tag war {day} mit {n}.",
        "took": "{name} hat {k} von {n} in „{list}“ übernommen.",
        "steady": "„{title}“ ist seit vier Wochen fest bei {name}.",
        "open_one": "„{a}“ ist seit {da} Tagen offen. Verschieben oder streichen?",
        "open_two": "„{a}“ ist seit {da} Tagen offen, „{b}“ seit {db}. Verschieben oder streichen?",
        "emptied_one": "„{list}“ wurde einmal ganz abgehakt.", "emptied": "„{list}“ wurde {n}-mal ganz abgehakt.",
        "frequent": "Am häufigsten: {titles}.",
    },
    "en": {
        "count_one": "1 task done", "count": "{n} tasks done",
        "mine_one": "You did 1 task", "mine": "You did {n} tasks",
        "more": "{head}, {d} more than the week before.", "fewer": "{head}, {d} fewer than the week before.",
        "same": "{head}, as many as the week before.", "plain": "{head}.",
        "none": "Nothing was done this week.", "none_mine": "You did nothing this week.",
        "strongest": "The strongest day was {day} with {n}.",
        "strongest_mine": "Your strongest day was {day} with {n}.",
        "took": "{name} took {k} of {n} in “{list}”.",
        "steady": "“{title}” has been with {name} for four weeks.",
        "open_one": "“{a}” has been open for {da} days. Move it or drop it?",
        "open_two": "“{a}” has been open for {da} days, “{b}” for {db}. Move them or drop them?",
        "emptied_one": "“{list}” was ticked off completely once.",
        "emptied": "“{list}” was ticked off completely {n} times.",
        "frequent": "Most often: {titles}.",
    },
}


def sentences(facts: dict[str, Any], *, alone: bool, language: str, names: dict[int | None, str]) -> list[str]:
    """The week in a few sentences. Alone: in the second person, without comparing people."""
    words = SENTENCES.get(language, SENTENCES["en"])
    out: list[str] = []
    count, previous = facts["count"], facts["previous"]
    if count == 0:
        out.append(words["none_mine" if alone else "none"])
    else:
        key = ("mine" if alone else "count") + ("_one" if count == 1 else "")
        head = words[key].format(n=count)
        difference = count - previous
        if previous == 0:
            out.append(words["plain"].format(head=head))
        elif difference > 0:
            out.append(words["more"].format(head=head, d=difference))
        elif difference < 0:
            out.append(words["fewer"].format(head=head, d=-difference))
        else:
            out.append(words["same"].format(head=head))
    strongest = facts["strongest_day"]
    if strongest and count > 1:
        day = WEEKDAY_NAMES.get(language, WEEKDAY_NAMES["en"])[strongest["weekday"]]
        out.append(words["strongest_mine" if alone else "strongest"].format(day=day, n=strongest["count"]))

    # A list gone for good has no name to quote: its sentences are left out.
    if not alone:
        for entry in [entry for entry in facts["lists"] if entry["list"]["name"]][:2]:
            top = entry["people"][0] if entry["people"] else None
            if (top and top["id"] is not None and entry["count"] >= 3 and len(entry["people"]) > 1
                    and top["count"] * 2 > entry["count"]):
                out.append(words["took"].format(name=names.get(top["id"], ""), k=top["count"], n=entry["count"],
                                                list=entry["list"]["name"]))
        for entry in facts["steady"][:1]:
            out.append(words["steady"].format(title=entry["title"], name=names.get(entry["person"], "")))
    long_open = facts["long_open"]
    if len(long_open) == 1:
        out.append(words["open_one"].format(a=long_open[0]["title"], da=long_open[0]["days"]))
    elif len(long_open) > 1:
        out.append(words["open_two"].format(a=long_open[0]["title"], da=long_open[0]["days"],
                                            b=long_open[1]["title"], db=long_open[1]["days"]))
    for entry in [entry for entry in facts["emptied"] if entry["list"]["name"]][:1]:
        key = "emptied_one" if entry["times"] == 1 else "emptied"
        out.append(words[key].format(list=entry["list"]["name"], n=entry["times"]))
    if facts["frequent"]:
        out.append(words["frequent"].format(titles=", ".join(entry["title"] for entry in facts["frequent"][:3])))
    return out


def names_of(people_list: list[dict[str, Any]]) -> dict[int | None, str]:
    return {entry["id"]: entry["name"] for entry in people_list}


# --- Today -----------------------------------------------------------------------------------------------------------


def today_block(data: Data) -> dict[str, Any]:
    """Per person: done today, and due today (open or done) with how many of those are done. "Whose" a due task is
    follows the notifications: its assignees, or whoever made it when nobody is assigned."""
    scope = data.scope
    day = scope.today.isoformat()
    done_today = [item for item in data.done if item.day == scope.today]
    due_done = [item for item in data.done if item.row.due_date == day]
    open_today = [row for row in data.open if row.due_date == day]
    overdue = [row for row in data.open if row.due_date and row.due_date < day]
    per: dict[int | None, dict[str, int]] = defaultdict(lambda: {"done": 0, "due": 0, "due_done": 0})
    for person in sorted({person for members in scope.members.values() for person in members}):
        per.setdefault(scope.person(person), {"done": 0, "due": 0, "due_done": 0})
    for item in done_today:
        per[item.person]["done"] += 1
    for item in due_done:
        per[item.person]["due"] += 1
        per[item.person]["due_done"] += 1
    for row in open_today:
        members = scope.members.get(row.space_id, set())
        whose = [person for person in (row.assignees or []) if person in members]
        if not whose and row.created_by in members:
            whose = [row.created_by]
        for person in whose:
            per[scope.person(person)]["due"] += 1
    return {
        "date": day, "done": len(done_today), "due": len(open_today) + len(due_done), "due_done": len(due_done),
        "open": len(open_today), "overdue": len(overdue),
        "people": [{"id": person, **counts} for person, counts in sorted(
            per.items(), key=lambda pair: (pair[0] != scope.viewer_id, pair[0] is None, pair[0] or 0))],
    }


# --- The page --------------------------------------------------------------------------------------------------------


def period_of(today: date, kind: str, year: int | None) -> tuple[date, date, date, date]:
    """First and last day of the period and of the one before it."""
    if year is not None:
        return date(year, 1, 1), date(year, 12, 31), date(year - 1, 1, 1), date(year - 1, 12, 31)
    length = RANGES[kind]
    first = today - timedelta(days=length - 1)
    return first, today, first - timedelta(days=length), first - timedelta(days=1)


def _year_block(data: Data, year: int, done: list[Done]) -> dict[str, Any]:
    scope = data.scope
    months = Counter(item.day.month for item in done)
    weekdays = Counter(item.day.weekday() for item in done)
    hours = Counter(item.at.hour for item in done)
    by_list = Counter(item.row.list_id for item in done)

    def best(counter: Counter[int]) -> int | None:
        return max(counter.items(), key=lambda pair: (pair[1], -pair[0]))[0] if counter else None

    # Made in the year: the tasks there are now and those recorded as done, a completed copy of a repeating task
    # not counted again (it carries the moment its original was made).
    made: set[str] = set()
    for item in data.done:
        is_copy = item.row.series_id is not None and item.row.series_id != item.row.reminder_id
        if not is_copy and item.row.created_at and scope.local(item.row.created_at).year == year:
            made.add(item.row.reminder_id)
    for row in (*data.open, *data.binned):
        if scope.local(row.created_at).year == year:
            made.add(row.id)
    top = by_list.most_common(1)
    return {
        "year": year,
        "months": [months.get(month, 0) for month in range(1, 13)],
        "best_month": best(months),
        "weekdays": [weekdays.get(day, 0) for day in range(7)],
        "best_weekday": best(weekdays),
        "hours": [hours.get(hour, 0) for hour in range(24)],
        "best_hour": best(hours),
        "top_list": {"list": _list_brief(data, top[0][0]), "count": top[0][1]} if top else None,
        "created": len(made),
        "completed": len(done),
    }


def page(db: Session, scope: Scope, kind: str, year: int | None) -> dict[str, Any]:
    """Everything the review shows (``stats-shape.md`` describes each field)."""
    data = load(db, scope)
    today = scope.today
    first, last, before_first, before_last = period_of(today, kind, year)
    done = data.done_between(first, last)
    before = data.done_between(before_first, before_last)
    heat_first = today - timedelta(days=HEATMAP_DAYS - 1)
    heat = daily_counts(data.done, heat_first, today)
    best_heat = max(((count, heat_first + timedelta(days=index)) for index, count in enumerate(heat)),
                    key=lambda pair: (pair[0], pair[1]), default=(0, today))
    dated = [item for item in done if item.row.on_time is not None]
    on_time = sum(1 for item in dated if item.row.on_time)
    durations: dict[str, list[float]] = defaultdict(list)
    for item in done:
        days = _duration_days(item)
        if days is not None:
            durations[item.row.list_id].append(days)
    every_duration = [days for values in durations.values() for days in values]
    per_list = Counter(item.row.list_id for item in done)
    per_person: dict[int | None, Counter[str]] = defaultdict(Counter)
    for item in done:
        per_person[item.person][item.row.list_id] += 1
    hours = [[0] * 24 for _ in range(7)]
    for item in done:
        hours[item.at.weekday()][item.at.hour] += 1
    shown_people = people(db, data)
    facts = week_facts(data)
    own = [item for item in data.done if item.row.completed_by == scope.viewer_id]
    return {
        "scope": {
            "space": scope.wanted, "alone": scope.alone, "time_zone": scope.zone_name, "today": today.isoformat(),
            "as_of": records.format_stamp(clock.now()),
            "spaces": [{"id": space.id, "name": space.name, "color": space.color, "icon": space.icon,
                        "private": space.private, "members": len(scope.members.get(space.id, ()))}
                       for space in scope.spaces],
        },
        "people": shown_people,
        "range": {"kind": kind, "year": year, "from": first.isoformat(), "to": last.isoformat(),
                  "previous_from": before_first.isoformat(), "previous_to": before_last.isoformat()},
        "total": {"count": len(done), "previous": len(before),
                  "change_pct": round(100 * (len(done) - len(before)) / len(before), 1) if before else None},
        "heatmap": {"from": heat_first.isoformat(), "to": today.isoformat(), "days": heat, "max": max(heat),
                    "best": {"date": best_heat[1].isoformat(), "count": best_heat[0]} if best_heat[0] else None},
        "streak": streak(data.done, today),
        "punctuality": {"on_time": on_time, "late": len(dated) - on_time, "percent": _pct(on_time, len(dated))},
        "duration": {
            "average_days": round(statistics.fmean(every_duration), 1) if every_duration else None,
            "median_days": round(statistics.median(every_duration), 1) if every_duration else None,
            "lists": sorted(({"list": _list_brief(data, list_id), "average_days": round(statistics.fmean(values), 1),
                              "count": len(values)} for list_id, values in durations.items()),
                            key=lambda entry: entry["average_days"]),
        },
        "lists": [{"list": _list_brief(data, list_id), "count": count, "share": round(count / len(done), 3)}
                  for list_id, count in per_list.most_common()],
        "by_person": [{"id": person, "count": sum(counts.values()),
                       "lists": [{"list_id": list_id, "count": count} for list_id, count in counts.most_common()]}
                      for person, counts in sorted(per_person.items(), key=lambda pair: -sum(pair[1].values()))],
        "hours": hours,
        "pulse": pulse(data),
        "week": {**facts, "sentences": sentences(facts, alone=scope.alone, language=scope.language,
                                                 names=names_of(shown_people))},
        "today": today_block(data),
        "records": records_of(data.done, today),
        "records_mine": None if scope.alone else records_of(own, today),
        "year": _year_block(data, year, done) if year is not None else None,
    }


def summary(db: Session, scope: Scope) -> dict[str, Any]:
    """For ``/api/v1/stats/summary``: the run, today, the last seven days, a year of days."""
    data = load(db, scope)
    today = scope.today
    first = today - timedelta(days=SUMMARY_DAYS - 1)
    run = streak(data.done, today)
    return {
        "time_zone": scope.zone_name, "today": today.isoformat(),
        "streak": {"current": run["current"], "record": run["record"], "done_today": run["done_today"]},
        "done_today": sum(1 for item in data.done if item.day == today),
        "done_week": len(data.done_between(today - timedelta(days=6), today)),
        "total": len(data.done),
        "days": {"from": first.isoformat(), "to": today.isoformat(), "counts": daily_counts(data.done, first, today)},
    }


def weekly_sentences(db: Session, account_id: int, today: date | None = None) -> list[str]:
    """The week in sentences for the weekly mail: every space of the account, the seven days before ``today``."""
    scope = scope_of(db, account_id, today=today)
    if scope is None or not scope.spaces:
        return []
    data = load(db, scope)
    facts = week_facts(data)
    return sentences(facts, alone=scope.alone, language=scope.language, names=names_of(people(db, data)))


# --- Review: what lies about -----------------------------------------------------------------------------------------


def _last_change(row: Reminder) -> datetime:
    stamps = [int(value) for value in (row.clock or {}).values() if isinstance(value, int | float)]
    made = records.parse_stamp(row.created_at)
    if not stamps:
        return made
    return max(made, datetime.fromtimestamp(max(stamps) / 1000, tz=made.tzinfo))


def review(db: Session, scope: Scope, limit: int) -> dict[str, Any]:
    """Open tasks for a look through: unchanged for more than ``STALE_DAYS`` days, or overdue; the oldest first. A
    repeating task comes only when it is overdue (it is meant to stay)."""
    data = load(db, scope)
    today = scope.today
    found = []
    for row in data.open:
        unchanged = (today - _last_change(row).astimezone(scope.zone).date()).days
        overdue = (today - date.fromisoformat(row.due_date)).days if row.due_date and row.due_date < today.isoformat() \
            else None
        reasons = []
        if unchanged > STALE_DAYS and not row.repeat:
            reasons.append("unchanged")
        if overdue:
            reasons.append("overdue")
        if not reasons:
            continue
        members = scope.members.get(row.space_id, set())
        found.append({
            "id": row.id, "title": row.title, "list": _list_brief(data, row.list_id), "section_id": row.section_id,
            "due_date": row.due_date, "due_time": row.due_time, "repeat": row.repeat, "flagged": row.flagged,
            "priority": row.priority,
            "assignees": [scope.person(person) for person in (row.assignees or []) if person in members],
            "created_at": row.created_at, "age_days": (today - scope.local(row.created_at).date()).days,
            "unchanged_days": unchanged, "overdue_days": overdue, "reasons": reasons,
        })
    found.sort(key=lambda entry: (entry["created_at"], entry["id"]))
    return {"today": today.isoformat(), "stale_days": STALE_DAYS, "total": len(found), "tasks": found[:limit]}


# --- Suggestions for a list ------------------------------------------------------------------------------------------


#: A count at the start of a title, with a unit: "2 ", "2x ", "1,5 l ", "500 g ".
QUANTITY = re.compile(r"^\d+(?:[.,]\d+)?\s*(?:x|×|stk\.?|stück|pck\.?|pkg\.?|g|kg|ml|l)?\s+", re.IGNORECASE)


def plain_title(title: str) -> str:
    """The title without a count at its start (``2 Gurken`` → ``Gurken``), as people wrote it otherwise."""
    clean = " ".join(unicodedata.normalize("NFC", title).split())
    stripped = QUANTITY.sub("", clean, count=1)
    return stripped or clean


def title_key(title: str) -> str:
    """What two titles are compared by: without a count at the start, blanks folded, lower case (NFC, casefold)."""
    return plain_title(title).casefold()


def suggestions(db: Session, account_id: int, list_id: str, limit: int) -> dict[str, Any] | None:
    """Titles often done in this list that are not open in it now, and the section each known title last stood in.
    None when the list is not there for the account."""
    row = db.get(TaskList, list_id)
    if row is None or row.deleted_at is not None or db.get(Member, (row.space_id, account_id)) is None:
        return None
    space = db.get(Space, row.space_id)
    if space is None or space.deleted_at is not None:
        return None
    scope = scope_of(db, account_id, row.space_id)
    assert scope is not None
    today = scope.today
    sections = {section.id: section for section in db.scalars(select(Section).where(Section.list_id == list_id))}
    groups: dict[str, list[Completion]] = defaultdict(list)
    for done in db.scalars(select(Completion).where(Completion.list_id == list_id, Completion.parent_id.is_(None))
                           .order_by(Completion.completed_at, Completion.id)):
        groups[title_key(done.title)].append(done)
    open_rows = list(db.scalars(select(Reminder).where(Reminder.list_id == list_id, Reminder.completed_at.is_(None),
                                                       Reminder.deleted_at.is_(None))))
    open_keys = {title_key(item.title) for item in open_rows}
    placement: dict[str, str] = {}
    for key, items in groups.items():
        section_id = items[-1].section_id
        if section_id in sections:
            placement[key] = section_id
    for item in open_rows:
        if item.section_id in sections:
            placement[title_key(item.title)] = item.section_id
    out = []
    for key, items in groups.items():
        if len(items) < 2 or key in open_keys or not key:
            continue
        days = sorted({scope.local(item.completed_at).date() for item in items})
        gaps = [(later - earlier).days for earlier, later in pairwise(days)]
        interval = round(statistics.median(gaps)) if gaps else None
        last = days[-1]
        section_id = placement.get(key)
        out.append({
            "title": plain_title(items[-1].title), "key": key, "count": len(items),
            "last": items[-1].completed_at, "last_days_ago": (today - last).days, "interval_days": interval,
            "expected": (last + timedelta(days=interval)).isoformat() if interval else None,
            "section_id": section_id, "section_name": sections[section_id].name if section_id else None,
        })
    out.sort(key=lambda entry: (-entry["count"], -records.ms(records.parse_stamp(entry["last"]))))
    return {
        "list_id": list_id,
        "suggestions": out[:limit],
        "sections": [{"id": section.id, "name": section.name}
                     for section in sorted(sections.values(), key=lambda section: (section.position, section.id))],
        "placement": dict(sorted(placement.items())),
    }
