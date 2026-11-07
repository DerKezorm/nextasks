"""Pairing the iPhone app and what a device may (``vertrag-block1.md``, "Koppeln", "Betreiber-Schalter",
"Wer bin ich"): QR code and short code once, ``ntd_`` keys that open ``/api/app/1`` only, the operator's switches,
the rate, ``/me``."""

from __future__ import annotations

from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.main import app
from app.services import devices, settings_service

from .conftest import PASSWORD, make_account
from .sync_helpers import API, WEB, person

SECRET_HEADER = "X-Pairing-Secret"


def _pair(browser: TestClient, address: str = "https://tasks.example.com") -> dict:
    made = browser.post("/api/app-pairing", json={"address": address})
    assert made.status_code == 201, made.text
    return made.json()


def _device(browser: TestClient, name: str = "Anna's iPhone") -> tuple[str, TestClient]:
    pairing = _pair(browser)
    query = parse_qs(urlsplit(pairing["link"]).query)
    picked = TestClient(app, base_url="http://testserver").post(
        f"{API}/pairing/{pairing['id']}/key", json={"device": name}, headers={SECRET_HEADER: query["secret"][0]})
    assert picked.status_code == 200, picked.text
    key = picked.json()["key"]
    phone = TestClient(app, base_url="http://testserver", headers={"Authorization": f"Bearer {key}"})
    return key, phone


def test_the_qr_code_carries_address_pairing_and_secret_and_works_once() -> None:
    account, browser = person("anna")
    pairing = _pair(browser)
    link = urlsplit(pairing["link"])
    assert link.scheme == "nextasks" and link.netloc == "connect"
    query = parse_qs(link.query)
    assert query["address"] == ["https://tasks.example.com"] and query["pairing"] == [pairing["id"]]
    assert pairing["qr_svg"].startswith("<svg") and len(pairing["code"]) == 9 and pairing["code"][4] == "-"
    app_side = TestClient(app, base_url="http://testserver")
    picked = app_side.post(f"{API}/pairing/{pairing['id']}/key", json={"device": "iPhone 17"},
                           headers={SECRET_HEADER: query["secret"][0]})
    assert picked.status_code == 200 and picked.headers["cache-control"] == "no-store"
    assert picked.json()["key"].startswith("ntd_") and picked.json()["account"] == {"id": account.id, "name": "anna"}
    again = app_side.post(f"{API}/pairing/{pairing['id']}/key", json={}, headers={SECRET_HEADER: query["secret"][0]})
    assert again.status_code == 404 and again.json()["detail"]["code"] == "app_pairing_unknown"
    assert browser.get(f"/api/app-pairing/{pairing['id']}").json() == {"state": "connected", "device": "iPhone 17"}
    listed = browser.get("/api/app-devices").json()
    assert [row["name"] for row in listed] == ["iPhone 17"] and "last_seen" in listed[0]


def test_the_short_code_is_forgiving_in_its_spelling_and_wrong_ones_answer_alike() -> None:
    _account, browser = person("anna")
    pairing = _pair(browser)
    app_side = TestClient(app, base_url="http://testserver")
    wrong = app_side.post(f"{API}/pairing/code", json={"code": "AAAA-AAAA", "device": "x"})
    assert wrong.status_code == 404 and wrong.json()["detail"]["code"] == "app_pairing_unknown"
    typed = pairing["code"].lower().replace("-", " ")
    assert app_side.post(f"{API}/pairing/code", json={"code": typed, "device": "x"}).status_code == 200


def test_a_device_key_opens_the_app_surface_only_and_a_disconnected_one_nothing() -> None:
    _account, browser = person("anna")
    _key, phone = _device(browser)
    assert phone.get(f"{API}/webpush/key").status_code == 200, "the key pair is made at the first need"
    me = phone.get(f"{API}/me").json()
    assert me["device"]["name"] == "Anna's iPhone" and me["account"]["username"] == "anna"
    assert isinstance(me["now"], int) and me["limits"]["attachment_bytes"] == 50 * 1024 * 1024
    assert {"changes", "batch", "files", "wait", "invites", "webpush"} <= set(me["features"])
    assert phone.get("/api/auth/me").status_code == 401, "a device key is no session"
    assert phone.get("/api/accounts").status_code == 401
    assert phone.delete(f"{API}/device").status_code == 204
    gone = phone.get(f"{API}/me")
    assert gone.status_code == 401 and gone.json()["detail"]["code"] == "not_signed_in"


