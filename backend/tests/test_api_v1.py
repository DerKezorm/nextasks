"""The API for programs (``/api/v1``, ``docs/api.md``): what a token sees (the account's spaces and the token's choice,
hidden spaces), what it may change (only with ``write``, only through the ops of the interface), ``external_ref`` safe
to repeat, keeping a program in step (``ids``, ``updated_since``), repeating tasks, the dashboard in the account's time
zone, and the walls in front (Origin, the brake, switched off)."""

from __future__ import annotations

import threading
from datetime import UTC, datetime
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import SessionLocal
from app.main import app
from app.models import Account, AssignedLog, ExternalRef, Reminder
from app.services import apitokens, clock, cursor, records, settings_service, trash, wiederholung

from .sync_helpers import (
    API,
    batch,
    changes,
    make_list,
    make_reminder,
    new_id,
    now_ms,
    person,
    private_space,
    put,
    shared_space,
)
from .test_pruefsaetze import REPEAT

V1 = "/api/v1"


@pytest.fixture(autouse=True)
def api_on() -> None:
    with SessionLocal() as db:
        settings_service.save(db, {"api_tokens_allowed": True})
    apitokens.forget()


def token(account: Account, level: str = "write", only: list[str] | None = None) -> TestClient:
    """A program with a token of ``account``: all its spaces, or ``only`` these."""
    with SessionLocal() as db:
        row = db.get(Account, account.id)
        assert row is not None
        _made, secret = apitokens.make(db, row, "program", level, only, None)
    return TestClient(app, base_url="http://testserver", headers={"Authorization": f"Bearer {secret}"})


def ok(answer: Any, status: int = 200) -> Any:
    assert answer.status_code == status, answer.text
    return answer.json() if answer.content else None


def refused(answer: Any, status: int, code: str) -> dict[str, Any]:
    assert answer.status_code == status, answer.text
    body = answer.json()["detail"]
    assert body["code"] == code, body
    assert isinstance(body["message"], str) and body["message"], body
    return body


def family() -> tuple[Account, TestClient, Account, TestClient, str, str]:
    """Anna and Ben with a shared space "Family" and its list "Shopping"."""
    anna_account, anna = person("anna")
    ben_account, ben = person("ben")
    space = shared_space(anna, ben)
    list_id = make_list(anna, space)
    return anna_account, anna, ben_account, ben, space, list_id


def ids_of(found: dict[str, Any]) -> list[str]:
    return [task["id"] for task in found["tasks"]]


# --- Who am I, what a token sees -------------------------------------------------------------------------------------


def test_me_names_the_time_zone_the_features_and_only_the_spaces_of_the_token() -> None:
    anna_account, anna, _ben_account, _ben, space, _list_id = family()
    private, _first = private_space(anna)
    anna.put(f"{API}/me", json={"timezone": "Europe/Berlin"})
    me = ok(token(anna_account).get(f"{V1}/me"))
    assert me["time_zone"] == "Europe/Berlin" and me["level"] == "write"
    assert {"tasks", "dashboard", "external_ref"} <= set(me["features"])
    assert {item["id"] for item in me["spaces"]} == {private, space}
    narrow = ok(token(anna_account, "read", [private]).get(f"{V1}/me"))
    assert [item["id"] for item in narrow["spaces"]] == [private] and narrow["level"] == "read"


