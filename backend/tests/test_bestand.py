"""Test "Bestand": every way in that worked in 0.8.0 still works in the running version.

The database comes from 0.8.0 itself (``tests/bestand/build.py``, stored as ``bestand-0.8.0.sql.gz``; the accounts
and their test values in ``bestand-0.8.0.json``). Each test loads it in place of the test database and then starts
the schema upkeep exactly as a container start after an update does (``init_db``). Then it signs in the way each
account could before: name and password (any case), second factor and recovery code, a provider, an open browser
session, a paired iPhone, an API token (and the member list nexmail reads with it), open invitations into nextasks
and into a space (with a new account and with the signed-in one), an address waiting for its link, a password the
operator set.

**Nothing here may be adapted to make a new version pass.** A red test means: an installation that runs 0.8.0 today
loses a way in after the update. Change the code, not the test. The only part that may change is the block at the
end (``AFTER_THE_CHANGE``): ways in that 0.8.0 did not have and that the shared account module brings. When the
module is wired in they pass, ``strict`` turns that red, and whoever wired it removes the marker.

**The fixture ages.** Sessions, invitations and links run out; loading pushes those dates into the future, nothing else
is touched before the start.
"""

from __future__ import annotations

import gzip
import json
import sqlite3
import tempfile
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from urllib.parse import urlencode, urlsplit

import pytest
from fastapi.testclient import TestClient

from app.db import SessionLocal, engine, init_db
from app.main import app
from app.models import Account, Member
from app.security import MAX_FAILURES, SESSION_COOKIE
from app.services import post_store, settings_service, totp
from app.vendor import nexoidc
from app.vendor.nexoidc import attempt, protocol

from .bestand.build import PUBLIC, dump_file, manifest_file, totp_seed
from .oidc_helpers import fakes

MANIFEST = json.loads(manifest_file().read_text(encoding="utf-8"))
ACCOUNTS: list[dict[str, Any]] = MANIFEST["accounts"]
PROVIDER = MANIFEST["provider"]
FAMILY = MANIFEST["family"]
TAB = {"X-Nextasks-Client": "tab-bestand0"}
NEW_PASSWORD = "Bestand-ganz-neu-2026"

WITH_PASSWORD = [a for a in ACCOUNTS if a["password"] and not a.get("blocked")]
WITH_FACTOR = [a for a in ACCOUNTS if a.get("second_factor")]
WITH_PROVIDER = [a for a in ACCOUNTS if a.get("provider")]
MEMBERS_WITH_PASSWORD = [a for a in WITH_PASSWORD if not a.get("operator")]
_COUNT: dict[str, int] = {}
for _a in ACCOUNTS:
    if _a["email"]:
        _COUNT[_a["email"].lower()] = _COUNT.get(_a["email"].lower(), 0) + 1
UNIQUE_CONFIRMED = [a for a in WITH_PASSWORD if a["email_confirmed"] and _COUNT[a["email"].lower()] == 1]
SHARED_ADDRESS = [a for a in WITH_PASSWORD if a["email"] and _COUNT[a["email"].lower()] > 1]

#: The tables whose rows the start must leave as they are (nothing renamed, nothing deleted).
COUNTED = ("accounts", "spaces", "members", "lists", "auth_sessions", "invites", "api_tokens", "app_devices",
           "oidc_providers", "oidc_links", "settings")


def _name(account: dict[str, Any]) -> str:
    return str(account["name"])


