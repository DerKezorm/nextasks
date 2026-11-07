"""Notifications for the iPhone app through the relay (``https://push.nexapps.dev``), as in nexmail
(``nexmail/backend/app/services/push.py``, contract ``nexmail-ios/docs/vertrag-push.md``) with nextasks's names
(``vertrag-block1.md``, "Mitteilungen").

The app keeps an X25519 key pair per server and hands the relay's ticket and its public key over at every start
(``PUT /api/app/1/push``). A notification is compact JSON ``{"title", "text", "reminder_id", "list_id", "type"}``,
encrypted for exactly that device: a fresh X25519 pair and nonce per message, HKDF-SHA256 with the info
``nextasks-push-v1``, ChaCha20-Poly1305 (``services/push_crypto.py``, the reference of the test set ``push.json``).
The relay and Apple only ever see the ciphertext.

Only 410 from the relay drops the ticket (the app brings a new one); any other failure leaves it and loses only this
one message. What went wrong is logged without the ticket.
"""

from __future__ import annotations

import base64
import binascii
import json
import logging
from collections.abc import Callable
from dataclasses import dataclass

import httpx
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import AppDevice
from . import net, push_crypto

logger = logging.getLogger("nextasks.push")

TITLE_MAX = 100
TEXT_MAX = 200
#: The relay takes at most this many characters of ``collapse``.
COLLAPSE_MAX = 64
RELAY_SECONDS = 8.0
TYPES = ("due", "assigned", "changed")


@dataclass(frozen=True)
class Message:
    title: str
    text: str
    reminder_id: str | None
    list_id: str | None
    #: ``due``, ``assigned`` or ``changed``.
    type: str
    #: ``apns-collapse-id``: a second message with the same one replaces the first.
    collapse: str = ""


def relay_url() -> str:
    """The relay's address; empty: the operator wants nothing to go out."""
    return get_settings().push_relay.strip().rstrip("/")


def key_valid(value: str) -> bool:
    """A public X25519 key one can agree with: 32 bytes, and no point of small order."""
    try:
        raw = base64.b64decode(value, validate=True)
        X25519PrivateKey.generate().exchange(X25519PublicKey.from_public_bytes(raw))
    except (binascii.Error, ValueError):
        return False
    return True


def plaintext(message: Message) -> bytes:
    """What the app decrypts: compact, fields in the order of the contract."""
    return json.dumps(
        {"title": message.title[:TITLE_MAX], "text": message.text[:TEXT_MAX], "reminder_id": message.reminder_id,
         "list_id": message.list_id, "type": message.type},
        ensure_ascii=False, separators=(",", ":"),
    ).encode("utf-8")


def seal(message: Message, device_key: str) -> str:
    return push_crypto.encrypt(plaintext(message), device_key)


def remember(db: Session, account_id: int, device_id: int, ticket: str, key: str) -> None:
    """Ticket and key at the device. The same ticket belongs to one device of the person: a device paired again
    brings its ticket, and the old pairing must not get every message twice."""
    for other in db.scalars(select(AppDevice).where(AppDevice.account_id == account_id, AppDevice.id != device_id,
                                                    AppDevice.push_ticket == ticket)):
        other.push_ticket = ""
        other.push_key = ""
    row = db.get(AppDevice, device_id)
    if row is not None:
        row.push_ticket = ticket
        row.push_key = key
    db.commit()


def forget(db: Session, device_id: int) -> None:
    row = db.get(AppDevice, device_id)
    if row is not None:
        row.push_ticket = ""
        row.push_key = ""
        db.commit()


def targets(db: Session, account_id: int) -> list[AppDevice]:
    if not relay_url():
        return []
    return list(db.scalars(select(AppDevice).where(AppDevice.account_id == account_id, AppDevice.push_ticket != "")))


def _post(url: str, body: dict[str, object]) -> int:
    with httpx.Client(timeout=RELAY_SECONDS, verify=net.ssl_context()) as client:
        return client.post(url, json=body).status_code


#: What sends to the relay; the tests put a recorder in its place.
POST: Callable[[str, dict[str, object]], int] = _post


def send(db: Session, account_id: int, message: Message) -> int:
    """To every device of the person with a ticket. Returns how many took it."""
    return send_all(db, account_id, message)[0]


def send_all(db: Session, account_id: int, message: Message) -> tuple[int, int]:
    """To every device of the person with a ticket: how many took it, and how many failed for a reason that may pass
    (a ticket the relay says is gone counts as neither)."""
    taken = failed = 0
    for device in targets(db, account_id):
        body: dict[str, object] = {"ticket": device.push_ticket, "enc": seal(message, device.push_key)}
        if message.collapse:
            body["collapse"] = message.collapse[:COLLAPSE_MAX]
        try:
            status = POST(f"{relay_url()}/v1/send", body)
        except (httpx.HTTPError, OSError) as exc:
            logger.info("Push to one device failed: %s", type(exc).__name__)
            failed += 1
            continue
        except ValueError:
            logger.info("Push to one device failed: its key is not usable")
            continue
        if status == 410:
            logger.info("A push ticket is gone; removing it")
            device.push_ticket = ""
            device.push_key = ""
            db.commit()
        elif status == 200:
            taken += 1
        else:
            logger.info("Push to one device failed: HTTP %s", status)
            failed += 1
    return taken, failed
