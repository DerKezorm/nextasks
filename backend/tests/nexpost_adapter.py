"""nexpost contract tests: nextasks' adapter (copied once from the module's template, now nextasks' file).

The contract tests in ``backend/tests/nexpost/`` run the module against nextasks' real store
(``app.services.post_store``) over the operator's settings and the table ``mail_outbox``. The database is the one of
the test session (``tests/conftest.py`` empties it before every test).
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from post_contract import Legacy, StandardAdapter, password


class Adapter(StandardAdapter):
    package = "app.vendor.nexpost"

    def start(self) -> None:
        from app.services import post_store

        post_store.configure()

    def stop(self) -> None:
        from app.vendor import nexpost

        nexpost.use_smtp(None)

    @contextmanager
    def store(self) -> Iterator[Any]:
        from app.db import SessionLocal
        from app.services.post_store import PostStore

        with SessionLocal() as db:
            yield PostStore(db)

    def new_sign_in_letter(self, where: str, sender: str) -> Any:
        """An account with a confirmed address signs in through nextasks' route ``POST /api/auth/login`` from a browser
        it does not know; the letter nextasks queues for it (``kontenpost.queue``), caught with ``catch_mail``."""
        from fastapi.testclient import TestClient

        from app.db import SessionLocal
        from app.main import app
        from app.models import OPERATOR, SIGN_IN_PASSWORD, Account
        from app.security import hash_password
        from app.services import settings_service
        from app.vendor.nexpost import testing

        secret = password()
        with SessionLocal() as db:
            settings_service.save(db, {"smtp_host": "mail.example.com", "smtp_from": "tasks@example.com",
                                       "public_url": "https://tasks.example.com"})
            db.add(Account(name="kim", display_name="Kim", role=OPERATOR, sign_in=SIGN_IN_PASSWORD,
                           password_hash=hash_password(secret), email="kim@example.com",
                           email_confirmed="kim@example.com", timezone="Europe/Berlin"))
            db.commit()
        with testing.catch_mail() as caught, TestClient(app, client=(sender, 50000)) as client:
            answer = client.post("/api/auth/login", json={"name": "kim", "password": secret},
                                 headers={"X-Nextasks-Client": "tab-contract0", "User-Agent": where})
            assert answer.status_code == 200, answer.text
        [letter] = [letter for letter in caught.letters if letter.kind == "new_sign_in"]
        return letter

    def raw_text(self) -> str:
        from sqlalchemy import text

        from app.db import engine

        parts: list[str] = []
        with engine.connect() as connection:
            for table in ("settings", "mail_outbox"):
                parts += [repr(tuple(row)) for row in connection.execute(text(f"SELECT * FROM {table}"))]  # noqa: S608
        return "\n".join(parts)

    def legacy(self) -> Legacy:
        """The mail server as the settings page of 0.8.0 saved it (``PUT /api/settings``: the keys ``smtp_*``, the
        password sealed with the server's key); 0.8.0 had no outbox for system mail (its ``notify_outbox`` carries the
        reports and events and stays nextasks' own)."""
        from app.db import SessionLocal
        from app.security import encrypt_secret
        from app.services import settings_service
        from app.vendor.nexpost.model import MailSettings

        secret = password()
        with SessionLocal() as db:
            settings_service.save(db, {
                "smtp_host": "smtp.example.com",
                "smtp_port": 465,
                "smtp_security": "tls",
                "smtp_user": "tasks@example.com",
                "smtp_password_enc": encrypt_secret(secret),
                "smtp_from": "tasks@example.com",
            })
        return Legacy(
            settings=MailSettings(
                host="smtp.example.com",
                port=465,
                security="tls",
                user="tasks@example.com",
                password=secret,
                sender="tasks@example.com",
                sender_name="",
            ),
            queued=0,
        )

    def account(self, address: str, *, language: str, name: str, confirmed: bool) -> Any:
        """An account of nextasks with this address: confirmed means it counts (proven by its link, as in 0.8.0)."""
        from app.db import SessionLocal
        from app.models import MEMBER, Account
        from app.security import hash_password

        with SessionLocal() as db:
            row = Account(name=f"post{abs(hash(address)) % 10**8}", role=MEMBER, password_hash=hash_password(password()),
                          email=address, email_confirmed=address if confirmed else "", language=language,
                          display_name=name)
            db.add(row)
            db.commit()
            return row.id

    def client(self, role: str) -> Any:
        from app.models import MEMBER, OPERATOR
        from tests.conftest import make_account, new_client

        if role == "anonymous":
            return new_client()
        name = "postop" if role == "operator" else "postmember"
        return new_client(make_account(name, OPERATOR if role == "operator" else MEMBER))

