"""nextasks among the other nex apps (verbinden 0.1.1 to 0.1.9), what is nextasks' own beside the contract tests in
``tests/nexverbinden``: a connection opens ``/api/v1`` only for the purposes of its pair in the catalog (nexnotes reads
and writes, nextime reads and ticks off, nexdiary only reads), only in the spaces given; the API keys other apps typed
in before keep working as before, beside a connection and with their own switch; ``/api/v1/me`` names when such a key
runs out; the old switch of API tokens does not close connections (they have their own, V14); and the consent page
shows the account as the profile does (0.1.8, B1); nexfolk learns how many open tasks concern a person, and nothing at
``/api/v1`` (0.1.13)."""

from __future__ import annotations

import secrets
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.main import app
from app.models import Account
from app.services import apitokens, clock, records, settings_service, verbinden
from app.vendor.nexmcp import oauthcore
from app.vendor.nexverbinden import CATALOG, Connection

from .sync_helpers import batch, make_list, make_reminder, person, private_space, put, shared_space
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

    assert verbinden.CONFIG.partners == ["nexnotes", "nexmail", "nextime", "nexpaper", "nexdiary", "nexfolk"]
    assert verbinden.CONFIG.usable == verbinden.CONFIG.partners
    for partner in verbinden.CONFIG.partners:
        granted = CATALOG.uses(partner, "nextasks")
        # verbinden 0.1.13: nexfolk's purpose is answered at /api/connect/about (``verbinden.about``).
        assert granted and set(granted) <= {*PURPOSES, verbinden.ABOUT}, partner
        assert CATALOG.uses("nextasks", partner) == (), partner


# --- verbinden 0.1.13: nexfolk asks which open tasks concern a person -----------------------------------------------

ABOUT = "/api/connect/about/tasks.about"


def _with_address(account: Account, address: str, *, counts: bool = True) -> None:
    with SessionLocal() as db:
        row = db.get(Account, account.id)
        assert row is not None
        row.email = address
        row.email_counted = address if counts else ""
        db.commit()


def _ask(program: TestClient, **person: Any) -> dict[str, Any]:
    answer = program.get(ABOUT, params=person)
    assert answer.status_code == 200, answer.text
    return dict(answer.json())


def test_a_task_concerns_a_person_by_the_name_in_its_title_as_whole_words() -> None:
    anna_account, anna, _space, _own, _shared = family()
    _private, first = private_space(anna)
    for title in ("Call pat example about the roof", "Patricia Exampleton", "Pat Examples birthday", "Pat"):
        make_reminder(anna, first, title=title)
    folk = connected(anna_account, "nexfolk")
    found = _ask(folk, name="Pat  Example")
    assert found["count"] == 1
    assert found["next"]["title"] == "Call pat example about the roof"
    assert _ask(folk, name="Nobody Else")["count"] == 0
    # Without a name, a title never counts (only an address assigned).
    assert _ask(folk, mail="pat@example.com")["count"] == 0


def test_a_task_concerns_a_person_whose_counting_address_is_assigned_to_it() -> None:
    anna_account, anna = person("anna")
    ben_account, ben = person("ben")
    space = shared_space(anna, ben)
    family_list = make_list(anna, space)
    task = make_reminder(anna, family_list, title="Fix the bike")
    assert put(anna, "reminder", task, {"assignees": [ben_account.id]})["ok"]
    folk = connected(anna_account, "nexfolk")
    _with_address(ben_account, "ben@example.com", counts=False)
    assert _ask(folk, mail="ben@example.com")["count"] == 0, "an address that does not count names nobody"
    _with_address(ben_account, "Ben@Example.com")
    found = _ask(folk, name="Somebody", mail="other@example.org", phone="+49 30 1234567")
    assert found["count"] == 0
    found = _ask(folk, mail="BEN@example.com")
    assert found["count"] == 1 and found["next"]["title"] == "Fix the bike"
    assert found["open"] == f"/lists/{family_list}?task={task}"


