"""Who sees whom (``services/visibility.py``): an account learns display name and picture only of itself and of
those it shares a space with, on every way out (the web, ``/api/app/1``, ``/api/v1``, mails and reports). Somebody
named in what it sees but sharing nothing any more is a former member. The operator sees every account where accounts
are managed.
"""

from __future__ import annotations

import io
from datetime import timedelta
from typing import Any

from fastapi.testclient import TestClient
from PIL import Image

from app.db import SessionLocal
from app.models import Account
from app.services import apitokens, clock, records, reports, settings_service

from .sync_helpers import API, batch, changes, make_list, make_reminder, person, shared_space, state
from .test_app_devices import _device

# --- Accounts: who sees whom ------------------------------------------------------------------------------------


def avatar(client: TestClient) -> None:
    out = io.BytesIO()
    Image.new("RGB", (40, 40), (200, 100, 0)).save(out, "PNG")
    assert client.put("/api/auth/avatar", content=out.getvalue()).status_code == 200


def display(client: TestClient, name: str) -> None:
    assert client.put("/api/me/profile", json={"display_name": name}).status_code == 200


def people_of(client: TestClient) -> dict[int, dict[str, Any]]:
    return {entry["id"]: entry for entry in changes(client)["people"]}


def strangers() -> tuple[Account, TestClient, Account, TestClient, Account, TestClient]:
    """Anna and Carl share no space; Ben shares one with each of them."""
    anna_account, anna = person("anna")
    ben_account, ben = person("ben")
    carl_account, carl = person("carl")
    for client, name in ((anna, "Anna A."), (ben, "Ben B."), (carl, "Carl C.")):
        display(client, name)
        avatar(client)
    shared_space(ben, anna, name="Ben and Anna")
    shared_space(ben, carl, name="Ben and Carl")
    return anna_account, anna, ben_account, ben, carl_account, carl


def test_an_account_sees_neither_name_nor_picture_of_one_it_shares_no_space_with() -> None:
    anna_account, anna, ben_account, _ben, carl_account, _carl = strangers()
    # The web: display names by account name, and the pictures.
    assert anna.get("/api/people", params={"name": ["ben", "carl", "anna"]}).json() == {"anna": "Anna A.",
                                                                                          "ben": "Ben B."}
    assert anna.get(f"/api/avatars/{ben_account.id}").status_code == 200
    assert anna.get(f"/api/avatars/{carl_account.id}").status_code == 404
    assert anna.get(f"/api/avatars/{carl_account.id}").json() == anna.get("/api/avatars/999999").json()
    # /api/app/1, in the browser and on a device.
    _key, phone = _device(anna)
    for client in (anna, phone):
        seen = people_of(client)
        assert set(seen) == {anna_account.id, ben_account.id}
        assert seen[ben_account.id]["name"] == "Ben B." and seen[ben_account.id]["avatar_hash"]
        assert client.get(f"{API}/people/{ben_account.id}/avatar").status_code == 200
        assert client.get(f"{API}/people/{carl_account.id}/avatar").status_code == 404
    assert anna.get(f"/api/avatars/{anna_account.id}").status_code == 200, "oneself"


def test_the_operator_sees_every_account_where_accounts_are_managed(client: TestClient, operator: Account) -> None:
    _anna_account, _anna, _ben_account, _ben, carl_account, _carl = strangers()
    assert client.get(f"/api/avatars/{carl_account.id}").status_code == 200
    assert {row["name"] for row in client.get("/api/accounts").json()} >= {"anna", "ben", "carl"}
    # Through the tasks the operator is an account like any other.
    assert client.get("/api/people", params={"name": ["carl"]}).json() == {}


def former_member() -> tuple[Account, TestClient, Account, TestClient, str, str]:
    """Carl made and finished a task in the space he shared with Anna, then left; they share nothing else."""
    anna_account, anna = person("anna")
    carl_account, carl = person("carl")
    display(carl, "Carl C.")
    avatar(carl)
    space = shared_space(anna, carl)
    list_id = make_list(anna, space)
    reminder = make_reminder(carl, list_id, "Mow the lawn")
    [done] = batch(carl, {"type": "complete", "id": reminder, "occurrence": None,
                          "at": records.format_stamp(clock.now()), "on": clock.now().date().isoformat()})
    assert done["ok"], done
    assert carl.delete(f"{API}/spaces/{space}/members/{carl_account.id}").status_code == 204
    return anna_account, anna, carl_account, carl, space, reminder


def test_a_task_of_a_former_member_keeps_saying_somebody_did_it_but_not_who() -> None:
    anna_account, anna, carl_account, _carl, _space, reminder = former_member()
    data = state(anna)[("reminder", reminder)]["data"]
    assert data["created_by"] == carl_account.id and data["completed_by"] == carl_account.id
    seen = people_of(anna)
    assert seen[carl_account.id] == {"id": carl_account.id, "name": None, "avatar_hash": None}
    assert seen[anna_account.id]["name"] == "anna"
    assert anna.get(f"{API}/people/{carl_account.id}/avatar").status_code == 404
    assert anna.get(f"/api/avatars/{carl_account.id}").status_code == 404


def test_a_program_learns_the_name_only_of_those_the_account_shares_a_space_with() -> None:
    anna_account, _anna, carl_account, _carl, _space, reminder = former_member()
    with SessionLocal() as db:
        settings_service.save(db, {"api_tokens_allowed": True})
        row = db.get(Account, anna_account.id)
        assert row is not None
        _made, secret = apitokens.make(db, row, "program", "read", None, None)
    apitokens.forget()
    from app.main import app

    program = TestClient(app, base_url="http://testserver", headers={"Authorization": f"Bearer {secret}"})
    task = program.get(f"/api/v1/tasks/{reminder}")
    assert task.status_code == 200, task.text
    assert task.json()["completed_by"] == {"id": carl_account.id, "name": None, "display_name": None}


def test_the_weekly_report_names_a_former_member_as_such() -> None:
    anna_account, _anna, _carl_account, _carl, _space, _reminder = former_member()
    now = clock.now()
    with SessionLocal() as db:
        row = db.get(Account, anna_account.id)
        assert row is not None
        done, _upcoming = reports._weekly_parts(db, row, base="https://tasks.example.com", today=now.date(),
                                                now=now + timedelta(minutes=1))
    assert [item.who for item in done] == ["done by Former member"]
    assert all("Carl" not in item.who for item in done)


def test_a_bundle_of_changes_by_a_former_member_does_not_name_him() -> None:
    from types import SimpleNamespace

    from app.services import notify

    anna_account, _anna, carl_account, _carl, _space, _reminder = former_member()
    with SessionLocal() as db:
        reader = SimpleNamespace(id=anna_account.id, language="en", browser_language="")
        listed = SimpleNamespace(name="Garden")
        events = [{"by": carl_account.id, "type": "completed"}]
        assert notify.bundle_text(db, reader, listed, events) == "Former member completed 1 task"
