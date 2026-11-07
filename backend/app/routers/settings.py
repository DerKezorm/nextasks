"""The operator's settings: address, sign-in, the iPhone app, invitations, uploads, invitation mail, backups.

Secrets (the mail password) are written encrypted and never read back: the answer only says whether one is set.
The sign-in providers live in ``routers/oidc.py``.
"""

from __future__ import annotations

import logging
from typing import Any, Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from ..config import get_settings
from ..deps import DbSession, OperatorAccount, unknown_proxy_seen
from ..errors import error
from ..models import SIGN_IN_PASSWORD
from ..models import Account as AccountRow
from ..security import encrypt_secret
from ..services import accounts, mailer, settings_service
from ..services.oidc_store import SqlStore
from ..vendor.nexoidc import authentik, providers

logger = logging.getLogger("nextasks.settings")

router = APIRouter(prefix="/api/settings", tags=["settings"])


class SettingsOut(BaseModel):
    public_url: str
    password_login: bool
    two_factor_required: bool
    backup_schedule: str
    backup_keep: int
    smtp_host: str
    smtp_port: int
    smtp_security: str
    smtp_user: str
    smtp_password_set: bool
    smtp_from: str
    api_tokens_allowed: bool
    upload_max_mb: int
    upload_ceiling_mb: int
    #: Photos lose place, device and the rest of their metadata on upload (``services/media.py``).
    strip_location: bool
    update_check: bool
    #: The iPhone app may use ``/api/app/1`` (off: 403 ``app_disabled``; the devices stay paired).
    app_enabled: bool
    #: New devices may be paired (off: 403 ``app_pairing_disabled``).
    app_pairing_allowed: bool
    #: Managers may invite into their spaces (off: 403 ``invites_disabled``).
    invites_enabled: bool
    #: The last mail the server took and the last failure (an error code), ISO times; None when there was none.
    mail_last_ok_at: str | None = None
    mail_last_error: str = ""
    mail_last_error_at: str | None = None
    #: Requests come with proxy headers, but no trusted proxy is configured (only in the answer of GET).
    proxy_unknown: bool = False


class SettingsIn(BaseModel):
    public_url: str | None = Field(default=None, max_length=255)
    password_login: bool | None = None
    two_factor_required: bool | None = None
    backup_schedule: Literal["off", "daily", "weekly"] | None = None
    backup_keep: int | None = Field(default=None, ge=1, le=365)
    smtp_host: str | None = Field(default=None, max_length=255)
    smtp_port: int | None = Field(default=None, ge=1, le=65535)
    smtp_security: Literal["starttls", "tls", "none"] | None = None
    smtp_user: str | None = Field(default=None, max_length=255)
    #: Empty removes the password; left out keeps it.
    smtp_password: str | None = Field(default=None, max_length=500)
    smtp_from: str | None = Field(default=None, max_length=255)
    api_tokens_allowed: bool | None = None
    upload_max_mb: int | None = Field(default=None, ge=1, le=100_000)
    strip_location: bool | None = None
    update_check: bool | None = None
    app_enabled: bool | None = None
    app_pairing_allowed: bool | None = None
    invites_enabled: bool | None = None
    #: The answer to the question that comes back as 409 ``public_url_change`` when a new public address leaves the
    #: redirect address at authentik behind (module 1.0.10): sent again with ``true`` after the operator agreed.
    confirm_address: bool = False


class TestMailIn(BaseModel):
    to: str = Field(max_length=255)
    #: The language the operator's page shows, for the mail when neither the receiver nor the operator has one.
    language: str = Field(default="", max_length=16)


