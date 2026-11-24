"""Taking turns (``rotation``, contract 0.9; ``services/rotation.py``): a repeating task in a shared space goes round
its people in their order. ``assignees`` holds whose turn it is, so an app without the field sees an ordinary
assignment; the server moves on after a completion, whichever way it came."""

from __future__ import annotations

from typing import Any

from app.db import SessionLocal
from app.models import Account
from app.services import rotation

from .sync_helpers import API, batch, entry, make_list, make_reminder, person, put, shared_space
from .test_api_v1 import V1, api_on, token  # noqa: F401  (``api_on`` is a fixture)
from .test_notify import Relay, phone_of, relay  # noqa: F401  (``relay`` is a fixture)

AT = "2026-11-06T09:15:00.000Z"
WEEKLY = {"due_date": "2026-11-06", "due_time": None, "repeat": "FREQ=WEEKLY;BYDAY=FR", "repeat_from": "due"}


def complete(browser: Any, reminder: str, occurrence: str | None, at: str = AT, on: str = "2026-11-06") -> dict:
    [result] = batch(browser, {"type": "complete", "id": reminder, "occurrence": occurrence, "at": at, "on": on})
    return result


def family() -> tuple[list[int], list[Any], str]:
    """Anna, Ben and Cleo in one space with a list; the ids and the browsers."""
    people = [person(name) for name in ("anna", "ben", "cleo")]
    ids = [account.id for account, _browser in people]
    browsers = [browser for _account, browser in people]
    space = shared_space(browsers[0], browsers[1], browsers[2])
    return ids, browsers, make_list(browsers[0], space)


def data(browser: Any, reminder: str) -> dict[str, Any]:
    found = entry(browser, "reminder", reminder)
    assert found is not None
    return found["data"]


def test_the_server_names_the_feature_and_an_ordinary_reminder_reads_without_turns() -> None:
    _ids, browsers, list_id = family()
    assert "rotation" in browsers[0].get(f"{API}/me").json()["features"]
    reminder = make_reminder(browsers[0], list_id, "Bins out")
    found = entry(browsers[0], "reminder", reminder)
    assert found is not None
    assert found["data"]["rotation"] == [] and found["clock"]["rotation"] == 0


def test_turning_it_on_puts_whose_turn_it_is_into_assignees() -> None:
    (anna, ben, cleo), browsers, list_id = family()
    reminder = make_reminder(browsers[0], list_id, "Bins out", rotation=[ben, cleo, anna], **WEEKLY)
    held = data(browsers[0], reminder)
    assert held["rotation"] == [ben, cleo, anna] and held["assignees"] == [ben]
    # One already in charge who is in the rotation keeps it.
    other = make_reminder(browsers[0], list_id, "Dishes", rotation=[anna, ben], assignees=[ben], **WEEKLY)
    assert data(browsers[0], other)["assignees"] == [ben]


def test_completing_moves_on_to_the_one_after_who_ticked_it_off() -> None:
    (anna, ben, cleo), browsers, list_id = family()
    reminder = make_reminder(browsers[0], list_id, "Bins out", rotation=[anna, ben, cleo], **WEEKLY)
    result = complete(browsers[0], reminder, "2026-11-06")
    assert result["ok"]
    assert result["current"]["data"]["assignees"] == [ben]
    assert result["copy"]["data"]["assignees"] == [anna], "the done copy keeps whose turn it was"
    # Cleo ticks off although it is Ben's turn: she had it, Anna is next.
    result = complete(browsers[2], reminder, "2026-11-13", at="2026-11-13T09:00:00.000Z", on="2026-11-13")
    assert result["current"]["data"]["assignees"] == [anna]
    assert result["copy"]["data"]["completed_by"] == cleo and result["copy"]["data"]["assignees"] == [ben]


