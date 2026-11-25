"""My account › Connections and the operator's keys: the routes of the shared key module (schluessel 1.0.0) under
``/api/connections``. Only a browser session manages keys (``require_account`` reads the session cookie; a token or a
paired iPhone never makes, lists or removes one). The old ways (``/api/api-tokens``, ``/api/admin/api-tokens``) stay.
"""

from __future__ import annotations

from fastapi import HTTPException, Request

from ..db import SessionLocal
from ..deps import DbSession, require_account, require_operator
from ..errors import error
from ..services import settings_service
from ..services.schluessel_store import CONFIG, SchluesselStore
from ..vendor.nexschluessel import api
from ..vendor.nexschluessel.errors import KeyRefused


def _store(db: DbSession) -> SchluesselStore:
    return SchluesselStore(db)


def _address(request: Request) -> str:
    with SessionLocal() as db:
        return settings_service.public_url(db) or str(request.base_url).rstrip("/")


def _error(refusal: KeyRefused) -> HTTPException:
    values = dict(refusal.details)
    if refusal.public_code != refusal.code:
        values["key_code"] = refusal.code
    return error(refusal.public_code, refusal.message, refusal.status, **values)


router = api.router(config=CONFIG, store=_store, account=require_account, operator=require_operator,
                    address=_address, error=_error)
