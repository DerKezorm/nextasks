"""Web Push: notifications to a browser, also with the page closed. Taken over from nexdiary (``services/webpush.py``).

A browser signs up in the interface (``PUT /api/app/1/webpush``): the address at its push service (Google, Apple,
Mozilla, Microsoft) and two keys. nextasks encrypts every message for that browser (RFC 8291, aes128gcm) and signs the
request with its own key pair (VAPID, RFC 8292): the push service sees that something arrives and for whom, never
what. The message is the same plain text as the app's (``services/push.py``); a click opens
``/lists/<list_id>?reminder=<reminder_id>`` (the service worker of the web makes that address).

The key pair is made at the first start and kept sealed with the server's secret; a new pair would mean signing every
browser up again.
"""

from __future__ import annotations

import base64
import hashlib
import logging
import os
import threading
import time
from collections.abc import Callable
from urllib.parse import urlsplit

import http_ece
import httpx
import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from sqlalchemy import delete, select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from ..models import Setting, WebPushSubscription, utcnow
from ..security import decrypt_secret, encrypt_secret
from . import net, settings_service

logger = logging.getLogger("nextasks.push")

#: How long a push service keeps a message for a browser that is offline: a due reminder of today is of no use
#: tomorrow.
TTL_SECONDS = 12 * 3600
VAPID_SECONDS = 12 * 3600
KEY_CONTEXT = "operator:vapid"
#: Where nobody set a contact: well formed, and plainly a placeholder. Apple refuses ``localhost``.
PLACEHOLDER_CONTACT = "mailto:admin@example.com"
#: How many browsers one account may sign up.
MAX_PER_ACCOUNT = 20

_lock = threading.Lock()


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def unb64url(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def public_bytes(key: ec.EllipticCurvePrivateKey) -> bytes:
    return key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)


def _load(stored: str) -> ec.EllipticCurvePrivateKey | None:
    pem = decrypt_secret(stored, KEY_CONTEXT)
    if not pem:
        return None
    key = serialization.load_pem_private_key(pem.encode("ascii"), password=None)
    return key if isinstance(key, ec.EllipticCurvePrivateKey) else None


def _sealed_new_key() -> str:
    key = ec.generate_private_key(ec.SECP256R1())
    pem = key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    ).decode("ascii")
    return encrypt_secret(pem, KEY_CONTEXT)


def server_key(db: Session) -> ec.EllipticCurvePrivateKey:
    """The key pair, made at the first need and kept sealed. Two at their first need make one: the second insert finds
    the first and does nothing."""
    with _lock:
        stored = str(settings_service.get(db, "push_key_enc") or "")
        key = _load(stored) if stored else None
        if key is not None:
            return key
        db.execute(sqlite_insert(Setting).values(key="push_key_enc", value=_sealed_new_key())
                   .on_conflict_do_nothing(index_elements=[Setting.key]))
        db.commit()
        key = _load(str(settings_service.get(db, "push_key_enc") or ""))
        if key is None:
            # Sealed under another secret.key: of no use any more. A new pair; the browsers sign up again.
            settings_service.save(db, {"push_key_enc": _sealed_new_key()})
            db.execute(delete(WebPushSubscription))
            db.commit()
            key = _load(str(settings_service.get(db, "push_key_enc")))
        assert key is not None
        return key


def ready(db: Session) -> bool:
    """The key pair is there (``webpush`` in ``features``)."""
    stored = str(settings_service.get(db, "push_key_enc") or "")
    return bool(stored) and _load(stored) is not None


def public_key(db: Session) -> str:
    return b64url(public_bytes(server_key(db)))


def encrypt(plaintext: bytes, p256dh: str, auth: str) -> bytes:
    return http_ece.encrypt(plaintext, salt=os.urandom(16), private_key=ec.generate_private_key(ec.SECP256R1()),
                            dh=unb64url(p256dh), auth_secret=unb64url(auth), version="aes128gcm")


def vapid_header(key: ec.EllipticCurvePrivateKey, endpoint: str, subject: str) -> str:
    parts = urlsplit(endpoint)
    claims = {"aud": f"{parts.scheme}://{parts.hostname}", "exp": int(time.time() + VAPID_SECONDS), "sub": subject}
    token = jwt.encode(claims, key, algorithm="ES256", headers={"typ": "JWT"})
    return f"vapid t={token}, k={b64url(public_bytes(key))}"


def subject(db: Session) -> str:
    contact = str(settings_service.get(db, "push_contact") or "").strip()
    if contact:
        return contact
    public = settings_service.public_url(db)
    return public if public.startswith("https://") else PLACEHOLDER_CONTACT


def valid_keys(p256dh: str, auth: str) -> bool:
    """A point on P-256, uncompressed, and an auth secret of 16 bytes."""
    try:
        point = unb64url(p256dh)
        secret = unb64url(auth)
    except (ValueError, TypeError):
        return False
    if len(point) != 65 or point[0] != 4 or len(secret) != 16:
        return False
    try:
        ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), point)
    except ValueError:
        return False
    return True


def endpoint_valid(endpoint: str) -> bool:
    """An https address of a push service: never a plain address in the own network to be sent requests to."""
    parts = urlsplit(endpoint.strip())
    return parts.scheme == "https" and bool(parts.hostname) and not parts.username and not parts.password


