"""nexwasneu contract tests: nextasks' adapter (copied once from the module's template, now nextasks' file).

The routes run in nextasks itself (``app.main``) on the database of the test session (``tests/conftest.py`` empties it
before every test): ``whats_new_seen`` at the account, routes under ``/api/whats-new``, the route of before ``POST
/api/me/whats-new/seen``, German and English. A new account is made the way the setup does it
(``accounts.create_with_password``).
"""

from __future__ import annotations

import itertools
from typing import Any

from fastapi.testclient import TestClient
from wasneu_contract import StandardAdapter

ROLES = {"operator": "olga", "member": "mia"}
PASSWORD = "correct horse battery"
_names = itertools.count()


class Adapter(StandardAdapter):
    package = "app.vendor.nexwasneu"
    root_package = "app"
    prefix = "/api/whats-new"
    old_seen: tuple[str, ...] = ("/api/me/whats-new/seen",)
    me = "/api/auth/me"
    me_field = "whats_new_seen"

    def start(self) -> None:
        from app.db import SessionLocal
        from app.models import MEMBER, OPERATOR
        from app.services import accounts, whats_new

        whats_new.configure()
        self.ids: dict[str, int] = {}
        with SessionLocal() as db:
            for role, name in ROLES.items():
                row = accounts.create_with_password(db, name, PASSWORD, OPERATOR if role == "operator" else MEMBER)
                self.ids[role] = row.id

    def stop(self) -> None:
        from app.services import whats_new

        whats_new.configure()

    def client(self, role: str) -> TestClient:
        from app.main import app

        client = TestClient(app, base_url="http://testserver", headers={"X-Nextasks-Client": "web"})
        if role in ROLES:
            answer = client.post("/api/auth/login", json={"name": ROLES[role], "password": PASSWORD})
            assert answer.status_code == 200, answer.text
        return client

    def _row(self, role: str) -> Any:
        from app.db import SessionLocal
        from app.models import Account

        with SessionLocal() as db:
            row = db.get(Account, self.ids[role])
            assert row is not None
            db.expunge(row)
            return row

    def stored_seen(self, role: str) -> str:
        return self._row(role).whats_new_seen or ""

    def set_seen(self, role: str, version: str) -> None:
        from app.db import SessionLocal
        from app.models import Account

        with SessionLocal() as db:
            row = db.get(Account, self.ids[role])
            assert row is not None
            row.whats_new_seen = version
            db.commit()

    def new_account_seen(self) -> str:
        from app.db import SessionLocal
        from app.services import accounts

        with SessionLocal() as db:
            row = accounts.create_with_password(db, f"new{next(_names)}", PASSWORD)
            return row.whats_new_seen or ""
