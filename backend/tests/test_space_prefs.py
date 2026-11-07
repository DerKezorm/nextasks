"""Hiding a space (``space_pref``, contract 0.3): one person's own setting per space, kept in step on all of that
person's devices through ``/changes`` and ``/batch`` like ``list_pref``; nobody else ever sees it."""

from __future__ import annotations

from datetime import timedelta

from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.main import app
from app.models import Gone, Space, SpacePref
from app.routers.app1 import features
from app.services import trash

from .conftest import sign_in
from .sync_helpers import (
    API,
    WEB,
    all_changes,
    changes,
    make_list,
    make_reminder,
    new_id,
    now_ms,
    person,
    private_space,
    put,
    shared_space,
    state,
)


def _second_browser(account: object) -> TestClient:
    other = TestClient(app, base_url="http://testserver", headers=WEB)
    sign_in(other, account)
    return other


def test_hiding_a_space_reaches_the_other_device_of_the_same_person() -> None:
    kim_account, kim = person("kim")
    phone = _second_browser(kim_account)
    space, _list_id = private_space(kim)
    since = changes(phone)["cursor"]
    result = put(kim, "space_pref", space, {"hidden": True})
    assert result["ok"] and result["applied"] == ["hidden"]
    assert result["current"]["data"] == {"id": space, "hidden": True}
    news = [item for item in changes(phone, since)["items"] if item["kind"] == "space_pref"]
    assert [(item["id"], item["data"]["hidden"]) for item in news] == [(space, True)]
    # Shown again on the phone: the browser hears of it.
    since = changes(kim)["cursor"]
    assert put(phone, "space_pref", space, {"hidden": False})["ok"]
    news = [item for item in changes(kim, since)["items"] if item["kind"] == "space_pref"]
    assert [(item["id"], item["data"]["hidden"]) for item in news] == [(space, False)]


def test_a_hidden_shared_space_stays_shown_for_the_others() -> None:
    _kim, kim = person("kim")
    _lou, lou = person("lou")
    space = shared_space(kim, lou)
    assert put(lou, "space_pref", space, {"hidden": True})["ok"]
    assert ("space_pref", space) not in state(kim), "nobody else ever sees it"
    assert state(lou)[("space_pref", space)]["data"]["hidden"] is True
    # Everything in the space still comes: hiding only changes what the own sidebar shows.
    list_id = make_list(kim, space)
    reminder = make_reminder(kim, list_id, "Bread")
    held = state(lou)
    assert ("list", list_id) in held and ("reminder", reminder) in held


def test_the_later_clock_wins_and_the_same_clock_takes_the_greater_value() -> None:
    _kim, kim = person("kim")
    space, _ = private_space(kim)
    moment = now_ms()
    assert put(kim, "space_pref", space, {"hidden": True}, moment)["ok"]
    late = put(kim, "space_pref", space, {"hidden": False}, moment - 1000)
    assert late["applied"] == [] and late["current"]["data"]["hidden"] is True, "an older change loses"
    tie = put(kim, "space_pref", space, {"hidden": False}, moment)
    assert tie["applied"] == [] and tie["current"]["data"]["hidden"] is True, "true > false canonically"
    assert put(kim, "space_pref", space, {"hidden": False}, moment + 1)["current"]["data"]["hidden"] is False


def test_only_members_hide_a_space_and_an_unknown_one_is_missing() -> None:
    _kim, kim = person("kim")
    _lou, lou = person("lou")
    space, _ = private_space(kim)
    stranger = put(lou, "space_pref", space, {"hidden": True})
    assert stranger["code"] == "not_found" and stranger["current"] is None
    assert put(kim, "space_pref", new_id(), {"hidden": True})["code"] == "parent_missing"
    wrong = put(kim, "space_pref", space, {"hidden": "yes"})
    assert wrong["code"] == "invalid" and wrong["fields"] == ["hidden"]


def test_leaving_a_space_takes_the_setting_along_and_joining_again_shows_the_space() -> None:
    lou_account, lou = person("lou")
    _kim, kim = person("kim")
    space = shared_space(kim, lou)
    assert put(lou, "space_pref", space, {"hidden": True})["ok"]
    since = changes(lou)["cursor"]
    assert lou.delete(f"{API}/spaces/{space}/members/{lou_account.id}").status_code == 204
    went = {(item["kind"], item["id"]) for item in changes(lou, since)["items"] if item["deleted"]}
    assert ("space_pref", space) in went
    with SessionLocal() as db:
        assert db.get(SpacePref, (lou_account.id, space)) is None
    link = kim.post(f"{API}/spaces/{space}/invites").json()["link"].rsplit("/", 1)[-1]
    assert lou.post(f"/api/invites/{link}/accept").status_code == 200
    assert ("space_pref", space) not in state(lou)


def test_a_space_gone_for_good_leaves_a_tombstone_for_the_setting() -> None:
    kim_account, kim = person("kim")
    space = shared_space(kim)
    assert put(kim, "space_pref", space, {"hidden": True})["ok"]
    since = changes(kim)["cursor"]
    assert put(kim, "space", space, {"deleted_at": "2026-01-01T00:00:00.000Z"})["ok"]
    with SessionLocal() as db:
        row = db.get(Space, space)
        row.trashed_at = row.trashed_at - timedelta(days=31)
        db.commit()
    trash.run_once()
    went = {(item["kind"], item["id"]) for item in changes(kim, since)["items"] if item["deleted"]}
    assert ("space_pref", space) in went
    with SessionLocal() as db:
        assert db.get(Gone, ("space_pref", space, kim_account.id)) is not None
    assert put(kim, "space_pref", space, {"hidden": False})["code"] == "gone"


def test_the_server_names_the_feature_and_a_full_fetch_brings_the_setting() -> None:
    with SessionLocal() as db:
        assert "space_prefs" in features(db)
    _kim, kim = person("kim")
    space, _ = private_space(kim)
    put(kim, "space_pref", space, {"hidden": True})
    items, _cursor = all_changes(kim)
    prefs = [item for item in items if item["kind"] == "space_pref"]
    assert len(prefs) == 1 and prefs[0]["clock"]["hidden"] > 0


def test_an_older_client_reading_only_the_kinds_of_0_2_finds_everything_else_unchanged() -> None:
    """A client of contract 0.2 knows seven kinds and skips the rest (app: ``Kind(rawValue:)`` is nil; web: no view of
    it). What it builds from the other entries is the same with and without a hidden space."""
    known = {"space", "member", "list", "section", "reminder", "attachment", "list_pref"}
    _kim, kim = person("kim")
    space, list_id = private_space(kim)
    make_reminder(kim, list_id, "Bread")

    def old_view() -> dict[tuple[str, str], object]:
        items, _ = all_changes(kim)
        return {(item["kind"], item["id"]): item["data"] for item in items if item["kind"] in known}

    before = old_view()
    assert put(kim, "space_pref", space, {"hidden": True})["ok"]
    assert old_view() == before
