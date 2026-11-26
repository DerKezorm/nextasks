"""The way out for reports and events: a queue in the database, sent in the background, tried again after a failure.

**Mail goes into the one outbox of the shared post module** (post 1.1.0, decided E33): ``enqueue`` with channel ``mail``
writes the report as a letter of the app (``channels.mail_letter``) under the key ``notify:<account>:<key>`` into
``mail_outbox``; the module tries again after 1, 5, 15, 60 and 180 minutes and tells nextasks of every try
(``PostStore.after_attempt``), which keeps the state of the person's way (``NotifyChannel``) as before. Rows for mail
that an older version left waiting in ``notify_outbox`` move there at the start (``move_waiting_mail``). The rest of
this file is the push channels'.

A message is queued under a key (``daily:2026-11-07``, ``assigned:<reminder>:<ms>``); the same key for the same account
and channel is never queued twice (unique in ``notify_outbox``), so a restart sends nothing twice. A failure is tried
again after the channel's ``retry_minutes`` (mail: 1, 5, 15, 60 and 180 minutes; push: 1, 5, 15), then given up; each
failure is logged by its kind (never the far side's answer) and shown at the person's channel (``NotifyChannel``) and,
for mail, at the operator's mail server.

The push of an event (browsers, app) does not wait for the round: ``try_now`` delivers it in the moment, ``record``
then writes the row as sent, or as due again after the first wait when it failed.

Sent and given-up rows stay 30 days, then go.
"""

from __future__ import annotations

import asyncio
import logging
import threading
from datetime import datetime, timedelta

from sqlalchemy import delete, or_, select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from ..db import SessionLocal
from ..models import Account, AssignedLog, NotifyChannel, NotifyOutbox
from . import channels, clock

logger = logging.getLogger("nextasks.notify")

#: Minutes to wait after the 1st, 2nd, … failure of mail; after the last one the message is given up. Each channel has
#: its own (``Channel.retry_minutes``).
RETRY_MINUTES = (1, 5, 15, 60, 180)
KEEP_DAYS = 30
#: How many messages one round sends at most (the rest follow in the next).
BATCH = 50
INTERVAL_SECONDS = 15

_wake = threading.Event()


MAIL = "mail"
#: How the key of a report in the outbox of the post module begins: ``notify:<account>:<key>``.
MAIL_KEY = "notify:"


def mail_key(account_id: int, key: str) -> str:
    return f"{MAIL_KEY}{account_id}:{key}"[:120]


def queue_mail(db: Session, account_id: int, key: str, message: channels.Message) -> int:
    """A report or event into the outbox of the post module, once per key; the caller commits (the module nudges its
    round after the commit). 1 when queued, 0 when the key was there already or there is no address to mail."""
    from ..models_accounts import MailOutbox
    from ..vendor import nexpost
    from .post_store import PostStore

    full = mail_key(account_id, key)
    if db.scalar(select(MailOutbox.id).where(MailOutbox.key == full)) is not None:
        return 0
    account = db.get(Account, account_id)
    target = channels.ready(db, account, MAIL) if account is not None else None
    if account is None or account.shut or target is None:
        return 0
    try:
        letter = channels.mail_letter(target.address, message, key=full)
    except channels.DeliveryError as exc:
        state = _state(db, account_id, MAIL)
        state.last_error, state.last_error_at = exc.code, clock.now()
        return 0
    nexpost.outbox.queue(PostStore(db), letter)
    return 1


def after_mail_attempt(db: Session, letter_key: str, error: str, given_up: bool) -> None:
    """What the post module tells of a try of a report (``PostStore.after_attempt``): the person's way of mail shows
    when it delivered last and its last failure, as before. The caller's transaction."""
    if not letter_key.startswith(MAIL_KEY):
        return
    account_part, _, key = letter_key[len(MAIL_KEY):].partition(":")
    try:
        account_id = int(account_part)
    except ValueError:
        return
    if db.get(Account, account_id) is None:
        return
    now = clock.now()
    state = _state(db, account_id, MAIL)
    if error:
        state.last_error, state.last_error_at = error, now
        logger.warning("Notification %s channel=mail account_id=%s kind=%s reason=%s",
                       "given up" if given_up else "not delivered, tried again later", account_id,
                       key.split(":", 1)[0], error)
    else:
        state.last_ok_at = now
        logger.info("Notification delivered channel=mail account_id=%s kind=%s", account_id, key.split(":", 1)[0])


