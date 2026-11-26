"""nextasks' own parts around the shared account module (konten 0.3.9, post 0.1.1): what only nextasks has, beyond the
contract tests in ``tests/nexkonten`` and ``tests/nexpost``.

The route of 0.8.0 with which the operator set a password answers 410; ``/api/v1/me`` names the account's id (Home
Assistant hangs on it); an invitation into a space reaches an account that has one and joins it signed in; an
invitation carries a display name; the operator's link for a new password, "Forgot your password?" and the emergency
command; and renaming an account moves nothing that hangs on it (everything carries the id).
"""

from __future__ import annotations

import re
from datetime import timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import SessionLocal
from app.main import app
from app.models import Account, ApiToken, AppDevice, Comment, Member, Reminder
from app.models_accounts import FormerName
from app.routers import auth as auth_router
from app.services import apitokens, devices, post_store, settings_service

from .conftest import PASSWORD, TAB, make_account, sign_in
from .sync_helpers import API, make_list, make_reminder, new_id, now_ms, person, put, shared_space

PUBLIC = "https://tasks.example.com"
NEW = "A-long-enough-password"


@pytest.fixture
def post(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, Any]]:
    """A mail server and the public address are set; what is mailed lands in this list instead."""
    sent: list[tuple[str, Any]] = []
    monkeypatch.setattr(post_store, "send_letter", lambda _db, letter, *a, **k: sent.append((letter.to, letter)))
    with SessionLocal() as db:
        settings_service.save(db, {"smtp_host": "smtp.example.com", "smtp_from": "tasks@example.com",
                                   "public_url": PUBLIC})
    return sent


def text_of(message: Any) -> str:
    return str(getattr(message, "text", "") or getattr(message, "body", ""))


def stranger() -> TestClient:
    return TestClient(app, base_url="http://testserver", headers=TAB)


def token_of(link: str) -> str:
    return link.rstrip("/").rsplit("/", 1)[-1]


# --- The operator no longer sets a password -------------------------------------------------------------------------


def test_the_old_route_that_set_a_password_answers_410(client: TestClient, operator: Account) -> None:
    anna = make_account("anna")
    gone = client.put(f"/api/accounts/{anna.id}/password", json={"password": NEW, "current_password": PASSWORD})
    assert gone.status_code == 410
    assert gone.json()["detail"]["code"] == "use_reset_link" and "reset-link" in gone.json()["detail"]["message"]
    # Nothing changed: the old password still signs in.
    assert stranger().post("/api/auth/login", json={"name": "anna", "password": PASSWORD}).status_code == 200


def test_the_operators_link_is_shown_once_without_mail_and_sets_a_new_password(client: TestClient,
                                                                                operator: Account) -> None:
    anna = make_account("anna")
    browser = stranger()
    sign_in(browser, anna)
    with SessionLocal() as db:
        row = db.get(Account, anna.id)
        assert row is not None
        devices.make_device(db, row, "Annas iPhone")
    wrong = client.post(f"/api/accounts/{anna.id}/reset-link", json={"current_password": "not it"})
    assert wrong.status_code == 401 and wrong.json()["detail"]["code"] == "wrong_password"
    own = client.post(f"/api/accounts/{operator.id}/reset-link", json={"current_password": PASSWORD})
    assert own.status_code == 409, "never for the operator's own account"
    made = client.post(f"/api/accounts/{anna.id}/reset-link", json={"current_password": PASSWORD, "days": 7})
    assert made.status_code == 201, made.text
    assert made.json()["sent"] is False and "/reset/" in made.json()["link"]
    token = token_of(made.json()["link"])
    assert stranger().get(f"/api/reset/{token}").json()["username"] == "anna"
    assert stranger().post(f"/api/reset/{token}", json={"password": "short"}).status_code == 422
    assert stranger().post(f"/api/reset/{token}", json={"password": NEW, "password_confirm": NEW}).status_code == 204
    assert stranger().post(f"/api/reset/{token}", json={"password": NEW}).status_code == 404, "once"
    # The browser is out, the iPhone stays and is listed after the next sign-in, with the operator's notice.
    assert browser.get("/api/auth/me").status_code == 401
    again = stranger()
    assert again.post("/api/auth/login", json={"name": "anna", "password": NEW}).status_code == 200
    me = again.get("/api/auth/me").json()
    assert me["password_reset_notice"] is True and me["new_password_origin"] == "operator"
    access = again.get("/api/auth/access").json()
    assert [item["kind"] for item in access["access"]] == ["device"] and access["origin"] == "operator"