def test_the_choice_at_the_token_holds_in_every_route() -> None:
    anna_account, anna, _ben_account, ben, space, list_id = family()
    private, first = private_space(anna)
    shared_task = make_reminder(ben, list_id, "Bread", due_date=clock.today().isoformat())
    own_task = make_reminder(anna, first, "Letter", due_date=clock.today().isoformat())
    program = token(anna_account, "write", [private])
    assert [item["id"] for item in ok(program.get(f"{V1}/spaces"))["spaces"]] == [private]
    assert {item["id"] for item in ok(program.get(f"{V1}/lists"))["lists"]} == {first}
    refused(program.get(f"{V1}/lists", params={"space_id": space}), 404, "not_found")
    assert ids_of(ok(program.get(f"{V1}/tasks"))) == [own_task]
    refused(program.get(f"{V1}/tasks/{shared_task}"), 404, "not_found")
    refused(program.get(f"{V1}/tasks", params={"list_id": list_id}), 404, "not_found")
    refused(program.patch(f"{V1}/tasks/{shared_task}", json={"title": "Mine"}), 404, "not_found")
    refused(program.delete(f"{V1}/tasks/{shared_task}"), 404, "not_found")
    refused(program.post(f"{V1}/tasks", json={"title": "There", "list_id": list_id}), 404, "not_found")
    assert ok(program.get(f"{V1}/tasks", params={"ids": shared_task}))["tasks"] == [{"id": shared_task,
                                                                                    "gone": True}]
    assert ok(program.get(f"{V1}/dashboard"))["counts"]["today"] == 1
    assert ok(token(anna_account).get(f"{V1}/dashboard"))["counts"]["today"] == 2
    with SessionLocal() as db:
        assert db.get(Reminder, shared_task).title == "Bread"  # type: ignore[union-attr]


def test_a_space_of_others_is_not_there_for_the_token() -> None:
    _anna_account, _anna, _ben_account, _ben, _space, _list_id = family()
    cleo_account, cleo = person("cleo")
    _private, first = private_space(cleo)
    secret = make_reminder(cleo, first, "Diary")
    program = token(_anna_account)
    refused(program.get(f"{V1}/tasks/{secret}"), 404, "not_found")
    refused(program.patch(f"{V1}/tasks/{secret}", json={"completed": True}), 404, "not_found")
    refused(program.post(f"{V1}/tasks", json={"title": "Into hers", "list_id": first}), 404, "not_found")
    refused(program.get(f"{V1}/lists", params={"space_id": _private}), 404, "not_found")
    assert secret not in ids_of(ok(program.get(f"{V1}/tasks", params={"state": "all", "subtasks": True})))
    assert cleo_account.id != _anna_account.id
    with SessionLocal() as db:
        assert db.get(Reminder, secret).completed_at is None  # type: ignore[union-attr]


def test_a_reading_token_changes_nothing() -> None:
    anna_account, anna = person("anna")
    _private, first = private_space(anna)
    task = make_reminder(anna, first, "Milk")
    program = token(anna_account, "read")
    assert ok(program.get(f"{V1}/tasks/{task}"))["title"] == "Milk"
    refused(program.post(f"{V1}/tasks", json={"title": "New"}), 403, "token_reads_only")
    refused(program.patch(f"{V1}/tasks/{task}", json={"completed": True}), 403, "token_reads_only")
    refused(program.delete(f"{V1}/tasks/{task}"), 403, "token_reads_only")
    with SessionLocal() as db:
        row = db.get(Reminder, task)
        assert row is not None and row.completed_at is None and row.deleted_at is None
        assert len(db.scalars(select(Reminder.id)).all()) == 1


