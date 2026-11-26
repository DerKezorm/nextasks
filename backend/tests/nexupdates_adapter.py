"""nexupdates contract tests: nextasks' adapter (from the module's ``tests-fuer-apps/adapter_template.py``).

The app as in production: the switch ``update_check`` in the settings table (JSON, as before the module), the routes
under ``/api/about`` (``routers/about.py``), the setup route ``POST /api/setup`` with the box (U1).

nextasks has no bell. So it never looks in the background (U19, ``on_newer`` is None) and asks only when an operator
opens "About": ``look`` here is that visit, the one way nextasks asks by itself. ``bell`` and ``bell_notices`` skip
with that reason (TODO updates 0.1.1: the contract tests know no app without a bell; question in
``einst-fragen/nextasks-module.md``); every test that ends with them has checked the questions that went out first.
"""

from __future__ import annotations

import secrets
from typing import Any

import pytest
from updates_contract import StandardAdapter

NO_BELL = "nextasks has no bell: no notice to tell, no look in the background (U19)"


class Adapter(StandardAdapter):
    package = "app.vendor.nexupdates"
    prefix = "/api/about"
    also: tuple[str, ...] = ()

    def start(self) -> None:
        from app.models import MEMBER, OPERATOR
        from app.services import updates
        from tests.conftest import make_account

        updates.configure()
        self._accounts = {
            "operator": make_account("boss", OPERATOR, password=secrets.token_urlsafe(12)),
            "member": make_account("robin", MEMBER, password=secrets.token_urlsafe(12)),
        }
        self._clients: dict[str, Any] = {}

    def stop(self) -> None:
        for client in self._clients.values():
            client.close()
        self._clients = {}

    def restart(self) -> None:
        # As main.lifespan does at the app's start (the data stay).
        from app.services import updates

        updates.configure()

    def client(self, role: str) -> Any:
        from tests.conftest import new_client

        if role not in self._clients:
            self._clients[role] = new_client(None if role == "anonymous" else self._accounts[role])
        return self._clients[role]

    def stored_switch(self) -> Any:
        from app.db import SessionLocal
        from app.models import Setting

        with SessionLocal() as db:
            row = db.get(Setting, "update_check")
            return None if row is None else row.value

    def store_legacy_switch(self, on: bool) -> None:
        # nextasks 0.8.0 wrote it through the settings (PUT /api/settings or /api/about/updates): JSON true or false.
        from app.db import SessionLocal
        from app.services import settings_service

        with SessionLocal() as db:
            settings_service.save(db, {"update_check": on})

    def setup(self, on: bool) -> None:
        """The setup of a new installation: no account yet, the code from the log, the box ticked or not. The
        operator it makes stands in for the one of ``start`` from then on (the member is made again)."""
        from fastapi.testclient import TestClient
        from sqlalchemy import delete

        from app.db import SessionLocal
        from app.main import app
        from app.models import MEMBER, Account
        from tests.conftest import SETUP_CODE, TAB, make_account

        self.stop()
        with SessionLocal() as db:
            db.execute(delete(Account))
            db.commit()
        password = secrets.token_urlsafe(12)
        # Without the app's start (lifespan): it would configure the module again and drop the stand-in for GitHub.
        browser = TestClient(app, base_url="http://testserver", headers=TAB)
        answer = browser.post("/api/setup", json={
            "display_name": "Olga", "name": "olga", "password": password, "password_confirm": password,
            "code": SETUP_CODE, "update_check": on,
        })
        browser.close()
        assert answer.status_code == 200, answer.text
        with SessionLocal() as db:
            made = db.query(Account).filter_by(name="olga").one()
            db.expunge(made)
        self._accounts = {"operator": made,
                          "member": make_account("robin", MEMBER, password=secrets.token_urlsafe(12))}

    def look(self) -> None:
        """U19: the one way nextasks asks by itself is an operator opening "About" (the state is asked when it is a
        day old and the switch is on)."""
        answer = self.client("operator").get(f"{self.prefix}/updates")
        assert answer.status_code == 200, answer.text

    def bell(self) -> list[str]:
        pytest.skip(NO_BELL)

    def bell_notices(self) -> list[tuple[str, str, str]]:
        pytest.skip(NO_BELL)

    def description(self) -> dict[str, Any]:
        # The app's own description (published under /api/openapi.json only with NEXTASKS_API_DOCS).
        from app.main import app

        return app.openapi()