def _schema(path: Path) -> tuple[dict[str, set[str]], dict[str, int]]:
    plain = sqlite3.connect(str(path))
    try:
        tables = [row[0] for row in plain.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")]
        columns = {t: {row[1] for row in plain.execute(f'PRAGMA table_info("{t}")')} for t in tables}
        # Table names from COUNTED, never from outside.
        counts = {t: plain.execute(f'SELECT count(*) FROM "{t}"').fetchone()[0] for t in COUNTED if t in columns}  # noqa: S608
    finally:
        plain.close()
    return columns, counts


@pytest.fixture
def bestand() -> tuple[dict[str, set[str]], dict[str, int]]:
    """The 0.8.0 database in place of the test database, then the start of the running version. Gives what the old
    database held (columns per table, rows per counted table), read before the start."""
    folder = Path(tempfile.mkdtemp(prefix="nextasks-bestand-load-"))
    loaded = folder / "bestand.db"
    plain = sqlite3.connect(str(loaded))
    try:
        plain.executescript(gzip.decompress(dump_file().read_bytes()).decode("utf-8"))
        plain.execute("UPDATE auth_sessions SET expires_at = datetime('now', '+30 days')")
        plain.execute("UPDATE invites SET expires_at = datetime('now', '+7 days')")
        plain.execute("UPDATE accounts SET email_pending_until = datetime('now', '+20 hours') WHERE email_pending <> ''")
        # A paired device rests after 365 days unused.
        plain.execute("UPDATE app_devices SET last_seen_at = datetime('now')")
        plain.commit()
    finally:
        plain.close()
    before = _schema(loaded)
    engine.dispose()
    source = sqlite3.connect(str(loaded))
    into = sqlite3.connect(engine.url.database)
    try:
        source.backup(into)
    finally:
        source.close()
        into.close()
    engine.dispose()
    init_db()
    return before


@pytest.fixture
def provider() -> Iterator[Any]:
    network = fakes.Network()
    nexoidc.use_transport(network.transport())
    protocol.clear_caches()
    attempt.forget_used_states()
    fake = network.add(fakes.FakeProvider(PROVIDER["issuer"], client_id=PROVIDER["client_id"],
                                          client_secret=PROVIDER["client_pass"]))
    yield fake
    nexoidc.use_transport(None)
    protocol.clear_caches()
    attempt.forget_used_states()


@pytest.fixture
def post(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, Any]]:
    """Mail is set up (the fixture has none) and goes into a list instead of out."""
    sent: list[tuple[str, Any]] = []
    # Every system mail goes through the shared post module since post 1.1.0 (``post_store.send_letter``).
    monkeypatch.setattr(post_store, "send_letter", lambda _db, letter, *a, **k: sent.append((letter.to, letter)))
    with SessionLocal() as db:
        settings_service.save(db, {"smtp_host": "mail.example.com", "smtp_from": "tasks@example.com"})
    return sent


_hosts = iter(range(1, 250))


def browser() -> TestClient:
    """A browser of its own, from an address of its own (the brakes per address are not what these tests are about),
    at the public https address of the fixture (its cookies are Secure)."""
    return TestClient(app, base_url=PUBLIC, headers=TAB, follow_redirects=False,
                      client=(f"203.0.113.{next(_hosts)}", 50000))


def me(client: TestClient) -> dict[str, Any] | None:
    answer = client.get("/api/auth/me")
    return answer.json() if answer.status_code == 200 else None


def with_password(client: TestClient, account: dict[str, Any], typed: str | None = None,
                  password: str | None = None) -> None:
    """The sign-in form of 0.8.0: field ``name``, then the code when the account has a second factor."""
    answer = client.post("/api/auth/login", json={"name": typed or _name(account),
                                                  "password": password or account["password"]})
    assert answer.status_code == 200, (_name(account), answer.status_code, answer.text)
    if answer.json().get("second_factor"):
        code = totp.code_at(totp_seed(account["second_factor"]), time.time())
        second = client.post("/api/auth/login/totp", json={"code": code})
        assert second.status_code == 200, (_name(account), second.text)


def refused(typed: str, password: str) -> int:
    return browser().post("/api/auth/login", json={"name": typed, "password": password}).status_code


def through_provider(client: TestClient, fake: Any, person: dict[str, Any]) -> Any:
    fake.person = dict(person)
    start = client.get(f"/api/oidc/{PROVIDER['slug']}/start")
    assert start.status_code in (302, 303, 307), start.text
    at_provider = start.headers["location"]
    path = urlsplit(fakes.query_of(at_provider)["redirect_uri"]).path
    return client.get(f"{path}?{urlencode(fake.authorize(at_provider))}")


def members_of_family() -> set[str]:
    with SessionLocal() as db:
        ids = {row.account_id for row in db.query(Member).filter_by(space_id=FAMILY)}
        return {row.name for row in db.query(Account).filter(Account.id.in_(ids))}


# --- The start after the update ---------------------------------------------------------------------------------------


def test_the_fixture_is_from_0_8_0() -> None:
    assert MANIFEST["version"] == "0.8.0"
    raw = gzip.decompress(dump_file().read_bytes()).decode("utf-8")
    assert 'CREATE TABLE "accounts"' in raw or "CREATE TABLE accounts" in raw


