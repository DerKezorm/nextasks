"""Spaces, members, invitations (``vertrag-block1.md``, "Bereiche und Mitglieder"; ``datenmodell.md``,
"Mitgliedschaft", "Einladung"): only managers invite and manage, never into "Private", a link for one person, seven
days, once; a space keeps a manager."""

from __future__ import annotations

from datetime import timedelta

from fastapi.testclient import TestClient
from sqlalchemy import update

from app.db import SessionLocal
from app.main import app
from app.models import Invite, utcnow
from app.services import records, settings_service

from .conftest import PASSWORD
from .sync_helpers import API, WEB, changes, new_id, person, private_space, put, shared_space, state


def _secret(link: str) -> str:
    return link.rsplit("/", 1)[-1]


def test_a_manager_invites_and_the_invited_person_joins_once() -> None:
    _anna, anna = person("anna")
    ben_account, ben = person("ben")
    _carl, carl = person("carl")
    space = new_id()
    put(anna, "space", space, {"name": "Family", "color": "green"})
    made = anna.post(f"{API}/spaces/{space}/invites")
    assert made.status_code == 201 and set(made.json()) == {"id", "link", "expires_at"}
    secret = _secret(made.json()["link"])
    page = TestClient(app, base_url="http://testserver").get(f"/api/invites/{secret}")
    assert page.json() == {"space_name": "Family", "invited_by": "anna", "expires_at": page.json()["expires_at"],
                           "already_member": False, "signed_in": False}
    assert ben.get(f"/api/invites/{secret}").json()["signed_in"] is True
    assert ben.post(f"/api/invites/{secret}/accept").json() == {"space_id": space}
    assert state(ben)[("space", space)]["data"]["role"] == "member"
    used = carl.post(f"/api/invites/{secret}/accept")
    assert used.status_code == 404 and used.json()["detail"]["code"] == "invite_unknown"
    assert ben_account.id in {p["id"] for p in changes(anna)["people"]}


def test_who_is_a_member_already_does_not_use_the_link_up() -> None:
    _anna, anna = person("anna")
    _ben, ben = person("ben")
    space = shared_space(anna, ben)
    secret = _secret(anna.post(f"{API}/spaces/{space}/invites").json()["link"])
    assert ben.get(f"/api/invites/{secret}").json()["already_member"] is True
    assert ben.post(f"/api/invites/{secret}/accept").json() == {"space_id": space}
    _carl, carl = person("carl")
    assert carl.post(f"/api/invites/{secret}/accept").status_code == 200, "the link is still there for Carl"


def test_a_link_opens_a_new_account_with_a_password_and_the_space_at_once() -> None:
    _anna, anna = person("anna")
    space = shared_space(anna)
    secret = _secret(anna.post(f"{API}/spaces/{space}/invites").json()["link"])
    stranger = TestClient(app, base_url="http://testserver", headers=WEB)
    made = stranger.post(f"/api/invite/{secret}", json={"name": "dora", "password": PASSWORD})
    assert made.status_code == 200, made.text
    assert made.json()["space_id"] == space and made.json()["name"] == "dora"
    held = state(stranger)
    assert ("space", space) in held and any(item["data"]["private"] for (kind, _), item in held.items()
                                            if kind == "space")


def test_only_managers_invite_and_never_into_private_and_not_when_the_operator_says_no() -> None:
    _anna, anna = person("anna")
    _ben, ben = person("ben")
    space = shared_space(anna, ben)
    refused = ben.post(f"{API}/spaces/{space}/invites")
    assert refused.status_code == 403 and refused.json()["detail"]["code"] == "forbidden"
    stranger_space = new_id()
    _carl, carl = person("carl")
    put(carl, "space", stranger_space, {"name": "Carl's"})
    assert anna.post(f"{API}/spaces/{stranger_space}/invites").status_code == 404
    private_id, _list = private_space(anna)
    private = anna.post(f"{API}/spaces/{private_id}/invites")
    assert private.status_code == 403 and private.json()["detail"]["code"] == "private_space"
    with SessionLocal() as db:
        settings_service.save(db, {"invites_enabled": False})
    off = anna.post(f"{API}/spaces/{space}/invites")
    assert off.status_code == 403 and off.json()["detail"]["code"] == "invites_disabled"


def test_invitations_run_out_after_seven_days_and_can_be_withdrawn() -> None:
    _anna, anna = person("anna")
    _ben, ben = person("ben")
    space = shared_space(anna)
    made = anna.post(f"{API}/spaces/{space}/invites").json()
    listed = anna.get(f"{API}/spaces/{space}/invites").json()
    assert [row["id"] for row in listed] == [made["id"]]
    with SessionLocal() as db:
        db.execute(update(Invite).values(expires_at=utcnow() - timedelta(seconds=1)))
        db.commit()
    assert ben.post(f"/api/invites/{_secret(made['link'])}/accept").status_code == 404
    other = anna.post(f"{API}/spaces/{space}/invites").json()
    assert anna.delete(f"{API}/spaces/{space}/invites/{other['id']}").status_code == 204
    assert ben.post(f"/api/invites/{_secret(other['link'])}/accept").status_code == 404