def drop_stale_mail(db: Session) -> int:
    """Before a round of the post module's outbox: a waiting report whose account has no way of mail any more (the
    address removed, changed or not confirmed, the account shut) is given up (``no_target``), as the round of 0.8.0
    decided at sending. Returns how many."""
    import json

    from ..models_accounts import MailOutbox

    dropped = 0
    waiting = db.scalars(select(MailOutbox).where(MailOutbox.sent_at.is_(None), MailOutbox.next_at.is_not(None),
                                                  MailOutbox.key.like(f"{MAIL_KEY}%"))).all()
    for row in waiting:
        account_part = (row.key or "")[len(MAIL_KEY):].partition(":")[0]
        account = db.get(Account, int(account_part)) if account_part.isdigit() else None
        target = channels.ready(db, account, MAIL) if account is not None and not account.shut else None
        try:
            to = str(json.loads(row.letter).get("to", ""))
        except ValueError:
            to = ""
        if target is None or target.address.lower() != to.lower():
            row.next_at, row.error = None, "no_target"
            dropped += 1
    if dropped:
        db.commit()
    return dropped


def move_waiting_mail(db: Session) -> int:
    """Mail an older version left waiting in ``notify_outbox`` goes into the outbox of the post module, under its key,
    with what tries it had; the row is closed (``failed_at`` with ``moved_to_post``). Returns how many moved."""
    now = clock.now()
    moved = 0
    rows = db.scalars(select(NotifyOutbox).where(NotifyOutbox.channel == MAIL, NotifyOutbox.sent_at.is_(None),
                                                 NotifyOutbox.failed_at.is_(None))).all()
    for row in rows:
        moved += queue_mail(db, row.account_id, row.key, channels.Message.from_dict(row.payload or {}))
        row.failed_at, row.last_error = now, "moved_to_post"
    if rows:
        db.commit()
        logger.info("Waiting mail of the notifications moved to the outbox of the post module count=%s", moved)
    return moved


def enqueue(db: Session, account_id: int, channel: str, key: str, message: channels.Message) -> int:
    """Queues once; the caller commits. 1 when queued, 0 when this key was there already. Mail goes into the outbox
    of the post module (``queue_mail``)."""
    if channel == MAIL:
        return queue_mail(db, account_id, key, message)
    result = db.execute(sqlite_insert(NotifyOutbox).values(
        account_id=account_id, channel=channel, key=key[:120], payload=message.to_dict(), created_at=clock.now(),
        next_try_at=clock.now(), attempts=0, last_error="",
    ).on_conflict_do_nothing())
    _wake.set()
    return int(result.rowcount or 0)  # type: ignore[attr-defined]


def known(db: Session, account_id: int, channel: str, key: str) -> bool:
    """This key went to this channel of the account already (or waits)."""
    if channel == MAIL:
        from ..models_accounts import MailOutbox

        return db.scalar(select(MailOutbox.id).where(MailOutbox.key == mail_key(account_id, key))) is not None
    return db.scalar(select(NotifyOutbox.id).where(NotifyOutbox.account_id == account_id,
                                                   NotifyOutbox.channel == channel,
                                                   NotifyOutbox.key == key[:120])) is not None


def try_now(db: Session, target: channels.Target, message: channels.Message) -> str:
    """Delivers at once; "" when it went, else the code of the failure. Writes nothing of its own."""
    try:
        channels.CHANNELS[target.kind].deliver(db, target, message)
    except channels.DeliveryError as exc:
        return exc.code
    return ""