def test_the_start_only_adds(bestand: tuple[dict[str, set[str]], dict[str, int]]) -> None:
    """Rule 10 of the draft: new columns with a default, nothing renamed or deleted, no row lost."""
    columns_before, counts_before = bestand
    columns_after, counts_after = _schema(Path(engine.url.database))
    for table, columns in columns_before.items():
        assert table in columns_after, f"table {table} is gone"
        missing = columns - columns_after[table]
        assert not missing, f"{table}: columns gone {sorted(missing)}"
    assert counts_after == counts_before


def test_every_account_is_still_there_with_its_name_address_and_spaces(bestand: Any) -> None:
    with SessionLocal() as db:
        rows = {row.name: row for row in db.query(Account).all()}
        assert set(rows) == {_name(a) for a in ACCOUNTS}
        for account in ACCOUNTS:
            row = rows[_name(account)]
            assert row.email == account["email"], _name(account)
            confirmed = bool(row.email) and row.email.casefold() == (row.email_confirmed or "").casefold()
            assert confirmed == account["email_confirmed"], _name(account)
            assert bool(row.password_hash) == bool(account["password"]), _name(account)
            assert bool(row.totp_secret_enc) == bool(account.get("second_factor")), _name(account)
            assert (row.blocked_at is not None) == bool(account.get("blocked")), _name(account)
    assert members_of_family() == {_name(a) for a in ACCOUNTS if FAMILY in a.get("spaces", [])}


# --- Name and password ------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("account", WITH_PASSWORD, ids=_name)
def test_name_and_password_still_sign_in(bestand: Any, account: dict[str, Any]) -> None:
    client = browser()
    with_password(client, account)
    assert (me(client) or {}).get("name") == _name(account)


@pytest.mark.parametrize("account", MEMBERS_WITH_PASSWORD, ids=_name)
def test_the_name_in_capitals_still_signs_in(bestand: Any, account: dict[str, Any]) -> None:
    client = browser()
    with_password(client, account, typed=f"  {_name(account).upper()} ")
    assert (me(client) or {}).get("name") == _name(account)


@pytest.mark.parametrize("account", WITH_PASSWORD, ids=_name)
def test_a_wrong_password_is_still_refused(bestand: Any, account: dict[str, Any]) -> None:
    assert refused(_name(account), account["password"] + "x") == 401


@pytest.mark.parametrize("account", WITH_FACTOR, ids=_name)
def test_a_recovery_code_still_stands_in_for_the_app(bestand: Any, account: dict[str, Any]) -> None:
    client = browser()
    first = client.post("/api/auth/login", json={"name": _name(account), "password": account["password"]})
    assert first.status_code == 200 and first.json()["second_factor"], first.text
    assert me(client) is None
    second = client.post("/api/auth/login/totp", json={"code": account["recovery_codes"][0]})
    assert second.status_code == 200, second.text
    assert (me(client) or {}).get("name") == _name(account)


def test_a_blocked_account_still_gets_no_session(bestand: Any) -> None:
    blocked = next(a for a in ACCOUNTS if a.get("blocked"))
    client = browser()
    answer = client.post("/api/auth/login", json={"name": _name(blocked), "password": blocked["password"]})
    assert answer.status_code in (401, 403), answer.text
    assert me(client) is None


def test_a_deleted_account_stays_gone(bestand: Any) -> None:
    deleted = MANIFEST["deleted"]
    assert refused(deleted["name"], deleted["password"]) == 401


def test_a_password_the_operator_set_still_signs_in(bestand: Any) -> None:
    """0.8.0's only way back for a forgotten password: the operator set a new one. It holds after the change."""
    account = next(a for a in ACCOUNTS if a["name"] == "jonas")
    client = browser()
    with_password(client, account)
    assert (me(client) or {}).get("name") == "jonas"


def test_password_sign_in_switched_off_still_keeps_members_out_and_lets_the_operator_in(bestand: Any) -> None:
    with SessionLocal() as db:
        settings_service.save(db, {"password_login": False})
    for account in WITH_PASSWORD:
        client = browser()
        if account.get("operator"):
            with_password(client, account)
            assert (me(client) or {}).get("name") == _name(account)
        else:
            answer = client.post("/api/auth/login", json={"name": _name(account), "password": account["password"]})
            assert answer.status_code in (401, 403), (_name(account), answer.text)
            assert me(client) is None