def test_a_hidden_space_is_listed_as_such_does_not_count_and_is_never_the_default() -> None:
    anna_account, anna, _ben_account, _ben, space, list_id = family()
    private, first = private_space(anna)
    make_reminder(anna, first, "Hidden one", due_date=clock.today().isoformat())
    make_reminder(anna, list_id, "Seen one", due_date=clock.today().isoformat())
    program = token(anna_account)
    made = ok(program.post(f"{V1}/tasks", json={"title": "Default"}), 201)
    assert made["list_id"] == first, "Private's first list while it is shown"
    assert put(anna, "space_pref", private, {"hidden": True})["ok"]
    spaces_seen = {item["id"]: item for item in ok(program.get(f"{V1}/spaces"))["spaces"]}
    assert spaces_seen[private]["hidden"] is True and spaces_seen[space]["hidden"] is False
    assert spaces_seen[private]["shared"] is False and spaces_seen[space]["shared"] is True
    lists = ok(program.get(f"{V1}/lists"))["lists"]
    assert [item["id"] for item in lists] == [list_id, first], "hidden spaces at the end, as in the sidebar"
    assert lists[1]["hidden"] is True and lists[0]["hidden"] is False
    board = ok(program.get(f"{V1}/dashboard"))
    assert board["counts"]["today"] == 1 and [task["title"] for task in board["today"]] == ["Seen one"]
    made = ok(program.post(f"{V1}/tasks", json={"title": "Default again"}), 201)
    assert made["list_id"] == list_id, "never a list in a hidden space"
    assert ok(program.get(f"{V1}/tasks/{made['id']}"))["title"] == "Default again"


def test_without_a_shown_space_there_is_no_default_list() -> None:
    anna_account, anna = person("anna")
    private, _first = private_space(anna)
    assert put(anna, "space_pref", private, {"hidden": True})["ok"]
    body = refused(token(anna_account).post(f"{V1}/tasks", json={"title": "Where?"}), 422, "invalid_input")
    assert body["fields"] == ["list_id"]


# --- Making and changing --------------------------------------------------------------------------------------------


def test_a_task_made_through_the_api_is_seen_by_the_devices_at_once() -> None:
    anna_account, _anna, ben_account, ben, space, list_id = family()
    since = changes(ben)["cursor"]
    program = token(anna_account)
    made = ok(program.post(f"{V1}/tasks", json={
        "list_id": list_id, "title": "Answer the school", "notes": "**Today**, not tomorrow", "url": "https://x.test",
        "due_date": "2026-11-08", "due_time": "09:00", "priority": 2, "flagged": True, "tags": ["mail"],
        "assignees": [ben_account.id]}), 201)
    assert made["notes_text"] == "Today, not tomorrow" and made["priority"] == 2 and made["flagged"] is True
    assert made["assignees"] == [{"id": ben_account.id, "name": "ben", "display_name": "ben"}]
    assert made["link"] is None, "no public address"
    seen = [item for item in changes(ben, since)["items"] if item["kind"] == "reminder"]
    assert [item["id"] for item in seen] == [made["id"]]
    assert seen[0]["data"]["created_by"] == anna_account.id and seen[0]["data"]["due_time"] == "09:00"
    waited = ben.get(f"{API}/wait", params={"cursor": since})
    assert waited.json()["cursor"] > since, "a waiting device hears of it at once"
    with SessionLocal() as db:
        logged = db.scalars(select(AssignedLog).where(AssignedLog.account_id == ben_account.id)).all()
    assert [row.reminder_id for row in logged] == [made["id"]], "assigned: the same event as from the interface"
    assert space


def test_ticking_off_through_the_api_reaches_changes_as_from_the_interface() -> None:
    anna_account, _anna, _ben_account, ben, _space, list_id = family()
    task = make_reminder(ben, list_id, "Bins")
    sub = make_reminder(ben, list_id, "Yellow bin", parent_id=task)
    since = changes(ben)["cursor"]
    done = ok(token(anna_account).patch(f"{V1}/tasks/{task}", json={"completed": True}))
    assert done["completed"] is True and done["completed_by"]["id"] == anna_account.id
    assert "next" not in done
    items = {item["id"]: item for item in changes(ben, since)["items"]}
    assert items[task]["data"]["completed_by"] == anna_account.id and items[task]["data"]["completed_at"]
    assert items[sub]["data"]["completed_at"] == items[task]["data"]["completed_at"], "subtasks go along"
    again = ok(token(anna_account).patch(f"{V1}/tasks/{task}", json={"completed": False}))
    assert again["completed"] is False and again["completed_by"] is None
    with SessionLocal() as db:
        assert db.get(Reminder, sub).completed_at is not None, "reopening opens only the task itself"  # type: ignore


