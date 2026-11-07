"""What time and what day it is. The server's own zone is ``TZ`` (as Docker images set it), otherwise UTC: an account
without a time zone of its own lives in it.

``now`` is the one place the sync and the notifications ask for the time, so that a test can move it.
"""

from __future__ import annotations

import os
from datetime import UTC, date, datetime, timedelta, tzinfo
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError, available_timezones

_shift_ms = 0


def zone() -> tzinfo:
    name = os.environ.get("TZ", "").strip()
    if name:
        try:
            return ZoneInfo(name)
        except (ZoneInfoNotFoundError, ValueError):
            pass
    return UTC


def zone_name() -> str:
    """The server's zone as an IANA name (``UTC`` when ``TZ`` names none)."""
    return str(getattr(zone(), "key", "UTC"))


def now() -> datetime:
    return datetime.now(UTC) + timedelta(milliseconds=_shift_ms)


def now_ms() -> int:
    return int(now().timestamp() * 1000)


def shift(milliseconds: int) -> None:
    """For the tests: the server's clock runs this much ahead (0 puts it back)."""
    global _shift_ms
    _shift_ms = milliseconds


def today() -> date:
    return now().astimezone(zone()).date()


_known: frozenset[str] | None = None


def valid_zone(name: str) -> bool:
    """An IANA name this server knows (``Europe/Berlin``, ``UTC``)."""
    global _known
    if _known is None:
        _known = frozenset(available_timezones()) | {"UTC"}
    return name in _known


def zone_of(name: str) -> tzinfo:
    if name and valid_zone(name):
        return ZoneInfo(name)
    return zone()
