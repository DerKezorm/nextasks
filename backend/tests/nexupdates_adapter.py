"""nexupdates contract tests: nextasks' adapter (from the module's ``tests-fuer-apps/adapter_template.py``).

The app as in production: the switch ``update_check`` in the settings table (JSON, as before the module), the routes
under ``/api/about`` (``routers/about.py``), the setup route ``POST /api/setup`` with the box (U1).

nextasks has no bell (``has_bell`` False, updates 0.1.2, ``on_newer`` is None). It pairs devices (``has_devices``,
updates 0.1.3, U24): an operator's device that understands and wants ``update`` counts as a bell, the background looks
at most once a day and tells it through the module geraete (``services/devices.py``); without one it asks nothing
(U19) and only an operator opening "About" asks.

Nothing reaches the relay: ``push.POST`` (what ``devices.send`` posts with) is a recorder here, and ``devices_told``
opens what reached the operator's device with its own key, as the app would.
"""

from __future__ import annotations

import json
import secrets
from typing import Any

from updates_contract import StandardAdapter


class Adapter(StandardAdapter):
    package = "app.vendor.nexupdates"
    prefix = "/api/about"
    also: tuple[str, ...] = ()
    has_bell = False
    has_devices = True

    def start(self) -> None:
        from app.models import MEMBER, OPERATOR
        from app.services import push, updates
        from tests.conftest import make_account

        updates.configure()
        self._post = push.POST
        self._sent: list[dict[str, Any]] = []
        push.POST = self._record
        #: The operator's device of ``want_on_device``: its id and its private key, per operator.
        self._devices: dict[int, tuple[Any, str]] = {}
        self._accounts = {
            "operator": make_account("boss", OPERATOR, password=secrets.token_urlsafe(12)),
            "member": make_account("robin", MEMBER, password=secrets.token_urlsafe(12)),
        }
        self._clients: dict[str, Any] = {}

    def stop(self) -> None:
        from app.services import push

        for client in self._clients.values():
            client.close()
        self._clients = {}
        if getattr(self, "_post", None) is not None:
            push.POST = self._post

    def _record(self, url: str, body: dict[str, Any]) -> int:
        self._sent.append(body)
        return 200

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

        for client in self._clients.values():
            client.close()
        self._clients = {}
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

    def description(self) -> dict[str, Any]:
        # The app's own description (published under /api/openapi.json only with NEXTASKS_API_DOCS).
        from app.main import app

        return app.openapi()

    def want_on_device(self, on: bool) -> None:
        """The operator's iPhone, paired as a coming app pairs: it names ``update`` among what it understands and has
        it switched on (``on``) or off."""
        from app.db import SessionLocal
        from app.models import utcnow
        from app.services import devices
        from app.vendor.nexgeraete import NewDevice, PushState, seal

        operator = self._accounts["operator"].id
        with SessionLocal() as db:
            store = devices.GeraeteStore(db)
            if operator not in self._devices:
                private, public = seal.key_pair()
                made = store.add_device(NewDevice(account_id=operator, name="Olga's iPhone",
                                                  token_hash=secrets.token_hex(32), prefix="ntd_test", kind="ios",
                                                  created_at=utcnow(),
                                                  model="iPhone 16", system="iOS 26.1", app_version="2.0", via="qr"))
                store.set_push(made.id, PushState(f"ticket-{secrets.token_urlsafe(6)}", public, ("update",)))
                self._devices[operator] = (made.id, private)
            store.set_kinds(self._devices[operator][0], {"update": on})
            db.commit()

    def devices_told(self) -> list[str]:
        """The versions that reached the operators' devices, opened with each device's key, oldest first."""
        from app.db import SessionLocal
        from app.services import devices
        from app.vendor.nexgeraete import seal

        tickets: dict[str, str] = {}
        with SessionLocal() as db:
            store = devices.GeraeteStore(db)
            for device_id, private in self._devices.values():
                found = store.device(device_id)
                if found is not None and found.push is not None:
                    tickets[found.push.ticket] = private
        told = []
        for body in self._sent:
            private = tickets.get(str(body.get("ticket")))
            if private is None:
                continue
            message = json.loads(seal.unseal(str(body["enc"]), private, devices.CONFIG.push_info))
            if message.get("type") == "update":
                told.append(str(message["version"]))
        return told
