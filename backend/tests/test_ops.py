"""Nothing happens twice (``op_id`` per device or session, seven days), two batches on the same thing at the same
moment apply one after the other, and ``/wait`` holds nothing else up."""

from __future__ import annotations

import socket
import threading
import time
from collections.abc import Iterator

import httpx
import pytest
import uvicorn
from sqlalchemy import func, select

from app.db import SessionLocal
from app.main import app
from app.models import AppOp, Reminder
from app.routers import app1

from .sync_helpers import API, batch, changes, make_reminder, new_id, person, private_space, put, put_op, state


def test_the_same_op_id_again_does_nothing_twice_and_answers_with_the_thing_as_it_is_now() -> None:
    _anna, anna = person("anna")
    _space, list_id = private_space(anna)
    reminder = new_id()
    op = put_op("reminder", reminder, {"list_id": list_id, "title": "Milk", "position": "a0"}, op_id=new_id())
    [first] = batch(anna, dict(op))
    put(anna, "reminder", reminder, {"title": "Oat milk"})
    [again] = batch(anna, dict(op))
    assert first["ok"] and again["ok"] and again["applied"] == first["applied"]
    assert again["current"]["data"]["title"] == "Oat milk", "current is read now, not kept"
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(Reminder)) == 1
        assert db.scalar(select(func.count()).select_from(AppOp)) == 2


def test_a_failed_op_is_kept_too_and_a_new_op_id_tries_again() -> None:
    _anna, anna = person("anna")
    _space, list_id = private_space(anna)
    parent = new_id()
    child = put_op("reminder", new_id(), {"list_id": list_id, "title": "Sub", "position": "a0", "parent_id": parent,
                                          "section_id": None}, op_id=new_id())
    [missing] = batch(anna, dict(child))
    assert missing["code"] == "parent_missing"
    make_reminder_id = put(anna, "reminder", parent, {"list_id": list_id, "title": "Parent", "position": "a1"})
    assert make_reminder_id["ok"]
    [same] = batch(anna, dict(child))
    assert same["code"] == "parent_missing", "the answer of that op_id stays"
    [retried] = batch(anna, {**child, "op_id": new_id()})
    assert retried["ok"]


def test_op_ids_belong_to_one_device_or_session() -> None:
    _anna, anna = person("anna")
    _ben, ben = person("ben")
    _space, anna_list = private_space(anna)
    _space2, ben_list = private_space(ben)
    op_id = new_id()
    [mine] = batch(anna, put_op("reminder", new_id(), {"list_id": anna_list, "title": "a", "position": "a0"},
                                op_id=op_id))
    [theirs] = batch(ben, put_op("reminder", new_id(), {"list_id": ben_list, "title": "b", "position": "a0"},
                                 op_id=op_id))
    assert mine["ok"] and theirs["ok"] and theirs["current"]["data"]["title"] == "b"


def test_two_batches_on_the_same_reminder_at_once_end_with_the_later_clock_whatever_the_timing() -> None:
    _anna, anna = person("anna")
    _space, list_id = private_space(anna)
    reminder = make_reminder(anna, list_id, "start")
    from .sync_helpers import now_ms

    for round_ in range(15):
        base = now_ms() + 1000 + round_ * 10
        gate = threading.Barrier(2)
        results: dict[str, list] = {}

        def send(label: str, title: str, moment: int, other: dict = results,
                 gate: threading.Barrier = gate) -> None:
            ops = [put_op("reminder", reminder, {"title": title}, moment, op_id=new_id()),
                   put_op("reminder", reminder, {"notes": title}, moment, op_id=new_id())]
            gate.wait()
            other[label] = batch(anna, *ops)

        early = threading.Thread(target=send, args=("early", f"early {round_}", base))
        late = threading.Thread(target=send, args=("late", f"late {round_}", base + 1))
        early.start()
        late.start()
        early.join()
        late.join()
        data = state(anna)[("reminder", reminder)]
        assert data["data"]["title"] == f"late {round_}" and data["data"]["notes"] == f"late {round_}", round_
        assert data["clock"]["title"] == base + 1
        cursors = [r["current"]["cursor"] for label in results for r in results[label]]
        assert all(isinstance(number, int) for number in cursors)


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


@pytest.fixture
def server() -> Iterator[str]:
    """The app behind a real server: one event loop for every request, as in production."""
    port = _free_port()
    running = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, lifespan="off", log_level="warning"))
    thread = threading.Thread(target=running.run, daemon=True)
    thread.start()
    for _ in range(100):
        if running.started:
            break
        time.sleep(0.05)
    yield f"http://127.0.0.1:{port}"
    running.should_exit = True
    thread.join(5)


def test_wait_holds_no_other_request_up_and_wakes_on_news_for_this_account(server: str,
                                                                           monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(app1, "WAIT_SECONDS", 6.0)
    _anna, anna = person("anna")
    _ben, ben = person("ben")
    _space, list_id = private_space(anna)
    _space2, ben_list = private_space(ben)
    since = changes(anna)["cursor"]
    headers = {"X-Nextasks-Client": "web", "Cookie": "; ".join(f"{k}={v}" for k, v in anna.cookies.items())}
    answers: list[tuple[float, dict]] = []

    def wait_for(count: int) -> None:
        with httpx.Client(base_url=server, headers=headers, timeout=30) as waiting:
            for _ in range(count):
                started = time.monotonic()
                answers.append((time.monotonic() - started,
                                waiting.get(f"{API}/wait", params={"cursor": since}).json()))
                answers[-1] = (time.monotonic() - started, answers[-1][1])

    waiters = [threading.Thread(target=wait_for, args=(1,)) for _ in range(12)]
    for waiter in waiters:
        waiter.start()
    time.sleep(0.5)
    with httpx.Client(base_url=server, headers=headers, timeout=10) as other:
        started = time.monotonic()
        for _ in range(5):
            assert other.get(f"{API}/me").status_code == 200
        assert time.monotonic() - started < 3, "twelve waiting requests hold nothing up"
    make_reminder(ben, ben_list, "Not for Anna")
    time.sleep(1.0)
    assert not answers, "news for somebody else wakes nobody here"
    reminder = make_reminder(anna, list_id, "For Anna")
    for waiter in waiters:
        waiter.join(10)
    assert len(answers) == 12
    assert all(seconds < 5 and answer["cursor"] > since for seconds, answer in answers)
    _ = reminder


def test_wait_answers_the_same_cursor_when_nothing_came(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(app1, "WAIT_SECONDS", 0.5)
    _anna, anna = person("anna")
    since = changes(anna)["cursor"]
    assert anna.get(f"{API}/wait", params={"cursor": since}).json() == {"cursor": since}
