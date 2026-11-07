"""Who gets what where: per person, each report and each event on each channel.

Reports (``services/reports.py``): ``daily`` ("My day": overdue, due today, newly assigned since the last one) and
``weekly`` (done in the last seven days in the person's spaces, also by others; due in the next seven). Each has its
own time (and weekday) in the person's time zone (``Account.timezone``, empty: the server's; the app reports the
device's, the web sets it in the profile).

Events, the ones the server already knows for push (``services/notify.py``) plus one of its own:

* ``assigned``: a task was given to me (as the push "assigned"),
* ``due``: a task with a time is due (as the push "due"),
* ``changed``: changes by others in a list I follow (as the bundled push "changed", ``notify_changes`` of the list),
* ``joined``: somebody accepted an invitation into one of my spaces.

**From the start** every channel has its defaults (``Channel.defaults``): mail none, the browsers and the app exactly
what went there before there were choices (``due``, ``assigned``, ``changed``). A ``NotifyRoute`` is stored only where
the person's choice differs from that: ``enabled`` true where the default is off, false where it is on. Rows from
before the defaults (mail only) are all "on" and keep meaning that.

Turning one on needs the channel set up by the operator and a confirmed target (for mail: a confirmed address; for the
browsers: one signed up; for the app: one paired device with a ticket). Turning off always works, and a choice stays
stored while its channel cannot be used. Every mail of a report or event carries a link that unsubscribes exactly it
(``unsubscribe_token``): signed by the server, no sign-in, nothing else.
"""

from __future__ import annotations

import base64
import re
import secrets
from collections.abc import Callable

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from ..models import Account, NotifyRoute, NotifySchedule
from ..security import signature
from . import channels, outbox, settings_service, spaces

REPORTS = ("daily", "weekly")
EVENTS = ("assigned", "due", "changed", "joined")
ALL = REPORTS + EVENTS
DEFAULT_TIME = {"daily": "07:00", "weekly": "18:00"}
#: Sunday evening: the week that was and the one that comes.
DEFAULT_WEEKDAY = 6
_TIME = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
_PURPOSE = "unsubscribe"
_MARK = 32


class ChoiceError(Exception):
    def __init__(self, code: str, message: str, status: int) -> None:
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


# --- Choices ---------------------------------------------------------------------------------------------------------


def _stored(db: Session, account_id: int) -> dict[tuple[str, str], bool]:
    return {(row.event, row.channel): bool(row.enabled)
            for row in db.scalars(select(NotifyRoute).where(NotifyRoute.account_id == account_id))}


def default_on(event: str, kind: str) -> bool:
    channel = channels.CHANNELS.get(kind)
    return channel is not None and event in channel.defaults


def routes_of(db: Session, account_id: int) -> dict[str, list[str]]:
    """Per report and event the channels it is on for, the defaults included, in the order of ``CHANNELS``."""
    stored = _stored(db, account_id)
    return {event: [kind for kind in channels.CHANNELS if stored.get((event, kind), default_on(event, kind))]
            for event in ALL}


def is_on(db: Session, account_id: int, event: str, kind: str) -> bool:
    row = db.get(NotifyRoute, (account_id, event, kind))
    return bool(row.enabled) if row is not None else default_on(event, kind)


def _store(db: Session, account_id: int, event: str, kind: str, on: bool) -> None:
    """Keeps a row only where the choice differs from the channel's default."""
    if on == default_on(event, kind):
        db.execute(delete(NotifyRoute).where(NotifyRoute.account_id == account_id, NotifyRoute.event == event,
                                             NotifyRoute.channel == kind))
        return
    row = db.get(NotifyRoute, (account_id, event, kind))
    if row is None:
        db.add(NotifyRoute(account_id=account_id, event=event, channel=kind, enabled=on))
    else:
        row.enabled = on


def set_route(db: Session, account: Account, event: str, channel: str, on: bool) -> None:
    if event not in ALL or channel not in channels.CHANNELS:
        raise ChoiceError("invalid_input", "There is no such choice.", 422)
    if on:
        kind = channels.CHANNELS[channel]
        if not kind.available(db):
            raise ChoiceError("channel_unavailable", "The operator has not set this channel up.", 409)
        if channels.ready(db, account, channel) is None:
            raise ChoiceError("channel_not_confirmed", "Confirm where it goes first.", 409)
    _store(db, account.id, event, channel, on)
    if on and event in REPORTS:
        schedule_row(db, account.id, event)
    db.commit()


def off(db: Session, account_id: int, event: str, channel: str) -> bool:
    """Turns one choice off (unsubscribing); True when it was on."""
    was_on = is_on(db, account_id, event, channel)
    _store(db, account_id, event, channel, False)
    db.commit()
    return was_on


