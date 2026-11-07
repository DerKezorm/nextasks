"""The way out for reports and events: a queue in the database, sent in the background, tried again after a failure.

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


def enqueue(db: Session, account_id: int, channel: str, key: str, message: channels.Message) -> int:
    """Queues once; the caller commits. 1 when queued, 0 when this key was there already."""
    result = db.execute(sqlite_insert(NotifyOutbox).values(
        account_id=account_id, channel=channel, key=key[:120], payload=message.to_dict(), created_at=clock.now(),
        next_try_at=clock.now(), attempts=0, last_error="",
    ).on_conflict_do_nothing())
    _wake.set()
    return int(result.rowcount or 0)  # type: ignore[attr-defined]


def known(db: Session, account_id: int, channel: str, key: str) -> bool:
    """This key went to this channel of the account already (or waits)."""
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
        due = db.scalars(select(NotifyOutbox).where(NotifyOutbox.sent_at.is_(None), NotifyOutbox.failed_at.is_(None),
                                                    NotifyOutbox.next_try_at <= now)
                         .order_by(NotifyOutbox.id).limit(BATCH)).all()
        for row in due:
            account = db.get(Account, row.account_id)
            target = channels.ready(db, account, row.channel) if account is not None else None
            if account is None or account.blocked_at is not None or target is None:
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