def _view(db: DbSession) -> SettingsOut:
    values = settings_service.get_all(db)
    return SettingsOut(
        public_url=values["public_url"],
        password_login=values["password_login"],
        two_factor_required=bool(values["two_factor_required"]),
        backup_schedule=values["backup_schedule"],
        backup_keep=values["backup_keep"],
        smtp_host=values["smtp_host"],
        smtp_port=values["smtp_port"],
        smtp_security=values["smtp_security"],
        smtp_user=values["smtp_user"],
        smtp_password_set=bool(values["smtp_password_enc"]),
        smtp_from=values["smtp_from"],
        api_tokens_allowed=bool(values["api_tokens_allowed"]),
        upload_max_mb=settings_service.upload_max_mb(db),
        upload_ceiling_mb=get_settings().upload_max_mb,
        strip_location=bool(values["strip_location"]),
        update_check=bool(values["update_check"]),
        app_enabled=bool(values["app_enabled"]),
        app_pairing_allowed=bool(values["app_pairing_allowed"]),
        invites_enabled=bool(values["invites_enabled"]),
        mail_last_ok_at=values["mail_last_ok_at"],
        mail_last_error=str(values["mail_last_error"] or ""),
        mail_last_error_at=values["mail_last_error_at"],
    )


@router.get("", response_model=SettingsOut)
def read(request: Request, _operator: OperatorAccount, db: DbSession) -> SettingsOut:
    # Requests come through a proxy nextasks was not told about: the sign-in brake sees one sender for everybody
    # (A5). The page names the setting.
    return _view(db).model_copy(update={"proxy_unknown": unknown_proxy_seen(request)})


@router.put("", response_model=SettingsOut)
def save(payload: SettingsIn, request: Request, operator: OperatorAccount, db: DbSession) -> SettingsOut:
    changes: dict[str, Any] = {}
    for key, value in payload.model_dump(exclude_unset=True, exclude={"confirm_address"}).items():
        if value is None:
            continue
        if key == "public_url":
            try:
                value = settings_service.normalize_public_url(value)
            except ValueError as exc:
                raise error("invalid_url", "Enter an address starting with http:// or https://.", 422) from exc
            # The redirect address at authentik (and at any provider made by hand) hangs on this address: ask before
            # it changes (module 1.0.10), nothing is saved until the operator agreed.
            question = authentik.public_url_guard(SqlStore(db), value, str(request.base_url),
                                                  confirm=payload.confirm_address)
            if question is not None:
                raise error("public_url_change", "The redirect address at authentik changes.", 409, **question)
        elif key == "smtp_from":
            value = value.strip()
            if value and not accounts.EMAIL_PATTERN.match(value):
                raise error("invalid_email", "This is not a mail address.", 422)
        elif key == "two_factor_required" and value and operator.sign_in == SIGN_IN_PASSWORD and not (
            operator.totp_secret_enc
        ):
            # Else the operator would be the first one sent to the account page, with nothing else in reach.
            raise error("own_second_factor_first", "Set up your own second factor first.", 409)
        elif key == "password_login" and not value:
            if not providers.public_list(SqlStore(db)):
                # Without a provider nobody but the operator could sign in any more, and invitations would fail.
                raise error("provider_first", "Set up a sign-in provider first.", 409)
        elif key == "upload_max_mb":
            value = min(int(value), get_settings().upload_max_mb)
        elif key == "smtp_password":
            changes["smtp_password_enc"] = encrypt_secret(value)
            continue
        elif isinstance(value, str):
            value = value.strip()
        changes[key] = value
    settings_service.save(db, changes)
    logger.info("Settings changed keys=%s by=%s", ",".join(sorted(changes)), operator.name)
    return _view(db)


@router.post("/mail-test", status_code=204, summary="Send a test mail through the configured server")
def mail_test(payload: TestMailIn, operator: OperatorAccount, db: DbSession) -> None:
    to = payload.to.strip()
    if not accounts.EMAIL_PATTERN.match(to):
        raise error("invalid_email", "This is not a mail address.", 422)
    # In the language of whoever receives it, as the invitation: an account with this address, else the operator's
    # own language, else the page's, else English (decision 8 of 05.10.2026).
    known = db.scalar(select(AccountRow).where(func.lower(AccountRow.email) == to.lower()).limit(1))
    language = mailer.mail_language(known.language if known else "", known.browser_language if known else "",
                                    operator.language, payload.language, operator.browser_language)
    try:
        mailer.send_test(db, to, language)
    except mailer.MailError as exc:
        # No mail server is a setting, not a failing server: no gateway error, no ERROR in the log (G12).
        raise error(exc.code, str(exc), 409 if exc.code == "mail_off" else 502) from exc
