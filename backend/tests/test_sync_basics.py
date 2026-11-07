"""The first steps of the sync: who calls, the space "Private", a put that makes and changes, ``/changes``."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app

from .sync_helpers import API, batch, changes, make_reminder, new_id, person, private_space, put, put_op, state


def test_every_account_has_its_private_space_with_a_first_list_in_its_language() -> None:
    account, browser = person("anna")
    browser.headers["Accept-Language"] = "de-DE"
    space_id, list_id = private_space(browser)
    held = state(browser)
    assert held[("space", space_id)]["data"]["name"] in ("Privat", "Private")
    assert held[("space", space_id)]["data"]["role"] == "manager"
    assert held[("member", f"{space_id}:{account.id}")]["data"]["role"] == "manager"
    assert held[("list", list_id)]["data"]["position"] == "a0"
    page = changes(browser)
    assert page["space_ids"] == [space_id]
    assert [p["id"] for p in page["people"]] == [account.id]


def test_without_a_key_or_session_nothing_opens_and_a_session_must_name_itself() -> None:
    plain = TestClient(app, base_url="http://testserver")
    answer = plain.get(f"{API}/me")
    assert answer.status_code == 401 and answer.json()["detail"]["code"] == "not_signed_in"
    _account, browser = person("anna")
    unnamed = TestClient(app, base_url="http://testserver", cookies=dict(browser.cookies))
    for method in ("GET", "POST"):
        refused = unnamed.request(method, f"{API}/me" if method == "GET" else f"{API}/batch", json={"ops": []})
        assert refused.status_code == 403 and refused.json()["detail"]["code"] == "bad_client"
    assert browser.get(f"{API}/me").status_code == 200


def test_a_reminder_is_made_changed_and_read_back_with_its_clocks() -> None:
    account, browser = person("anna")
    _space, list_id = private_space(browser)
    reminder = make_reminder(browser, list_id, "Milk", tags=["Shop", "shop", "Dairy"])
    held = state(browser)[("reminder", reminder)]
    assert held["data"]["title"] == "Milk" and held["data"]["tags"] == ["Shop", "Dairy"]
    assert held["data"]["created_by"] == account.id and held["clock"]["title"] > 0
    assert held["clock"]["notes"] == 0, "what was not sent has the clock 0 of a default"
    result = put(browser, "reminder", reminder, {"title": "Oat milk"})
    assert result["ok"] and result["applied"] == ["title"] and result["current"]["data"]["title"] == "Oat milk"


def test_a_batch_answers_every_op_in_order_and_one_failure_holds_no_other_up() -> None:
    _account, browser = person("anna")
    _space, list_id = private_space(browser)
    good = new_id()
    results = batch(
        browser,
        put_op("reminder", "NOT-A-UUID", {"title": "x"}),
        put_op("reminder", good, {"list_id": list_id, "title": "Bread", "position": "a0"}),
        {"type": "explode"},
    )
    assert [r["ok"] for r in results] == [False, True, False]
    assert results[0]["code"] == "invalid" and results[0]["current"] is None
    assert results[1]["current"]["id"] == good


def test_too_many_ops_are_refused_as_invalid_input() -> None:
    _account, browser = person("anna")
    ops = [{"op_id": new_id(), "type": "position", "space_id": new_id(), "position": "a0"} for _ in range(201)]
    answer = browser.post(f"{API}/batch", json={"ops": ops})
    assert answer.status_code == 422 and answer.json()["detail"]["code"] == "invalid_input"
