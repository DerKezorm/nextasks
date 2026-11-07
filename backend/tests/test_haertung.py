"""Prüfgang 05.10.2026, block 5: the sign-in brake behind a proxy, device cookies, pictures, names and addresses with
control characters, an unchanged password."""

from __future__ import annotations

import io
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from app import deps
from app.config import get_settings
from app.db import SessionLocal
from app.main import app
from app.models import Account, utcnow
from app.security import DEVICE_COOKIE, brake, device_token

from .conftest import PASSWORD, make_account, new_client

NEW_PASSWORD = "another long password"


def _browser(host: str = "172.18.0.2") -> TestClient:
    """A browser behind the proxy nobody named: every one of them comes from the proxy's address."""
    return TestClient(app, base_url="http://testserver", headers={"X-Nextasks-Client": "tab-proxy00001"},
                      client=(host, 50000))


def _spray(count: int = 31) -> list[int]:
    """A stranger behind the same proxy tries one password against many names, with made-up X-Forwarded-For."""
    stranger = _browser()
    return [stranger.post("/api/auth/login", json={"name": f"guess{n}", "password": "summer2026"},
                          headers={"X-Forwarded-For": f"198.51.100.{n}"}).status_code for n in range(count)]


def _known(name: str, password: str = PASSWORD) -> TestClient:
    """A browser that signed in as ``name`` (and so holds its device cookie), signed out again."""
    brake.forget()
    browser = _browser()
    assert browser.post("/api/auth/login", json={"name": name, "password": password}).status_code == 200
    assert browser.cookies.get(DEVICE_COOKIE)
    browser.post("/api/auth/logout")
    return browser


def _sign_in(browser: TestClient, name: str, password: str = PASSWORD) -> None:
    brake.forget()
    assert browser.post("/api/auth/login", json={"name": name, "password": password}).status_code == 200


def _passes(browser: TestClient, name: str, password: str = PASSWORD) -> int:
    """After a stranger's guesses from the same address: in (200), or waiting like everybody (429)."""
    brake.forget()
    assert 429 in _spray()
    return browser.post("/api/auth/login", json={"name": name, "password": password}).status_code


# --- A5: the brake per sender always counts ---------------------------------------------------------------------------


def test_a5_a_made_up_forwarded_header_does_not_switch_off_the_brake_across_names(client: TestClient) -> None:
    """Without trusted proxies any X-Forwarded-For took the brake per sender away, and one password could be tried
    against any number of names (40 of 40 answered 401). The header is ignored then, the connection counts."""
    sprayer = _browser("203.0.113.66")
    answers = [sprayer.post("/api/auth/login", json={"name": f"name{n}", "password": "summer2026"},
                            headers={"X-Forwarded-For": f"198.51.100.{n}"}).status_code for n in range(40)]
    assert 429 in answers and answers.index(429) <= 32


def test_a5_a_browser_known_to_that_name_passes_a_strangers_guessing(client: TestClient, operator: Account) -> None:
    make_account("anna")
    make_account("bob")
    own = _known("anna")
    assert _passes(own, "anna") == 200
    own.post("/api/auth/logout")
    # Without that browser, with a made-up cookie or with one given to another name: the sender waits.
    assert _passes(_browser(), "anna") == 429
    forged = _browser()
    with SessionLocal() as db:
        anna_id = db.query(Account).filter_by(name="anna").one().id
    forged.cookies.set(DEVICE_COOKIE, f"{anna_id}.abc." + "0f" * 16, path="/api/auth")
    assert _passes(forged, "anna") == 429
    other = _browser()
    with SessionLocal() as db:
        bob = db.query(Account).filter_by(name="bob").one()
        other.cookies.set(DEVICE_COOKIE, device_token(db, bob), path="/api/auth")
    assert _passes(other, "anna") == 429
    # The count per name stays for the known browser too.
    brake.forget()
    tries = [own.post("/api/auth/login", json={"name": "anna", "password": "wrong guess"}).status_code
             for _ in range(12)]
    assert 429 in tries


def _spray_name(name: str, count: int = 12) -> list[int]:
    """A stranger behind the same proxy guesses the password of one name only."""
    stranger = _browser()
    return [stranger.post("/api/auth/login", json={"name": name, "password": f"guess {n}"}).status_code
            for n in range(count)]


