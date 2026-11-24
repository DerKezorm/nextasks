"""Comments (contract 0.9, kind ``comment``, word ``comments``): a text with mentions and optionally a picture under a
task of a shared space; everybody in the space reads and writes, the author edits for a day and removes at any time,
a manager removes any. They travel with ``/changes``, follow their task into another space, and go with it."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import SessionLocal
from app.models import Comment, Gone, Reminder, utcnow
from app.services import clock, records, trash

from .sync_helpers import (
    API,
    batch,
    changes,
    entry,
    make_list,
    make_reminder,
    new_id,
    now_ms,
    person,
    private_space,
    put,
    put_op,
    shared_space,
    state,
)


def comment(client: TestClient, reminder_id: str, text: str = "Who buys it?", **fields: Any) -> tuple[str, dict]:
    comment_id = new_id()
    body = {"reminder_id": reminder_id, "text": text, "mentions": [], **fields}
    result = put(client, "comment", comment_id, body, {"text": now_ms()})
    return comment_id, result


def family() -> tuple[Any, TestClient, Any, TestClient, str, str]:
    anna_account, anna = person("anna")
    ben_account, ben = person("ben")
    space = shared_space(anna, ben)
    task = make_reminder(anna, make_list(anna, space))
    return anna_account, anna, ben_account, ben, space, task


def test_the_server_names_comments_among_its_features() -> None:
    _account, browser = person("anna")
    assert "comments" in browser.get(f"{API}/me").json()["features"]


def test_a_comment_is_made_and_everybody_in_the_space_gets_it() -> None:
    anna_account, anna, ben_account, ben, _space, task = family()
    comment_id, result = comment(anna, task, "  Who buys it, @ben?  ", mentions=[ben_account.id, 999])
    assert result["ok"], result
    current = result["current"]
    assert current["kind"] == "comment" and current["clock"] == {"text": current["clock"]["text"]}
    data = current["data"]
    assert data["text"] == "Who buys it, @ben?" and data["mentions"] == [ben_account.id], "non-members drop out"
    assert data["author_id"] == anna_account.id and data["reminder_id"] == task
    assert data["edited_at"] is None and data["removed_at"] is None and data["attachment_id"] is None
    seen = entry(ben, "comment", comment_id)
    assert seen is not None and seen["data"]["text"] == "Who buys it, @ben?"
    assert anna_account.id in {person["id"] for person in changes(ben)["people"]}


def test_no_comment_in_private_without_text_or_without_a_task_one_sees() -> None:
    _dora_account, dora = person("dora")
    _space, first = private_space(dora)
    task = make_reminder(dora, first)
    assert comment(dora, task)[1]["code"] == "forbidden"
    _a, shared_anna, _b, ben, _s, shared_task = family()
    assert comment(shared_anna, shared_task, "   ")[1]["code"] == "invalid"
    _c, carl = person("carl")
    assert comment(carl, shared_task)[1]["code"] == "not_found"
    assert comment(ben, new_id())[1]["code"] == "parent_missing"
    missing = put(ben, "comment", new_id(), {"text": "x", "mentions": []}, {"text": now_ms()})
    assert missing["code"] == "invalid" and missing["fields"] == ["reminder_id"]


def test_the_author_edits_for_a_day_others_never() -> None:
    _a, anna, _b, ben, _space, task = family()
    comment_id, _result = comment(anna, task, "Milk")
    edited = put(anna, "comment", comment_id, {"text": "Oat milk", "mentions": [], "reminder_id": new_id()},
                 {"text": now_ms() + 1})
    assert edited["ok"] and edited["current"]["data"]["text"] == "Oat milk"
    assert edited["current"]["data"]["edited_at"] is not None
    assert edited["current"]["data"]["reminder_id"] == task and "reminder_id" in edited["ignored"]
    assert put(ben, "comment", comment_id, {"text": "Mine now", "mentions": []}, {"text": now_ms() + 2})["code"] \
        == "forbidden"
    clock.shift(int(timedelta(hours=24, minutes=1).total_seconds() * 1000))
    assert put(anna, "comment", comment_id, {"text": "Late", "mentions": []}, {"text": now_ms() + 3})["code"] \
        == "forbidden"


def test_an_edit_carries_text_and_mentions_together() -> None:
    _a, anna, _b, _ben, _space, task = family()
    comment_id, _result = comment(anna, task)
    half = put(anna, "comment", comment_id, {"text": "half"}, {"text": now_ms() + 1})
    assert half["code"] == "invalid" and half["fields"] == ["mentions"]


def test_removing_leaves_message_removed_author_or_manager_only() -> None:
    _a, anna, _b, ben, space, task = family()
    mine, _ = comment(ben, task, "Ben's")
    theirs, _ = comment(anna, task, "Anna's")
    [refused] = batch(ben, {"type": "delete", "kind": "comment", "id": theirs})
    assert refused["code"] == "forbidden"
    [own] = batch(ben, {"type": "delete", "kind": "comment", "id": mine})
    assert own["ok"] and own["current"]["data"]["text"] == "" and own["current"]["data"]["removed_at"]
    [again] = batch(ben, {"type": "delete", "kind": "comment", "id": mine})
    assert again["ok"]
    assert put(ben, "comment", mine, {"text": "back", "mentions": []}, {"text": now_ms() + 10**6})["code"] \
        == "forbidden"
    # Ben is no manager; Anna made the space and removes any.
    [managed] = batch(anna, {"type": "delete", "kind": "comment", "id": mine})
    assert managed["ok"]
    _c, carl = person("carl")
    [unseen] = batch(carl, {"type": "delete", "kind": "comment", "id": theirs})
    assert unseen["code"] == "not_found"
    assert space


def test_a_picture_is_an_attachment_of_the_same_task_and_goes_with_its_comment() -> None:
    _a, anna, _b, ben, space, task = family()
    attachment_id = new_id()
    sent = anna.post(f"{API}/files", data={"id": attachment_id, "reminder_id": task, "op_id": new_id()},
                     files={"file": ("note.txt", b"hello", "text/plain")})
    assert sent.json()["ok"], sent.text
    other = make_reminder(anna, make_list(anna, space, "Other"))
    assert comment(anna, other, "", attachment_id=attachment_id)[1]["fields"] == ["attachment_id"]
    comment_id, made = comment(anna, task, "", attachment_id=attachment_id)
    assert made["ok"] and made["current"]["data"]["attachment_id"] == attachment_id
    [removed] = batch(anna, {"type": "delete", "kind": "comment", "id": comment_id})
    assert removed["current"]["data"]["attachment_id"] is None
    assert entry(ben, "attachment", attachment_id) is None
    assert ("attachment", attachment_id) in {(item["kind"], item["id"]) for item in changes(ben, 1)["items"]
                                             if item["deleted"]}


def test_comments_follow_their_task_into_another_space_and_leave_who_does_not_see_it() -> None:
    _a, anna, _b, ben, _space, task = family()
    _c, carl = person("carl")
    other_space = shared_space(anna, carl, name="Club")
    comment_id, _ = comment(anna, task)
    since = changes(ben)["cursor"]
    target = make_list(anna, other_space, "Club list")
    moved = put(anna, "reminder", task, {"list_id": target, "section_id": None, "parent_id": None,
                                         "position": "a0"})
    assert moved["ok"], moved
    assert entry(carl, "comment", comment_id) is not None
    told = {(item["kind"], item["id"]): item["deleted"] for item in changes(ben, since)["items"]}
    assert told[("comment", comment_id)] is True


def test_comments_go_with_their_task_for_good() -> None:
    _a, anna, _b, ben, _space, task = family()
    comment_id, _ = comment(anna, task)
    put(anna, "reminder", task, {"deleted_at": records.format_stamp(clock.now())})
    assert entry(ben, "comment", comment_id) is not None, "in the bin it still comes"
    with SessionLocal() as db:
        row = db.get(Reminder, task)
        assert row is not None
        row.trashed_at = utcnow() - timedelta(days=31)
        db.commit()
    trash.run_once()
    with SessionLocal() as db:
        assert db.get(Comment, comment_id) is None
        assert db.scalar(select(Gone).where(Gone.kind == "comment", Gone.id == comment_id)) is not None
    assert entry(ben, "comment", comment_id) is None
    assert comment(anna, task)[1]["code"] == "gone"
    assert put(anna, "comment", comment_id, {"text": "x", "mentions": []}, {"text": now_ms()})["code"] == "gone"


def test_a_member_who_leaves_hears_the_comments_went() -> None:
    _a, anna, ben_account, ben, space, task = family()
    comment_id, _ = comment(anna, task)
    since = changes(ben)["cursor"]
    assert ben.delete(f"{API}/spaces/{space}/members/{ben_account.id}").status_code == 204
    told = {(item["kind"], item["id"]): item["deleted"] for item in changes(ben, since)["items"]}
    assert told[("comment", comment_id)] is True
    assert state(anna)[("comment", comment_id)]["data"]["author_id"] is not None


def test_an_older_caller_sending_an_unknown_kind_still_gets_invalid() -> None:
    _account, browser = person("anna")
    [result] = batch(browser, put_op("note", new_id(), {"text": "x"}))
    assert result["code"] == "invalid" and result["fields"] == ["kind"]
