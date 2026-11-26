"""nexmcp contract tests: nextasks' adapter (from the module's ``tests-fuer-apps/adapter_template.py``).

The app as in production: MCP keys and programs in ``mcp_keys`` through the key module (``/api/connections``), the
module's routes (``routers/mcp.py``), the tools of ``services/mcp.py`` over the same services as ``/api/v1``. nextasks
had no MCP before (``legacy_keys`` empty, no program), no "AI allowed" per account, MCP off on every installation.
The database is the test session's (``tests/conftest.py`` empties it before every test); ``start_older`` is the same
start, since a database of 0.8.0 has nothing of MCP.
"""

from __future__ import annotations

import secrets
from typing import Any

from mcp_contract import LegacyKey, LegacyProgram, StandardAdapter


def _task(account_id: int, title: str) -> str:
    """A task in the account's space "Private", made as a program of 0.8.0 makes one (``apiwrite.create``)."""
    from app.db import SessionLocal
    from app.models import Account
    from app.services import apiread, apiwrite, sync

    with SessionLocal() as db:
        row = db.get(Account, account_id)
        assert row is not None
        db.expunge(row)
        sight = apiread.sight_of(db, row)
        default = apiread.World.read(db, sight).default_list()
    assert default is not None
    done = apiwrite.create(sync.Caller(account=row, key=f"t:{account_id}"), sight, {"title": title}, default.id)
    return done.task_id


class Adapter(StandardAdapter):
    package = "app.vendor.nexmcp"
    keys_prefix = "/api/connections"
    prefix = "/api/connections/mcp"
    has_ai = False
    older_had_mcp_on = False

    def start(self) -> None:
        from app.db import SessionLocal
        from app.models import MEMBER, OPERATOR, Account
        from app.routers.auth import ensure_private
        from tests.conftest import make_account

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
        self._own = _task(self._accounts["owner"].id, "Groceries")
        self._foreign = _task(self._accounts["other"].id, "Diary")
        self._clients: dict[str, Any] = {}

    def start_older(self) -> None:
        # A database of 0.8.0 has no MCP at all: nothing to write before the start.
        self.start()

    def stop(self) -> None:
        for client in self._clients.values():
            client.close()

    def client(self, role: str) -> Any:
        from tests.conftest import new_client

        if role not in self._clients:
            self._clients[role] = new_client(None if role == "anonymous" else self._accounts[role])
        return self._clients[role]

    def config(self) -> Any:
        from app.services import mcp

        return mcp.CONFIG

    def keys_config(self) -> Any:
        from app.services.schluessel_store import CONFIG

        return CONFIG

    def read_call(self) -> tuple[str, dict[str, Any]]:
        return "read_task", {"task_id": self._own}

    def change_call(self) -> tuple[str, dict[str, Any]]:
        return "create_task", {"title": "From the program"}

    def foreign_call(self) -> tuple[str, dict[str, Any]]:
        return "read_task", {"task_id": self._foreign}

    def legacy_keys(self) -> list[LegacyKey]:
        return []

    def legacy_program(self) -> LegacyProgram | None:
        return None
