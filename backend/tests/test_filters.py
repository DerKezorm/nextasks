"""Own filters (``filter``) and hidden tiles (``tile_pref``), contract 0.5: an account's own things, in no space, kept in
step on all of its devices through ``/changes`` and ``/batch``; nobody else ever sees them. The server keeps a filter's
``rules`` as they came and never evaluates them."""

from __future__ import annotations

from datetime import timedelta

from fastapi.testclient import TestClient
from sqlalchemy import select, update

from app.db import SessionLocal
from app.main import app
from app.models import Gone, SavedFilter, TilePref, utcnow
from app.routers.app1 import features
from app.services import records, trash

from .conftest import PASSWORD, sign_in
from .sync_helpers import (
    all_changes,
    batch,
    changes,
    make_reminder,
    new_id,
    now_ms,
    person,
    private_space,
    put,
    state,
)

TODAY = "00000000-0000-4000-8000-0000000000a1"
COMPLETED = "00000000-0000-4000-8000-0000000000a6"


def _second_browser(account: object) -> TestClient:
    other = TestClient(app, base_url="http://testserver", headers={"X-Nextasks-Client": "web"})
    sign_in(other, account)
    return other


def _make_filter(client: TestClient, name: str = "Urgent", position: str = "a0", **fields: object) -> str:
    filter_id = new_id()
    result = put(client, "filter", filter_id, {"name": name, "position": position, **fields})
    assert result["ok"], result
    return filter_id


def _delete(client: TestClient, kind: str, item_id: str) -> dict:
    [result] = batch(client, {"type": "delete", "kind": kind, "id": item_id})
    return result


# --- filter ---------------------------------------------------------------------------------------------------------


def test_a_new_filter_gets_the_defaults_with_clock_zero() -> None:
    _robin, robin = person("robin")
    filter_id = new_id()
    moment = now_ms()
    result = put(robin, "filter", filter_id, {"name": "  Urgent  ", "position": "a0"}, moment)
    assert result["ok"] and result["applied"] == ["name", "position"]
    current = result["current"]
    assert current["kind"] == "filter" and current["id"] == filter_id and current["deleted"] is False
    assert current["data"] == {"id": filter_id, "name": "Urgent", "color": "blue", "icon": "filter", "position": "a0",
                               "rules": {}, "hidden": False}
    assert current["clock"] == {"name": moment, "color": 0, "icon": 0, "position": moment, "rules": 0, "hidden": 0}


def test_a_filter_reaches_the_other_device_of_the_same_person_with_its_rules_as_they_came() -> None:
    robin_account, robin = person("robin")
    phone = _second_browser(robin_account)
    since = changes(phone)["cursor"]
    rules = {"state": "open", "due": ["today", "overdue"], "assignees": ["me", 3], "flagged": True,
             "from_a_newer_app": {"nested": [1, 2.5, None]}}
    filter_id = _make_filter(robin, "Mine today", color="red", icon="flame", rules=rules, hidden=True)
    news = [item for item in changes(phone, since)["items"] if item["kind"] == "filter"]
    assert [item["id"] for item in news] == [filter_id]
    assert news[0]["data"] == {"id": filter_id, "name": "Mine today", "color": "red", "icon": "flame",
                               "position": "a0", "rules": rules, "hidden": True}
    assert set(news[0]["clock"]) == {"name", "color", "icon", "position", "rules", "hidden"}
    # A full fetch brings it as well.
    assert state(phone)[("filter", filter_id)]["data"]["rules"] == rules


