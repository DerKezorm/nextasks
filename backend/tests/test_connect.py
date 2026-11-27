"""nextasks among the other nex apps (verbinden 0.1.1 to 0.1.9), what is nextasks' own beside the contract tests in
``tests/nexverbinden``: a connection opens ``/api/v1`` only for the purposes of its pair in the catalog (nexnotes reads
and writes, nextime reads and ticks off, nexdiary only reads), only in the spaces given; the API keys other apps typed
in before keep working as before, beside a connection and with their own switch; ``/api/v1/me`` names when such a key
runs out; the old switch of API tokens does not close connections (they have their own, V14); and the consent page
shows the account as the profile does (0.1.8, B1)."""

from __future__ import annotations

import secrets
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.main import app
from app.models import Account
from app.services import apitokens, settings_service, verbinden
from app.vendor.nexmcp import oauthcore
from app.vendor.nexverbinden import CATALOG, Connection

from .sync_helpers import make_list, make_reminder, person, private_space, shared_space
from .test_api_v1 import token

V1 = "/api/v1"


@pytest.fixture(autouse=True)
def fresh_brake() -> None:
    apitokens.forget()


def connected(account: Account, partner: str, areas: list[str] | None = None) -> TestClient:
    """``partner`` as it holds a connection with ``account`` here (written as the module writes one after the
    consent): a program with the token of the connection."""
    access = verbinden.ACCESS_PREFIX + secrets.token_urlsafe(32)
    now = datetime.now(UTC)
    with SessionLocal() as db:
        store = verbinden.VerbindenStore(db)
        store.save(Connection(
            id=secrets.token_urlsafe(12), account_id=account.id, partner=partner,
            partner_base=f"https://{partner}.example.com", partner_account=account.name, uses=(),
            grants=CATALOG.uses(partner, "nextasks"), areas_granted=areas, areas_used=None, held=store.seal("{}"),
            issued_access_hash=oauthcore.digest(access), issued_refresh_hash=oauthcore.digest(secrets.token_hex(16)),
            issued_access_expires=now + timedelta(hours=1), created_at=now,
        ))
        store.commit()
    return TestClient(app, base_url="http://testserver", headers={"Authorization": f"Bearer {access}"})


def status(answer: Any, code: str | None = None) -> int:
    if code is not None:
        assert answer.json()["detail"]["code"] == code, answer.text
    return int(answer.status_code)


def family() -> tuple[Account, TestClient, str, str, str]:
    """Anna with her "Private" (a task in it) and a shared space "Family" with Ben (a task in it)."""
    anna_account, anna = person("anna")
    _ben_account, ben = person("ben")
    _private, private_list = private_space(anna)
    space = shared_space(anna, ben)
    family_list = make_list(anna, space)
    own = make_reminder(anna, private_list, title="Own")
    shared = make_reminder(anna, family_list, title="Shared")
    return anna_account, anna, space, own, shared


def test_nexnotes_reads_and_writes_tasks_but_never_reads_members() -> None:
    account, _anna, space, own, _shared = family()
    notes = connected(account, "nexnotes")
    assert status(notes.get(f"{V1}/tasks")) == 200
    assert status(notes.post(f"{V1}/tasks", json={"title": "From a note"})) == 201
    assert status(notes.patch(f"{V1}/tasks/{own}", json={"title": "Changed"})) == 200
    assert status(notes.get(f"{V1}/spaces/{space}/members"), "purpose_missing") == 403


def test_nextime_reads_and_ticks_off_but_changes_nothing_else() -> None:
    account, _anna, space, own, _shared = family()
    calendar = connected(account, "nextime")
    assert status(calendar.get(f"{V1}/tasks")) == 200
    assert status(calendar.patch(f"{V1}/tasks/{own}", json={"completed": True})) == 200
    assert status(calendar.patch(f"{V1}/tasks/{own}", json={"title": "Renamed"}), "purpose_missing") == 403
    assert status(calendar.patch(f"{V1}/tasks/{own}", json={"completed": False, "title": "x"}), "purpose_missing") == 403
    assert status(calendar.post(f"{V1}/tasks", json={"title": "New"}), "purpose_missing") == 403
    assert status(calendar.delete(f"{V1}/tasks/{own}"), "purpose_missing") == 403
    assert status(calendar.post(f"{V1}/tasks/{own}/comments", json={"text": "Hi"}), "purpose_missing") == 403
    assert status(calendar.get(f"{V1}/spaces/{space}/members"), "purpose_missing") == 403


def test_nexdiary_only_reads() -> None:
    account, _anna, _space, own, _shared = family()
    diary = connected(account, "nexdiary")
    assert status(diary.get(f"{V1}/tasks/{own}")) == 200
    assert status(diary.patch(f"{V1}/tasks/{own}", json={"completed": True}), "purpose_missing") == 403
    assert status(diary.post(f"{V1}/tasks", json={"title": "New"}), "purpose_missing") == 403


def test_nexmail_sees_the_members_of_a_shared_space() -> None:
    account, _anna, space, _own, _shared = family()
    mail = connected(account, "nexmail")
    found = mail.get(f"{V1}/spaces/{space}/members")
    assert status(found) == 200 and {person["name"] for person in found.json()["members"]} == {"anna", "ben"}


