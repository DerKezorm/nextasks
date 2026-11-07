"""Operator settings in the database, with defaults."""

from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import Setting
from ..vendor.nexoidc import flow

DEFAULTS: dict[str, Any] = {
    "log_mode": "normal",
    "log_mode_until": None,
    #: off | daily | weekly. Daily in the night unless the operator decides otherwise.
    "backup_schedule": "daily",
    "backup_keep": 7,
    #: Largest attachment, in MB; never above ``NEXTASKS_UPLOAD_MAX_MB`` (at most 50).
    "upload_max_mb": 50,
    #: Photos attached to tasks keep of their metadata only the orientation and the colour profile: no place, no
    #: device, no times (``services/media.py``). Off: they stay as they came.
    "strip_location": True,
    #: The address people use to reach nextasks: invitation links, the QR code of the app, the OIDC redirect. Empty
    #: means ``NEXTASKS_PUBLIC_URL``, and without that the request's own.
    "public_url": "",
    #: Members may sign in with a password. The operator always may: the emergency exit when OIDC fails.
    "password_login": True,
    #: Every account that signs in with a password needs a second factor; until it has one, it reaches only its
    #: account page. Accounts from OIDC bring their provider's.
    "two_factor_required": False,
    #: Tokens for programs such as n8n or nexdeck (``/api/v1``): closed until the operator opens it.
    "api_tokens_allowed": False,
    #: Ask GitHub once a day whether a newer nextasks is out (services/updates). Only the question goes out, so on.
    "update_check": True,
    #: Invitation mail: without a host nothing is sent, the link to copy is enough.
    "smtp_host": "",
    "smtp_port": 587,
    #: starttls | tls | none
    "smtp_security": "starttls",
    "smtp_user": "",
    "smtp_password_enc": "",
    "smtp_from": "",
    #: The last mail the server took and the last failure (an error code), as ISO times: shown at the mail server.
    "mail_last_ok_at": None,
    "mail_last_error": "",
    "mail_last_error_at": None,
    #: The iPhone app (``/api/app/1``): off answers every device with 403 ``app_disabled``; the devices stay paired.
    "app_enabled": True,
    #: New pairings of the app (QR code, short code, sign-in page); off: 403 ``app_pairing_disabled``.
    "app_pairing_allowed": True,
    #: Managers of a space may invite people by link; off: 403 ``invites_disabled``.
    "invites_enabled": True,
    #: Who sends web push, for the push services to contact (``mailto:`` or ``https:``); empty: the public address.
    "push_contact": "",
    #: The key pair of web push (VAPID), sealed with the server secret (``services/webpush.py``). Made once.
    "push_key_enc": "",
}


def get(db: Session, key: str) -> Any:
    row = db.get(Setting, key)
    if row is None:
        return DEFAULTS.get(key)
    return row.value


def get_all(db: Session) -> dict[str, Any]:
    values = dict(DEFAULTS)
    for row in db.scalars(select(Setting)):
        values[row.key] = row.value
    return values


def save(db: Session, changes: dict[str, Any], *, commit: bool = True) -> None:
    """Writes the changes; ``commit`` False leaves them in the caller's transaction."""
    for key, value in changes.items():
        if key not in DEFAULTS:
            raise KeyError(key)
        row = db.get(Setting, key)
        if row is None:
            db.add(Setting(key=key, value=value))
        else:
            row.value = value
    if commit:
        db.commit()
    else:
        db.flush()


def normalize_public_url(value: str) -> str:
    """``scheme://host[:port]`` and nothing else, or empty. ``ValueError`` for anything people could not type into
    a browser: no other schemes, no credentials, no path, no query; and for anything the shared sign-in module would
    not take as a public address (``flow.clean_public_url``: a clean host, at most 199 characters)."""
    text = value.strip()
    if not text:
        return ""
    parts = urlsplit(text)
    if parts.scheme.lower() not in ("http", "https") or not parts.hostname:
        raise ValueError("scheme or host")
    if parts.username or parts.password or parts.query or parts.fragment or parts.path not in ("", "/"):
        raise ValueError("path, query or credentials")
    try:
        parts.port  # noqa: B018 - raises ValueError when the port is not a number
    except ValueError as exc:
        raise ValueError("port") from exc
    return flow.clean_public_url(f"{parts.scheme.lower()}://{parts.netloc}")


def public_url(db: Session) -> str:
    """The public address without a trailing slash: the setting, otherwise the environment, otherwise empty."""
    stored = str(get(db, "public_url") or "").strip().rstrip("/")
    return stored or get_settings().public_url.strip().rstrip("/")


def upload_max_mb(db: Session) -> int:
    """The largest upload in MB: the operator's setting, never above what the environment allows."""
    return max(1, min(int(get(db, "upload_max_mb") or 1), get_settings().upload_max_mb))