def schedule_row(db: Session, account_id: int, report: str) -> NotifySchedule:
    row = db.get(NotifySchedule, (account_id, report))
    if row is None:
        row = NotifySchedule(account_id=account_id, report=report, time=DEFAULT_TIME[report],
                             weekday=DEFAULT_WEEKDAY, last_period="")
        db.add(row)
        db.flush()
    return row


def schedules_of(db: Session, account_id: int) -> dict[str, dict[str, object]]:
    out: dict[str, dict[str, object]] = {}
    for report in REPORTS:
        row = db.get(NotifySchedule, (account_id, report))
        out[report] = {"time": row.time if row else DEFAULT_TIME[report],
                       "weekday": row.weekday if row else DEFAULT_WEEKDAY}
    return out


def set_schedule(db: Session, account_id: int, report: str, time: str, weekday: int | None) -> None:
    if report not in REPORTS or not _TIME.match(time) or (weekday is not None and not 0 <= weekday <= 6):
        raise ChoiceError("invalid_input", "The input is not valid.", 422)
    row = schedule_row(db, account_id, report)
    row.time = time
    if weekday is not None:
        row.weekday = weekday
    db.commit()


# --- Unsubscribing ---------------------------------------------------------------------------------------------------


def unsubscribe_token(account_id: int, event: str, channel: str) -> str:
    """Allows exactly one thing: turning off ``event`` on ``channel`` for this account."""
    payload = base64.urlsafe_b64encode(f"{account_id}:{event}:{channel}".encode()).rstrip(b"=").decode("ascii")
    return payload + signature(_PURPOSE, payload, _MARK)


def read_token(token: str) -> tuple[int, str, str] | None:
    if not 0 < len(token) <= 200 or len(token) <= _MARK:
        return None
    payload, mark = token[:-_MARK], token[-_MARK:]
    if not secrets.compare_digest(mark.encode("utf-8", "replace"), signature(_PURPOSE, payload, _MARK).encode()):
        return None
    try:
        account, event, channel = base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)).decode().split(":")
        account_id = int(account)
    except (ValueError, UnicodeDecodeError):
        return None
    if event not in ALL or channel not in channels.CHANNELS:
        return None
    return account_id, event, channel


def unsubscribe_link(db: Session, account_id: int, event: str, channel: str) -> str:
    return f"{settings_service.public_url(db)}/unsubscribe/{unsubscribe_token(account_id, event, channel)}"


def unsubscribe_api(db: Session, account_id: int, event: str, channel: str) -> str:
    """The address mail programs POST to at one click (``List-Unsubscribe``)."""
    return f"{settings_service.public_url(db)}/api/notify/unsubscribe/{unsubscribe_token(account_id, event, channel)}"


# --- Sending ---------------------------------------------------------------------------------------------------------

#: Makes the full message for one account: (language, base address, unsubscribe address) → message (None: nothing
#: to say). Needs the public address: every link in it is absolute.
Maker = Callable[[str, str, str], "channels.Message | None"]
#: Makes the short message for the push channels: language → title, one line, a path as link and ``data``.
Short = Callable[[str], "channels.Message | None"]


def dispatch(db: Session, account: Account, event: str, key: str, make: Maker, short: Short | None = None, *,
             at_once: bool = False) -> int:
    """Hands the message of ``event`` to every channel the account has it on for and that can take it now: a full
    channel (mail) gets ``make``'s message through the outbox, a short one (browsers, app) ``short``'s. With
    ``at_once`` the short channels are tried right here, as the push of an event was before; only a failure goes to
    the outbox for another try. Before the call nothing may wait to be committed (a push takes its time); the caller
    commits after. Returns how many were sent or queued (a key handled before counts as none)."""
    if account.blocked_at is not None:
        return 0
    base = settings_service.public_url(db)
    language = spaces.language_of(account)
    queued: list[tuple[str, channels.Message]] = []
    tried: list[tuple[str, channels.Message, str]] = []
    full_key = f"{event}:{key}"
    for kind in routes_of(db, account.id)[event]:
        channel = channels.CHANNELS[kind]
        target = channels.ready(db, account, kind)
        if target is None:
            continue
        if channel.short:
            message = short(language) if short is not None else None
            if message is None:
                continue
            if at_once and not outbox.known(db, account.id, kind, full_key):
                tried.append((kind, message, outbox.try_now(db, target, message)))
            else:
                queued.append((kind, message))
            continue
        if not base:
            continue
        message = make(language, base, unsubscribe_api(db, account.id, event, kind))
        if message is not None:
            queued.append((kind, message))
    count = 0
    for kind, message, error in tried:
        count += outbox.record(db, account.id, kind, full_key, message, error)
    for kind, message in queued:
        count += outbox.enqueue(db, account.id, kind, full_key, message)
    return count


def wants(db: Session, account_id: int, event: str) -> bool:
    return bool(routes_of(db, account_id)[event])
