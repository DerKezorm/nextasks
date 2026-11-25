"""Server › Sign-in, the page of the shared account module (konten 1.1.0): the switches of the card "Anmeldung" with
their rules (``signin.view``/``signin.change``) and "Ready for the internet?" (``readiness.check``). Operator only.

The old way (``PUT /api/settings`` with ``password_login``, ``two_factor_required``, ``passkeys_allowed``) stays as it
was, for scripts and older pages; the page uses these.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..config import get_settings
from ..deps import DbSession, OperatorAccount, confirmed_without_password
from ..models import OidcProvider
from ..security import SESSION_COOKIE, session_by_provider
from ..services import settings_service
from ..services.konten_store import KontenStore
from ..vendor import nexkonten
from .auth import fail

logger = logging.getLogger("nextasks.auth")

router = APIRouter(prefix="/api/server/sign-in", tags=["settings"])


class SignInChange(BaseModel):
    password_login: bool | None = None
    factor_required: bool | None = None
    passkeys_allowed: bool | None = None
    #: The operator's own password: asked when "Require a second factor of everybody" goes off.
    password: str = Field(default="", max_length=200)


def _provider_checked(request: Request, db: DbSession) -> bool:
    """This session began at a provider that checks the second factor itself."""
    return session_by_provider(db, request.cookies.get(SESSION_COOKIE))


def _view(request: Request, db: DbSession, operator: OperatorAccount) -> dict[str, Any]:
    store = KontenStore(db)
    return {
        **nexkonten.signin.view(store, operator.id, provider_checked=_provider_checked(request, db)),
        "public_url": str(settings_service.get(db, "public_url") or ""),
    }


@router.get("", summary="The switches of the sign-in and what may change")
def read(request: Request, operator: OperatorAccount, db: DbSession) -> dict[str, Any]:
    return _view(request, db, operator)


@router.put("", summary="Change the switches of the sign-in, with the module's rules")
def change(payload: SignInChange, request: Request, operator: OperatorAccount, db: DbSession) -> dict[str, Any]:
    store = KontenStore(db)
    try:
        nexkonten.signin.change(
            store, operator.id, password_login=payload.password_login, factor_required=payload.factor_required,
            passkeys_allowed=payload.passkeys_allowed, password=payload.password,
            actor_confirmed=payload.factor_required is False and confirmed_without_password(request, db, operator),
            provider_checked=_provider_checked(request, db),
        )
    except nexkonten.AccountError as exc:
        raise fail(exc) from exc
    logger.info("Sign-in changed by=%s", operator.name)
    return _view(request, db, operator)


@router.get("/readiness", summary="Ready for the internet? What nextasks checks of itself")
def readiness(request: Request, operator: OperatorAccount, db: DbSession) -> dict[str, Any]:
    settings = get_settings()
    store = KontenStore(db)
    checking = [row.label for row in db.scalars(
        select(OidcProvider).where(OidcProvider.enabled.is_(True), OidcProvider.trusts_second_factor.is_(True)))]
    found = nexkonten.readiness.check(
        public_url=str(settings_service.get(db, "public_url") or ""),
        request_https=request.url.scheme == "https",
        factor_required=store.factor_required(),
        own_factor=nexkonten.signin.has_own_factor(store, operator.id),
        trusted_proxies=[part.strip() for part in (settings.trusted_proxies or "").split(",") if part.strip()],
        peer=request.client.host if request.client else "",
        forwarded=bool(request.headers.get("x-forwarded-for")),
        cookie_secure=settings.cookie_secure,
        providers_checking=checking,
        session_days=settings.session_days,
    )
    return found.as_dict()
