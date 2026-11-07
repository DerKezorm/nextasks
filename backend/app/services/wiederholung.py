# Herkunft: nextasks-ios/docs/pruefsaetze/referenz/wiederholung.py (Referenz der Prüfsätze, Stand 06.11.2026),
# unverändert übernommen; geändert wird nur dort. Prüfsatz: tests/pruefsaetze/wiederholung.json.
"""Reference for repeating reminders (datenmodell.md, section "Wiederholung").

Pure standard library. Dates are ``datetime.date`` or ``YYYY-MM-DD`` strings.

- ``validate(rule, repeat_from)``: is the rule inside the allowed subset and spelling?
- ``next_due(rule, repeat_from, due_date, on_date)``: the next due date, or None when the rule ends.
- ``next_rule(rule)``: the rule to store after one completion (COUNT counted down).
- ``copy_id(original_id, occurrence)``: id of the completed copy (UUIDv5).
- ``complete(reminder, occurrence, at, on, by, existing_ids)``: what completing does.
"""

from __future__ import annotations

import calendar
import re
import uuid
from dataclasses import dataclass
from datetime import date, timedelta

__all__ = [
    "InvalidRule",
    "Rule",
    "parse",
    "validate",
    "next_due",
    "next_rule",
    "copy_id",
    "complete",
]

DAYS = ("MO", "TU", "WE", "TH", "FR", "SA", "SU")
ORDER = ("FREQ", "INTERVAL", "BYMONTH", "BYMONTHDAY", "BYDAY", "COUNT", "UNTIL")
FREQS = ("DAILY", "WEEKLY", "MONTHLY", "YEARLY")
REPEAT_FROM = ("due", "completion")

_POSITIVE = re.compile(r"[1-9][0-9]*")
_MONTHLY_BYDAY = re.compile(r"(-1|[1-4])(MO|TU|WE|TH|FR|SA|SU)")
_UNTIL = re.compile(r"[0-9]{8}")


class InvalidRule(ValueError):
    """The rule is outside the allowed subset or spelling."""


@dataclass(frozen=True)
class Rule:
    freq: str
    interval: int = 1
    bymonth: int | None = None
    bymonthday: int | None = None  # 1..31 or -1
    weekdays: tuple[int, ...] = ()  # WEEKLY: 0 = Monday
    ordinal: int | None = None  # MONTHLY BYDAY: 1..4 or -1
    weekday: int | None = None  # MONTHLY BYDAY: 0 = Monday
    count: int | None = None
    until: date | None = None


def _number(value: str, low: int, high: int, what: str) -> int:
    if not _POSITIVE.fullmatch(value):
        raise InvalidRule(f"{what} must be a number without sign or leading zero")
    n = int(value)
    if not low <= n <= high:
        raise InvalidRule(f"{what} must be {low}..{high}")
    return n


def _monthday(value: str) -> int:
    if value == "-1":
        return -1
    return _number(value, 1, 31, "BYMONTHDAY")


