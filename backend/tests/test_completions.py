"""The record of completions (``services/completions.py``): one row per done reminder, from every way of writing, gone
when opened again, kept when the reminder goes, gone with its space, filled once from what is done already."""

from __future__ import annotations

from typing import Any

from sqlalchemy import delete, select

from app.db import SessionLocal
from app.models import Completion, Reminder, Setting, Space
from app.services import completions, settings_service, trash, wiederholung

from .sync_helpers import batch, make_list, make_reminder, person, private_space, put, shared_space
from .test_api_v1 import token

AT = "2026-11-06T09:15:00.000Z"


def complete(browser: Any, reminder: str, occurrence: str | None, at: str = AT, on: str = "2026-11-06") -> dict:
    [result] = batch(browser, {"type": "complete", "id": reminder, "occurrence": occurrence, "at": at, "on": on})
    return result


def rows() -> dict[str, Completion]:
    with SessionLocal() as db:
        return {row.reminder_id: row for row in db.scalars(select(Completion))}


def test_completing_writes_one_row_and_opening_again_takes_it_away() -> None:
    account, browser = person("anna")
    space, list_id = private_space(browser)
    task = make_reminder(browser, list_id, "Bins out", due_date="2026-11-07", due_time="19:00")
    sub = make_reminder(browser, list_id, "Paper", parent_id=task)
    assert complete(browser, task, None)["ok"]
    found = rows()
    row = found[task]
    assert (row.title, row.space_id, row.list_id, row.completed_by, row.completed_at) == (
        "Bins out", space, list_id, account.id, AT)
    assert (row.due_date, row.due_time, row.on_time, row.series_id, row.parent_id) == (
        "2026-11-07", "19:00", True, None, None)
    assert found[sub].parent_id == task, "a subtask done along is recorded as one"
    assert complete(browser, task, None)["code"] == "already_done"
    assert len(rows()) == 2
    opened = put(browser, "reminder", task, {"completed_at": None, "completed_by": None})
    assert opened["ok"] and task not in rows()
    assert complete(browser, task, None, at="2026-11-08T10:00:00.000Z", on="2026-11-08")["ok"]
    again = rows()[task]
    assert again.completed_at == "2026-11-08T10:00:00.000Z" and again.on_time is False, "late: after its due day"
    assert len(rows()) == 2


def test_a_repeating_reminder_records_each_occurrence_under_its_series() -> None:
    _account, browser = person("anna")
    _space, list_id = private_space(browser)
    task = make_reminder(browser, list_id, "Water plants", due_date="2026-11-06", repeat="FREQ=DAILY;COUNT=3")
    assert complete(browser, task, "2026-11-06")["ok"]
    assert complete(browser, task, "2026-11-07", at="2026-11-07T08:00:00.000Z", on="2026-11-07")["ok"]
    assert complete(browser, task, "2026-11-08", at="2026-11-08T08:00:00.000Z", on="2026-11-08")["ok"]
    found = rows()
    first, second = wiederholung.copy_id(task, "2026-11-06"), wiederholung.copy_id(task, "2026-11-07")
    assert set(found) == {first, second, task}, "two copies, then the original itself when its rule ended"
    assert {row.series_id for row in found.values()} == {task}
    assert found[first].due_date == "2026-11-06" and found[task].due_date == "2026-11-08"


def test_the_record_outlives_the_bin_and_going_for_good() -> None:
    _account, browser = person("anna")
    _space, list_id = private_space(browser)
    task = make_reminder(browser, list_id, "Milk")
    complete(browser, task, None)
    assert put(browser, "reminder", task, {"deleted_at": AT})["ok"]
    with SessionLocal() as db:
        row = db.get(Reminder, task)
        assert row is not None
        trash.purge_reminder(db, row)
        db.commit()
        assert db.get(Reminder, task) is None
    assert rows()[task].title == "Milk"


def test_a_space_that_goes_takes_its_rows_along() -> None:
    _anna_account, anna = person("anna")
    _ben_account, ben = person("ben")
    space = shared_space(anna, ben)
    list_id = make_list(anna, space)
    task = make_reminder(anna, list_id, "Bread")
    complete(ben, task, None)
    _private, mine = private_space(anna)
    own = make_reminder(anna, mine, "Own")
    complete(anna, own, None)
    with SessionLocal() as db:
        found = db.get(Space, space)
        assert found is not None
        trash.purge_space(db, found)
        db.commit()
    assert set(rows()) == {own}


def test_a_done_reminder_moved_into_another_space_takes_its_row_along() -> None:
    _anna_account, anna = person("anna")
    _ben_account, ben = person("ben")
    space = shared_space(anna, ben)
    shared_list = make_list(anna, space)
    private, mine = private_space(anna)
    task = make_reminder(anna, shared_list, "Gift for Ben")
    complete(anna, task, None)
    assert put(anna, "reminder", task, {"list_id": mine, "section_id": None, "parent_id": None,
                                        "position": "a5"})["ok"]
    row = rows()[task]
    assert (row.space_id, row.list_id) == (private, mine)


def test_the_api_for_programs_records_and_opens_the_same_way() -> None:
    account, browser = person("anna")
    _space, list_id = private_space(browser)
    task = make_reminder(browser, list_id, "Call the plumber")
    with SessionLocal() as db:
        settings_service.save(db, {"api_tokens_allowed": True})
    program = token(account)
    assert program.patch(f"/api/v1/tasks/{task}", json={"completed": True}).status_code == 200
    assert rows()[task].completed_by == account.id
    assert program.patch(f"/api/v1/tasks/{task}", json={"completed": False}).status_code == 200
    assert task not in rows()


def test_filled_once_from_what_is_done_already_with_the_series_found() -> None:
    _account, browser = person("anna")
    _space, list_id = private_space(browser)
    plain = make_reminder(browser, list_id, "Milk")
    series = make_reminder(browser, list_id, "Bins", due_date="2026-11-06", repeat="FREQ=WEEKLY;BYDAY=FR")
    complete(browser, plain, None)
    complete(browser, series, "2026-11-06")
    before = {key: (row.series_id, row.title, row.on_time) for key, row in rows().items()}
    with SessionLocal() as db:
        db.execute(delete(Completion))
        db.execute(delete(Setting).where(Setting.key == completions.FILLED))
        db.commit()
    completions.fill_once()
    after = {key: (row.series_id, row.title, row.on_time) for key, row in rows().items()}
    assert after == before and after[wiederholung.copy_id(series, "2026-11-06")][0] == series
    with SessionLocal() as db:
        assert completions.fill(db) == 0, "nothing twice"