def test_someone_outside_the_rotation_moves_it_one_step_on() -> None:
    (anna, ben, cleo), browsers, list_id = family()
    reminder = make_reminder(browsers[0], list_id, "Bins out", rotation=[ben, cleo], **WEEKLY)
    assert data(browsers[0], reminder)["assignees"] == [ben]
    result = complete(browsers[0], reminder, "2026-11-06")
    assert result["current"]["data"]["assignees"] == [cleo]
    assert anna not in result["current"]["data"]["rotation"]


def test_a_date_passed_over_or_moved_on_without_a_copy_keeps_the_turn() -> None:
    (anna, ben, _cleo), browsers, list_id = family()
    reminder = make_reminder(browsers[0], list_id, "Bins out", rotation=[anna, ben], **WEEKLY)
    # Passed over by hand: the due date set a week on.
    assert put(browsers[0], "reminder", reminder, {**WEEKLY, "due_date": "2026-11-13"})["ok"]
    assert data(browsers[0], reminder)["assignees"] == [anna]
    # Done, then set back by hand and ticked off again: the copy is there, the original only moves on.
    later = {"at": "2026-11-13T09:00:00.000Z", "on": "2026-11-13"}
    assert complete(browsers[0], reminder, "2026-11-13", **later)["current"]["data"]["assignees"] == [ben]
    assert put(browsers[0], "reminder", reminder, {**WEEKLY, "due_date": "2026-11-13"})["ok"]
    again = complete(browsers[1], reminder, "2026-11-13", **later)
    assert again["ok"] and again["copy"]["data"]["completed_by"] == anna
    assert again["current"]["data"]["assignees"] == [ben]


def test_the_end_of_the_rule_keeps_the_turn() -> None:
    (anna, ben, _cleo), browsers, list_id = family()
    reminder = make_reminder(browsers[0], list_id, "Bins out", rotation=[anna, ben],
                             **{**WEEKLY, "repeat": "FREQ=WEEKLY;BYDAY=FR;COUNT=1"})
    result = complete(browsers[0], reminder, "2026-11-06")
    assert result["current"]["data"]["completed_at"] == AT and result["current"]["data"]["assignees"] == [anna]


def test_one_person_left_is_a_fixed_assignee() -> None:
    (anna, _ben, _cleo), browsers, list_id = family()
    reminder = make_reminder(browsers[0], list_id, "Bins out", rotation=[anna], **WEEKLY)
    assert complete(browsers[1], reminder, "2026-11-06")["current"]["data"]["assignees"] == [anna]


def test_without_repetition_or_in_private_it_changes_nothing() -> None:
    (anna, ben, _cleo), browsers, list_id = family()
    plain = make_reminder(browsers[0], list_id, "Call grandma", rotation=[anna, ben], assignees=[anna, ben])
    held = data(browsers[0], plain)
    assert held["rotation"] == [anna, ben] and held["assignees"] == [anna, ben], "kept, but no turns"
    # Moved into "Private": nobody can be in charge there.
    private_list = next(item["id"] for item in browsers[0].get(f"{API}/changes", params={"since": 0}).json()["items"]
                        if item["kind"] == "list" and item["data"]["name"] in ("Tasks", "Aufgaben"))
    repeating = make_reminder(browsers[0], list_id, "Bins out", rotation=[anna, ben], **WEEKLY)
    moved = put(browsers[0], "reminder", repeating, {"list_id": private_list, "section_id": None, "parent_id": None,
                                                     "position": "a0"})
    assert moved["current"]["data"]["rotation"] == [] and moved["current"]["data"]["assignees"] == []


def test_non_members_fall_out_quietly() -> None:
    (anna, ben, _cleo), browsers, list_id = family()
    stranger, _browser = person("dora")
    reminder = make_reminder(browsers[0], list_id, "Bins out", rotation=[stranger.id, anna, ben], **WEEKLY)
    assert data(browsers[0], reminder)["rotation"] == [anna, ben]