def test_a_repeating_task_moves_on_and_names_the_open_occurrence_and_the_copy() -> None:
    anna_account, anna = person("anna")
    _private, first = private_space(anna)
    case = next(item for item in REPEAT["next_due"] if item["rule"] == "FREQ=WEEKLY;BYDAY=FR")
    task = make_reminder(anna, first, "Water the plants", due_date=case["due_date"], due_time="08:00",
                         repeat=case["rule"])
    sub = make_reminder(anna, first, "Fern", parent_id=task)
    batch(anna, {"type": "complete", "id": sub, "occurrence": None, "at": records.format_stamp(clock.now()),
                 "on": clock.today().isoformat()})
    done = ok(token(anna_account).patch(f"{V1}/tasks/{task}", json={"completed": True}))
    assert done["id"] == task and done["completed"] is False, "the task keeps its id and stays open"
    assert done["due_date"] == case["expect"] and done["due_time"] == "08:00"
    assert done["next"] == task
    assert done["completed_copy"] == wiederholung.copy_id(task, case["due_date"])
    copy = ok(token(anna_account).get(f"{V1}/tasks/{done['completed_copy']}"))
    assert copy["completed"] is True and copy["due_date"] == case["due_date"] and copy["repeat"] is None
    assert ok(token(anna_account).get(f"{V1}/tasks/{task}"))["subtasks"]["open"] == 1, "subtasks open again"
    last = make_reminder(anna, first, "Last time", due_date="2026-11-06", repeat="FREQ=DAILY;COUNT=1")
    ended = ok(token(anna_account).patch(f"{V1}/tasks/{last}", json={"completed": True}))
    assert ended["completed"] is True and "next" not in ended, "a rule at its end completes the task itself"


def test_fields_change_null_clears_and_the_bin_works_both_ways() -> None:
    anna_account, anna, _ben_account, _ben, _space, list_id = family()
    _private, first = private_space(anna)
    task = make_reminder(anna, first, "Call", due_date="2026-11-09", due_time="10:00", repeat="FREQ=DAILY")
    program = token(anna_account)
    changed = ok(program.patch(f"{V1}/tasks/{task}", json={"title": "Call back", "due_date": None, "tags": ["a"]}))
    assert changed["title"] == "Call back" and changed["due_date"] is None and changed["due_time"] is None
    assert changed["repeat"] is None and changed["tags"] == ["a"]
    refused(program.patch(f"{V1}/tasks/{task}", json={"due_time": "09:00"}), 422, "invalid_input")
    moved = ok(program.patch(f"{V1}/tasks/{task}", json={"list_id": list_id}))
    assert moved["list_id"] == list_id
    assert ok(program.delete(f"{V1}/tasks/{task}"), 204) is None
    trashed = ok(program.get(f"{V1}/tasks/{task}"))
    assert trashed["trashed"] is True and trashed["trashed_at"]
    assert task not in ids_of(ok(program.get(f"{V1}/tasks")))
    assert task in ids_of(ok(program.get(f"{V1}/tasks", params={"include_trashed": True})))
    back = ok(program.patch(f"{V1}/tasks/{task}", json={"trashed": False}))
    assert back["trashed"] is False
    body = refused(program.patch(f"{V1}/tasks/{task}", json={"repeat": "FREQ=DAILY"}), 422, "invalid_input")
    assert "repeat" in body["fields"]
    refused(program.patch(f"{V1}/tasks/{task}", json={"assignees": [999]}), 422, "invalid_input")