def test_a_link_from_a_manager_who_is_no_manager_any_more_is_no_way_in() -> None:
    anna_account, anna = person("anna")
    ben_account, ben = person("ben")
    space = shared_space(anna, ben)
    assert anna.put(f"{API}/spaces/{space}/members/{ben_account.id}", json={"role": "manager"}).status_code == 200
    secret = _secret(anna.post(f"{API}/spaces/{space}/invites").json()["link"])
    assert ben.put(f"{API}/spaces/{space}/members/{anna_account.id}", json={"role": "member"}).status_code == 200
    _carl, carl = person("carl")
    assert carl.post(f"/api/invites/{secret}/accept").status_code == 404


def test_a_space_keeps_a_manager() -> None:
    anna_account, anna = person("anna")
    ben_account, ben = person("ben")
    space = shared_space(anna, ben)
    demote = anna.put(f"{API}/spaces/{space}/members/{anna_account.id}", json={"role": "member"})
    assert demote.status_code == 409 and demote.json()["detail"]["code"] == "last_manager"
    leave = anna.delete(f"{API}/spaces/{space}/members/{anna_account.id}")
    assert leave.status_code == 409 and leave.json()["detail"]["code"] == "last_manager"
    assert ben.delete(f"{API}/spaces/{space}/members/{anna_account.id}").status_code == 403, "members remove nobody"
    assert ben.delete(f"{API}/spaces/{space}/members/{ben_account.id}").status_code == 204, "but may leave"
    assert anna.delete(f"{API}/spaces/{space}/members/{anna_account.id}").status_code == 204, "alone, she may go"


def test_nobody_leaves_the_private_space_and_roles_are_managers_business() -> None:
    anna_account, anna = person("anna")
    ben_account, ben = person("ben")
    private_id, _list = private_space(anna)
    refused = anna.delete(f"{API}/spaces/{private_id}/members/{anna_account.id}")
    assert refused.status_code == 403 and refused.json()["detail"]["code"] == "private_space"
    space = shared_space(anna, ben)
    assert ben.put(f"{API}/spaces/{space}/members/{ben_account.id}", json={"role": "manager"}).status_code == 403
    bad = anna.put(f"{API}/spaces/{space}/members/{ben_account.id}", json={"role": "owner"})
    assert bad.status_code == 422
    since = changes(ben)["cursor"]
    assert anna.put(f"{API}/spaces/{space}/members/{ben_account.id}", json={"role": "manager"}).status_code == 200
    new_role = [item for item in changes(ben, since)["items"] if item["kind"] in ("member", "space")]
    assert any(item["kind"] == "member" and item["data"]["role"] == "manager" for item in new_role)


def test_deleting_an_account_hands_the_space_to_the_member_who_joined_first() -> None:
    from .conftest import make_account

    anna_account, anna = person("anna")
    ben_account, ben = person("ben")
    carl_account, carl = person("carl")
    space = shared_space(anna, ben, carl)
    boss = make_account("boss", "operator")
    admin = TestClient(app, base_url="http://testserver", headers=WEB)
    assert admin.post("/api/auth/login", json={"name": boss.name, "password": PASSWORD}).status_code == 200
    gone = admin.request("DELETE", f"/api/accounts/{anna_account.id}", json={"current_password": PASSWORD})
    assert gone.status_code == 204, gone.text
    held = state(carl)
    assert held[("member", f"{space}:{ben_account.id}")]["data"]["role"] == "manager"
    assert ("member", f"{space}:{anna_account.id}") not in held
    people = {p["id"]: p for p in changes(carl)["people"]}
    assert anna_account.id not in people or people[anna_account.id]["name"] is None
    _ = carl_account


def test_every_time_of_invitations_pairing_and_devices_is_written_like_the_data_model() -> None:
    """``YYYY-MM-DDTHH:MM:SS.sssZ`` everywhere (contract, "Zeiten wie im Datenmodell"): these answers came out with
    microseconds, and the invitation page with ``+00:00``."""
    _anna, anna = person("anna")
    space = new_id()
    put(anna, "space", space, {"name": "Family"})
    made = anna.post(f"{API}/spaces/{space}/invites").json()
    listed = anna.get(f"{API}/spaces/{space}/invites").json()
    page = TestClient(app, base_url="http://testserver").get(f"/api/invites/{_secret(made['link'])}").json()
    pairing = anna.post("/api/app-pairing", json={"address": "https://tasks.example.com"}).json()
    code = TestClient(app, base_url="http://testserver").post(f"{API}/pairing/code",
                                                              json={"code": pairing["code"], "device": "iPhone"})
    assert code.status_code == 200, code.text
    phone = TestClient(app, base_url="http://testserver", headers={"Authorization": f"Bearer {code.json()['key']}"})
    assert phone.get(f"{API}/me").status_code == 200
    device = anna.get("/api/app-devices").json()[0]
    times = [made["expires_at"], listed[0]["expires_at"], page["expires_at"], pairing["expires_at"],
             device["created_at"], device["last_seen"]]
    assert all(isinstance(value, str) and records.STAMP.fullmatch(value) for value in times), times
