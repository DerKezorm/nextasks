"""The settings pass (plan "Einstellungen", modules konten 1.1.0, post 1.1.0, schluessel 1.0.0, sicherung 1.0.1, log
1.0.0): the new ways the page uses, and that every way of before still answers as it did. Every address is made up."""

from __future__ import annotations

import secrets

from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.main import app
from app.models import Account, ApiToken, utcnow
from app.services import apitokens, settings_service

from .conftest import PASSWORD, TAB, make_account, new_client, purge_deleted


def test_a_deleted_account_is_shut_out_and_comes_back_within_its_days(client: TestClient, operator: Account) -> None:
    anna = make_account("anna")
    with new_client(anna) as browser:
        assert browser.get("/api/auth/me").status_code == 200
        assert client.request("DELETE", f"/api/accounts/{anna.id}", json={"current_password": PASSWORD}).status_code == 204
        assert browser.get("/api/auth/me").status_code == 401
    listed = {row["name"]: row for row in client.get("/api/accounts").json()}
    assert listed["anna"]["deleted_at"] and listed["anna"]["purge_at"]
    refused = client.post(f"/api/accounts/{anna.id}/restore", json={"current_password": "wrong one"})
    assert refused.status_code == 401
    assert client.post(f"/api/accounts/{anna.id}/restore", json={"current_password": PASSWORD}).status_code == 204
    assert {row["name"]: row for row in client.get("/api/accounts").json()}["anna"]["deleted_at"] is None
    with new_client() as again:
        assert again.post("/api/auth/login", json={"name": "anna", "password": PASSWORD}).status_code == 200


def test_after_its_days_a_deleted_account_cannot_come_back(client: TestClient, operator: Account) -> None:
    anna = make_account("anna")
    assert client.request("DELETE", f"/api/accounts/{anna.id}", json={"current_password": PASSWORD}).status_code == 204
    purge_deleted(anna.id)
    assert client.post(f"/api/accounts/{anna.id}/restore", json={"current_password": PASSWORD}).status_code == 404


def test_several_operators_and_never_the_last_one_away(client: TestClient, operator: Account) -> None:
    anna = make_account("anna")
    made = client.put(f"/api/accounts/{anna.id}/role", json={"role": "operator", "current_password": PASSWORD})
    assert made.status_code == 200 and made.json()["role"] == "operator"
    own = client.put(f"/api/accounts/{operator.id}/role", json={"role": "member", "current_password": PASSWORD})
    assert own.status_code == 409 and own.json()["detail"]["code"] == "cannot_demote_self"


def test_the_theme_is_kept_at_the_account_and_a_browsers_value_is_taken_once(client: TestClient,
                                                                             operator: Account) -> None:
    assert client.get("/api/auth/me").json()["theme"] == ""
    assert client.post("/api/me/theme/adopt", json={"value": "light"}).json() == {"theme": "light"}
    assert client.post("/api/me/theme/adopt", json={"value": "dark"}).json() == {"theme": "light"}
    assert client.put("/api/me/theme", json={"theme": "dark"}).json()["theme"] == "dark"
    assert client.put("/api/me/theme", json={"theme": "pink"}).status_code == 422


def test_the_sign_in_page_says_what_may_change_and_ready_for_the_internet(operator: Account) -> None:
    with TestClient(app, base_url="https://testserver", headers=TAB) as secure:
        from .conftest import sign_in

        sign_in(secure, operator)
        view = secure.get("/api/server/sign-in").json()
        assert view["password_login"] is True and view["password_may_go_off"] is False
        refused = secure.put("/api/server/sign-in", json={"password_login": False})
        assert refused.status_code == 409 and refused.json()["detail"]["code"] == "provider_first"
        first = secure.put("/api/server/sign-in", json={"factor_required": True})
        assert first.status_code == 409 and first.json()["detail"]["code"] == "own_second_factor_first"
        ready = secure.get("/api/server/sign-in/readiness").json()
        assert ready["state"] in ("ok", "warn", "bad")
        assert [point["key"] for point in ready["points"]][:2] == ["address", "factorForAll"]


def test_only_operators_reach_the_new_server_pages(client: TestClient, operator: Account) -> None:
    member = make_account("mika")
    with new_client(member) as browser:
        for path in ("/api/server/sign-in", "/api/server/sign-in/readiness", "/api/server/mail",
                     "/api/server/storage", "/api/connections/admin/keys", "/api/connections/interfaces"):
            assert browser.get(path).status_code == 403, path


def test_a_token_of_0_8_0_still_opens_the_api_and_shows_among_the_new_keys(client: TestClient,
                                                                         operator: Account) -> None:
    with SessionLocal() as db:
        settings_service.save(db, {"api_tokens_allowed": True})
        token = apitokens.TOKEN_PREFIX + secrets.token_urlsafe(32)
        db.add(ApiToken(account_id=operator.id, name="Home Assistant", level="read", token_hash=apitokens.digest(token),
                        prefix=token[:8], spaces=None, created_at=utcnow()))
        db.commit()
    with TestClient(app, base_url="http://testserver") as program:
        assert program.get("/api/v1/me", headers={"Authorization": f"Bearer {token}"}).status_code == 200
    listed = client.get("/api/connections/keys").json()
    assert [(key["name"], key["prefix"]) for key in listed["keys"]] == [("Home Assistant", token[:8])]
    # The old ways of the interface answer as before.
    assert [entry["name"] for entry in client.get("/api/api-tokens").json()["tokens"]] == ["Home Assistant"]
    assert [entry["name"] for entry in client.get("/api/admin/api-tokens").json()] == ["Home Assistant"]


def test_the_old_ways_of_backups_mail_and_log_still_answer(client: TestClient, operator: Account) -> None:
    assert client.get("/api/backups").status_code == 200
    assert client.get("/api/server/storage/backups").json()["schedule"]["every"] == "daily"
    assert client.get("/api/settings").json()["backup_schedule"] == "daily"
    assert client.get("/api/logs/level").json()["variable"] == "NEXTASKS_LOG_LEVEL"
    assert client.get("/api/server/mail").json()["sender_name_default"] == "nextasks"


def test_the_box_for_an_address_not_proven_only_for_a_new_one(client: TestClient, operator: Account) -> None:
    with SessionLocal() as db:
        settings_service.save(db, {"smtp_host": "mail.example.com", "smtp_from": "tasks@example.com"})
        row = db.get(Account, operator.id)
        assert row is not None
        # Counts without a link (as an address of before the update would, before the migration proves it).
        row.email, row.email_counted = "tester@example.com", "tester@example.com"
        db.commit()
    assert client.get("/api/auth/me").json()["email_needs_proof"] is True
    with SessionLocal() as db:
        row = db.get(Account, operator.id)
        assert row is not None
        row.email_confirmed = "tester@example.com"
        db.commit()
    assert client.get("/api/auth/me").json()["email_needs_proof"] is False