def subscribe(db: Session, account_id: int, endpoint: str, p256dh: str, auth: str, user_agent: str = "") -> None:
    """One browser, one row: signing up again (also as another account on the same browser) replaces it; for the same
    account it keeps its first day."""
    before = db.scalar(select(WebPushSubscription).where(WebPushSubscription.endpoint == endpoint))
    since = before.created_at if before is not None and before.account_id == account_id else utcnow()
    db.execute(delete(WebPushSubscription).where(WebPushSubscription.endpoint == endpoint))
    db.add(WebPushSubscription(account_id=account_id, endpoint=endpoint, p256dh=p256dh, auth=auth,
                               user_agent=user_agent[:300], created_at=since))
    db.flush()
    rows = list(db.scalars(select(WebPushSubscription).where(WebPushSubscription.account_id == account_id)
                           .order_by(WebPushSubscription.id.desc())))
    for old in rows[MAX_PER_ACCOUNT:]:
        db.delete(old)
    db.commit()


def unsubscribe(db: Session, account_id: int, endpoint: str) -> None:
    db.execute(delete(WebPushSubscription).where(WebPushSubscription.account_id == account_id,
                                                 WebPushSubscription.endpoint == endpoint))
    db.commit()


def _post(url: str, body: bytes, headers: dict[str, str]) -> int:
    with httpx.Client(timeout=10.0, verify=net.ssl_context()) as client:
        return client.post(url, content=body, headers=headers).status_code


#: What sends to a push service; the tests put a recorder in its place.
POST: Callable[[str, bytes, dict[str, str]], int] = _post


def send(db: Session, account_id: int, plaintext: bytes, *, topic: str = "") -> int:
    """To every browser of the person; how many took it."""
    return send_all(db, account_id, plaintext, topic=topic)[0]


def send_all(db: Session, account_id: int, plaintext: bytes, *, topic: str = "") -> tuple[int, int]:
    """To every browser of the person: how many took it and how many failed for a reason that may pass. A browser
    whose push service says 404 or 410 threw its subscription away; it is removed and counts as neither."""
    rows = list(db.scalars(select(WebPushSubscription).where(WebPushSubscription.account_id == account_id)))
    if not rows:
        return 0, 0
    key = server_key(db)
    sender = subject(db)
    taken = failed = 0
    for row in rows:
        headers = {"Authorization": vapid_header(key, row.endpoint, sender), "Content-Encoding": "aes128gcm",
                   "Content-Type": "application/octet-stream", "TTL": str(TTL_SECONDS), "Urgency": "normal"}
        if topic:
            headers["Topic"] = "".join(char for char in topic if char.isalnum() or char in "-_")[:32]
        try:
            status = POST(row.endpoint, encrypt(plaintext, row.p256dh, row.auth), headers)
        except (httpx.HTTPError, OSError, ValueError) as exc:
            logger.info("Web push to one browser failed: %s", type(exc).__name__)
            failed += 1
            continue
        if status in (404, 410):
            logger.info("A browser's push subscription is gone; removing it")
            db.delete(row)
            db.commit()
        elif status < 400:
            row.last_ok_at = utcnow()
            db.commit()
            taken += 1
        else:
            logger.info("Web push to one browser failed: HTTP %s", status)
            failed += 1
    return taken, failed


# --- The browsers of one account -------------------------------------------------------------------------------------

_BROWSERS = (("Edg/", "Edge"), ("EdgA/", "Edge"), ("EdgiOS/", "Edge"), ("OPR/", "Opera"),
             ("SamsungBrowser/", "Samsung Internet"), ("Firefox/", "Firefox"), ("FxiOS/", "Firefox"),
             ("CriOS/", "Chrome"), ("Chrome/", "Chrome"), ("Chromium/", "Chromium"), ("Safari/", "Safari"))
_SYSTEMS = (("iPhone", "iOS"), ("iPad", "iPadOS"), ("Android", "Android"), ("Windows", "Windows"),
            ("CrOS", "ChromeOS"), ("Mac OS X", "macOS"), ("Macintosh", "macOS"), ("Linux", "Linux"))


def describe(user_agent: str) -> tuple[str, str]:
    """Browser and system from a ``User-Agent`` (``("Chrome", "Windows")``); empty where it says nothing known."""
    browser = next((name for mark, name in _BROWSERS if mark in user_agent), "")
    system = next((name for mark, name in _SYSTEMS if mark in user_agent), "")
    return browser, system


def subscriptions(db: Session, account_id: int) -> list[WebPushSubscription]:
    return list(db.scalars(select(WebPushSubscription).where(WebPushSubscription.account_id == account_id)
                           .order_by(WebPushSubscription.created_at.desc(), WebPushSubscription.id.desc())))


def remove(db: Session, account_id: int, subscription_id: int) -> bool:
    """Removes one browser of the account; True when there was one."""
    result = db.execute(delete(WebPushSubscription).where(WebPushSubscription.account_id == account_id,
                                                          WebPushSubscription.id == subscription_id))
    db.commit()
    return bool(result.rowcount)  # type: ignore[attr-defined]


def endpoint_mark(endpoint: str) -> str:
    """What lets a browser find its own row without the address being sent around: SHA-256 of the endpoint, hex."""
    return hashlib.sha256(endpoint.encode("utf-8")).hexdigest()