def test_rules_are_one_field_the_later_object_wins_whole() -> None:
    _robin, robin = person("robin")
    moment = now_ms()
    filter_id = new_id()
    assert put(robin, "filter", filter_id, {"name": "Work", "position": "a0",
                                            "rules": {"flagged": True, "priority": [3]}}, moment)["ok"]
    older = put(robin, "filter", filter_id, {"rules": {"tags": ["home"]}}, moment - 1000)
    assert older["applied"] == [] and older["ignored"] == ["rules"]
    assert older["current"]["data"]["rules"] == {"flagged": True, "priority": [3]}
    later = put(robin, "filter", filter_id, {"rules": {"tags": ["home"]}, "name": "Home"}, moment + 1000)
    assert later["applied"] == ["name", "rules"]
    assert later["current"]["data"]["rules"] == {"tags": ["home"]}, "never merged condition by condition"
    assert later["current"]["data"]["name"] == "Home" and later["current"]["data"]["position"] == "a0"
    assert later["current"]["clock"]["rules"] == moment + 1000 and later["current"]["clock"]["position"] == moment
    # The same clock: the canonically greater value is taken, on every server and device alike.
    tie = put(robin, "filter", filter_id, {"hidden": True}, 0)
    assert tie["applied"] == ["hidden"] and tie["current"]["data"]["hidden"] is True


def test_what_a_filter_must_have_and_may_hold() -> None:
    _robin, robin = person("robin")
    missing = put(robin, "filter", new_id(), {"color": "red"})
    assert missing["code"] == "invalid" and missing["fields"] == ["name", "position"]
    for name in ("", "   ", "x" * 81, 5):
        wrong = put(robin, "filter", new_id(), {"name": name, "position": "a0"})
        assert wrong["code"] == "invalid" and wrong["fields"] == ["name"], name
    assert put(robin, "filter", new_id(), {"name": "x" * 80, "position": "a0"})["ok"]
    for bad in ({"position": "not a key"}, {"color": "beige"}, {"hidden": "yes"}, {"icon": ""}):
        wrong = put(robin, "filter", new_id(), {"name": "Urgent", "position": "a0", **bad})
        assert wrong["code"] == "invalid" and wrong["fields"] == list(bad), bad


def test_rules_must_be_an_object_of_at_most_4000_characters_written() -> None:
    _robin, robin = person("robin")
    for rules in ([], "state=open", None, 1, True):
        wrong = put(robin, "filter", new_id(), {"name": "Urgent", "position": "a0", "rules": rules})
        assert wrong["code"] == "invalid" and wrong["fields"] == ["rules"], rules
    # Written as {"t":"…"}: eight characters around the text.
    fits = {"t": "x" * (records.MAX_RULES - 8)}
    assert put(robin, "filter", new_id(), {"name": "Long", "position": "a0", "rules": fits})["ok"]
    too_long = {"t": "x" * (records.MAX_RULES - 7)}
    wrong = put(robin, "filter", new_id(), {"name": "Long", "position": "a0", "rules": too_long})
    assert wrong["code"] == "invalid" and wrong["fields"] == ["rules"]
    # Characters, not bytes: an umlaut counts once.
    umlauts = {"t": "ä" * (records.MAX_RULES - 8)}
    assert put(robin, "filter", new_id(), {"name": "Umlauts", "position": "a0", "rules": umlauts})["ok"]
    # A change is checked the same way.
    filter_id = _make_filter(robin)
    wrong = put(robin, "filter", filter_id, {"rules": too_long})
    assert wrong["code"] == "invalid" and wrong["current"]["data"]["rules"] == {}


def test_nobody_else_sees_or_changes_my_filter() -> None:
    _robin, robin = person("robin")
    _mara, mara = person("mara")
    since = changes(mara)["cursor"]
    filter_id = _make_filter(robin, rules={"flagged": True})
    assert ("filter", filter_id) not in state(mara)
    assert not [item for item in changes(mara, since)["items"] if item["kind"] == "filter"]
    taken = put(mara, "filter", filter_id, {"name": "Mine now", "position": "a0"})
    assert taken["code"] == "not_found" and taken["current"] is None
    removed = _delete(mara, "filter", filter_id)
    assert removed["code"] == "not_found" and removed["current"] is None
    held = state(robin)[("filter", filter_id)]["data"]
    assert held["name"] == "Urgent" and held["rules"] == {"flagged": True}