@pytest.mark.parametrize("name", ["tester", "anna"])
def test_a5_a_stranger_guessing_that_very_name_does_not_keep_its_known_browser_out(client: TestClient,
                                                                                   operator: Account,
                                                                                   name: str) -> None:
    """Behind a proxy nobody named, everybody has one address: the count per address and name would hold the own
    browser too after five guesses at the operator's (or the emergency account's) name. For a browser with a device
    cookie of that name the count per name goes with the browser."""
    if name != "tester":
        make_account(name)
    own = _known(name)
    brake.forget()
    assert 429 in _spray_name(name)
    without = _browser().post("/api/auth/login", json={"name": name, "password": PASSWORD})
    assert without.status_code == 429, "without the cookie the sender waits"
    assert own.post("/api/auth/login", json={"name": name, "password": PASSWORD}).status_code == 200


def test_a5_the_known_browser_is_still_slowed_by_its_own_wrong_passwords(client: TestClient,
                                                                         operator: Account) -> None:
    own = _known("tester")
    brake.forget()
    tries = [own.post("/api/auth/login", json={"name": "tester", "password": f"wrong {n}"}).status_code
             for n in range(8)]
    assert tries[:5] == [401] * 5 and 429 in tries
    # The count is its own: another name from the same browser is not held by it.
    make_account("anna")
    assert own.post("/api/auth/login", json={"name": "anna", "password": PASSWORD}).status_code == 200


def test_a5_a_device_cookie_with_an_endless_account_number_is_no_cookie(client: TestClient, operator: Account) -> None:
    browser = _browser("192.0.2.77")
    browser.cookies.set(DEVICE_COOKIE, "9" * 40 + ".abc." + "0f" * 16, path="/api/auth")
    assert browser.post("/api/auth/login", json={"name": "tester", "password": PASSWORD}).status_code == 200