def record(db: Session, account_id: int, channel: str, key: str, message: channels.Message, error: str) -> int:
    """Writes what ``try_now`` did: sent, or tried once and due again after the channel's first wait (given up when it
    has none). The caller commits. 1 when written, 0 when the key was there already."""
    now = clock.now()
    retries = channels.CHANNELS[channel].retry_minutes
    values: dict[str, object] = {"account_id": account_id, "channel": channel, "key": key[:120],
                                 "payload": message.to_dict(), "created_at": now, "next_try_at": now, "attempts": 1,
                                 "last_error": error}
    state = _state(db, account_id, channel)
    if not error:
        values["sent_at"] = now
        state.last_ok_at = now
        logger.info("Notification delivered channel=%s account_id=%s kind=%s", channel, account_id,
                    key.split(":", 1)[0])
    else:
        state.last_error, state.last_error_at = error, now
        if retries:
            values["next_try_at"] = now + timedelta(minutes=retries[0])
            logger.warning("Notification not delivered, tried again later channel=%s account_id=%s try=1 reason=%s",
                           channel, account_id, error)
        else:
            values["failed_at"] = now
    result = db.execute(sqlite_insert(NotifyOutbox).values(**values).on_conflict_do_nothing())
    return int(result.rowcount or 0)  # type: ignore[attr-defined]


def _state(db: Session, account_id: int, kind: str) -> NotifyChannel:
    row = db.get(NotifyChannel, (account_id, kind))
    if row is None:
        row = NotifyChannel(account_id=account_id, kind=kind, last_error="")
        db.add(row)
    return row


def send_round(now: datetime | None = None) -> int:
    """Sends what is due. Returns how many went out."""
    now = now or clock.now()
    sent = 0
    with SessionLocal() as db:
        # Mail is the post module's now; a row for it left by an older version moves there.
        move_waiting_mail(db)
        due = db.scalars(select(NotifyOutbox).where(NotifyOutbox.sent_at.is_(None), NotifyOutbox.failed_at.is_(None),
                                                    NotifyOutbox.channel != MAIL,
                                                    NotifyOutbox.next_try_at <= now)
                         .order_by(NotifyOutbox.id).limit(BATCH)).all()
        for row in due:
            account = db.get(Account, row.account_id)
            target = channels.ready(db, account, row.channel) if account is not None else None
            if account is None or account.shut or target is None:
                # The address was removed or is unconfirmed now, the channel switched off: nothing to send to.
                row.failed_at, row.last_error = now, "no_target"
                db.commit()
                continue
            message = channels.Message.from_dict(row.payload or {})
            retries = channels.CHANNELS[row.channel].retry_minutes
            row.attempts += 1
            try:
                channels.CHANNELS[row.channel].deliver(db, target, message)
            except channels.DeliveryError as exc:
                row.last_error = exc.code
                state = _state(db, row.account_id, row.channel)
                state.last_error, state.last_error_at = exc.code, now
                if row.attempts > len(retries):
                    row.failed_at = now
                    logger.warning("Notification given up channel=%s account_id=%s key=%s reason=%s", row.channel,
                                   row.account_id, row.key.split(":", 1)[0], exc.code)
                else:
                    row.next_try_at = now + timedelta(minutes=retries[row.attempts - 1])
                    logger.warning("Notification not delivered, tried again later channel=%s account_id=%s try=%s "
                                   "reason=%s", row.channel, row.account_id, row.attempts, exc.code)
                db.commit()
                continue
            row.sent_at = now
            state = _state(db, row.account_id, row.channel)
            state.last_ok_at = now
            db.commit()
            sent += 1
            logger.info("Notification delivered channel=%s account_id=%s kind=%s", row.channel, row.account_id,
                        row.key.split(":", 1)[0])
    return sent


def tidy(now: datetime | None = None) -> None:
    now = now or clock.now()
    with SessionLocal() as db:
        db.execute(delete(NotifyOutbox).where(or_(NotifyOutbox.sent_at < now - timedelta(days=KEEP_DAYS),
                                                  NotifyOutbox.failed_at < now - timedelta(days=KEEP_DAYS))))
        db.execute(delete(AssignedLog).where(AssignedLog.at < now - timedelta(days=8)))
        db.commit()


def wake() -> None:
    _wake.set()


async def run_forever(stop: asyncio.Event) -> None:
    from . import reports

    rounds = 0
    while not stop.is_set():
        _wake.clear()
        try:
            await asyncio.to_thread(reports.report_round)
            await asyncio.to_thread(send_round)
            if rounds % 240 == 0:
                await asyncio.to_thread(tidy)
        except Exception:
            logger.exception("The round of reports and mail failed")
        rounds += 1
        waited = 0.0
        while waited < INTERVAL_SECONDS and not stop.is_set() and not _wake.is_set():
            try:
                await asyncio.wait_for(stop.wait(), timeout=1)
                return
            except TimeoutError:
                waited += 1
