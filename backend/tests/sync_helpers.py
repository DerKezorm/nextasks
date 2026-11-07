"""Helpers for the tests of ``/api/app/1``: browsers of made-up people, ops, pages of ``/changes``."""

from __future__ import annotations

import uuid
from typing import Any

from fastapi.testclient import TestClient

from app.main import app
from app.models import Account
from app.services import clock

from .conftest import make_account, sign_in

API = "/api/app/1"
WEB = {"X-Nextasks-Client": "web"}


def new_id() -> str:
    return str(uuid.uuid4())


def now_ms() -> int:
    return clock.now_ms()


def person(name: str) -> tuple[Account, TestClient]:
    """A made-up person with a browser that speaks to ``/api/app/1`` as the web does."""
    account = make_account(name)
    browser = TestClient(app, base_url="http://testserver", headers=WEB)
    sign_in(browser, account)
    return account, browser


def batch(client: TestClient, *ops: dict[str, Any]) -> list[dict[str, Any]]:
    for op in ops:
        op.setdefault("op_id", new_id())
    answer = client.post(f"{API}/batch", json={"ops": list(ops)})
    assert answer.status_code == 200, answer.text
    return answer.json()["results"]


def put_op(kind: str, item_id: str, fields: dict[str, Any], clock_ms: int | dict[str, int] | None = None,
           **extra: Any) -> dict[str, Any]:
    from app.services import records

    if isinstance(clock_ms, dict):
        clocks = clock_ms
    else:
        moment = now_ms() if clock_ms is None else clock_ms
        clocks = {records.key_of(kind, name): moment for name in fields
                  if name not in ("created_at", "created_by", "private", "role", "id")}
    return {"type": "put", "kind": kind, "id": item_id, "fields": fields, "clock": clocks, **extra}


def put(client: TestClient, kind: str, item_id: str, fields: dict[str, Any],
        clock_ms: int | dict[str, int] | None = None) -> dict[str, Any]:
    [result] = batch(client, put_op(kind, item_id, fields, clock_ms))
    return result


def changes(client: TestClient, since: int = 0, limit: int | None = None) -> dict[str, Any]:
    params: dict[str, Any] = {"since": since}
    if limit is not None:
        params["limit"] = limit
    answer = client.get(f"{API}/changes", params=params)
    assert answer.status_code == 200, answer.text
    return answer.json()


def all_changes(client: TestClient, since: int = 0, limit: int = 500) -> tuple[list[dict[str, Any]], int]:
    """Every page until ``more`` is false: the items in order, and the last cursor."""
    items: list[dict[str, Any]] = []
    while True:
        page = changes(client, since, limit)
        items += page["items"]
        since = page["cursor"]
        if not page["more"]:
            return items, since


def state(client: TestClient) -> dict[tuple[str, str], dict[str, Any]]:
    """What a fresh app would hold: every thing it sees, by ``(kind, id)``."""
    items, _cursor = all_changes(client)
    return {(item["kind"], item["id"]): item for item in items if not item["deleted"]}


def private_space(client: TestClient) -> tuple[str, str]:
    """The space "Private" of the caller and its first list."""
    held = state(client)
    space = next(item for (kind, _), item in held.items() if kind == "space" and item["data"]["private"])
    first = next(item for (kind, _), item in held.items()
                 if kind == "list" and item["data"]["space_id"] == space["id"])
    return space["id"], first["id"]


def shared_space(owner: TestClient, *others: TestClient, name: str = "Family") -> str:
    """A space ``owner`` makes and the others join by invitation."""
    space_id = new_id()
    assert put(owner, "space", space_id, {"name": name})["ok"]
    for other in others:
        link = owner.post(f"{API}/spaces/{space_id}/invites")
        assert link.status_code == 201, link.text
        secret = link.json()["link"].rsplit("/", 1)[-1]
        joined = other.post(f"/api/invites/{secret}/accept")
        assert joined.status_code == 200, joined.text
    return space_id


def make_list(client: TestClient, space_id: str, name: str = "Shopping", position: str = "a1") -> str:
    list_id = new_id()
    result = put(client, "list", list_id, {"space_id": space_id, "name": name, "position": position})
    assert result["ok"], result
    return list_id


def make_reminder(client: TestClient, list_id: str, title: str = "Milk", position: str = "a0",
                  **fields: Any) -> str:
    reminder_id = new_id()
    result = put(client, "reminder", reminder_id, {"list_id": list_id, "title": title, "position": position,
                                                   **_whole_groups(fields)})
    assert result["ok"], result
    return reminder_id


def _whole_groups(fields: dict[str, Any]) -> dict[str, Any]:
    """A change carries all fields of its group: the missing ones of a group get their defaults."""
    out = dict(fields)
    if any(name in out for name in ("due_date", "due_time", "repeat", "repeat_from")):
        out = {"due_date": None, "due_time": None, "repeat": None, "repeat_from": "due", **out}
    if any(name in out for name in ("section_id", "parent_id")):
        out = {"section_id": None, "parent_id": None, **out}
    return out


def entry(client: TestClient, kind: str, item_id: str) -> dict[str, Any] | None:
    return state(client).get((kind, item_id))