def parse(rule: str, repeat_from: str = "due") -> Rule:
    """Parse and check a rule. Raises InvalidRule."""
    if repeat_from not in REPEAT_FROM:
        raise InvalidRule("repeat_from must be due or completion")
    if not isinstance(rule, str) or rule == "":
        raise InvalidRule("empty rule")
    values: dict[str, str] = {}
    keys: list[str] = []
    for part in rule.split(";"):
        key, sep, value = part.partition("=")
        if not sep or key not in ORDER or value == "":
            raise InvalidRule(f"bad part {part!r}")
        if key in values:
            raise InvalidRule(f"{key} twice")
        values[key] = value
        keys.append(key)
    positions = [ORDER.index(k) for k in keys]
    if positions != sorted(positions):
        raise InvalidRule("parts out of order")
    if keys[0] != "FREQ":
        raise InvalidRule("FREQ missing")
    if "COUNT" in values and "UNTIL" in values:
        raise InvalidRule("COUNT and UNTIL together")

    freq = values["FREQ"]
    if freq not in FREQS:
        raise InvalidRule("unknown FREQ")

    interval = 1
    if "INTERVAL" in values:
        interval = _number(values["INTERVAL"], 2, 99, "INTERVAL")

    count = None
    if "COUNT" in values:
        count = _number(values["COUNT"], 1, 999, "COUNT")
    until = None
    if "UNTIL" in values:
        raw = values["UNTIL"]
        if not _UNTIL.fullmatch(raw):
            raise InvalidRule("UNTIL must be YYYYMMDD")
        try:
            until = date(int(raw[:4]), int(raw[4:6]), int(raw[6:]))
        except ValueError as exc:
            raise InvalidRule("UNTIL is no date") from exc

    present = {k for k in values if k in ("BYMONTH", "BYMONTHDAY", "BYDAY")}
    if repeat_from == "completion":
        if present:
            raise InvalidRule("completion allows only FREQ, INTERVAL, COUNT, UNTIL")
        return Rule(freq, interval, count=count, until=until)

    if freq == "DAILY":
        if present:
            raise InvalidRule("DAILY allows only INTERVAL")
        return Rule(freq, interval, count=count, until=until)

    if freq == "WEEKLY":
        if present != {"BYDAY"}:
            raise InvalidRule("WEEKLY needs BYDAY and nothing else")
        names = values["BYDAY"].split(",")
        if not 1 <= len(names) <= 7 or any(n not in DAYS for n in names):
            raise InvalidRule("WEEKLY BYDAY: 1-7 days without number")
        days = tuple(DAYS.index(n) for n in names)
        if any(a >= b for a, b in zip(days, days[1:])):
            raise InvalidRule("WEEKLY BYDAY: order MO..SU, no repeats")
        return Rule(freq, interval, weekdays=days, count=count, until=until)

    if freq == "MONTHLY":
        if present == {"BYMONTHDAY"}:
            return Rule(freq, interval, bymonthday=_monthday(values["BYMONTHDAY"]), count=count, until=until)
        if present == {"BYDAY"}:
            m = _MONTHLY_BYDAY.fullmatch(values["BYDAY"])
            if not m:
                raise InvalidRule("MONTHLY BYDAY: one day with ordinal 1-4 or -1")
            return Rule(
                freq, interval, ordinal=int(m.group(1)), weekday=DAYS.index(m.group(2)), count=count, until=until
            )
        raise InvalidRule("MONTHLY needs exactly one of BYMONTHDAY or BYDAY")

    # YEARLY
    if present != {"BYMONTH", "BYMONTHDAY"}:
        raise InvalidRule("YEARLY needs BYMONTH and BYMONTHDAY and nothing else")
    month = _number(values["BYMONTH"], 1, 12, "BYMONTH")
    return Rule(freq, interval, bymonth=month, bymonthday=_monthday(values["BYMONTHDAY"]), count=count, until=until)


def validate(rule: str, repeat_from: str = "due") -> bool:
    try:
        parse(rule, repeat_from)
    except InvalidRule:
        return False
    return True


def _as_date(value: date | str) -> date:
    return value if isinstance(value, date) else date.fromisoformat(value)


def _month_length(year: int, month: int) -> int:
    return calendar.monthrange(year, month)[1]


def _capped(year: int, month: int, day: int) -> date:
    """Day in the month; -1 and days past the end mean the last day (deliberate deviation from RFC 5545)."""
    last = _month_length(year, month)
    return date(year, month, last if day == -1 or day > last else day)


def _plus_months(year: int, month: int, k: int) -> tuple[int, int]:
    total = year * 12 + (month - 1) + k
    return total // 12, total % 12 + 1


def _nth_weekday(year: int, month: int, ordinal: int, weekday: int) -> date:
    if ordinal == -1:
        last = date(year, month, _month_length(year, month))
        return last - timedelta(days=(last.weekday() - weekday) % 7)
    first = date(year, month, 1)
    return first + timedelta(days=(weekday - first.weekday()) % 7 + 7 * (ordinal - 1))


def _next_from_due(r: Rule, base: date) -> date:
    n = r.interval
    if r.freq == "DAILY":
        return base + timedelta(days=n)
    if r.freq == "WEEKLY":
        week0 = base - timedelta(days=base.weekday())
        day = base
        while True:
            day += timedelta(days=1)
            weeks = (day - timedelta(days=day.weekday()) - week0).days // 7
            if weeks % n == 0 and day.weekday() in r.weekdays:
                return day
    if r.freq == "MONTHLY":
        k = 0
        while True:
            y, m = _plus_months(base.year, base.month, k * n)
            if r.bymonthday is not None:
                cand = _capped(y, m, r.bymonthday)
            else:
                cand = _nth_weekday(y, m, r.ordinal, r.weekday)
            if cand > base:
                return cand
            k += 1
    # YEARLY
    k = 0
    while True:
        cand = _capped(base.year + k * n, r.bymonth, r.bymonthday)
        if cand > base:
            return cand
        k += 1