def test_the_operators_link_goes_by_mail_to_an_address_that_counts(client: TestClient, operator: Account,
                                                                    post: list[tuple[str, Any]]) -> None:
    anna = make_account("anna")
    with SessionLocal() as db:
        row = db.get(Account, anna.id)
        assert row is not None
        row.email, row.email_confirmed = "anna@example.com", "anna@example.com"
        db.commit()
    made = client.post(f"/api/accounts/{anna.id}/reset-link", json={"current_password": PASSWORD})
    assert made.status_code == 201 and made.json() == {**made.json(), "link": None, "sent": True}
    [(to, letter)] = post
    assert to == "anna@example.com" and f"{PUBLIC}/reset/" in text_of(letter)


# --- Forgot your password? ------------------------------------------------------------------------------------------


def test_forgot_password_mails_a_link_to_an_address_that_counts_and_says_the_same_for_anybody(
        client: TestClient, post: list[tuple[str, Any]]) -> None:
    anna = make_account("anna")
    make_account("ben")
    with SessionLocal() as db:
        row = db.get(Account, anna.id)
        assert row is not None
        row.email, row.email_confirmed = "anna@example.com", "anna@example.com"
        db.commit()
    assert client.get("/api/auth/methods").json()["forgot_mail"] is True
    answers = [stranger().post("/api/auth/forgot", json={"name": typed}) for typed in ("ANNA@example.com", "ben",
                                                                                       "nobody")]
    assert {answer.status_code for answer in answers} == {202}
    assert len({answer.text for answer in answers}) == 1, "the same answer whatever was typed"
    [(to, letter)] = post
    assert to == "anna@example.com"
    link = re.search(r"https://\S+/reset/(\S+)", text_of(letter))
    assert link is not None
    assert stranger().post(f"/api/reset/{link.group(1)}", json={"password": NEW}).status_code == 204
    assert stranger().post("/api/auth/login", json={"name": "anna", "password": NEW}).status_code == 200


def test_without_a_mail_server_forgot_password_mails_nothing(client: TestClient,
                                                              monkeypatch: pytest.MonkeyPatch) -> None:
    sent: list[Any] = []
    monkeypatch.setattr(post_store, "send_letter", lambda *a, **k: sent.append(a))
    make_account("anna")
    assert client.get("/api/auth/methods").json()["forgot_mail"] is False
    assert stranger().post("/api/auth/forgot", json={"name": "anna"}).status_code == 202
    assert sent == []


def test_forgot_password_runs_after_the_answer_also_in_a_thread(client: TestClient, post: list[tuple[str, Any]],
                                                                monkeypatch: pytest.MonkeyPatch) -> None:
    import time

    monkeypatch.setattr(auth_router, "FORGOT_IN_THREAD", True)
    anna = make_account("anna")
    with SessionLocal() as db:
        row = db.get(Account, anna.id)
        assert row is not None
        row.email, row.email_counted = "anna@example.com", "anna@example.com"
        db.commit()
    assert stranger().post("/api/auth/forgot", json={"name": "anna"}).status_code == 202
    for _ in range(100):
        if post:
            break
        time.sleep(0.05)
    assert [to for to, _ in post] == ["anna@example.com"]


# --- /api/v1/me names the id ----------------------------------------------------------------------------------------