def test_assignees_only_in_shared_spaces_and_only_members() -> None:
    anna_account, anna, ben_account, _ben, _space, list_id = family()
    _private, first = private_space(anna)
    program = token(anna_account)
    refused(program.post(f"{V1}/tasks", json={"title": "x", "list_id": first, "assignees": [ben_account.id]}),
            422, "invalid_input")
    cleo_account, _cleo = person("cleo")
    refused(program.post(f"{V1}/tasks", json={"title": "x", "list_id": list_id, "assignees": [cleo_account.id]}),
            422, "invalid_input")
    made = ok(program.post(f"{V1}/tasks", json={"title": "x", "list_id": list_id, "assignees": [ben_account.id]}),
              201)
    assert [person_["id"] for person_ in made["assignees"]] == [ben_account.id]


def test_subtasks_and_sections_must_fit_their_list() -> None:
    anna_account, anna, _ben_account, _ben, _space, list_id = family()
    _private, first = private_space(anna)
    parent = make_reminder(anna, first, "Trip")
    program = token(anna_account)
    child = ok(program.post(f"{V1}/tasks", json={"title": "Tickets", "parent_id": parent}), 201)
    assert child["parent_id"] == parent and child["list_id"] == first
    refused(program.post(f"{V1}/tasks", json={"title": "x", "parent_id": parent, "list_id": list_id}), 409, "conflict")
    refused(program.post(f"{V1}/tasks", json={"title": "x", "parent_id": child["id"]}), 409, "conflict")
    refused(program.post(f"{V1}/tasks", json={"title": "x", "list_id": list_id, "section_id": new_id()}), 409,
            "conflict")
    one = ok(program.get(f"{V1}/tasks/{parent}"))
    assert one["subtasks"]["total"] == 1 and one["subtasks"]["items"][0]["id"] == child["id"]
    assert child["id"] not in ids_of(ok(program.get(f"{V1}/tasks")))
    assert child["id"] in ids_of(ok(program.get(f"{V1}/tasks", params={"subtasks": True})))


# --- external_ref ---------------------------------------------------------------------------------------------------


def test_external_ref_makes_one_task_whatever_its_state_and_a_new_one_once_it_is_gone() -> None:
    anna_account, anna, ben_account, _ben, _space, list_id = family()
    program = token(anna_account)
    key = "nexmail:<abc@example.test>"
    first = ok(program.post(f"{V1}/tasks", json={"title": "Reply", "list_id": list_id, "external_ref": key}), 201)
    assert first["external_ref"] == key
    second = ok(program.post(f"{V1}/tasks", json={"title": "Reply again", "list_id": list_id, "external_ref": key}))
    assert second["id"] == first["id"] and second["title"] == "Reply"
    assert ok(program.get(f"{V1}/tasks", params={"external_ref": key}))["tasks"][0]["id"] == first["id"]
    # Ben sees the task, not Anna's key; his own key is his own.
    ben_program = token(ben_account)
    assert ok(ben_program.get(f"{V1}/tasks/{first['id']}"))["external_ref"] is None
    assert ok(ben_program.get(f"{V1}/tasks", params={"external_ref": key}))["tasks"] == []
    his = ok(ben_program.post(f"{V1}/tasks", json={"title": "His", "list_id": list_id, "external_ref": key}), 201)
    assert his["id"] != first["id"]
    ok(program.patch(f"{V1}/tasks/{first['id']}", json={"completed": True}))
    assert ok(program.post(f"{V1}/tasks", json={"title": "x", "external_ref": key}))["id"] == first["id"]
    ok(program.delete(f"{V1}/tasks/{first['id']}"), 204)
    kept = ok(program.post(f"{V1}/tasks", json={"title": "x", "external_ref": key}))
    assert kept["id"] == first["id"] and kept["trashed"] is True, "the key stays while the task is in the bin"
    with cursor.WRITE_LOCK, SessionLocal() as db:
        row = db.get(Reminder, first["id"])
        assert row is not None
        trash.purge_reminder(db, row)
        db.commit()
        assert db.get(ExternalRef, (anna_account.id, key)) is None, "gone for good: the key goes with it"
    anew = ok(program.post(f"{V1}/tasks", json={"title": "Reply", "list_id": list_id, "external_ref": key}), 201)
    assert anew["id"] != first["id"]
    assert anna


