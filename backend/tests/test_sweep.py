"""The look through (``routers/sweep.py``): what lies about, without what one kept in the last 30 days; keeping is
per account and only for tasks one sees."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app
from app.services import clock, records

from .sync_helpers import WEB, make_list, make_reminder, new_id, person, private_space, put, shared_space
from .test_stats import ago


def _stale(browser: TestClient, list_id: str, title: str) -> str:
    """A task made 30 days ago and unchanged for 20."""
    task = new_id()
    moment = records.ms(records.parse_stamp(ago(20)[0]))
    assert put(browser, "reminder", task, {"list_id": list_id, "title": title, "position": "a1",
                                           "created_at": ago(30)[0]}, clock_ms=moment)["ok"]
    return task


def test_a_kept_task_stays_out_for_thirty_days() -> None:
    _account, anna = person("anna")
    _space, first = private_space(anna)
    attic = _stale(anna, first, "Attic")
    tax = make_reminder(anna, first, "Tax", due_date=ago(3)[1])
    found = anna.get("/api/sweep").json()
    assert [task["id"] for task in found["tasks"]] == [attic, tax]
    assert found["total"] == 2 and found["keep_days"] == 30

    kept = anna.post("/api/sweep/keep", json={"id": attic})
    assert kept.status_code == 200, kept.text
    found = anna.get("/api/sweep").json()
    assert [task["id"] for task in found["tasks"]] == [tax] and found["total"] == 1
    # The plain review still knows it.
    assert len(anna.get("/api/review").json()["tasks"]) == 2

    clock.shift(31 * 24 * 3600_000)
    assert attic in [task["id"] for task in anna.get("/api/sweep").json()["tasks"]]


def test_keeping_can_be_taken_back() -> None:
    _account, anna = person("anna")
    _space, first = private_space(anna)
    attic = _stale(anna, first, "Attic")
    assert anna.post("/api/sweep/keep", json={"id": attic}).status_code == 200
    assert anna.get("/api/sweep").json()["total"] == 0
    assert anna.delete(f"/api/sweep/keep/{attic}").status_code == 200
    assert anna.get("/api/sweep").json()["total"] == 1


def test_keeping_is_per_account_and_only_for_what_one_sees() -> None:
    _account, anna = person("anna")
    _other, ben = person("ben")
    _third, cleo = person("cleo")
    space = shared_space(anna, ben)
    chores = make_list(anna, space, "Chores")
    attic = _stale(anna, chores, "Attic")
    assert ben.post("/api/sweep/keep", json={"id": attic}).status_code == 200
    assert ben.get("/api/sweep").json()["total"] == 0
    assert anna.get("/api/sweep").json()["total"] == 1
    assert cleo.post("/api/sweep/keep", json={"id": attic}).status_code == 404
    assert anna.post("/api/sweep/keep", json={"id": new_id()}).status_code == 404
    assert anna.get("/api/sweep", params={"space": new_id()}).status_code == 404


def test_without_a_session_there_is_no_look_through() -> None:
    stranger = TestClient(app, base_url="http://testserver", headers=WEB)
    assert stranger.get("/api/sweep").status_code == 401
    assert stranger.post("/api/sweep/keep", json={"id": new_id()}).status_code == 401