def test_a5_the_operator_hears_of_a_proxy_nobody_named(client: TestClient, operator: Account,
                                                       monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(deps, "_warned_unknown_proxy", False)
    assert client.get("/api/settings").json()["proxy_unknown"] is False
    assert client.get("/api/settings", headers={"X-Real-IP": "198.51.100.4"}).json()["proxy_unknown"] is True
    # Remembered for the next visit without the header, and gone once the proxy is named.
    assert client.get("/api/settings").json()["proxy_unknown"] is True
    monkeypatch.setattr(get_settings(), "trusted_proxies", "172.16.0.0/12")
    assert client.get("/api/settings", headers={"X-Forwarded-For": "198.51.100.4"}).json()["proxy_unknown"] is False
    with new_client(make_account("anna")) as member:
        assert member.get("/api/settings").status_code == 403


# --- A5: a device cookie holds only for its account as it was ---------------------------------------------------------


def test_a5_a_new_password_forgets_the_browsers_but_the_one_that_changed_it(client: TestClient,
                                                                             operator: Account) -> None:
    make_account("anna")
    old = _known("anna")
    changer = _browser()
    _sign_in(changer, "anna")
    assert changer.put("/api/auth/password", json={"current": PASSWORD, "new": NEW_PASSWORD}).status_code == 204
    changer.post("/api/auth/logout")
    assert _passes(old, "anna", NEW_PASSWORD) == 429
    assert _passes(changer, "anna", NEW_PASSWORD) == 200


def test_a5_a_device_cookie_from_before_a_new_password_does_not_open_the_lock(client: TestClient,
                                                                              operator: Account) -> None:
    from app.security import MAX_FAILURES

    make_account("anna")
    old = _known("anna")
    changer = _browser()
    _sign_in(changer, "anna")
    changer.put("/api/auth/password", json={"current": PASSWORD, "new": NEW_PASSWORD})
    with SessionLocal() as db:
        row = db.query(Account).filter_by(name="anna").one()
        row.failed_logins, row.locked_until = MAX_FAILURES, utcnow() + timedelta(minutes=10)
        db.commit()
    brake.forget()
    assert old.post("/api/auth/login", json={"name": "anna", "password": NEW_PASSWORD}).status_code == 401
    assert changer.post("/api/auth/login", json={"name": "anna", "password": NEW_PASSWORD}).status_code == 200


@pytest.mark.parametrize("way", ["block", "password", "sign-out", "totp-reset"])
def test_a5_what_the_operator_does_to_an_account_forgets_its_browsers(client: TestClient, operator: Account,
                                                                      way: str) -> None:
    anna = make_account("anna")
    browser = _known("anna")
    confirm = {"current_password": PASSWORD}
    if way == "block":
        for path in ("block", "unblock"):
            assert client.post(f"/api/accounts/{anna.id}/{path}", json=confirm).status_code == 204
    elif way == "password":
        answer = client.put(f"/api/accounts/{anna.id}/password", json={**confirm, "password": PASSWORD})
        assert answer.status_code == 204
    elif way == "sign-out":
        assert client.post(f"/api/accounts/{anna.id}/sign-out").status_code == 204
    else:
        with SessionLocal() as db:
            row = db.get(Account, anna.id)
            assert row is not None
            row.totp_secret_enc = "sealed seed"
            db.commit()
        assert client.post(f"/api/accounts/{anna.id}/totp/reset", json=confirm).status_code == 200
    assert _passes(browser, "anna") == 429, way


def test_a5_signing_out_everywhere_forgets_the_others_and_keeps_this_one(client: TestClient,
                                                                         operator: Account) -> None:
    make_account("anna")
    other, keeper = _known("anna"), _browser()
    _sign_in(keeper, "anna")
    assert keeper.post("/api/auth/logout-all").status_code == 204
    keeper.post("/api/auth/logout")
    assert _passes(other, "anna") == 429
    assert _passes(keeper, "anna") == 200


def test_a5_a_new_account_under_the_id_of_a_deleted_one_knows_none_of_its_browsers(client: TestClient,
                                                                                   operator: Account) -> None:
    gone = make_account("zoe")
    browser = _known("zoe")
    deleted = client.request("DELETE", f"/api/accounts/{gone.id}", json={"current_password": PASSWORD})
    assert deleted.status_code == 204
    after = make_account("zora")
    assert after.id == gone.id, "SQLite gives the id of the deleted last account again"
    assert _passes(browser, "zora") == 429


# --- A7: pixels are counted before a picture is decoded ---------------------------------------------------------------


def _picture(kind: str, width: int, height: int) -> bytes:
    from PIL import Image

    if kind == "HEIF":
        import pillow_heif

        pillow_heif.register_heif_opener()
    out = io.BytesIO()
    mode = "1" if kind in ("PNG", "BMP", "GIF") else "L"
    Image.new(mode, (width, height)).save(out, kind)
    return out.getvalue()


# --- A13: control characters in names and mail addresses --------------------------------------------------------------


@pytest.mark.parametrize("address", ["anna@example.com\n", "anna@example.com\nBcc: x@example.com",
                                     "anna@example.com\r"])
def test_a13_the_mail_pattern_ends_at_the_end(address: str) -> None:
    """Every caller strips the address first; the pattern itself does not let a closing line break pass either."""
    from app.services import accounts

    assert accounts.EMAIL_PATTERN.match(address) is None
    assert accounts.EMAIL_PATTERN.match("anna@example.com") is not None


@pytest.mark.parametrize("name", ["Anna\x85Berg", "Anna\x9b31m", "Anna\x00", "Anna\x1b[31m", "Anna\x7f",
                                  "Anna\u202eBerg", "Anna\u200b"])
def test_a13_a_display_name_with_a_control_or_format_character_is_refused(client: TestClient, operator: Account,
                                                                         name: str) -> None:
    answer = client.put("/api/me/profile", json={"display_name": name})
    assert answer.status_code == 422 and answer.json()["detail"]["code"] == "display_name_invalid"


# --- E25: the same password is no new one -----------------------------------------------------------------------------


def test_e25_the_current_password_is_no_new_one_and_ends_nothing(client: TestClient, operator: Account) -> None:
    with new_client(operator) as other:
        answer = client.put("/api/auth/password", json={"current": PASSWORD, "new": PASSWORD})
        assert answer.status_code == 422 and answer.json()["detail"]["code"] == "password_unchanged"
        assert other.get("/api/auth/me").status_code == 200, "the other session goes on"
        assert client.put("/api/auth/password", json={"current": PASSWORD, "new": NEW_PASSWORD}).status_code == 204
        assert other.get("/api/auth/me").status_code == 401

