"""The AI tools (MCP): the routes of the shared module ``nexmcp`` (mcp 1.1.0).

* ``POST /api/mcp``: JSON-RPC for programs with an MCP key or a program's access token in ``Authorization: Bearer``;
  refused with an ``Origin`` (no web page), while the operator has MCP off (404, the default of new apps), and for
  anything that is no valid key.
* OAuth for programs that connect themselves (``/api/oauth/register``, ``/token``, ``/revoke``, ``/authorize``, the
  metadata under ``/.well-known/``); the account agrees on the page ``/oauth/authorize``.
* My account › Connections: the tools and the rights per tool of an own key, the requests that wait
  (``/api/connections/mcp``, browser session only); the operator's settings under ``/api/connections/mcp/admin``.

MCP keys are made, listed and revoked through the key module (``/api/connections/keys``, ``routers/connections.py``).
"""

from __future__ import annotations

from collections.abc import Iterator

from fastapi import HTTPException, Request

from ..db import SessionLocal
from ..deps import client_ip, require_account, require_operator
from ..errors import error
from ..services import mcp, settings_service
from ..services.schluessel_store import SchluesselStore
from ..vendor.nexmcp import api
from ..vendor.nexmcp.errors import McpRefused


def _store() -> Iterator[SchluesselStore]:
    with SessionLocal() as db:
        yield SchluesselStore(db)


def _address(request: Request) -> str:
    with SessionLocal() as db:
        return settings_service.public_url(db) or str(request.base_url).rstrip("/")


def _error(refusal: McpRefused) -> HTTPException:
    return error(refusal.code, refusal.message, refusal.status, **refusal.details)


router = api.router(config=mcp.CONFIG, store=_store, account=require_account, operator=require_operator,
                    address=_address, sender=client_ip, error=_error, prefix="/api/connections/mcp",
                    notify=lambda event, request: mcp.notify(event, request))