def test_the_api_names_the_accounts_id(client: TestClient) -> None:
    anna = make_account("anna")
    with SessionLocal() as db:
        settings_service.save(db, {"api_tokens_allowed": True})
        row = db.get(Account, anna.id)
        assert row is not None
        _made, token = apitokens.make(db, row, "Home Assistant", "read")
    me = stranger().get("/api/v1/me", headers={"Authorization": f"Bearer {token}"}).json()
    assert me["id"] == anna.id and me["name"] == "anna"


# --- Invitations ----------------------------------------------------------------------------------------------------


def test_an_invitation_carries_a_display_name_and_suggests_a_username(client: TestClient, operator: Account) -> None:
    made = client.post("/api/invites", json={"display_name": "Doris Dorn", "email": "doris@example.com"})
    assert made.status_code == 201 and made.json()["display_name"] == "Doris Dorn"
    token = token_of(made.json()["link"])
    shown = stranger().get(f"/api/invite/{token}").json()
    assert (shown["display_name"], shown["name"], shown["email"]) == ("Doris Dorn", "doris-dorn", "doris@example.com")
    guest = stranger()
    accepted = guest.post(f"/api/invite/{token}", json={"display_name": "Doris", "name": "doris", "password": NEW,
                                                        "password_confirm": NEW})
    assert accepted.status_code == 200, accepted.text
    me = guest.get("/api/auth/me").json()
    assert (me["name"], me["display_name"], me["email"]) == ("doris", "Doris", "doris@example.com")
    # The address of the invitation counts (it reached this person); it was not mailed, so it is not proven.
    assert me["email_confirmed"] is True and me["email_proven"] is False
    assert stranger().post("/api/auth/login", json={"name": "DORIS@example.com", "password": NEW}).status_code == 200


def test_an_invitation_of_0_8_0_without_a_display_name_takes_the_username(client: TestClient,
                                                                         operator: Account) -> None:
    token = token_of(client.post("/api/invites", json={}).json()["link"])
    guest = stranger()
    assert guest.post(f"/api/invite/{token}", json={"name": "emil", "password": NEW}).status_code == 200
    assert guest.get("/api/auth/me").json()["display_name"] == "emil"


def test_a_space_invitation_reaches_an_account_that_has_one_and_it_joins_signed_in(
        postbox_free_mail: None) -> None:
    anna_account, anna = person("anna")
    ben_account, ben = person("ben")
    with SessionLocal() as db:
        row = db.get(Account, ben_account.id)
        assert row is not None
        row.email, row.email_confirmed = "ben@example.com", "ben@example.com"
        db.commit()
    space = shared_space(anna)
    made = anna.post(f"/api/spaces/{space}/invites", json={"email": "BEN@example.com", "display_name": "Ben"})
    assert made.status_code == 201, made.text
    token = token_of(made.json()["link"])
    # Signed in, ben joins with his account; no second account is made.
    joined = ben.post(f"/api/invites/{token}/accept")
    assert joined.status_code == 200 and joined.json()["space_id"] == space
    with SessionLocal() as db:
        assert db.get(Member, (space, ben_account.id)) is not None
        assert db.scalar(select(Account).where(Account.name != "anna", Account.name != "ben")) is None
    assert anna_account.id != ben_account.id


