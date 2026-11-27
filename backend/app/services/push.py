"""Notifications for the iPhone app through the relay (``https://push.nexapps.dev``), as in nexmail
(``nexmail/backend/app/services/push.py``, contract ``nexmail-ios/docs/vertrag-push.md``) with nextasks's names
(``vertrag-block1.md``, "Mitteilungen").

The app keeps an X25519 key pair per server and hands the relay's ticket and its public key over at every start
(``PUT /api/app/1/push``). A notification is compact JSON ``{"title", "text", "reminder_id", "list_id", "type"}``
(``due`` adds ``"priority"``),
encrypted for exactly that device: a fresh X25519 pair and nonce per message, HKDF-SHA256 with the info
``nextasks-push-v1``, ChaCha20-Poly1305 (``services/push_crypto.py``, the reference of the test set ``push.json``).
The relay and Apple only ever see the ciphertext.

Only 410 from the relay drops the ticket (the app brings a new one); any other failure leaves it and loses only this
one message. What went wrong is logged without the ticket. Since geraete 0.1.0 the shared module ``nexgeraete`` signs
the devices up (``PUT /api/app/1/push``), keeps the kinds per device and sends (``services/devices.py``); this keeps
the message's form and the way to the relay (``POST``).
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
    #: 0–3, sent with ``due`` (contract 0.6): the app shows priority 3 time-sensitive. ``None``: left out.
    priority: int | None = None


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
    """What the app decrypts: compact, fields in the order of the contract; ``priority`` last and only when set."""
    fields: dict[str, object] = {"title": message.title[:TITLE_MAX], "text": message.text[:TEXT_MAX],
                                 "reminder_id": message.reminder_id, "list_id": message.list_id, "type": message.type}
    if message.priority is not None:
        fields["priority"] = message.priority
    return json.dumps(fields, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def seal(message: Message, device_key: str) -> str:
    return push_crypto.encrypt(plaintext(message), device_key)


def targets(db: Session, account_id: int) -> list[AppDevice]:
    """The account's devices that took notifications (a ticket), while the relay is set."""
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
    """To every device of the person that may get it, through the shared module ``nexgeraete`` (geraete 0.1.0): only
    the kinds a device understands (the published app: all of nextasks'), not switched off on it, nothing while the
    account is out or the app switched off. How many took it, and how many failed for a reason that may pass (a ticket
    the relay says is gone is dropped and counts as neither)."""
    from . import devices

    told = devices.tell(db, account_id, message.type, plaintext(message), collapse=message.collapse)
    return told.sent, told.failed
