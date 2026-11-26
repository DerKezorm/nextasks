"""nexschluessel contract tests: nextasks' adapter (copied once from the module's template, now nextasks' file).

The contract tests in ``backend/tests/nexschluessel/`` run the module against nextasks' store over ``api_tokens``
(``services/schluessel_store.py``), its routes under ``/api/connections`` and the real way a token is used
(``GET /api/v1/me``). The database is the test session's (``tests/conftest.py`` empties it before every test).
"""

from __future__ import annotations

import secrets
from datetime import timedelta
from typing import Any

from schluessel_contract import LegacyKey, StandardAdapter


class Adapter(StandardAdapter):
    package = "app.vendor.nexschluessel"
    prefix = "/api/connections"

    def start(self) -> None:
        from fastapi.testclient import TestClient

        from app.db import SessionLocal
        from app.main import app
        from app.models import MEMBER, OPERATOR, Account
        from app.routers.auth import ensure_private
        from app.services import settings_service
        from tests.conftest import TAB, make_account

        self._main = TestClient(app, base_url="http://testserver", headers=TAB)
        self._main.__enter__()
        self._accounts = {
            "owner": make_account("owner", MEMBER, password=secrets.token_urlsafe(12)),
            "other": make_account("other", MEMBER, password=secrets.token_urlsafe(12)),
            "operator": make_account("boss", OPERATOR, password=secrets.token_urlsafe(12)),
        }
        with SessionLocal() as db:
            for account in self._accounts.values():
                row = db.get(Account, account.id)
                assert row is not None
                ensure_private(db, row)
            # Tokens are closed until the operator opens them (0.8.0); the contract asks with them open.
            settings_service.save(db, {"api_tokens_allowed": True})
        self._clients: dict[str, Any] = {}

    def stop(self) -> None:
        for client in self._clients.values():
            client.close()
        self._main.__exit__(None, None, None)

    def config(self) -> Any:
        from app.services.schluessel_store import CONFIG

        return CONFIG

    def client(self, role: str) -> Any:
        from tests.conftest import new_client

        if role not in self._clients:
            self._clients[role] = new_client(None if role == "anonymous" else self._accounts[role])
        return self._clients[role]

    def legacy_keys(self) -> list[LegacyKey]:
        return [
            LegacyKey("API token (read)", "api", "ntk_", "read"),
            LegacyKey("API token (write)", "api", "ntk_", "write"),
        ]

    def make_legacy(self, spec: LegacyKey, *, account: str = "owner", expired: bool = False) -> str:
        """As nextasks 0.8.0 made them (``services/apitokens.make``), all spaces, 90 days."""
        from app.db import SessionLocal
        from app.models import ApiToken, utcnow
        from app.services import apitokens

        token = apitokens.TOKEN_PREFIX + secrets.token_urlsafe(32)
        now = utcnow()
        with SessionLocal() as db:
            db.add(ApiToken(account_id=self._accounts[account].id, name=spec.label, level=spec.right,
                            token_hash=apitokens.digest(token), prefix=token[: len(apitokens.TOKEN_PREFIX) + 4],
                            spaces=None, created_at=now,
                            expires_at=now - timedelta(hours=1) if expired else now + timedelta(days=90)))
            db.commit()
        return token

    def probe(self, kind: str, secret: str) -> int:
        client = self.client("anonymous")
        return client.get("/api/v1/me", headers={"Authorization": f"Bearer {secret}"}).status_code

    def owe_factor(self) -> None:
        from app.db import SessionLocal
        from app.services import settings_service

        with SessionLocal() as db:
            settings_service.save(db, {"two_factor_required": True})

    def foreign_area(self) -> Any:
        from app.db import SessionLocal
        from app.services import spaces

        with SessionLocal() as db:
            found = spaces.private_of(db, self._accounts["other"].id)
            assert found is not None
            return found.id
