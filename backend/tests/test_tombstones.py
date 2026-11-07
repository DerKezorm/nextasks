"""The bin and what goes for good (``datenmodell.md``, "Papierkorb und Grabsteine"): ``deleted_at`` with
``trashed_at``, 30 days from the server's receipt, tombstones that refuse changes (``gone``), 90 days later the cursor
floor rises (410), and a page handed out with ``more: true`` can always be followed."""

from __future__ import annotations

from datetime import timedelta

from sqlalchemy import select, update

from app.db import SessionLocal
from app.models import Gone, Hidden, Reminder, Space, TaskList, utcnow
from app.services import cursor, trash

from .sync_helpers import (
    API,
    batch,
    changes,
    make_list,
    make_reminder,
    new_id,
    person,
    private_space,
    put,
    shared_space,
    state,
)

DELETED = "2026-11-06T10:00:00.000Z"


def _age(model: object, item_id: str, days: int) -> None:
    with SessionLocal() as db:
        row = db.get(model, item_id)
        row.trashed_at = row.trashed_at - timedelta(days=days)
        db.commit()


def test_deleting_puts_into_the_bin_with_the_servers_moment_and_restoring_takes_it_out() -> None:
    _anna, anna = person("anna")
    _space, list_id = private_space(anna)
    reminder = make_reminder(anna, list_id, "x")
    assert put(anna, "reminder", reminder, {"deleted_at": DELETED})["ok"]
    with SessionLocal() as db:
        assert db.get(Reminder, reminder).trashed_at is not None
    held = state(anna)[("reminder", reminder)]
    assert held["data"]["deleted_at"] == DELETED, "in the bin it still comes, with its deleted_at"
    put(anna, "reminder", reminder, {"deleted_at": None})
    with SessionLocal() as db:
        assert db.get(Reminder, reminder).trashed_at is None


def test_thirty_days_after_the_receipt_the_thing_goes_with_its_children_and_leaves_tombstones() -> None:
    _anna, anna = person("anna")
    _ben, ben = person("ben")
    space = shared_space(anna, ben)
    list_id = make_list(anna, space)
    reminder = make_reminder(anna, list_id, "x")
    sub = make_reminder(anna, list_id, "y", parent_id=reminder)
    since = changes(ben)["cursor"]
    put(anna, "list", list_id, {"deleted_at": DELETED})
    _age(TaskList, list_id, 29)
    trash.run_once()
    assert ("list", list_id) in state(anna), "29 days: still in the bin"
    _age(TaskList, list_id, 2)
    trash.run_once()
    went = {(item["kind"], item["id"]) for item in changes(ben, since)["items"] if item["deleted"]}
    assert {("list", list_id), ("reminder", reminder), ("reminder", sub)} <= went
    again = put(anna, "reminder", reminder, {"title": "back?"})
    assert again["code"] == "gone" and again["current"]["deleted"] is True
    made_in_it = put(anna, "reminder", new_id(), {"list_id": list_id, "title": "z", "position": "a0"})
    assert made_in_it["code"] == "gone"


def test_a_section_and_an_attachment_are_deleted_for_good_at_once_and_twice_is_fine() -> None:
    _anna, anna = person("anna")
    _space, list_id = private_space(anna)
    section = new_id()
    put(anna, "section", section, {"list_id": list_id, "name": "Fridge", "position": "a0"})
    reminder = make_reminder(anna, list_id, "Milk", section_id=section)
    [first, second] = batch(anna, {"type": "delete", "kind": "section", "id": section},
                            {"type": "delete", "kind": "section", "id": section})
    assert first["ok"] and second["ok"] and first["current"]["deleted"] is True
    assert state(anna)[("reminder", reminder)]["data"]["section_id"] == section, "read as none, kept as it was"
    assert put(anna, "section", section, {"name": "again"})["code"] == "gone"
    [wrong] = batch(anna, {"type": "delete", "kind": "reminder", "id": reminder})
    assert wrong["code"] == "invalid"


def test_the_private_space_cannot_be_deleted_and_only_managers_change_a_space() -> None:
    _anna, anna = person("anna")
    ben_account, ben = person("ben")
    private_id, _list = private_space(anna)
    assert put(anna, "space", private_id, {"deleted_at": DELETED})["code"] == "forbidden"
    assert put(anna, "space", private_id, {"name": "Mine", "color": "green"})["ok"], "renaming is fine"
    space = shared_space(anna, ben)
    assert put(ben, "space", space, {"name": "Ours"})["code"] == "forbidden"
    assert put(ben, "space", space, {"deleted_at": DELETED})["code"] == "forbidden"
    assert put(anna, "space", space, {"deleted_at": DELETED})["ok"]
    _ = ben_account


def test_a_space_nobody_is_in_any_more_goes_after_thirty_days() -> None:
    anna_account, anna = person("anna")
    space = shared_space(anna)
    assert anna.delete(f"{API}/spaces/{space}/members/{anna_account.id}").status_code == 204
    with SessionLocal() as db:
        db.execute(update(Space).where(Space.id == space).values(orphaned_at=utcnow() - timedelta(days=31)))
        db.commit()
    trash.run_once()
    with SessionLocal() as db:
        assert db.get(Space, space) is None
        assert db.scalar(select(Gone).where(Gone.kind == "space", Gone.id == space)) is not None


def test_after_ninety_days_tombstones_go_and_an_older_cursor_starts_over() -> None:
    _anna, anna = person("anna")
    _space, list_id = private_space(anna)
    old = changes(anna)["cursor"]
    section = new_id()
    put(anna, "section", section, {"list_id": list_id, "name": "s", "position": "a0"})
    batch(anna, {"type": "delete", "kind": "section", "id": section})
    with SessionLocal() as db:
        db.execute(update(Gone).values(gone_at=utcnow() - timedelta(days=91)))
        db.execute(update(Hidden).values(at=utcnow() - timedelta(days=91)))
        db.commit()
    trash.run_once()
    expired = anna.get(f"{API}/changes", params={"since": old})
    assert expired.status_code == 410 and expired.json()["detail"]["code"] == "cursor_expired"
    with SessionLocal() as db:
        last, _oldest = cursor.state(db)
    beyond = anna.get(f"{API}/changes", params={"since": last + 5})
    assert beyond.status_code == 410, "newer than the server: a restored backup"
    assert anna.get(f"{API}/changes", params={"since": 0}).status_code == 200


def test_a_page_handed_out_with_more_can_always_be_followed_even_after_tombstones_went() -> None:
    _anna, anna = person("anna")
    _space, list_id = private_space(anna)
    for number in range(6):
        make_reminder(anna, list_id, f"r{number}")
    section = new_id()
    put(anna, "section", section, {"list_id": list_id, "name": "s", "position": "a0"})
    batch(anna, {"type": "delete", "kind": "section", "id": section})
    first = changes(anna, 0, limit=2)
    assert first["more"] is True
    with SessionLocal() as db:
        db.execute(update(Gone).values(gone_at=utcnow() - timedelta(days=91)))
        db.commit()
    trash.run_once()
    with SessionLocal() as db:
        assert cursor.state(db)[1] > first["cursor"], "the floor rose past the page's cursor"
    following = anna.get(f"{API}/changes", params={"since": first["cursor"], "limit": 2})
    assert following.status_code == 200, following.text
