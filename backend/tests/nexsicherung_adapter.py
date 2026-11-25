"""nexsicherung contract tests: nextasks' adapter (copied once from the module's template, now nextasks' file).

The contract tests in ``backend/tests/nexsicherung/`` run the module against nextasks' real hooks
(``app/services/backup_hooks.py``), its routes (``/api/server/storage`` and the old ``/api/backups``) and its data. The
database and data folder are the ones of the test session (``tests/conftest.py`` empties the database and the media
before every test, ``start`` the backups folder).
"""

from __future__ import annotations

import json
import os
import secrets
import zipfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sicherung_contract import StandardAdapter


class Adapter(StandardAdapter):
    package = "app.vendor.nexsicherung"
    prefix = "/api/server/storage"
    legacy_prefix = "/api/backups"
    legacy_header = "x-nextasks-password"

    def start(self) -> None:
        import shutil

        from fastapi.testclient import TestClient

        from app.main import app
        from app.models import MEMBER, OPERATOR
        from app.services import backups
        from tests.conftest import TAB, make_account

        # A fresh backups folder, as on a new server: the session's own holds the copies of every test before.
        shutil.rmtree(backups.folder(), ignore_errors=True)
        self._password = secrets.token_urlsafe(12)
        self._operator = make_account("olli", OPERATOR, password=self._password)
        self._member = make_account("mika", MEMBER, password=secrets.token_urlsafe(12))
        self._clients: list[Any] = []
        self._main = TestClient(app, base_url="http://testserver", headers=TAB)
        self._main.__enter__()

    def stop(self) -> None:
        for client in self._clients:
            client.close()
        self._main.__exit__(None, None, None)

    @property
    def password(self) -> str:
        return self._password

    def _client(self, account: Any) -> Any:
        from tests.conftest import new_client

        client = new_client(account)
        self._clients.append(client)
        return client

    def operator(self) -> Any:
        return self._client(self._operator)

    def member(self) -> Any:
        return self._client(self._member)

    def restart(self) -> None:
        """The next start: the database closed, the staged restore swapped in, the database opened and checked."""
        from app.db import engine, init_db
        from app.services import backups

        engine.dispose()
        backups.configure()
        backups.tidy_at_start()
        backups.apply_pending()
        init_db()

    def add_content(self, label: str) -> None:
        """A task of the operator with an attachment's file (as an upload leaves it: the file in the media folder,
        named by its SHA-256)."""
        import hashlib

        from app.services import backups
        from tests.sync_helpers import WEB, make_reminder, private_space

        root = backups.media_root()
        root.mkdir(parents=True, exist_ok=True)
        data = label.encode() * 50 + secrets.token_bytes(8)
        (root / hashlib.sha256(data).hexdigest()).write_bytes(data)
        client = self._client(self._operator)
        client.headers.update(WEB)
        _space, list_id = private_space(client)
        make_reminder(client, list_id, label)

    def content(self) -> Any:
        from app.db import SessionLocal
        from app.models import Reminder
        from app.services import backup_hooks, backups
        from app.vendor.nexsicherung import tools

        with SessionLocal() as db:
            titles = sorted(row.title for row in db.query(Reminder).filter(Reminder.deleted_at.is_(None)))
        files = sorted((rel, tools.sha256_file(full)) for rel, full in backup_hooks.media_files(backups.media_root()))
        return {"titles": titles, "files": files}

    def legacy_archive(self) -> tuple[Path, Any]:
        """A backup as nextasks 0.8.0 made it (``services/backups.create`` before the module): the same members and
        manifest, version 0.8.0, the old name."""
        self.add_content("from the old version")
        held = self.content()
        from app.services import backup_hooks, backups

        folder = backups.folder()
        folder.mkdir(parents=True, exist_ok=True)
        moment = datetime(2026, 10, 1, 3, 0, 0, tzinfo=UTC)
        target = folder / f"nextasks-{moment.strftime('%Y-%m-%d-%H%M%S')}.zip"
        backup_hooks.write_archive(target, {"version": "0.8.0", "created": moment.isoformat(timespec="seconds"),
                                            "kind": "scheduled", "note": ""})
        # 0.8.0 wrote the manifest as its dataclass: every field, in this order.
        with zipfile.ZipFile(target) as archive:
            manifest = json.loads(archive.read(backup_hooks.MANIFEST))
            members = [(info, archive.read(info)) for info in archive.infolist() if info.filename != backup_hooks.MANIFEST]
        old = {key: manifest[key] for key in ("version", "created", "kind", "note", "tasks", "files", "bytes", "media")}
        os.remove(target)
        with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
            for info, data in members:
                archive.writestr(info, data)
            archive.writestr(backup_hooks.MANIFEST, json.dumps(old, ensure_ascii=False))
        return target, held

    def settings_schedule(self) -> tuple[str, int]:
        found = self.operator().get("/api/settings").json()
        return found["backup_schedule"], found["backup_keep"]