def test_external_ref_at_the_same_moment_makes_one_task() -> None:
    anna_account, anna = person("anna")
    private_space(anna)
    program = token(anna_account)
    start = threading.Barrier(4)
    answers: list[Any] = []

    def send() -> None:
        start.wait()
        answers.append(program.post(f"{V1}/tasks", json={"title": "Once", "external_ref": "mail:1"}))

    threads = [threading.Thread(target=send) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert sorted(answer.status_code for answer in answers) == [200, 200, 200, 201]
    assert len({answer.json()["id"] for answer in answers}) == 1
    with SessionLocal() as db:
        assert len(db.scalars(select(Reminder.id)).all()) == 1


# --- Keeping in step ------------------------------------------------------------------------------------------------


def test_updated_since_tells_done_binned_gone_and_dates_even_from_an_offline_clock() -> None:
    anna_account, _anna, _ben_account, ben, _space, list_id = family()
    done = make_reminder(ben, list_id, "Done offline")
    binned = make_reminder(ben, list_id, "Binned")
    purged = make_reminder(ben, list_id, "Purged")
    moved = make_reminder(ben, list_id, "Moved date", due_date="2026-11-10")
    calm = make_reminder(ben, list_id, "Untouched")
    other_list = make_list(ben, _space, "Garden", "a2")
    with_list = make_reminder(ben, other_list, "Goes with its list")
    clock.shift(5 * 60_000)
    program = token(anna_account)
    mark = ok(program.get(f"{V1}/tasks", params={"updated_since": "2000-01-01T00:00:00Z"}))["as_of"]
    clock.shift(10 * 60_000)
    # Ticked off on a phone that was offline: its clock is from before the mark.
    old = now_ms() - 60 * 60_000
    batch(ben, {"type": "complete", "id": done, "occurrence": None, "at": records.format_stamp(
        datetime.fromtimestamp(old / 1000, tz=UTC)), "on": clock.today().isoformat()})
    put(ben, "reminder", binned, {"deleted_at": records.format_stamp(clock.now())})
    put(ben, "list", other_list, {"deleted_at": records.format_stamp(clock.now())})
    put(ben, "reminder", moved, {"due_date": "2026-11-12", "due_time": None, "repeat": None, "repeat_from": "due"})
    with cursor.WRITE_LOCK, SessionLocal() as db:
        row = db.get(Reminder, purged)
        assert row is not None
        trash.purge_reminder(db, row)
        db.commit()
    found = ok(program.get(f"{V1}/tasks", params={"updated_since": mark}))["tasks"]
    by_id = {item["id"]: item for item in found}
    assert by_id[done]["completed"] is True
    assert by_id[binned]["trashed"] is True
    assert by_id[moved]["due_date"] == "2026-11-12"
    assert by_id[purged] == {"id": purged, "gone": True}
    assert by_id[with_list]["trashed"] is True, "into the bin with its list"
    assert calm not in by_id
    # A minute is given for changes that took their cursor before a moment and were written after it.
    clock.shift(20 * 60_000)
    later = ok(program.get(f"{V1}/tasks", params={"updated_since": mark}))
    clock.shift(22 * 60_000)
    assert ok(program.get(f"{V1}/tasks", params={"updated_since": later["as_of"]}))["tasks"] == []


def test_ids_answer_every_state_and_gone_for_what_is_not_there() -> None:
    anna_account, anna, _ben_account, ben, _space, list_id = family()
    open_one = make_reminder(ben, list_id, "Open")
    binned = make_reminder(ben, list_id, "Binned")
    put(ben, "reminder", binned, {"deleted_at": records.format_stamp(clock.now())})
    purged = make_reminder(ben, list_id, "Purged")
    with cursor.WRITE_LOCK, SessionLocal() as db:
        trash.purge_reminder(db, db.get(Reminder, purged))  # type: ignore[arg-type]
        db.commit()
    never = new_id()
    found = ok(token(anna_account).get(f"{V1}/tasks", params={"ids": f"{open_one},{binned},{purged},{never}"}))
    by_id = {item["id"]: item for item in found["tasks"]}
    assert set(by_id) == {open_one, binned, purged, never} and len(found["tasks"]) == 4
    assert by_id[open_one]["trashed"] is False and by_id[binned]["trashed"] is True
    assert by_id[purged] == {"id": purged, "gone": True} and by_id[never] == {"id": never, "gone": True}
    refused(token(anna_account).get(f"{V1}/tasks", params={"ids": "nope"}), 422, "invalid_input")
    too_many = ",".join(new_id() for _ in range(201))
    refused(token(anna_account).get(f"{V1}/tasks", params={"ids": too_many}), 422, "invalid_input")
    assert anna


def test_leaving_a_space_is_gone_for_a_token_of_all_spaces_and_unheard_of_for_one_limited_elsewhere() -> None:
    _anna_account, anna, ben_account, ben, space, list_id = family()
    private, _first = private_space(ben)
    task = make_reminder(anna, list_id, "Shared")
    clock.shift(2 * 60_000)
    wide = token(ben_account)
    narrow = token(ben_account, "read", [private])
    mark = ok(wide.get(f"{V1}/tasks"))["as_of"]
    clock.shift(5 * 60_000)
    ok(ben.delete(f"{API}/spaces/{space}/members/{ben_account.id}"), 204)
    assert {"id": task, "gone": True} in ok(wide.get(f"{V1}/tasks", params={"updated_since": mark}))["tasks"]
    assert ok(narrow.get(f"{V1}/tasks", params={"updated_since": mark}))["tasks"] == []
    assert anna


def test_paging_goes_through_everything_once() -> None:
    anna_account, anna = person("anna")
    _private, first = private_space(anna)
    made = {make_reminder(anna, first, f"Task {number}", position=f"a{number}") for number in range(7)}
    program = token(anna_account)
    seen: list[str] = []
    page = ok(program.get(f"{V1}/tasks", params={"limit": 3}))
    seen += ids_of(page)
    while page["next_cursor"]:
        page = ok(program.get(f"{V1}/tasks", params={"limit": 3, "cursor": page["next_cursor"]}))
        seen += ids_of(page)
    assert sorted(seen) == sorted(made) and len(seen) == 7
    refused(program.get(f"{V1}/tasks", params={"cursor": "%%%"}), 422, "invalid_input")


# --- Dashboard and days ----------------------------------------------------------------------------------------------


def test_the_dashboard_counts_in_the_accounts_time_zone_just_before_midnight() -> None:
    anna_account, anna = person("anna")
    _private, first = private_space(anna)
    anna.put(f"{API}/me", json={"timezone": "America/Los_Angeles"})
    # 07:30 UTC on 8 November is 23:30 on 7 November in Los Angeles.
    target = datetime(2026, 11, 8, 7, 30, tzinfo=UTC)
    clock.shift(int((target - datetime.now(UTC)).total_seconds() * 1000))
    late = make_reminder(anna, first, "Yesterday", due_date="2026-11-06")
    today = make_reminder(anna, first, "Tonight", due_date="2026-11-07", due_time="23:45", flagged=True)
    soon = make_reminder(anna, first, "Tomorrow", due_date="2026-11-08")
    week = make_reminder(anna, first, "Next week", due_date="2026-11-14")
    make_reminder(anna, first, "Too far", due_date="2026-11-15")
    make_reminder(anna, first, "Whenever")
    board = ok(token(anna_account).get(f"{V1}/dashboard"))
    assert board["time_zone"] == "America/Los_Angeles"
    assert board["counts"] == {"overdue": 1, "today": 1, "upcoming": 2, "assigned_to_me": 0, "flagged": 1,
                               "open": 6}
    assert [task["id"] for task in board["overdue"]] == [late]
    assert [task["id"] for task in board["today"]] == [today]
    assert [task["id"] for task in board["upcoming"]] == [soon, week]
    found = ok(token(anna_account).get(f"{V1}/tasks", params={"due": "today"}))
    assert ids_of(found) == [today]
    assert ok(token(anna_account).get(f"{V1}/dashboard", params={"limit": 1}))["counts"]["upcoming"] == 2
    assert len(ok(token(anna_account).get(f"{V1}/dashboard", params={"limit": 1}))["upcoming"]) == 1


def test_link_follows_the_public_address() -> None:
    anna_account, anna = person("anna")
    _private, first = private_space(anna)
    task = make_reminder(anna, first, "Link")
    program = token(anna_account)
    assert ok(program.get(f"{V1}/tasks/{task}"))["link"] is None
    with SessionLocal() as db:
        settings_service.save(db, {"public_url": "https://tasks.example.com"})
    assert ok(program.get(f"{V1}/tasks/{task}"))["link"] == f"https://tasks.example.com/lists/{first}?task={task}"
    assert ok(program.get(f"{V1}/dashboard"))["link"] == "https://tasks.example.com/today"


# --- Walls ----------------------------------------------------------------------------------------------------------


def test_a_request_from_a_web_page_is_refused() -> None:
    anna_account, anna = person("anna")
    program = token(anna_account)
    refused(program.get(f"{V1}/me", headers={"Origin": "https://evil.example"}), 403, "origin_refused")
    refused(program.post(f"{V1}/tasks", json={"title": "x"}, headers={"Origin": "https://evil.example"}), 403,
            "origin_refused")
    assert anna


def test_the_brake_stops_a_token_after_600_a_minute(monkeypatch: pytest.MonkeyPatch) -> None:
    anna_account, anna = person("anna")
    monkeypatch.setattr(apitokens, "PER_MINUTE", 3)
    program = token(anna_account)
    for _ in range(3):
        ok(program.get(f"{V1}/me"))
    answer = program.get(f"{V1}/me")
    refused(answer, 429, "slow_down")
    assert answer.headers["Retry-After"] == "60"
    ok(token(anna_account).get(f"{V1}/me"))  # another token has its own count
    assert anna


def test_switched_off_and_wrong_tokens_answer_401_in_the_api_form() -> None:
    anna_account, anna = person("anna")
    program = token(anna_account)
    refused(TestClient(app).get(f"{V1}/me", headers={"Authorization": "Bearer ntk_nope"}), 401, "token_invalid")
    refused(program.post(f"{V1}/tasks", json={"title": "x", "colour": "red"}), 422, "invalid_input")
    refused(program.put(f"{V1}/tasks"), 405, "method_not_allowed")
    with SessionLocal() as db:
        settings_service.save(db, {"api_tokens_allowed": False})
    refused(program.get(f"{V1}/me"), 401, "api_off")
    assert anna


def test_every_route_describes_itself() -> None:
    schema = app.openapi()
    routes = {path: methods for path, methods in schema["paths"].items() if path.startswith(V1)}
    assert set(routes) == {f"{V1}/me", f"{V1}/spaces", f"{V1}/lists", f"{V1}/tasks", f"{V1}/tasks/{{task_id}}",
                           f"{V1}/dashboard"}
    for path, methods in routes.items():
        for method, operation in methods.items():
            assert operation.get("summary"), (method, path)
            answers = operation["responses"]
            good = answers.get("200") or answers.get("201") or answers.get("204")
            assert good is not None, (method, path)
            if method != "delete":
                assert "$ref" in str(good), (method, path)
            assert "$ref" in str(answers.get("404") or answers.get("401")), (method, path)