@pytest.fixture
def postbox_free_mail(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(post_store, "send_letter", lambda *a, **k: None)
    with SessionLocal() as db:
        settings_service.save(db, {"smtp_host": "smtp.example.com", "smtp_from": "tasks@example.com",
                                   "public_url": PUBLIC})


# --- Renaming moves nothing that hangs on the account -------------------------------------------------------------------


def test_renaming_keeps_assignments_comments_mentions_and_memberships(client: TestClient, operator: Account) -> None:
    anna_account, anna = person("anna")
    ben_account, ben = person("ben")
    space = shared_space(anna, ben)
    task = make_reminder(anna, make_list(anna, space), assignees=[ben_account.id])
    comment_id = new_id()
    assert put(ben, "comment", comment_id, {"reminder_id": task, "text": "On it, @anna",
                                             "mentions": [anna_account.id]}, {"text": now_ms()})["ok"]
    with SessionLocal() as db:
        row = db.get(Account, ben_account.id)
        assert row is not None
        _made, _token = apitokens.make(db, row, "Script", "read")
        devices.make_device(db, row, "Bens iPhone")

    # Ben renames himself (with his password), then the operator renames him again.
    renamed = ben.put("/api/me/profile", json={"name": "benjamin", "password": PASSWORD})
    assert renamed.status_code == 200 and renamed.json()["name"] == "benjamin", renamed.text
    assert renamed.json()["former_name"] == "ben"
    again = client.put(f"/api/accounts/{ben_account.id}/name", json={"name": "benno", "current_password": PASSWORD})
    assert again.status_code == 200 and again.json()["name"] == "benno"

    with SessionLocal() as db:
        reminder = db.get(Reminder, task)
        note = db.get(Comment, comment_id)
        assert reminder is not None and reminder.assignees == [ben_account.id]
        assert note is not None and note.author_id == ben_account.id and note.mentions == [anna_account.id]
        assert db.get(Member, (space, ben_account.id)) is not None
        assert db.scalar(select(ApiToken).where(ApiToken.account_id == ben_account.id)) is not None
        assert db.scalar(select(AppDevice).where(AppDevice.account_id == ben_account.id)) is not None
        assert set(db.scalars(select(FormerName.name).where(FormerName.account_id == ben_account.id))) == {
            "ben", "benjamin"}
    # Still signed in, the session hangs on the id; the token too; the iPhone app hears the new username.
    assert ben.get("/api/auth/me").json()["name"] == "benno"
    assert ben.get(f"{API}/me").json()["account"]["id"] == ben_account.id
    # The old names are reserved for good, and they never sign in.
    taken = anna.put("/api/me/profile", json={"name": "ben", "password": PASSWORD})
    assert taken.status_code == 409 and taken.json()["detail"]["code"] == "name_taken"
    assert stranger().post("/api/auth/login", json={"name": "ben", "password": PASSWORD}).status_code == 401
    assert stranger().post("/api/auth/login", json={"name": "benno", "password": PASSWORD}).status_code == 200


def test_renaming_needs_the_password_and_a_deleted_accounts_name_stays_reserved(client: TestClient,
                                                                                operator: Account) -> None:
    _ben_account, ben = person("ben")
    refused = ben.put("/api/me/profile", json={"name": "benjamin", "password": "not it"})
    assert refused.status_code == 401 and refused.json()["detail"]["code"] == "wrong_password"
    zoe = make_account("zoe")
    assert client.request("DELETE", f"/api/accounts/{zoe.id}", json={"current_password": PASSWORD}).status_code == 204
    taken = ben.put("/api/me/profile", json={"name": "zoe", "password": PASSWORD})
    assert taken.status_code == 409 and taken.json()["detail"]["code"] == "name_taken"


# --- The emergency command --------------------------------------------------------------------------------------------


def test_the_emergency_command_prints_a_link_that_sets_a_new_password(client: TestClient,
                                                                      capsys: pytest.CaptureFixture[str]) -> None:
    from app import emergency

    make_account("boss", "operator")
    with SessionLocal() as db:
        settings_service.save(db, {"public_url": PUBLIC})
    assert emergency.main(["reset-link", "BOSS", "--days", "7"]) == 0
    printed = capsys.readouterr().out
    link = re.search(rf"{re.escape(PUBLIC)}/reset/(\S+)", printed)
    assert link is not None and "Valid until" in printed
    assert stranger().post(f"/api/reset/{link.group(1)}", json={"password": NEW}).status_code == 204
    signed = stranger()
    assert signed.post("/api/auth/login", json={"name": "boss", "password": NEW}).status_code == 200
    assert signed.get("/api/auth/me").json()["new_password_origin"] == "server"
    assert emergency.main(["reset-link", "nobody"]) == 1


def test_taking_the_own_address_away_asks_for_the_password(client: TestClient) -> None:
    """konten 0.3.10: removing the own address needs the own password (replaces "Entfernen geht immer")."""
    anna = make_account("anna")
    sign_in(client, anna)
    assert client.put("/api/me/email", json={"address": "anna@example.com", "password": PASSWORD}).status_code == 200
    refused = client.request("DELETE", "/api/me/email", json={"password": "not the password at all"})
    assert refused.status_code == 401
    assert client.get("/api/auth/me").json()["email"] == "anna@example.com"
    assert client.request("DELETE", "/api/me/email", json={"password": PASSWORD}).status_code == 200
    assert client.get("/api/auth/me").json()["email"] == ""


def test_every_signed_in_account_sees_every_picture(client: TestClient) -> None:
    """Part 2 of the shared account module (decided 25.11.2026): pictures for every signed-in account, not only for
    those sharing a space; nobody signed out sees one."""
    import io

    from PIL import Image

    anna = make_account("anna")
    sign_in(client, anna)
    out = io.BytesIO()
    Image.new("RGB", (40, 40), (10, 120, 200)).save(out, "PNG")
    assert client.put("/api/auth/avatar", content=out.getvalue()).status_code == 200
    client.post("/api/auth/logout")
    bob = make_account("bob")
    sign_in(client, bob)
    assert client.get(f"/api/avatars/{anna.id}").status_code == 200
    client.post("/api/auth/logout")
    client.cookies.clear()
    assert client.get(f"/api/avatars/{anna.id}").status_code == 401


def test_the_operators_list_keeps_an_expired_invitation_until_withdrawn(client: TestClient, operator: Any) -> None:
    from app.db import SessionLocal
    from app.models import Invite, utcnow

    made = client.post("/api/invites", json={"days": 1, "email": "late@example.com", "send": False}).json()
    with SessionLocal() as db:
        row = db.get(Invite, made["id"])
        assert row is not None
        row.expires_at = utcnow() - timedelta(minutes=1)
        db.commit()
    listed = {entry["id"]: entry for entry in client.get("/api/invites").json()}
    assert listed[made["id"]]["expired"] is True
    assert client.delete(f"/api/invites/{made['id']}").status_code == 204
    assert made["id"] not in {entry["id"] for entry in client.get("/api/invites").json()}


def test_the_password_says_when_it_was_changed_last(client: TestClient) -> None:
    """konten 0.3.10: "Last changed on" under Security. An account written like one of 0.8.0 has no date; a new
    password sets it."""
    anna = make_account("anna")
    sign_in(client, anna)
    assert client.get("/api/auth/me").json()["password_changed_at"] is None
    new = "Another-long-enough-password"
    assert client.put("/api/auth/password", json={"current": PASSWORD, "new": new}).status_code == 204
    assert client.get("/api/auth/me").json()["password_changed_at"] is not None


def test_the_security_answer_says_whether_a_passkey_can_be_added_here(client: TestClient, operator: Account) -> None:
    """E49: without a public https address and away from localhost the box "Passkeys" says what is missing instead
    of the button; with one, or on localhost, it offers "Add a passkey" (``passkeys_can_add`` in ``/api/auth/me``)."""
    assert client.get("/api/auth/me").json()["passkeys_can_add"] is False
    assert client.get("/api/auth/me", headers={"Origin": "http://localhost:5510"}).json()["passkeys_can_add"] is True
    with SessionLocal() as db:
        settings_service.save(db, {"public_url": "http://tasks.example.com"})
    assert client.get("/api/auth/me").json()["passkeys_can_add"] is False
    # A set address counts alone: http answers no, also with the page on localhost (adding would fail there).
    assert client.get("/api/auth/me", headers={"Origin": "http://localhost:5510"}).json()["passkeys_can_add"] is False
    with SessionLocal() as db:
        settings_service.save(db, {"public_url": "http://localhost:8510"})
    assert client.get("/api/auth/me", headers={"Origin": "http://localhost:8510"}).json()["passkeys_can_add"] is False
    with SessionLocal() as db:
        settings_service.save(db, {"public_url": PUBLIC})
    assert client.get("/api/auth/me").json()["passkeys_can_add"] is True
