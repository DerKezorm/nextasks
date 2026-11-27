"""nexverbinden contract tests: nextasks' adapter (from the module's ``tests-fuer-apps/adapter_template.py``).

nextasks is the host: the partner of the tests is nextime, which uses ``tasks.read`` and ``tasks.complete``, so the
probes show both sides: what it was given opens, ``tasks.write`` and ``members.read`` are turned away (403). The app
runs on the test session's database (``tests/conftest.py`` empties it before every test) at the public address
``https://nextasks.example.com``; the older version (0.8.0) had API keys, typed in by other apps, but never typed in a
key of another app (``older_link`` False).
"""

from __future__ import annotations

import secrets
import sqlite3
from datetime import timedelta
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient
from verbinden_contract import StandardAdapter

BASE = "https://nextasks.example.com"


class Adapter(StandardAdapter):
    package = "app.vendor.nexverbinden"
    partner = "nextime"
    base = BASE
    older_link = False
    #: verbinden 0.1.8 (B1): owner and other have a shown name besides the user name, as people set it in the profile.
    shown_names = {"owner": "Kim Example", "other": "Sam Example"}  # noqa: RUF012 (read only)

    def start(self, folder: Path, *, older: bool = False) -> None:
        from app.db import SessionLocal
        from app.models import MEMBER, OPERATOR, Account, ApiToken, utcnow
        from app.routers.auth import ensure_private
        from app.services import apitokens, settings_service, verbinden
        from tests.conftest import PASSWORD, make_account

        self._accounts = {
            "owner": make_account(self.names["owner"], MEMBER),
            "other": make_account(self.names["other"], MEMBER),
            "operator": make_account("boss", OPERATOR),
        }
        self._password = PASSWORD
        with SessionLocal() as db:
            settings_service.save(db, {"public_url": BASE})
            for role, account in self._accounts.items():
                row = db.get(Account, account.id)
                assert row is not None
                row.display_name = self.shown_names.get(role, "")
                ensure_private(db, row)
        self._clients: dict[str, TestClient] = {}
        # Two spaces of the owner with a list and a task in each (the card asks which of them a partner reads).
        from tests.sync_helpers import make_list, make_reminder, private_space, shared_space

        owner = self.client("owner")
        private, first_list = private_space(owner)
        self._garden = shared_space(owner, name="Garden")
        garden_list = make_list(owner, self._garden, name="Beds")
        self._task = make_reminder(owner, first_list, title="Milk")
        # verbinden 0.1.7 (V41): a task in each space, for a write into the space given and one into the other.
        self._lists = {private: first_list, self._garden: garden_list}
        self._tasks = {private: self._task, self._garden: make_reminder(owner, garden_list, title="Water the roses")}
        self.older_key = ""
        self.older_key_path = "/api/v1/me"
        if older:
            # An API key of 0.8.0, as another app has it typed in (all spaces, 90 days).
            token = apitokens.TOKEN_PREFIX + secrets.token_urlsafe(32)
            now = utcnow()
            with SessionLocal() as db:
                settings_service.save(db, {"api_tokens_allowed": True})
                db.add(ApiToken(account_id=self._accounts["owner"].id, name="nexmail", level="write",
                                token_hash=apitokens.digest(token), prefix=token[:8], spaces=None, created_at=now,
                                expires_at=now + timedelta(days=90)))
                db.commit()
            self.older_key = token
        self.store = verbinden.VerbindenStore(SessionLocal())
        # V39 (0.1.4): every call of the app's hook, heard on the way through (the router looks it up at each call).
        self._ended: list[tuple[Any, str]] = []
        self._hook = verbinden.on_disconnected

        def heard(store: Any, account_id: Any, partner: str) -> None:
            self._ended.append((account_id, partner))
            self._hook(store, account_id, partner)

        verbinden.on_disconnected = heard

    def stop(self) -> None:
        from app.services import verbinden

        verbinden.on_disconnected = self._hook
        for client in self._clients.values():
            client.close()
        self.store.db.close()

    def disconnected(self) -> list[tuple[Any, str]]:
        return list(self._ended)

    def asgi(self) -> Any:
        from app.main import app

        return app

    def client(self, role: str | None) -> TestClient:
        from app.main import app
        from tests.conftest import TAB, sign_in

        key = role or "anonymous"
        if key not in self._clients:
            made = TestClient(app, base_url=BASE, headers=TAB if role else {})
            if role:
                sign_in(made, self._accounts[role])
            self._clients[key] = made
        return self._clients[key]

    def config(self) -> Any:
        from app.services import verbinden

        return verbinden.CONFIG

    def block(self, role: str, blocked: bool = True) -> None:
        account = self._accounts[role]
        answer = self.client("operator").post(f"/api/accounts/{account.id}/{'block' if blocked else 'unblock'}",
                                              json={"current_password": self._password})
        assert answer.status_code == 204, answer.text
        if not blocked and role in self._clients:
            # Blocking ended the account's browser sessions (as in 0.8.0): its browser signs in again.
            from tests.conftest import sign_in

            sign_in(self._clients[role], account)

    def account_id(self, role: str) -> Any:
        return self._accounts[role].id

    def probe(self, purpose: str) -> str | tuple[str, str, Any] | None:
        """The route of ``/api/v1`` each purpose opens (``routers/v1.py``), and since 0.1.13 the question about a
        person (``tasks.about``)."""
        return {
            "tasks.read": "/api/v1/tasks",
            "tasks.complete": ("PATCH", f"/api/v1/tasks/{self._task}", {"completed": True}),
            "tasks.write": ("POST", "/api/v1/tasks", {"title": "From the probe"}),
            "members.read": f"/api/v1/spaces/{self._garden}/members",
            # verbinden 0.1.13: nexfolk's question about a person (nextime, the partner here, is turned away).
            "tasks.about": "/api/connect/about/tasks.about?name=Pat",
        }[purpose]

    def write_into(self, purpose: str, area: Any) -> tuple[str, str, Any]:
        """A write of ``purpose`` into the space ``area`` of the owner (verbinden 0.1.7): a task completed there, or a
        new task in its list; ``routers/v1.py`` refuses both outside the spaces the connection was given."""
        if purpose == "tasks.complete":
            return ("PATCH", f"/api/v1/tasks/{self._tasks[str(area)]}", {"completed": True})
        return ("POST", "/api/v1/tasks", {"title": "From the partner", "list_id": self._lists[str(area)]})

    #: verbinden 0.1.13 (V51): nexfolk asks how many open tasks concern a person (``services/verbinden.about``).
    about_purpose = "tasks.about"

    def about_seed(self, purpose: str, area: Any, person: Any) -> None:
        """An open task of the owner in the space ``area`` with the person's name in its title."""
        from tests.sync_helpers import make_reminder

        assert purpose == self.about_purpose
        make_reminder(self.client("owner"), self._lists[str(area)], title=f"Call {person.name} about the garden",
                      position="a1")

    def areas_seen(self, purpose: str, answer: Any) -> set[str]:
        from app.db import SessionLocal
        from app.models import TaskList

        if "spaces" in answer:
            return {str(space["id"]) for space in answer["spaces"]}
        if "lists" in answer:
            return {str(row["space_id"]) for row in answer["lists"]}
        with SessionLocal() as db:
            found = set()
            for task in answer["tasks"]:
                row = db.get(TaskList, task["list_id"])
                if row is not None:
                    found.add(str(row.space_id))
            return found

    def everything(self) -> str:
        from app.db import engine

        plain = sqlite3.connect(str(engine.url.database))
        try:
            return "\n".join(plain.iterdump())
        finally:
            plain.close()

    def own_tables(self) -> dict[str, Any]:
        from sqlalchemy import select

        from app.db import SessionLocal
        from app.models import ApiToken

        with SessionLocal() as db:
            rows = db.scalars(select(ApiToken).order_by(ApiToken.id)).all()
            return {"api_tokens": [(row.id, row.account_id, row.name, row.level, row.token_hash, row.prefix,
                                    row.spaces, row.expires_at, row.blocked_at) for row in rows]}