def test_the_web_has_no_device_and_cannot_disconnect_one() -> None:
    _account, browser = person("anna")
    me = browser.get(f"{API}/me").json()
    assert me["device"] is None
    assert browser.delete(f"{API}/device").status_code == 404


def test_disconnecting_in_the_browser_and_signing_out_everywhere_end_the_devices() -> None:
    _account, browser = person("anna")
    _key, phone = _device(browser)
    [row] = browser.get("/api/app-devices").json()
    assert browser.delete(f"/api/app-devices/{row['id']}").status_code == 204
    assert phone.get(f"{API}/me").status_code == 401
    _key2, phone2 = _device(browser)
    assert browser.post("/api/auth/logout-all").status_code == 204
    assert phone2.get(f"{API}/me").status_code == 401


def test_the_operators_switches() -> None:
    operator = make_account("boss", "operator")
    admin = TestClient(app, base_url="http://testserver", headers=WEB)
    assert admin.post("/api/auth/login", json={"name": operator.name, "password": PASSWORD}).status_code == 200
    _key, phone = _device(admin, "Boss phone")
    assert admin.put("/api/settings", json={"app_pairing_allowed": False}).json()["app_pairing_allowed"] is False
    refused = admin.post("/api/app-pairing", json={"address": "https://tasks.example.com"})
    assert refused.status_code == 403 and refused.json()["detail"]["code"] == "app_pairing_disabled"
    assert phone.get(f"{API}/me").status_code == 200, "paired devices go on"
    admin.put("/api/settings", json={"app_enabled": False})
    off = phone.get(f"{API}/me")
    assert off.status_code == 403 and off.json()["detail"]["code"] == "app_disabled"
    assert admin.get(f"{API}/me").status_code == 200, "the web is not the app"
    admin.put("/api/settings", json={"app_enabled": True})
    assert phone.get(f"{API}/me").status_code == 200, "still paired"


def test_without_an_address_there_is_no_pairing() -> None:
    _account, browser = person("anna")
    refused = browser.post("/api/app-pairing", json={"address": ""})
    assert refused.status_code == 422 and refused.json()["detail"]["code"] == "app_address_missing"
    with SessionLocal() as db:
        settings_service.save(db, {"public_url": "https://tasks.example.com"})
    assert browser.post("/api/app-pairing", json={"address": ""}).json()["address"] == "https://tasks.example.com"


def test_at_most_five_pairings_wait() -> None:
    _account, browser = person("anna")
    for _ in range(5):
        _pair(browser)
    refused = browser.post("/api/app-pairing", json={"address": "https://tasks.example.com"})
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "app_too_many_pairings"


def test_the_sign_in_page_gets_a_link_for_the_app() -> None:
    _account, browser = person("anna")
    answer = browser.post("/api/app-connect", json={"device": "iPad"})
    assert answer.status_code == 200 and answer.json()["link"].startswith("nextasks://connect?address=")


def test_six_hundred_requests_a_minute_then_wait(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(devices, "PER_MINUTE", 5)
    _account, browser = person("anna")
    for _ in range(5):
        assert browser.get(f"{API}/me").status_code == 200
    slow = browser.get(f"{API}/me")
    assert slow.status_code == 429 and slow.json()["detail"]["code"] == "too_many" and slow.headers["retry-after"]


def test_me_takes_the_time_zone_and_language() -> None:
    _account, browser = person("anna")
    answer = browser.put(f"{API}/me", json={"timezone": "Europe/Berlin", "language": "de"})
    assert answer.status_code == 200
    assert answer.json()["account"]["timezone"] == "Europe/Berlin" and answer.json()["account"]["language"] == "de"
    wrong = browser.put(f"{API}/me", json={"timezone": "Atlantis/Nowhere", "language": "fr"})
    assert wrong.status_code == 422 and wrong.json()["detail"]["fields"] == ["timezone", "language"]


def test_a_required_second_factor_that_is_missing_keeps_the_app_out() -> None:
    _account, browser = person("anna")
    with SessionLocal() as db:
        settings_service.save(db, {"two_factor_required": True})
    refused = browser.get(f"{API}/me")
    assert refused.status_code == 401 and refused.json()["detail"]["code"] == "not_signed_in"