def test_a_deleted_filter_leaves_a_tombstone_for_its_owner_alone() -> None:
    robin_account, robin = person("robin")
    _mara, mara = person("mara")
    phone = _second_browser(robin_account)
    filter_id = _make_filter(robin)
    since_phone = changes(phone)["cursor"]
    since_mara = changes(mara)["cursor"]
    result = _delete(robin, "filter", filter_id)
    assert result["ok"] and result["current"]["deleted"] is True and result["current"]["data"] is None
    went = [item for item in changes(phone, since_phone)["items"] if item["kind"] == "filter"]
    assert [(item["id"], item["deleted"]) for item in went] == [(filter_id, True)]
    assert not [item for item in changes(mara, since_mara)["items"] if item["kind"] == "filter"]
    assert ("filter", filter_id) not in state(phone)
    with SessionLocal() as db:
        assert db.get(SavedFilter, filter_id) is None
        assert db.get(Gone, ("filter", filter_id, robin_account.id)) is not None
    # Already gone: ok. A change to it: gone. Another account may not take the id over.
    assert _delete(phone, "filter", filter_id)["ok"]
    again = put(phone, "filter", filter_id, {"name": "Back", "position": "a0"})
    assert again["code"] == "gone" and again["current"]["deleted"] is True
    stranger = put(mara, "filter", filter_id, {"name": "Mine", "position": "a0"})
    assert stranger["code"] == "not_found" and stranger["current"] is None
    assert _delete(mara, "filter", filter_id)["code"] == "not_found"
    # An id the server never had.
    assert _delete(robin, "filter", new_id())["code"] == "not_found"


def test_a_filter_tombstone_goes_after_ninety_days() -> None:
    _robin, robin = person("robin")
    filter_id = _make_filter(robin)
    assert _delete(robin, "filter", filter_id)["ok"]
    with SessionLocal() as db:
        db.execute(update(Gone).where(Gone.kind == "filter").values(gone_at=utcnow() - timedelta(days=91)))
        db.commit()
    trash.run_once()
    with SessionLocal() as db:
        assert db.scalar(select(Gone).where(Gone.kind == "filter")) is None


def test_only_sections_attachments_and_filters_are_deleted_for_good() -> None:
    _robin, robin = person("robin")
    result = _delete(robin, "tile_pref", TODAY)
    assert result["code"] == "invalid" and result["fields"] == ["kind"]


# --- tile_pref ------------------------------------------------------------------------------------------------------


def test_hiding_a_tile_reaches_the_other_device_and_nobody_else() -> None:
    robin_account, robin = person("robin")
    _mara, mara = person("mara")
    phone = _second_browser(robin_account)
    since = changes(phone)["cursor"]
    since_mara = changes(mara)["cursor"]
    result = put(robin, "tile_pref", COMPLETED, {"hidden": True})
    assert result["ok"] and result["applied"] == ["hidden"]
    assert result["current"]["kind"] == "tile_pref" and result["current"]["id"] == COMPLETED
    assert result["current"]["data"] == {"id": COMPLETED, "hidden": True}
    news = [item for item in changes(phone, since)["items"] if item["kind"] == "tile_pref"]
    assert [(item["id"], item["data"]["hidden"]) for item in news] == [(COMPLETED, True)]
    assert set(news[0]["clock"]) == {"hidden"}
    assert not [item for item in changes(mara, since_mara)["items"] if item["kind"] == "tile_pref"]
    # Mara's own setting for the same tile is hers alone.
    assert put(mara, "tile_pref", COMPLETED, {"hidden": False})["ok"]
    assert state(robin)[("tile_pref", COMPLETED)]["data"]["hidden"] is True
    assert state(mara)[("tile_pref", COMPLETED)]["data"]["hidden"] is False


def test_a_tile_setting_follows_the_clock_and_starts_with_the_default() -> None:
    _robin, robin = person("robin")
    moment = now_ms()
    made = put(robin, "tile_pref", TODAY, {}, moment)
    assert made["ok"] and made["current"]["data"]["hidden"] is False and made["current"]["clock"] == {"hidden": 0}
    assert put(robin, "tile_pref", TODAY, {"hidden": True}, moment)["ok"]
    late = put(robin, "tile_pref", TODAY, {"hidden": False}, moment - 1000)
    assert late["applied"] == [] and late["current"]["data"]["hidden"] is True, "an older change loses"
    assert put(robin, "tile_pref", TODAY, {"hidden": False}, moment + 1)["current"]["data"]["hidden"] is False