def test_a_connection_sees_only_the_spaces_given() -> None:
    account, _anna, space, own, shared = family()
    mail = connected(account, "nexmail", areas=[space])
    seen = {task["id"] for task in mail.get(f"{V1}/tasks").json()["tasks"]}
    assert seen == {shared}
    assert status(mail.get(f"{V1}/tasks/{own}"), "not_found") == 404


def test_the_switch_of_api_tokens_does_not_close_connections_and_theirs_does() -> None:
    account, _anna, _space, _own, _shared = family()
    notes = connected(account, "nexnotes")
    with SessionLocal() as db:
        settings_service.save(db, {"api_tokens_allowed": False})
    assert status(notes.get(f"{V1}/me")) == 200
    with SessionLocal() as db:
        settings_service.save(db, {"connections_enabled": False})
    assert status(notes.get(f"{V1}/me"), "connections_off") == 403


def test_an_api_key_typed_in_before_works_on_beside_a_connection_and_says_when_it_ends() -> None:
    """The old ways stay: nexnotes (``PUT /api/nextasks``), nexmail (``POST /api/aufgabenziele/nextasks``) and nextime
    (``PUT /api/nextasks``) hold an ``ntk_`` key of nextasks and call ``/api/v1`` with it."""
    account, _anna, _space, own, _shared = family()
    with SessionLocal() as db:
        settings_service.save(db, {"api_tokens_allowed": True})
    typed = token(account)
    connected(account, "nexmail")
    me = typed.get(f"{V1}/me").json()
    assert me["name"] == "anna" and me["level"] == "write"
    assert status(typed.get(f"{V1}/spaces")) == 200
    assert status(typed.patch(f"{V1}/tasks/{own}", json={"title": "Still mine"})) == 200
    # Made by apitokens.make without days: it never runs out.
    assert me["expires_at"] is None
    with SessionLocal() as db:
        row = db.get(Account, account.id)
        assert row is not None
        _made, secret = apitokens.make(db, row, "nextime", "read", None, 90)
    ending = TestClient(app, base_url="http://testserver", headers={"Authorization": f"Bearer {secret}"})
    assert ending.get(f"{V1}/me").json()["expires_at"].endswith("Z")


def test_nexpaper_makes_a_task_from_a_document_and_reads_it_but_never_the_members() -> None:
    """Teil B (V19): nexpaper › nextasks with ``tasks.read`` and ``tasks.write``."""
    account, _anna, space, own, _shared = family()
    paper = connected(account, "nexpaper")
    made = paper.post(f"{V1}/tasks", json={"title": "Pay the invoice", "due_date": "2026-12-01"})
    assert status(made) == 201
    assert paper.get(f"{V1}/tasks/{made.json()['id']}").json()["title"] == "Pay the invoice"
    assert status(paper.patch(f"{V1}/tasks/{own}", json={"completed": True})) == 200
    assert status(paper.get(f"{V1}/spaces/{space}/members"), "purpose_missing") == 403


def test_the_consent_page_shows_the_account_as_the_profile_does() -> None:
    """verbinden 0.1.8 (B1): ``account_card`` gives the shown name, the user name and the own picture at the very
    address the profile asks for it (``avatarUrl``: ``/api/avatars/<id>?v=<avatar>``), which opens for the account; no
    picture: none, the page draws the letter as the profile does."""
    from urllib.parse import quote

    from app.vendor.nexverbinden.connect import account_card

    from .test_avatars import photo

    anna_account, anna = person("anna")
    with SessionLocal() as db:
        card = verbinden.VerbindenStore(db).account_card(anna_account.id)
        # Without a shown name the module shows the user name alone.
        assert account_card(verbinden.VerbindenStore(db), anna_account.id) == {
            "name": "", "username": "anna", "picture": None, "color": None}
        row = db.get(Account, anna_account.id)
        assert row is not None
        row.display_name = "Anna Example"
        db.commit()
    assert card == {"name": "anna", "username": "anna", "picture": None, "color": None}
    assert anna.put("/api/auth/avatar", content=photo()).status_code == 200
    me = anna.get("/api/auth/me").json()
    with SessionLocal() as db:
        card = account_card(verbinden.VerbindenStore(db), anna_account.id)
    assert card == {"name": "Anna Example", "username": "anna",
                    "picture": f"/api/avatars/{anna_account.id}?v={quote(me['avatar'], safe='')}", "color": None}
    shown = anna.get(card["picture"])
    assert shown.status_code == 200 and shown.headers["content-type"].startswith("image/")


def test_every_partner_card_stands_for_purposes_nextasks_really_grants() -> None:
    """V20: nextasks shows a card only for a partner whose purposes work at ``/api/v1``; it uses nothing of them
    (a host only), so no card ever says "connected" without an effect here."""
    from app.routers.v1 import PURPOSES

    assert verbinden.CONFIG.partners == ["nexnotes", "nexmail", "nextime", "nexpaper", "nexdiary"]
    assert verbinden.CONFIG.usable == verbinden.CONFIG.partners
    for partner in verbinden.CONFIG.partners:
        granted = CATALOG.uses(partner, "nextasks")
        assert granted and set(granted) <= set(PURPOSES), partner
        assert CATALOG.uses("nextasks", partner) == (), partner
