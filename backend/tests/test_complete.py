"""``complete`` (``datenmodell.md``, "Regeln" and "Wiederholung"; ``vertrag-block1.md``): one is enough, subtasks
come along, a repeating reminder leaves a done copy with the id UUIDv5(original, occurrence) and moves on; a second
completion of the same occurrence does nothing."""

from __future__ import annotations

from typing import Any

from app.services import wiederholung

from .sync_helpers import batch, changes, make_reminder, new_id, person, private_space, put, shared_space, state

AT = "2026-11-06T09:15:00.000Z"


def complete(browser: Any, reminder: str, occurrence: str | None, at: str = AT, on: str = "2026-11-06") -> dict:
    [result] = batch(browser, {"type": "complete", "id": reminder, "occurrence": occurrence, "at": at, "on": on})
    return result


def _setup(**fields: Any) -> tuple[Any, Any, str, str]:
    account, browser = person("anna")
    _space, list_id = private_space(browser)
    return account, browser, list_id, make_reminder(browser, list_id, "Bins out", **fields)


def test_completing_once_sets_who_and_when_and_takes_open_subtasks_along() -> None:
    account, browser, list_id, reminder = _setup()
    open_sub = make_reminder(browser, list_id, "Paper", parent_id=reminder)
    done_sub = make_reminder(browser, list_id, "Glass", parent_id=reminder)
    assert complete(browser, done_sub, None, at="2026-11-05T08:00:00.000Z", on="2026-11-05")["ok"]
    result = complete(browser, reminder, None)
    assert result["ok"] and result["copy_id"] is None and result["next_due"] is None
    assert result["current"]["data"]["completed_at"] == AT and result["current"]["data"]["completed_by"] == account.id
    held = state(browser)
    assert held[("reminder", open_sub)]["data"]["completed_at"] == AT
    assert held[("reminder", done_sub)]["data"]["completed_at"] == "2026-11-05T08:00:00.000Z", "already done stays"
    again = complete(browser, reminder, None)
    assert again["ok"] is False and again["code"] == "already_done" and again["current"]["id"] == reminder


def test_one_is_enough_whoever_completes_first() -> None:
    _anna, anna = person("anna")
    ben_account, ben = person("ben")
    space = shared_space(anna, ben)
    from .sync_helpers import make_list

    list_id = make_list(anna, space)
    reminder = make_reminder(anna, list_id, "Feed the cat", assignees=[ben_account.id])
    assert complete(ben, reminder, None)["ok"]
    assert complete(anna, reminder, None)["code"] == "already_done"
    assert state(anna)[("reminder", reminder)]["data"]["completed_by"] == ben_account.id


def test_a_repeating_reminder_leaves_a_done_copy_and_moves_on() -> None:
    account, browser, list_id, reminder = _setup(due_date="2026-11-06", due_time="07:00", repeat="FREQ=WEEKLY;BYDAY=FR",
                                                 repeat_from="due", tags=["home"])
    sub = make_reminder(browser, list_id, "Yellow bag", parent_id=reminder)
    complete(browser, sub, None)
    result = complete(browser, reminder, "2026-11-06")
    copy_id = wiederholung.copy_id(reminder, "2026-11-06")
    assert result["ok"] and result["copy_id"] == copy_id
    assert result["next_due"] == {"due_date": "2026-11-13", "due_time": "07:00"}
    copy = result["copy"]
    assert copy["id"] == copy_id and copy["data"]["completed_at"] == AT and copy["data"]["completed_by"] == account.id
    assert copy["data"]["repeat"] is None and copy["data"]["due_date"] == "2026-11-06"
    assert copy["data"]["tags"] == ["home"] and copy["data"]["parent_id"] is None
    assert set(copy["clock"].values()) == {1793956500000}, "every clock of the copy is the moment of completing"
    original = result["current"]["data"]
    assert original["due_date"] == "2026-11-13" and original["completed_at"] is None
    # At least the moment of completing: a clock never goes back (the due group was changed later than that here).
    assert result["current"]["clock"]["due"] >= 1793956500000
    assert state(browser)[("reminder", sub)]["data"]["completed_at"] is None, "its subtasks open again"
    # The same occurrence again (another device, a lost answer): nothing happens.
    twice = complete(browser, reminder, "2026-11-06")
    assert twice["code"] == "already_done"
    assert state(browser)[("reminder", reminder)]["data"]["due_date"] == "2026-11-13"


def test_an_occurrence_that_is_no_longer_the_due_date_changes_nothing() -> None:
    _account, browser, _list, reminder = _setup(due_date="2026-11-06", due_time=None, repeat="FREQ=DAILY",
                                                repeat_from="due")
    put(browser, "reminder", reminder, {"due_date": "2026-11-10", "due_time": None, "repeat": "FREQ=DAILY",
                                        "repeat_from": "due"})
    result = complete(browser, reminder, "2026-11-06")
    assert result["code"] == "due_changed" and result["current"]["data"]["due_date"] == "2026-11-10"


def test_count_runs_down_and_the_last_one_completes_the_original() -> None:
    _account, browser, _list, reminder = _setup(due_date="2026-11-06", due_time=None, repeat="FREQ=DAILY;COUNT=2",
                                                repeat_from="due")
    first = complete(browser, reminder, "2026-11-06")
    assert first["current"]["data"]["repeat"] == "FREQ=DAILY;COUNT=1"
    last = complete(browser, reminder, "2026-11-07", at="2026-11-07T09:00:00.000Z", on="2026-11-07")
    assert last["ok"] and last["copy_id"] is None and last["next_due"] is None
    assert last["current"]["data"]["completed_at"] == "2026-11-07T09:00:00.000Z"


def test_repeat_from_completion_counts_from_the_day_of_completing() -> None:
    _account, browser, _list, reminder = _setup(due_date="2026-11-01", due_time=None, repeat="FREQ=MONTHLY",
                                                repeat_from="completion")
    result = complete(browser, reminder, "2026-11-01", at="2026-11-06T22:30:00.000Z", on="2026-11-07")
    assert result["next_due"]["due_date"] == "2026-12-07"


def test_the_day_of_completing_may_be_one_day_off_the_moment_not_more() -> None:
    _account, browser, _list, reminder = _setup()
    result = complete(browser, reminder, None, at=AT, on="2026-11-08")
    assert result["code"] == "invalid" and result["fields"] == ["on"]
    assert complete(browser, reminder, None, at=AT, on="bad")["fields"] == ["on"]


def test_complete_of_what_one_does_not_see_is_not_found() -> None:
    _anna, anna = person("anna")
    _ben, ben = person("ben")
    _space, list_id = private_space(anna)
    reminder = make_reminder(anna, list_id, "Secret")
    result = complete(ben, reminder, None)
    assert result["code"] == "not_found" and result["current"] is None
    assert complete(ben, new_id(), None)["code"] == "not_found"


def test_the_copy_comes_through_changes_for_everybody_in_the_space() -> None:
    _anna, anna = person("anna")
    _ben, ben = person("ben")
    space = shared_space(anna, ben)
    from .sync_helpers import make_list

    list_id = make_list(anna, space)
    reminder = make_reminder(anna, list_id, "Water plants", due_date="2026-11-06", due_time=None,
                             repeat="FREQ=DAILY", repeat_from="due")
    since = changes(ben)["cursor"]
    complete(anna, reminder, "2026-11-06")
    ids = {item["id"] for item in changes(ben, since)["items"]}
    assert {reminder, wiederholung.copy_id(reminder, "2026-11-06")} <= ids