def test_the_lock_after_wrong_passwords_still_holds_per_account(bestand: Any) -> None:
    """Wrong passwords from many addresses lock the account, not the address (0.8.0: ``MAX_FAILURES``); the module's
    ``authenticate`` has no lock, so the app has to keep this one."""
    account = next(a for a in MEMBERS_WITH_PASSWORD if not a.get("second_factor"))
    for _ in range(MAX_FAILURES):
        assert refused(_name(account), "wrong-wrong-wrong") == 401
    assert refused(_name(account), account["password"]) == 401


@pytest.mark.parametrize("account", [a for a in WITH_PROVIDER if not a["password"]], ids=_name)
def test_an_account_without_a_password_still_has_none(bestand: Any, account: dict[str, Any]) -> None:
    for attempt_ in ("-", " ", _name(account), "Bestand-anna-2026"):
        assert refused(_name(account), attempt_) == 401


# --- Providers --------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("account", WITH_PROVIDER, ids=_name)
def test_the_provider_still_signs_in(bestand: Any, provider: Any, account: dict[str, Any]) -> None:
    client = browser()
    back = through_provider(client, provider, account["provider"])
    assert back.status_code in (302, 303), back.text
    assert "error" not in back.headers["location"], back.headers["location"]
    assert (me(client) or {}).get("name") == _name(account)


# --- What is signed in already, and what other apps read --------------------------------------------------------------


def test_an_open_browser_session_stays_open(bestand: Any) -> None:
    account = next(a for a in ACCOUNTS if a.get("session"))
    client = browser()
    client.cookies.set(SESSION_COOKIE, account["session"])
    assert (me(client) or {}).get("name") == _name(account)


def test_a_paired_iphone_stays_paired_and_hears_its_username(bestand: Any) -> None:
    account = next(a for a in ACCOUNTS if a.get("device"))
    answer = browser().get("/api/app/1/me", headers={"Authorization": f"Bearer {account['device']}"})
    assert answer.status_code == 200, answer.text
    assert answer.json()["account"]["username"] == _name(account)


def test_an_api_token_keeps_working(bestand: Any) -> None:
    account = next(a for a in ACCOUNTS if a.get("api_token"))
    answer = browser().get("/api/v1/me", headers={"Authorization": f"Bearer {account['api_token']}"})
    assert answer.status_code == 200, answer.text
    assert answer.json()["name"] == _name(account)


def test_the_member_list_nexmail_reads_keeps_its_fields(bestand: Any) -> None:
    """``GET /api/v1/spaces/{id}/members`` (nexmail): the same people, by id, with ``name`` and ``display_name``."""
    account = next(a for a in ACCOUNTS if a.get("api_token"))
    answer = browser().get(f"/api/v1/spaces/{FAMILY}/members",
                           headers={"Authorization": f"Bearer {account['api_token']}"})
    assert answer.status_code == 200, answer.text
    people = answer.json()["members"]
    assert {person["name"] for person in people} == members_of_family()
    for person in people:
        assert set(person) >= {"id", "name", "display_name", "role"}
        assert person["display_name"]


# --- Invitations and addresses ----------------------------------------------------------------------------------------


@pytest.mark.parametrize("invite", MANIFEST["open_invites"],
                         ids=lambda i: ("space-" if i["space"] else "") + (i["email"] or "no-address"))
def test_an_open_invitation_still_makes_an_account_with_the_fields_of_0_8_0(bestand: Any, invite: dict) -> None:
    """The request of 0.8.0: ``name`` and ``password``, nothing else (an open tab, the mail of yesterday). The module
    wants a display name; the route has to do without one. An invitation into a space makes a member there."""
    client = browser()
    assert client.get(f"/api/invite/{invite['token']}").status_code == 200
    made = client.post(f"/api/invite/{invite['token']}", json={"name": "neu.gast", "password": NEW_PASSWORD})
    assert made.status_code == 200, made.text
    own = me(client) or {}
    assert own.get("name") == "neu.gast"
    assert own.get("email") == invite["email"]
    if invite["space"]:
        assert "neu.gast" in members_of_family()
    again = browser()
    with_password(again, {"name": "neu.gast", "password": NEW_PASSWORD})
    assert (me(again) or {}).get("name") == "neu.gast"


