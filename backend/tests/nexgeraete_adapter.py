"""nexgeraete contract tests: nextasks' adapter (copied once from the module's template, now nextasks' file).

The contract runs the module inside the real nextasks: its start, its database (the one of the test session, emptied
before every test by ``tests/conftest.py``), its sessions and operators, its ``GeraeteStore`` over ``app_devices``,
its own device route ``GET /api/app/1/me``. The module's browser routes sit under ``/api/devices`` (the addresses of
before keep their old answers, ``routers/app_pairing.py``).

Nothing goes into the network: ``push.POST`` (what ``devices.send`` posts with) is the contract's recorder. The clock
is nextasks' own (``services/clock.shift``), which the device routes and the store read.
"""

from __future__ import annotations

import json
import secrets
from datetime import timedelta
from typing import Any

from geraete_contract import LegacyDevice, Made, Relay, StandardAdapter

#: The accounts of the contract: username, display name, role.
ROLES = {"owner": ("kim", "Kim Example", "member"), "other": ("mila", "Mila Example", "member"),
         "operator": ("olli", "Olli Example", "operator")}
WEB = {"X-Nextasks-Client": "tab-geraete"}


class Adapter(StandardAdapter):
    package = "app.vendor.nexgeraete"
    app_prefix = "/api/app/1"
    browser_prefix = "/api/devices"

    def start(self) -> None:
        from app.security import brake
        from app.services import clock, devices, push
        from tests.conftest import PASSWORD, make_account

        self.relay = Relay()
        self._post = push.POST
        push.POST = self.relay
        self._on_paired = devices.on_paired
        self.paired: list[tuple[Any, str]] = []

        def recorded(holder: Any, device: Any) -> None:
            self.paired.append((holder.id, device.name))
            self._on_paired(holder, device)

        devices.on_paired = recorded
        self.offset = timedelta(0)
        clock.shift(0)
        brake.forget()
        devices.forget()
        self.password = PASSWORD
        self.ids = {role: make_account(login, role_name).id for role, (login, _name, role_name) in ROLES.items()}
        from app.db import SessionLocal
        from app.models import Account

        with SessionLocal() as db:
            for role, (_login, name, _role) in ROLES.items():
                row = db.get(Account, self.ids[role])
                assert row is not None
                row.display_name = name
                row.email = f"{_login}@example.com"
            db.commit()
        self.clients: dict[str, Any] = {}

    def stop(self) -> None:
        from app.services import clock, devices, push

        for client in self.clients.values():
            client.close()
        push.POST = self._post
        devices.on_paired = self._on_paired
        clock.shift(0)

    def restart(self) -> None:
        from app.security import brake
        from app.services import devices

        for client in self.clients.values():
            client.close()
        self.clients = {}
        brake.forget()
        devices.forget()

    def config(self) -> Any:
        from app.services import devices

        return devices.config()

    def client(self, role: str) -> Any:
        from fastapi.testclient import TestClient

        from app.db import SessionLocal
        from app.main import app
        from app.models import Account
        from app.security import SESSION_COOKIE, start_session

        if role not in self.clients:
            if role == "anonymous":
                self.clients[role] = TestClient(app)
            else:
                client = TestClient(app, headers=WEB)
                with SessionLocal() as db:
                    row = db.get(Account, self.ids[role])
                    assert row is not None
                    client.cookies.set(SESSION_COOKIE, start_session(db, row, "127.0.0.1", "contract"))
                self.clients[role] = client
        return self.clients[role]

    def account_id(self, role: str) -> Any:
        return self.ids[role]

    def legacy_devices(self) -> list[LegacyDevice]:
        """What 0.8.0 wrote: a device paired by QR code or code, one brought in over iCloud (the same row), and one
        that took notifications (``push.remember``)."""
        return [LegacyDevice("paired"), LegacyDevice("brought in over iCloud"), LegacyDevice("with push", push=True)]

    def make_legacy(self, spec: LegacyDevice, *, account: str = "owner") -> Made:
        from app.db import SessionLocal
        from app.models import Account
        from app.services import devices
        from app.vendor.nexgeraete import seal

        with SessionLocal() as db:
            row = db.get(Account, self.ids[account])
            assert row is not None
            key, device = devices.make_device(db, row, spec.label)
            made = Made(key)
            if spec.push:
                made.private_key, public = seal.key_pair()
                made.ticket = f"legacy-{secrets.token_urlsafe(6)}"
                device.push_ticket = made.ticket
                device.push_key = public
                db.commit()
        return made

    def probe(self, token: str | None, headers: dict[str, str] | None = None) -> Any:
        sent = dict(headers or {})
        if token is not None:
            sent["Authorization"] = f"Bearer {token}"
        return self.device_client().get(f"{self.app_prefix}/me", headers=sent)

    def database_text(self) -> bytes:
        from app.config import get_settings
        from app.db import engine

        engine.dispose()
        path = get_settings().database_path
        found = path.read_bytes()
        for suffix in ("-wal", "-shm"):
            extra = path.with_name(path.name + suffix)
            if extra.exists():
                found += extra.read_bytes()
        return found

    def _manage(self, action: str, account: str) -> None:
        from app.db import SessionLocal
        from app.services.konten_store import KontenStore
        from app.vendor.nexkonten import manage

        with SessionLocal() as db:
            getattr(manage, action)(KontenStore(db), self.ids[account], actor_id=self.ids["operator"],
                                    password=self.password)
        # Blocking and deleting end the account's browser sessions: its browser signs in anew when asked next.
        old = self.clients.pop(account, None)
        if old is not None:
            old.close()

    def block(self, account: str = "owner") -> None:
        self._manage("block", account)

    def unblock(self, account: str = "owner") -> None:
        self._manage("unblock", account)

    def remove(self, account: str = "owner") -> None:
        self._manage("remove", account)

    def restore(self, account: str = "owner") -> None:
        self._manage("restore", account)

    def purge(self, account: str = "owner") -> None:
        from app.db import SessionLocal
        from app.models import Account, utcnow
        from app.services.konten_store import KontenStore
        from app.vendor.nexkonten import manage

        self.remove(account)
        with SessionLocal() as db:
            row = db.get(Account, self.ids[account])
            assert row is not None
            row.deleted_at = utcnow() - timedelta(days=manage.DELETE_DAYS + 1)
            db.commit()
        with SessionLocal() as db:
            assert manage.purge_due(KontenStore(db)) == [self.ids[account]]

    def owe_factor(self, account: str = "owner") -> None:
        from app.db import SessionLocal
        from app.models import Account
        from app.services import settings_service, totp

        with SessionLocal() as db:
            for role, number in self.ids.items():
                if role != account:
                    row = db.get(Account, number)
                    assert row is not None
                    row.totp_secret_enc = totp.seal_seed(totp.generate_seed())
            db.commit()
            settings_service.save(db, {"two_factor_required": True})

    def switch(self, name: str, on: bool) -> None:
        from app.db import SessionLocal
        from app.services import devices, settings_service

        with SessionLocal() as db:
            settings_service.save(db, {devices.ENABLED if name == "app" else devices.SWITCH: on})

    def travel(self, delta: timedelta) -> None:
        from app.services import clock

        self.offset += delta
        clock.shift(int(self.offset.total_seconds() * 1000))

    def tell(self, account: str, kind: str) -> None:
        from app.db import SessionLocal
        from app.services import devices

        message = json.dumps({"title": "Kim Example", "text": "changed something", "reminder_id": None,
                              "list_id": None, "type": kind}, separators=(",", ":")).encode("utf-8")
        with SessionLocal() as db:
            devices.tell(db, self.ids[account], kind, message)

    def announce(self, version: str) -> None:
        from app.services import devices

        # The contract checks the running version in the text against "1.2.1", the version its reference app runs
        # (test_nexgeraete_push.py); nextasks says its own __version__ in production.
        devices.announce(version, current="1.2.1")

    def sweep(self) -> int:
        from app.services import devices

        return devices.sweep()

    def paired_mails(self) -> list[tuple[Any, str]]:
        return list(self.paired)