def _next_from_completion(r: Rule, base: date) -> date:
    n = r.interval
    if r.freq == "DAILY":
        return base + timedelta(days=n)
    if r.freq == "WEEKLY":
        return base + timedelta(days=7 * n)
    if r.freq == "MONTHLY":
        y, m = _plus_months(base.year, base.month, n)
        return _capped(y, m, base.day)
    return _capped(base.year + n, base.month, base.day)


def next_due(rule: str, repeat_from: str, due_date: date | str, on_date: date | str | None) -> date | None:
    """Next due date after one step, or None when the rule ends (COUNT=1 or past UNTIL).

    ``due_date`` is the current due date (base for ``repeat_from: due``), ``on_date`` the day of completing
    in the completing device's time zone (base for ``repeat_from: completion``).
    """
    r = parse(rule, repeat_from)
    if r.count == 1:
        return None
    if repeat_from == "due":
        nxt = _next_from_due(r, _as_date(due_date))
    else:
        nxt = _next_from_completion(r, _as_date(on_date))
    if r.until is not None and nxt > r.until:
        return None
    return nxt


def next_rule(rule: str) -> str:
    """Rule stored on the original after one completion: COUNT=n becomes COUNT=n-1, everything else stays."""
    parts = rule.split(";")
    last = parts[-1]
    if last.startswith("COUNT="):
        n = int(last[6:])
        if n <= 1:
            raise InvalidRule("COUNT=1 ends the rule, there is nothing to count down")
        parts[-1] = f"COUNT={n - 1}"
    return ";".join(parts)


def copy_id(original_id: str, occurrence: date | str) -> str:
    """UUIDv5 with namespace = id of the original, name = occurrence as YYYY-MM-DD, lower case."""
    name = _as_date(occurrence).isoformat()
    return str(uuid.uuid5(uuid.UUID(original_id), name)).lower()


def complete(
    reminder: dict,
    occurrence: str | None,
    at: str,
    on: date | str,
    by: int | None,
    existing_ids: set[str] | frozenset[str] = frozenset(),
) -> dict:
    """What completing a reminder does.

    ``reminder`` holds the fields from the data model (at least ``id``, ``due_date``, ``due_time``, ``repeat``,
    ``repeat_from``, ``completed_at``). ``at`` is the time of completing (``YYYY-MM-DDTHH:MM:SS.sssZ``),
    ``on`` the day of completing in the device's time zone, ``by`` the account (None locally).
    ``existing_ids`` are the reminder ids the caller already has (to find an existing copy).

    Returns ``{"result", "original", "copy", "copy_id", "next_due", "subtasks"}``:

    - ``result``: ``completed`` (the original itself is done), ``copy`` (a completed copy was made and the
      original moved on), ``already_done`` or ``due_changed`` (nothing to do).
    - ``original``: the changed fields of the original (empty when nothing happens).
    - ``copy``: the full copy (all fields of the original with the documented exceptions) or None.
    - ``next_due``: ``{"due_date", "due_time"}`` of the original after moving on, or None.
    - ``subtasks``: ``complete`` (open subtasks are completed with the same time), ``reopen`` or None.
    """
    nothing = {"original": {}, "copy": None, "copy_id": None, "next_due": None, "subtasks": None}
    due = reminder.get("due_date")
    repeat = reminder.get("repeat") if due else None
    repeat_from = reminder.get("repeat_from") or "due"

    if repeat is None:
        if reminder.get("completed_at"):
            return {"result": "already_done", **nothing}
        return {
            "result": "completed",
            **nothing,
            "original": {"completed_at": at, "completed_by": by},
            "subtasks": "complete",
        }

    if occurrence is not None:
        cid = copy_id(reminder["id"], occurrence)
        if cid in existing_ids:
            return {"result": "already_done", **nothing}
    if reminder.get("completed_at"):
        return {"result": "already_done", **nothing}
    if occurrence != due:
        return {"result": "due_changed", **nothing}

    nxt = next_due(repeat, repeat_from, due, on)
    if nxt is None:
        return {
            "result": "completed",
            **nothing,
            "original": {"completed_at": at, "completed_by": by},
            "subtasks": "complete",
        }

    copy = dict(reminder)
    copy.update(
        id=cid,
        repeat=None,
        repeat_from="due",
        due_date=occurrence,
        completed_at=at,
        completed_by=by,
        parent_id=None,
    )
    next_fields = {"due_date": nxt.isoformat(), "due_time": reminder.get("due_time")}
    return {
        "result": "copy",
        "original": {**next_fields, "repeat": next_rule(repeat), "repeat_from": repeat_from},
        "copy": copy,
        "copy_id": cid,
        "next_due": next_fields,
        "subtasks": "reopen",
    }
