"""Every test run gets its own empty data directory; nothing touches ``data/`` of the project."""

from __future__ import annotations

import os
import tempfile
from collections.abc import Iterator

_DATA = tempfile.mkdtemp(prefix="nextasks-tests-")
os.environ["NEXTASKS_DATA_DIR"] = _DATA
os.environ["NEXTASKS_DISABLE_BACKGROUND"] = "1"
os.environ["NEXTASKS_FRONTEND_DIST"] = os.path.join(_DATA, "no-frontend")
# Set, not removed: a value in the environment wins over a .env file in the project, a removed one does not.
os.environ["NEXTASKS_MEDIA_DIR"] = os.path.join(_DATA, "media")
os.environ["NEXTASKS_LOCALES_DIR"] = os.path.join(_DATA, "locales")
os.environ["NEXTASKS_LOG_LEVEL"] = ""
os.environ["NEXTASKS_API_DOCS"] = "false"
# Argon2 as cheap as it goes: the tests make many accounts. The strength itself is Argon2's business.
os.environ["NEXTASKS_ARGON2_TIME"] = "1"
os.environ["NEXTASKS_ARGON2_MEMORY_KIB"] = "1024"
os.environ["NEXTASKS_ARGON2_PARALLELISM"] = "1"
# Never GitHub from a test: port 9 refuses at once.
os.environ["NEXTASKS_UPDATE_URL"] = "http://127.0.0.1:9/releases/latest"
# Never the real push relay: port 9 refuses at once; the push tests put a recorder in its place.
os.environ["NEXTASKS_PUSH_RELAY"] = "http://127.0.0.1:9"
os.environ["NEXTASKS_SECRET_KEY"] = "test-secret-key-for-the-test-run-only"
SETUP_CODE = "test-setup-code"
os.environ["NEXTASKS_SETUP_TOKEN"] = SETUP_CODE

import shutil  # noqa: E402
from pathlib import Path  # noqa: E402

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import delete  # noqa: E402

from app.db import SessionLocal, init_db  # noqa: E402
from app.main import app  # noqa: E402
from app.models import MEMBER, OPERATOR, Account, Base, Setting  # noqa: E402
from app.routers import app1  # noqa: E402
from app.security import SESSION_COOKIE, brake, hash_password, start_session  # noqa: E402
from app.services import clock, devices, emailaddr, notify, totp, updates  # noqa: E402

DATA_DIR = _DATA
MEDIA = Path(_DATA) / "media"
TAB = {"X-Nextasks-Client": "tab-tests000"}


@pytest.fixture(scope="session", autouse=True)
def schema() -> None:
    init_db()


@pytest.fixture(autouse=True)
def clean_db(schema: None) -> Iterator[None]:
    with SessionLocal() as db:
        for table in reversed(Base.metadata.sorted_tables):
            db.execute(delete(table))
        db.execute(delete(Setting))
        db.commit()
    assert MEDIA.resolve().is_relative_to(Path(_DATA).resolve())
    shutil.rmtree(MEDIA, ignore_errors=True)
    MEDIA.mkdir(parents=True)
    brake.forget()
    emailaddr.forget()
    totp.forget()
    updates.forget()
    clock.shift(0)
    app1.forget_private_cache()
    devices.forget()
    notify.INLINE = True
    yield
    app.dependency_overrides.clear()


PASSWORD = "correct horse battery"


def make_account(name: str, role: str = MEMBER, password: str = PASSWORD) -> Account:
    """An account with a password, straight into the database."""
    with SessionLocal() as db:
        row = Account(name=name, role=role, password_hash=hash_password(password))
        db.add(row)
        db.commit()
        db.expunge(row)
    return row


def sign_in(client: TestClient, account: Account) -> None:
    """The client carries a session of ``account`` from now on (a real one, as after signing in)."""
    with SessionLocal() as db:
        row = db.get(Account, account.id)
        assert row is not None
        token = start_session(db, row, "127.0.0.1", "tests")
    client.cookies.set(SESSION_COOKIE, token)


def new_client(account: Account | None = None) -> TestClient:
    """Another browser, signed in as ``account`` when one is given. Close it (``with``) when done."""
    client = TestClient(app, base_url="http://testserver", headers=TAB)
    if account is not None:
        sign_in(client, account)
    return client


def _operator(client: TestClient) -> Account:
    with SessionLocal() as db:
        row = db.query(Account).filter_by(name="tester").one_or_none()
        if row is not None:
            db.expunge(row)
    if row is None:
        row = make_account("tester", OPERATOR)
    sign_in(client, row)
    return row


@pytest.fixture
def client() -> Iterator[TestClient]:
    # As the interface does: every request names its tab (changes are refused without it).
    with TestClient(app, base_url="http://testserver", headers=TAB) as test_client:
        yield test_client


@pytest.fixture
def operator(client: TestClient) -> Account:
    """The signed-in operator ``tester``."""
    return _operator(client)


@pytest.fixture
def account(client: TestClient) -> Account:
    """The same as ``operator``, under the name the tests from nexlore use."""
    return _operator(client)
