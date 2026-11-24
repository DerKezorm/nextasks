"""The focus of the day (``routers/focus.py``): up to three tasks per account, only for today, only what the account
sees; gone ones fall out, the next day it is empty, others never see it."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app
from app.services import clock, records

from .sync_helpers import WEB, make_list, make_reminder, person, private_space, put, shared_space


def test_the_focus_holds_up_to_three_own_tasks_for_today_only() -> None:
    _account, anna = person("anna")
    _space, first = private_space(anna)
    tasks = [make_reminder(anna, first, f"Task {n}", position=f"a{n}") for n in range(4)]
    assert anna.get("/api/focus").json()["ids"] == []

    answer = anna.put("/api/focus", json={"ids": [tasks[2], tasks[0], tasks[2]]})
    assert answer.status_code == 200, answer.text
    assert answer.json()["ids"] == [tasks[2], tasks[0]]
    found = anna.get("/api/focus").json()
    assert found["ids"] == [tasks[2], tasks[0]] and found["most"] == 3
    assert found["date"] == clock.today().isoformat()

    assert anna.put("/api/focus", json={"ids": tasks}).status_code == 422

    # Tomorrow it reads empty.
    clock.shift(24 * 3600_000)
    assert anna.get("/api/focus").json()["ids"] == []


def test_a_binned_task_falls_out_and_a_foreign_one_is_refused() -> None:
    _account, anna = person("anna")
    _other, ben = person("ben")
    _space, first = private_space(anna)
    _bens, bens_list = private_space(ben)
    mine = make_reminder(anna, first, "Mine")
    binned = make_reminder(anna, first, "Binned", position="a1")
    foreign = make_reminder(ben, bens_list, "Ben's")
    assert anna.put("/api/focus", json={"ids": [mine, foreign]}).status_code == 404
    assert anna.put("/api/focus", json={"ids": [mine, binned]}).status_code == 200
    assert put(anna, "reminder", binned, {"deleted_at": records.format_stamp(clock.now())})["ok"]
    assert anna.get("/api/focus").json()["ids"] == [mine]
    # Ben's own focus is his, Anna's stays unseen by him.
    assert ben.get("/api/focus").json()["ids"] == []


def test_in_a_shared_space_each_member_has_an_own_focus() -> None:
    _account, anna = person("anna")
    _other, ben = person("ben")
    space = shared_space(anna, ben)
    chores = make_list(anna, space, "Chores")
    task = make_reminder(anna, chores, "Bins")
    assert ben.put("/api/focus", json={"ids": [task]}).json()["ids"] == [task]
    assert anna.get("/api/focus").json()["ids"] == []


def test_without_a_session_there_is_no_focus() -> None:
    stranger = TestClient(app, base_url="http://testserver", headers=WEB)
    assert stranger.get("/api/focus").status_code == 401