def test_an_app_without_the_field_changing_assignees() -> None:
    """An older app sends ``assignees`` only: someone of the rotation takes the turn; anything else keeps it."""
    (anna, ben, cleo), browsers, list_id = family()
    reminder = make_reminder(browsers[0], list_id, "Bins out", rotation=[anna, ben], **WEEKLY)
    assert put(browsers[1], "reminder", reminder, {"assignees": [ben]})["current"]["data"]["assignees"] == [ben]
    assert put(browsers[1], "reminder", reminder, {"assignees": [cleo]})["current"]["data"]["assignees"] == [ben]
    assert put(browsers[1], "reminder", reminder, {"assignees": []})["current"]["data"]["assignees"] == [ben]
    assert put(browsers[1], "reminder", reminder, {"assignees": [cleo, anna]})["current"]["data"]["assignees"] == [anna]


def test_leaving_the_space_passes_the_turn_on() -> None:
    (anna, ben, cleo), browsers, list_id = family()
    space = entry(browsers[0], "list", list_id)["data"]["space_id"]  # type: ignore[index]
    reminder = make_reminder(browsers[0], list_id, "Bins out", rotation=[anna, ben, cleo], assignees=[ben], **WEEKLY)
    assert browsers[1].delete(f"{API}/spaces/{space}/members/{ben}").status_code == 204
    held = data(browsers[0], reminder)
    assert held["rotation"] == [anna, cleo] and held["assignees"] == [cleo]
    assert browsers[2].delete(f"{API}/spaces/{space}/members/{cleo}").status_code == 204
    held = data(browsers[0], reminder)
    assert held["rotation"] == [anna] and held["assignees"] == [anna], "one left: still on"


def test_the_api_reads_writes_and_moves_on_like_the_app(api_on: None) -> None:  # noqa: F811
    (anna, ben, cleo), browsers, list_id = family()
    reminder = make_reminder(browsers[0], list_id, "Bins out", **WEEKLY)
    with SessionLocal() as db:
        account = db.get(Account, anna)
    api = token(account)
    assert "rotation" in api.get(f"{V1}/me").json()["features"]
    changed = api.patch(f"{V1}/tasks/{reminder}", json={"rotation": [cleo, anna]})
    assert changed.status_code == 200, changed.text
    body = changed.json()
    assert [p["id"] for p in body["rotation"]] == [cleo, anna] and [p["id"] for p in body["assignees"]] == [cleo]
    refused = api.patch(f"{V1}/tasks/{reminder}", json={"rotation": [999]})
    assert refused.status_code == 422 and refused.json()["detail"]["fields"] == ["rotation"]
    done = api.patch(f"{V1}/tasks/{reminder}", json={"completed": True})
    assert done.status_code == 200, done.text
    assert [p["id"] for p in done.json()["assignees"]] == [cleo], "Anna ticked off, Cleo is next after her"
    assert ben not in [p["id"] for p in done.json()["rotation"]]


def test_the_pieces() -> None:
    assert rotation.whose([1, 2, 3], [5, 3]) == 3
    assert rotation.whose([1, 2, 3], [], before=[2]) == 2
    assert rotation.after_completion([1, 2, 3], [3], 3) == 1
    assert rotation.after_completion([1, 2, 3], [2], 9) == 3
    assert rotation.without([1, 2, 3], [2], {2}, True) == ([1, 3], [3])
    assert rotation.without([1, 2, 3], [3], {3}, True) == ([1, 2], [1])
    assert rotation.without([1, 2], [2, 7], {2}, False) == ([1], [7])
    assert rotation.active([1], "FREQ=DAILY", "2026-11-06", False)
    assert not rotation.active([1], "FREQ=DAILY", None, False)
    assert not rotation.active([1], "FREQ=DAILY", "2026-11-06", True)


def test_the_next_one_hears_it_is_their_turn(relay: Relay) -> None:  # noqa: F811
    (anna, ben, _cleo), browsers, list_id = family()
    phone_of(browsers[1])
    reminder = make_reminder(browsers[0], list_id, "Bins out", rotation=[anna, ben], **WEEKLY)
    assert relay.messages() == []
    complete(browsers[0], reminder, "2026-11-06")
    messages = relay.messages()
    assert [(m["type"], m["reminder_id"]) for m in messages] == [("assigned", reminder)]