def test_completed_tasks_and_those_in_the_bin_do_not_count() -> None:
    anna_account, anna, space, _own, _shared = family()
    family_list = make_list(anna, space, name="Errands", position="a2")
    done = make_reminder(anna, family_list, title="Kim Example: gift")
    binned = make_reminder(anna, family_list, title="Kim Example: card")
    other_list = make_list(anna, space, name="Old", position="a3")
    make_reminder(anna, other_list, title="Kim Example: letter")
    make_reminder(anna, family_list, title="Kim Example: cake")
    folk = connected(anna_account, "nexfolk")
    assert _ask(folk, name="Kim Example")["count"] == 4
    now = records.format_stamp(clock.now())
    [completed] = batch(anna, {"type": "complete", "id": done, "occurrence": None, "at": now, "on": now[:10]})
    assert completed["ok"], completed
    assert put(anna, "reminder", binned, {"deleted_at": now})["ok"]
    assert put(anna, "list", other_list, {"deleted_at": now})["ok"]
    found = _ask(folk, name="Kim Example")
    assert found["count"] == 1 and found["next"]["title"] == "Kim Example: cake"


def test_only_the_spaces_given_count() -> None:
    anna_account, anna, space, _own, _shared = family()
    private, first = private_space(anna)
    family_list = make_list(anna, space, name="Errands", position="a2")
    make_reminder(anna, first, title="Kim Example: private")
    make_reminder(anna, family_list, title="Kim Example: family")
    # A space anna is no member of never counts.
    _carl_account, carl = person("carl")
    _carl_private, carl_list = private_space(carl)
    make_reminder(carl, carl_list, title="Kim Example: carl")
    assert _ask(connected(anna_account, "nexfolk"), name="Kim Example")["count"] == 2
    found = _ask(connected(anna_account, "nexfolk", areas=[space]), name="Kim Example")
    assert found["count"] == 1 and found["next"]["title"] == "Kim Example: family"
    del private


def test_the_next_is_the_one_due_next_else_the_one_made_last() -> None:
    anna_account, anna = person("anna")
    _private, first = private_space(anna)
    make_reminder(anna, first, title="Kim Example older", created_at="2026-11-20T12:00:00.000Z")
    last = make_reminder(anna, first, title="Kim Example newer", created_at="2026-11-25T12:00:00.000Z")
    folk = connected(anna_account, "nexfolk")
    found = _ask(folk, name="Kim Example")
    assert found["next"] == {"title": "Kim Example newer", "at": "2026-11-25"}
    assert found["last"] is None and found["open"] == f"/lists/{first}?task={last}"
    make_reminder(anna, first, title="Kim Example later", due_date="2026-12-10")
    soon = make_reminder(anna, first, title="Kim Example soon", due_date="2026-12-01", due_time="09:30")
    make_reminder(anna, first, title="Kim Example same day", due_date="2026-12-01", due_time="18:00")
    found = _ask(folk, name="Kim Example")
    assert found["count"] == 5
    assert found["next"] == {"title": "Kim Example soon", "at": "2026-12-01T09:30"}
    assert found["open"] == f"/lists/{first}?task={soon}"


def test_nexfolk_reads_nothing_at_api_v1() -> None:
    """``tasks.about`` opens the small answer only: ``/api/v1`` turns nexfolk away, ``/me`` included."""
    anna_account, _anna, space, own, _shared = family()
    folk = connected(anna_account, "nexfolk")
    assert CATALOG.uses("nexfolk", "nextasks") == ("tasks.about",)
    for route in ("/me", "/spaces", f"/spaces/{space}/members", "/lists", "/tasks", f"/tasks/{own}",
                  f"/tasks/{own}/comments", "/dashboard", "/stats/summary"):
        assert status(folk.get(V1 + route), "purpose_missing") == 403, route
    for method, route, body in (("POST", "/tasks", {"title": "From nexfolk"}),
                                ("PATCH", f"/tasks/{own}", {"completed": True}),
                                ("DELETE", f"/tasks/{own}", None),
                                ("POST", f"/tasks/{own}/comments", {"text": "Hello"})):
        answer = folk.request(method, V1 + route, json=body)
        assert status(answer, "purpose_missing") == 403, (method, route)
    # What it is for answers.
    assert folk.get(ABOUT, params={"name": "Own"}).status_code == 200
