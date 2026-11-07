"""Attachments and profile pictures (``vertrag-block1.md``, ``/files``, ``/people/{id}/avatar``): the file lies under
its hash, once for every attachment with the same content; ``ETag`` and ``Range`` work; the backup carries the files
and the new tables."""

from __future__ import annotations

import hashlib
import io
import sqlite3
import zipfile
from typing import Any

from PIL import Image

from app.db import SessionLocal
from app.services import backups, files, settings_service

from .sync_helpers import (
    API,
    batch,
    changes,
    make_list,
    make_reminder,
    new_id,
    person,
    private_space,
    shared_space,
    state,
)

CONTENT = b"%PDF-1.4 a small invoice\n" * 40


def upload(browser: Any, reminder: str, attachment: str | None = None, data: bytes = CONTENT,
           name: str = "invoice.pdf", mime: str = "application/pdf", op_id: str | None = None) -> Any:
    return browser.post(f"{API}/files", data={"id": attachment or new_id(), "reminder_id": reminder,
                                              "op_id": op_id or new_id()},
                        files={"file": (name, data, mime)})


def test_an_attachment_goes_up_once_and_comes_down_with_etag_and_range() -> None:
    account, browser = person("anna")
    _space, list_id = private_space(browser)
    reminder = make_reminder(browser, list_id, "Pay the bill")
    attachment = new_id()
    answer = upload(browser, reminder, attachment)
    assert answer.status_code == 200, answer.text
    result = answer.json()
    digest = hashlib.sha256(CONTENT).hexdigest()
    assert result["ok"] and result["current"]["kind"] == "attachment"
    assert result["current"]["data"] == {"id": attachment, "reminder_id": reminder, "name": "invoice.pdf",
                                         "mime": "application/pdf", "size": len(CONTENT), "hash": digest,
                                         "created_by": account.id, "created_at": result["current"]["data"]["created_at"]}
    assert result["current"]["clock"] == {}
    assert files.path_of(digest).read_bytes() == CONTENT
    down = browser.get(f"{API}/files/{attachment}")
    assert down.status_code == 200 and down.content == CONTENT and down.headers["etag"] == f'"{digest}"'
    assert browser.get(f"{API}/files/{attachment}", headers={"If-None-Match": f'"{digest}"'}).status_code == 304
    part = browser.get(f"{API}/files/{attachment}", headers={"Range": "bytes=0-7"})
    assert part.status_code == 206 and part.content == CONTENT[:8]


def test_the_same_id_again_with_the_same_file_is_fine_with_another_it_is_invalid() -> None:
    _account, browser = person("anna")
    _space, list_id = private_space(browser)
    reminder = make_reminder(browser, list_id, "x")
    attachment = new_id()
    assert upload(browser, reminder, attachment).json()["ok"]
    assert upload(browser, reminder, attachment).json()["ok"]
    other = upload(browser, reminder, attachment, data=b"something else").json()
    assert other["ok"] is False and other["code"] == "invalid" and other["current"]["id"] == attachment
    empty = upload(browser, reminder, data=b"").json()
    assert empty["code"] == "invalid"


def test_the_same_op_id_is_answered_again_without_a_second_file() -> None:
    _account, browser = person("anna")
    _space, list_id = private_space(browser)
    reminder = make_reminder(browser, list_id, "x")
    op_id = new_id()
    first = upload(browser, reminder, op_id=op_id).json()
    again = upload(browser, reminder, op_id=op_id).json()
    assert first["ok"] and again["ok"] and again["current"]["id"] == first["current"]["id"]
    assert sum(1 for (kind, _id) in state(browser) if kind == "attachment") == 1


def test_where_an_attachment_cannot_go() -> None:
    _anna, anna = person("anna")
    _ben, ben = person("ben")
    _space, list_id = private_space(anna)
    reminder = make_reminder(anna, list_id, "x")
    assert upload(ben, reminder).json()["code"] == "not_found"
    assert upload(anna, new_id()).json()["code"] == "parent_missing"
    with SessionLocal() as db:
        settings_service.save(db, {"upload_max_mb": 1})
    big = upload(anna, reminder, data=b"x" * (1024 * 1024 + 1))
    assert big.status_code == 413 and big.json()["detail"]["code"] == "too_large"


def test_deleting_the_last_attachment_of_a_content_removes_the_file() -> None:
    _account, browser = person("anna")
    _space, list_id = private_space(browser)
    reminder = make_reminder(browser, list_id, "x")
    first, second = new_id(), new_id()
    upload(browser, reminder, first)
    upload(browser, reminder, second)
    digest = hashlib.sha256(CONTENT).hexdigest()
    [gone] = batch(browser, {"type": "delete", "kind": "attachment", "id": first})
    assert gone["ok"] and files.path_of(digest).exists(), "the other attachment still has the file"
    batch(browser, {"type": "delete", "kind": "attachment", "id": second})
    assert not files.path_of(digest).exists()
    assert browser.get(f"{API}/files/{second}").status_code == 404


def test_a_member_downloads_a_stranger_does_not() -> None:
    _anna, anna = person("anna")
    _ben, ben = person("ben")
    _carl, carl = person("carl")
    space = shared_space(anna, ben)
    reminder = make_reminder(anna, make_list(anna, space), "x")
    attachment = new_id()
    upload(anna, reminder, attachment)
    assert ben.get(f"{API}/files/{attachment}").status_code == 200
    assert carl.get(f"{API}/files/{attachment}").status_code == 404


def _picture() -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (40, 40), (200, 50, 50)).save(out, "PNG")
    return out.getvalue()


def test_a_profile_picture_is_seen_by_those_who_share_a_space_with_its_hash_as_etag() -> None:
    anna_account, anna = person("anna")
    _ben, ben = person("ben")
    _carl, carl = person("carl")
    shared_space(anna, ben)
    assert anna.put("/api/auth/avatar", content=_picture(), headers={"X-Nextasks-Client": "web"}).status_code == 200
    people = {p["id"]: p for p in changes(ben)["people"]}
    digest = people[anna_account.id]["avatar_hash"]
    assert digest and len(digest) == 64
    picture = ben.get(f"{API}/people/{anna_account.id}/avatar")
    assert picture.status_code == 200 and picture.headers["etag"] == f'"{digest}"'
    assert picture.headers["content-type"] == "image/webp"
    assert ben.get(f"{API}/people/{anna_account.id}/avatar", headers={"If-None-Match": f'"{digest}"'}).status_code == 304
    assert carl.get(f"{API}/people/{anna_account.id}/avatar").status_code == 404


def test_the_backup_carries_the_files_and_the_tables_of_the_new_model(tmp_path: Any) -> None:
    _account, browser = person("anna")
    _space, list_id = private_space(browser)
    reminder = make_reminder(browser, list_id, "In the backup")
    upload(browser, reminder)
    archive = backups.create()
    with zipfile.ZipFile(archive) as packed:
        names = set(packed.namelist())
        assert f"media/{hashlib.sha256(CONTENT).hexdigest()}" in names
        database = tmp_path / "copy.db"
        database.write_bytes(packed.read(backups.DATABASE_ENTRY))
    connection = sqlite3.connect(database)
    try:
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert {"spaces", "members", "lists", "sections", "reminders", "attachments", "list_prefs", "gone", "hidden",
                "sync_state", "app_devices"} <= tables
        assert connection.execute("SELECT title FROM reminders").fetchall() == [("In the backup",)]
    finally:
        connection.close()

