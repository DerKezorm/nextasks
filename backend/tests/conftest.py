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
#: At least 16 characters: the shared account module passes over a shorter NEXTASKS_SETUP_TOKEN.
SETUP_CODE = "test-setup-code-of-the-tests"
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
from app.services import clock, devices, emailaddr, gone, notify, totp, updates  # noqa: E402
from app.vendor.nexkonten import factor as konten_factor  # noqa: E402
from app.vendor.nexkonten import passkeys as konten_passkeys  # noqa: E402
from app.vendor.nexkonten import setup as konten_setup  # noqa: E402

DATA_DIR = _DATA
MEDIA = Path(_DATA) / "media"
TAB = {"X-Nextasks-Client": "tab-tests000"}


# The contract tests of the shared modules (``tests/nexoidc``, ``tests/nexkonten``, ``tests/nexpost``) bring their own
# ``conftest.py`` (unchanged from the modules, guarded by checksums). pytest loads them all as ``conftest``; whichever
# came last stands in ``sys.modules``, and ``from conftest import ...`` of a contract test then found another one's
# (in a parallel run, depending on the order). While collecting and before every test ``sys.modules["conftest"]``
# points to the ``conftest.py`` nearest to the test.
_CONFTESTS: dict[Path, object] = {}


def pytest_plugin_registered(plugin: object, manager: object) -> None:
    path = getattr(plugin, "__file__", None)
    if path and Path(path).name == "conftest.py":
        _CONFTESTS[Path(path).resolve().parent] = plugin


def _nearest_conftest(path: Path) -> None:
    import sys

    for folder in [Path(path).resolve(), *Path(path).resolve().parents]:
        module = _CONFTESTS.get(folder)
        if module is not None:
            sys.modules["conftest"] = module  # type: ignore[assignment]
            return


def pytest_collectstart(collector: pytest.Collector) -> None:
    if isinstance(collector, pytest.Module):
        _nearest_conftest(collector.path)


def pytest_runtest_setup(item: pytest.Item) -> None:
    _nearest_conftest(item.path)


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
    konten_factor.forget()
    konten_passkeys.forget()
    konten_setup.forget_generated_code()
    updates.forget()
    clock.shift(0)
    app1.forget_private_cache()
    devices.forget()
    gone.forget()
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


def purge_deleted(account_id: int) -> None:
    """A deleted account after its 30 days to bring it back: gone for good, as the hourly round leaves it
    (``manage.purge_due``, konten 1.1.0)."""
    from datetime import timedelta

    from app.services.konten_store import KontenStore
    from app.vendor.nexkonten import manage

    with SessionLocal() as db:
        row = db.get(Account, account_id)
        assert row is not None and row.deleted_at is not None, "deleted, not yet gone"
        row.deleted_at = row.deleted_at - timedelta(days=manage.DELETE_DAYS, minutes=1)
        db.commit()
        assert account_id in manage.purge_due(KontenStore(db))