def test_only_the_six_tiles_have_a_setting() -> None:
    _robin, robin = person("robin")
    for tile in records.TILE_IDS:
        assert put(robin, "tile_pref", tile, {"hidden": True})["ok"], tile
    for wrong_id in (new_id(), "00000000-0000-4000-8000-0000000000a7", "00000000-0000-4000-8000-0000000000a0",
                     "00000000-0000-4000-8000-0000000000A1"):
        wrong = put(robin, "tile_pref", wrong_id, {"hidden": True})
        assert wrong["code"] == "invalid" and wrong["fields"] == ["id"], wrong_id
    wrong = put(robin, "tile_pref", TODAY, {"hidden": "yes"})
    assert wrong["code"] == "invalid" and wrong["fields"] == ["hidden"]
    assert len([item for item in all_changes(robin)[0] if item["kind"] == "tile_pref"]) == 6


# --- Both -----------------------------------------------------------------------------------------------------------


def test_the_server_names_the_feature() -> None:
    with SessionLocal() as db:
        assert "filters" in features(db) and "space_prefs" in features(db)
    _robin, robin = person("robin")
    assert "filters" in robin.get("/api/app/1/me").json()["features"]


def test_deleting_the_account_takes_its_filters_and_tile_settings_along(client: TestClient, operator: object) -> None:
    sam_account, sam = person("sam")
    _robin, robin = person("robin")
    filter_id = _make_filter(sam)
    gone_id = _make_filter(sam, "Old", "a1")
    assert _delete(sam, "filter", gone_id)["ok"]
    assert put(sam, "tile_pref", TODAY, {"hidden": True})["ok"]
    kept = _make_filter(robin)
    assert put(robin, "tile_pref", TODAY, {"hidden": True})["ok"]
    answer = client.request("DELETE", f"/api/accounts/{sam_account.id}", json={"current_password": PASSWORD})
    assert answer.status_code == 204, answer.text
    with SessionLocal() as db:
        assert db.get(SavedFilter, filter_id) is None
        assert db.get(TilePref, (sam_account.id, TODAY)) is None
        assert db.scalar(select(Gone).where(Gone.kind == "filter", Gone.account_id == sam_account.id)) is None
        assert db.get(SavedFilter, kept) is not None
        assert db.get(TilePref, (_robin.id, TODAY)) is not None


def test_an_older_client_reading_only_the_kinds_of_0_4_finds_everything_else_unchanged() -> None:
    """A client of contract 0.4 skips the kinds it does not know. What it builds from the other entries is the same
    with and without filters and hidden tiles."""
    known = {"space", "member", "list", "section", "reminder", "attachment", "list_pref", "space_pref"}
    _robin, robin = person("robin")
    _space, list_id = private_space(robin)
    make_reminder(robin, list_id, "Bread")

    def old_view() -> dict[tuple[str, str], object]:
        items, _ = all_changes(robin)
        return {(item["kind"], item["id"]): item["data"] for item in items if item["kind"] in known}

    before = old_view()
    filter_id = _make_filter(robin)
    assert put(robin, "tile_pref", TODAY, {"hidden": True})["ok"]
    assert _delete(robin, "filter", filter_id)["ok"]
    assert old_view() == before


def test_paging_carries_own_things_without_losing_one() -> None:
    _robin, robin = person("robin")
    made = {_make_filter(robin, f"f{number}", f"a{number}") for number in range(5)}
    for tile in records.TILE_IDS[:3]:
        assert put(robin, "tile_pref", tile, {"hidden": True})["ok"]
    items, _cursor = all_changes(robin, limit=2)
    assert {item["id"] for item in items if item["kind"] == "filter"} == made
    assert {item["id"] for item in items if item["kind"] == "tile_pref"} == set(records.TILE_IDS[:3])
