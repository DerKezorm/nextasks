"""The history of a task (``services/history.py``, ``GET /api/reminders/{id}/history``): made, done or opened again
(also by a repetition), the date, assignees, priority, another list, another title, each with who did it; one
person's changes of one field within ten minutes are one row. Written wherever the change came from (the web, the
app, ``/api/v1``), read only by members of the space."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.services import clock

from .sync_helpers import batch, make_list, make_reminder, new_id, now_ms, person, put, shared_space

MINUTE = 60_000


def events(client: TestClient, task: str) -> list[dict[str, Any]]:
    answer = client.get(f"/api/reminders/{task}/history")
    assert answer.status_code == 200, answer.text
    return answer.json()["events"]


def fields(client: TestClient, task: str) -> list[tuple[str, Any, Any]]:
    return [(event["field"], event["old"], event["new"]) for event in events(client, task)]


def later(minutes: int) -> None:
    clock.shift(clock_offset[0] + minutes * MINUTE)
    clock_offset[0] += minutes * MINUTE


clock_offset = [0]


def setup_function() -> None:
    clock_offset[0] = 0


def family() -> tuple[Any, TestClient, Any, TestClient, str, str, str]:
    anna_account, anna = person("anna")
    ben_account, ben = person("ben")
    space = shared_space(anna, ben)
    first = make_list(anna, space)
    task = make_reminder(anna, first, title="Milk")
    return anna_account, anna, ben_account, ben, space, first, task


def test_making_and_the_maker_settling_it_is_one_event() -> None:
    anna_account, anna, _b, _ben, _space, _first, task = family()
    put(anna, "reminder", task, {"priority": 2})
    put(anna, "reminder", task, {"title": "Oat milk"})
    told = events(anna, task)
    assert [event["field"] for event in told] == ["created"]
    assert told[0]["by"] == anna_account.id and told[0]["at"].endswith("Z")


def test_each_change_names_who_did_it_and_what_it_was() -> None:
    _a, anna, ben_account, ben, space, first, task = family()
    later(11)
    other = make_list(anna, space, "Other", "a2")
    put(ben, "reminder", task, {"title": "Oat milk"})
    put(ben, "reminder", task, {"priority": 3})
    put(ben, "reminder", task, {"assignees": [ben_account.id]})
    put(ben, "reminder", task, {"due_date": "2026-12-01", "due_time": "09:00", "repeat": None, "repeat_from": "due"})
    put(ben, "reminder", task, {"list_id": other, "section_id": None, "parent_id": None, "position": "a0"})
    [done] = batch(ben, {"type": "complete", "id": task, "occurrence": "2026-12-01", "at": "2026-11-24T10:00:00.000Z",
                         "on": "2026-11-24"})
    assert done["ok"], done
    told = events(anna, task)
    assert {event["by"] for event in told[1:]} == {ben_account.id}
    assert fields(anna, task)[1:] == [
        ("title", "Milk", "Oat milk"),
        ("priority", 0, 3),
        ("assignees", [], [ben_account.id]),
        ("due", {"due_date": None, "due_time": None}, {"due_date": "2026-12-01", "due_time": "09:00"}),
        ("list", {"id": first, "name": "Shopping"}, {"id": other, "name": "Other"}),
        ("completion", False, True),
    ]


def test_one_person_one_field_within_ten_minutes_is_one_row_back_where_it_began_none() -> None:
    _a, anna, _b, ben, _space, _first, task = family()
    later(11)
    put(ben, "reminder", task, {"priority": 1})
    later(3)
    put(ben, "reminder", task, {"priority": 3})
    assert fields(anna, task)[1:] == [("priority", 0, 3)]
    put(anna, "reminder", task, {"priority": 2})
    later(4)
    put(ben, "reminder", task, {"priority": 1})
    assert fields(anna, task)[1:] == [("priority", 0, 3), ("priority", 3, 2), ("priority", 2, 1)]
    later(1)
    [done] = batch(ben, {"type": "complete", "id": task, "occurrence": None, "at": clock.now().strftime(
        "%Y-%m-%dT%H:%M:%S.000Z"), "on": clock.now().date().isoformat()})
    assert done["ok"]
    put(ben, "reminder", task, {"completed_at": None, "completed_by": None})
    assert [field for field, _old, _new in fields(anna, task)] == ["created", "priority", "priority", "priority"]
    later(11)
    put(ben, "reminder", task, {"priority": 0})
    assert fields(anna, task)[-1] == ("priority", 1, 0)


def test_a_repetition_done_says_the_date_not_a_new_date_or_a_new_task() -> None:
    _a, anna, _b, ben, _space, first, _task = family()
    weekly = make_reminder(anna, first, title="Bins", position="a1", due_date="2026-11-24", repeat="FREQ=DAILY")
    later(11)
    [done] = batch(ben, {"type": "complete", "id": weekly, "occurrence": "2026-11-24",
                         "at": "2026-11-24T10:00:00.000Z", "on": "2026-11-24"})
    assert done["ok"] and done["copy_id"]
    assert fields(anna, weekly)[1:] == [("occurrence", None, "2026-11-24")]
    assert events(anna, done["copy_id"]) == []


def test_api_v1_writes_into_the_history_too() -> None:
    from app.db import SessionLocal
    from app.services import apitokens, settings_service

    from .test_api_v1 import token

    with SessionLocal() as db:
        settings_service.save(db, {"api_tokens_allowed": True})
    apitokens.forget()
    anna_account, anna, _b, _ben, _space, _first, task = family()
    later(11)
    answer = token(anna_account).patch(f"/api/v1/tasks/{task}", json={"priority": 3})
    assert answer.status_code == 200, answer.text
    assert fields(anna, task)[-1] == ("priority", 0, 3) and events(anna, task)[-1]["by"] == anna_account.id


def test_only_members_read_the_history() -> None:
    _a, _anna, _b, _ben, _space, _first, task = family()
    _c, carl = person("carl")
    assert carl.get(f"/api/reminders/{task}/history").status_code == 404
    assert carl.get(f"/api/reminders/{new_id()}/history").status_code == 404
    assert carl.get("/api/reminders/not-an-id/history").status_code == 404
    assert now_ms()