def test_an_open_invitation_into_a_space_still_takes_the_signed_in_account(bestand: Any) -> None:
    join = MANIFEST["join_signed_in"]
    account = next(a for a in ACCOUNTS if a["name"] == join["who"])
    client = browser()
    with_password(client, account)
    answer = client.post(f"/api/invites/{join['token']}/accept")
    assert answer.status_code == 200, answer.text
    assert answer.json()["space_id"] == join["space"]
    assert join["who"] in members_of_family()


def test_an_address_waiting_for_its_link_is_still_confirmed_by_it(bestand: Any) -> None:
    account = next(a for a in ACCOUNTS if a.get("pending_link"))
    answer = browser().post("/api/email/confirm", json={"token": account["pending_link"]})
    assert answer.status_code == 200, answer.text
    with SessionLocal() as db:
        row = db.query(Account).filter_by(name=_name(account)).one()
        assert row.email == account["pending_email"] == row.email_confirmed


def test_a_shared_address_never_signs_in(bestand: Any) -> None:
    """True in 0.8.0 (no sign-in by address at all) and after the change (rule 3)."""
    for account in SHARED_ADDRESS:
        assert refused(account["email"], account["password"]) in (401, 422)


def test_an_unconfirmed_address_never_signs_in(bestand: Any) -> None:
    """An address an invitation or a provider brought and nobody confirmed: no way in, before and after (the draft:
    "nur bestätigte Adressen")."""
    for account in WITH_PASSWORD:
        if account["email"] and not account["email_confirmed"]:
            assert refused(account["email"], account["password"]) in (401, 422), _name(account)


# --- After the change (account module): what 0.8.0 did not do ---------------------------------------------------------

AFTER_THE_CHANGE = pytest.mark.xfail(strict=True, reason="comes with the account module (nexkonten)")


@pytest.mark.parametrize("account", UNIQUE_CONFIRMED, ids=_name)
def test_after_the_change_a_unique_confirmed_address_signs_in(bestand: Any, account: dict[str, Any]) -> None:
    client = browser()
    with_password(client, account, typed=account["email"].upper())
    assert (me(client) or {}).get("name") == _name(account)


@pytest.mark.parametrize("account", UNIQUE_CONFIRMED, ids=_name)
def test_after_the_change_forgot_password_mails_a_link(bestand: Any, post: list, account: dict[str, Any]) -> None:
    answer = browser().post("/api/auth/forgot", json={"name": _name(account)})
    assert answer.status_code == 202, answer.text
    assert [to.lower() for to, _message in post] == [account["email"].lower()]


def test_after_the_change_mcp_is_off_and_an_api_token_opens_only_the_api(bestand: Any) -> None:
    """mcp 1.1.0: 0.8.0 had no MCP, so every installation starts with it off (decision 5); an API token of 0.8.0
    never opens it and keeps opening ``/api/v1``."""
    account = next(a for a in ACCOUNTS if a.get("api_token"))
    key = {"Authorization": f"Bearer {account['api_token']}"}
    answer = browser().post("/api/mcp", headers=key, json={"jsonrpc": "2.0", "id": 1, "method": "ping"})
    assert answer.status_code == 404, answer.text
    with SessionLocal() as db:
        settings_service.save(db, {"mcp_enabled": True})
    answer = browser().post("/api/mcp", headers=key, json={"jsonrpc": "2.0", "id": 1, "method": "ping"})
    assert answer.status_code == 401, answer.text
    assert browser().get("/api/v1/me", headers=key).status_code == 200


def test_after_the_change_nextasks_describes_itself_to_other_nex_apps_and_the_typed_in_key_works_on(
    bestand: Any,
) -> None:
    """verbinden 0.1.1: ``/.well-known/nex-app`` names nextasks and that it connects (the operator's switch, on from the
    start, V1 7a); the API key another app typed in under 0.8.0 keeps opening ``/api/v1`` beside it."""
    found = browser().get("/.well-known/nex-app")
    assert found.status_code == 200, found.text
    assert found.json()["app"] == "nextasks" and found.json()["connect"] is True
    account = next(a for a in ACCOUNTS if a.get("api_token"))
    assert browser().get("/api/v1/me", headers={"Authorization": f"Bearer {account['api_token']}"}).status_code == 200
