"""Connections with other nex apps: the routes of the shared module ``nexverbinden`` (verbinden 0.1.1), the same
places in every app: ``/.well-known/nex-app``, ``/api/connect/…`` (the cards, the consent, the operator's switch and
addresses, and between the apps ``token``, ``revoke``, ``retire``, ``hello``). The pages ``/connect/app`` and
``/connect/return`` are the web's. A partner then uses ``/api/v1`` with the token of its connection
(``routers/v1.py``)."""

from __future__ import annotations

from collections.abc import Iterator

from fastapi import HTTPException, Request

from ..db import SessionLocal
from ..deps import require_account, require_operator
from ..errors import error
from ..services import settings_service, verbinden
from ..vendor.nexverbinden import Refused, api


def _store() -> Iterator[verbinden.VerbindenStore]:
    with SessionLocal() as db:
        yield verbinden.VerbindenStore(db)


def _address(request: Request) -> str:
    with SessionLocal() as db:
        return settings_service.public_url(db) or str(request.base_url).rstrip("/")


def _error(refusal: Refused) -> HTTPException:
    return error(refusal.code, refusal.message, refusal.status, **refusal.details)


router = api.router(config=verbinden.CONFIG, store=_store, account=require_account, operator=require_operator,
                    address=_address, error=_error)
