"""After a restore the change counter goes on past everything handed out before it (``backups._continue_counter``).

Found by the app against a real server: the restored counter handed out again numbers a device already held for
changes the backup did not know. A write after the restore moved the counter back up to the device's cursor, and
``/changes`` then answered the device with nothing instead of 410: what it had stayed with it for ever."""

from __future__ import annotations

from sqlalchemy import select

from app.db import SessionLocal
from app.models import PageCursor
from app.services import backups, cursor

from .conftest import sign_in
from .sync_helpers import API, changes, make_reminder, person, private_space


def test_after_a_restore_the_counter_goes_on_and_every_older_cursor_starts_over() -> None:
    anna_account, anna = person("anna")
    _space, list_id = private_space(anna)
    make_reminder(anna, list_id, "before the backup")
    at_backup = changes(anna)["cursor"]
    name = backups.create().name
    # One change after the backup: the device holds a cursor the backup never handed out.
    make_reminder(anna, list_id, "lost with the restore")
    device = changes(anna)["cursor"]
    assert device > at_backup
    for number in range(4):
        make_reminder(anna, list_id, f"page {number}")
    assert changes(anna, 0, limit=2)["more"] is True

    backups.stage_restore(name)
    assert backups.apply_pending() is True

    with SessionLocal() as db:
        last, oldest = cursor.state(db)
        assert db.scalar(select(PageCursor)) is None, "pages of the old state go"
    assert last > device and oldest == last
    sign_in(anna, anna_account)
    # The case of the report: somebody writes after the restore before the device asks.
    make_reminder(anna, list_id, "after the restore")
    for since in (at_backup, device):
        answer = anna.get(f"{API}/changes", params={"since": since})
        assert answer.status_code == 410, (since, answer.text)
        assert answer.json()["detail"]["code"] == "cursor_expired"
    fresh = changes(anna, 0)
    titles = {item["data"]["title"] for item in fresh["items"] if item["kind"] == "reminder" and item["data"]}
    assert {"before the backup", "after the restore"} <= titles
    assert "lost with the restore" not in titles
    assert anna.get(f"{API}/changes", params={"since": fresh["cursor"]}).status_code == 200
