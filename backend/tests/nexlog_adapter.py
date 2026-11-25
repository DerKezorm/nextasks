"""nexlog contract tests: nextasks' adapter (copied once from the module's template, now nextasks' file).

The contract tests in ``backend/tests/nexlog/`` run the module inside nextasks: its start (``main.lifespan``:
``logs.setup``, the level stored under ``log_mode`` and ``log_mode_until``), its middleware (request numbers in
``x-request-id``, who acts), its check of operators and its routes under ``/api/logs``. The database and data folder are
the ones of the test session (``tests/conftest.py`` empties the database before every test).
"""

from __future__ import annotations

import os
import shutil
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from log_contract import LegacyLine, Secret, StandardAdapter

OPERATOR_NAME = "tester"


class Adapter(StandardAdapter):
    package = "app.vendor.nexlog"
    prefix = "/api/logs"
    request_id_header = "x-request-id"
    #: A route behind the sign-in: ``/api/about`` answers everyone and so names nobody.
    probe_path = "/api/auth/me"

    def start(self) -> None:
        """nextasks started as in production: the lifespan of the app (setup, the stored level, the watchdog off in
        the tests)."""
        from fastapi.testclient import TestClient

        from app.main import app
        from app.services import logs
        from tests.conftest import TAB

        self._clients: list[Any] = []
        # A fresh log folder, as on a new server: the session's own log holds the lines of every test before.
        self._folder = Path(tempfile.mkdtemp(prefix="nextasks-log-"))
        logs.configure(log_dir=self._folder)
        self._main = TestClient(app, base_url="http://testserver", headers=TAB)
        self._main.__enter__()

    def stop(self) -> None:
        from app.vendor import nexlog

        for client in self._clients:
            client.close()
        self._main.__exit__(None, None, None)
        from app.services import logs

        nexlog.shutdown()
        logs.configure()
        logs.setup()
        shutil.rmtree(self._folder, ignore_errors=True)

    def client(self, role: str) -> Any:
        from app.models import MEMBER, OPERATOR
        from tests.conftest import make_account, new_client

        if role == "anonymous":
            client = new_client()
        else:
            name = OPERATOR_NAME if role == "operator" else "member"
            client = new_client(self._account(name, OPERATOR if role == "operator" else MEMBER, make_account))
        self._clients.append(client)
        return client

    @staticmethod
    def _account(name: str, role: str, make: Any) -> Any:
        from app.db import SessionLocal
        from app.models import Account

        with SessionLocal() as db:
            row = db.query(Account).filter_by(name=name).one_or_none()
            if row is not None:
                db.expunge(row)
                return row
        return make(name, role)

    def operator_name(self) -> str:
        return OPERATOR_NAME

    def stored(self) -> tuple[Any, Any]:
        from app.db import SessionLocal
        from app.services import settings_service

        with SessionLocal() as db:
            return settings_service.get(db, "log_mode"), settings_service.get(db, "log_mode_until")

    def store_legacy(self, deep: bool, minutes_from_now: int) -> None:
        """As nextasks 0.8.0 stored it (``main._write_log_mode``): the mode, its end as ISO text in UTC or None."""
        from app.db import SessionLocal
        from app.services import settings_service

        if deep:
            until = datetime.now(UTC) + timedelta(minutes=minutes_from_now)
            values = {"log_mode": "detailed", "log_mode_until": until.isoformat()}
        else:
            values = {"log_mode": "quiet", "log_mode_until": None}
        with SessionLocal() as db:
            settings_service.save(db, values)

    @contextmanager
    def environment(self, value: str) -> Iterator[None]:
        from app.config import get_settings

        settings = get_settings()
        before = settings.log_level
        settings.log_level = value
        try:
            yield
        finally:
            settings.log_level = before

    def legacy_lines(self) -> list[LegacyLine]:
        """Lines in the form nextasks 0.8.0 wrote them (``services/logs.py`` before the module), server clock."""
        local = datetime(2026, 11, 20, 9, 15, 2).astimezone().isoformat()
        return [
            LegacyLine(
                raw="2026-11-20 09:15:02 INFO     nextasks.sync [a1b2c3 u:kim] | Changes taken in count=3",
                level="INFO",
                logger="nextasks.sync",
                message="Changes taken in count=3",
                request_id="a1b2c3",
                user="kim",
                at=local,
            ),
            LegacyLine(
                raw="2026-11-20 09:15:03 WARNING  nextasks.auth [d4e5f6] | Sign-in refused name=kim reason=password",
                level="WARNING",
                logger="nextasks.auth",
                message="Sign-in refused name=kim reason=password",
                request_id="d4e5f6",
            ),
            LegacyLine(
                raw="2026-11-20 09:15:04 INFO     nextasks [-] | nextasks 0.8.0 started",
                level="INFO",
                logger="nextasks",
                message="nextasks 0.8.0 started",
            ),
        ]

    def secrets(self) -> list[Secret]:
        made = os.urandom(9).hex()
        return [
            *(Secret(f"Token used {prefix}{made}", hidden=made, kept=[f"{prefix}…"])
              for prefix in ("ntk_", "ntd_", "nxm_", "nxa_", "nxc_")),
            Secret(f"GET /api/invite/{made}x -> 200", hidden=made, kept=["/api/invite/…"]),
            Secret(f"GET /api/calendar/{made}x -> 200", hidden=made, kept=["/api/calendar/…"]),
            Secret(f"GET /api/unsubscribe/{made}x -> 200", hidden=made, kept=["/api/unsubscribe/…"]),
            Secret(f"GET /api/notify/unsubscribe/{made}x -> 200", hidden=made, kept=["/api/notify/unsubscribe/…"]),
            Secret(f"GET /confirm-email/{made}x -> 200", hidden=made, kept=["/confirm-email/…"]),
        ]
