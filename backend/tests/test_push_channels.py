"""The browsers (web push) and the iPhone/iPad app (relay) as channels of their own next to mail
(``services/channels.py``): to every browser or device of the person, on from the start for exactly what went there
before there were choices, each event and report turned on and off per channel, reports short by push, a failed push
tried again. Nothing goes to the network: recorders stand in for the push services and the relay."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import http_ece
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import SessionLocal
from app.models import NotifyOutbox, NotifyRoute, WebPushSubscription
from app.services import notify, notifyprefs, outbox, push, reports, webpush

from . import test_notify as base
from .sync_helpers import API, make_list, make_reminder, person, private_space, put, shared_space

CHROME = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 "
          "Safari/537.36")
FIREFOX = "Mozilla/5.0 (Android 15; Mobile; rv:144.0) Gecko/144.0 Firefox/144.0"


@dataclass
class Browser:
    endpoint: str
    key: ec.EllipticCurvePrivateKey
    auth: bytes


class Services:
    """The push services of all browsers: records what was sent, answers per address."""

    def __init__(self) -> None:
        self.sent: list[tuple[str, bytes, dict[str, str]]] = []
        self.status: dict[str, int] = {}

    def __call__(self, url: str, body: bytes, headers: dict[str, str]) -> int:
        self.sent.append((url, body, headers))
        return self.status.get(url, 201)

    def opened(self, browser: Browser) -> list[dict[str, Any]]:
        return [json.loads(http_ece.decrypt(body, private_key=browser.key, auth_secret=browser.auth,
                                            version="aes128gcm"))
                for url, body, _headers in self.sent if url == browser.endpoint]


@pytest.fixture
def services(monkeypatch: pytest.MonkeyPatch) -> Services:
    recorder = Services()
    monkeypatch.setattr(webpush, "POST", recorder)
    return recorder


@pytest.fixture
def relay(monkeypatch: pytest.MonkeyPatch) -> base.Relay:
    recorder = base.Relay()
    monkeypatch.setattr(push, "POST", recorder)
    return recorder


def signed_up(client: TestClient, user_agent: str = CHROME) -> Browser:
    key = ec.generate_private_key(ec.SECP256R1())
    auth = os.urandom(16)
    point = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    endpoint = f"https://push.example.com/send/{os.urandom(6).hex()}"
    answer = client.put(f"{API}/webpush", headers={"User-Agent": user_agent},
                        json={"endpoint": endpoint, "keys": {"p256dh": webpush.b64url(point),
                                                             "auth": webpush.b64url(auth)}})
    assert answer.status_code == 200, answer.text
    return Browser(endpoint, key, auth)


def notify_state(client: TestClient) -> dict[str, Any]:
    answer = client.get("/api/notify")
    assert answer.status_code == 200, answer.text
    return answer.json()


def route(client: TestClient, event: str, channel: str, on: bool) -> Any:
    return client.put("/api/notify/routes", json={"event": event, "channel": channel, "on": on})


def two_people() -> tuple[Any, TestClient, Any, TestClient, str]:
    anna_account, anna = person("anna")
    ben_account, ben = person("ben")
    space = shared_space(anna, ben)
    return anna_account, anna, ben_account, ben, make_list(anna, space)


# --- The channel "Browser" -------------------------------------------------------------------------------------------


def test_the_browser_channel_reaches_every_browser_and_drops_one_whose_service_forgot_it(services: Services) -> None:
    _anna_account, anna, ben_account, ben, list_id = two_people()
    first = signed_up(ben, CHROME)
    second = signed_up(ben, FIREFOX)
    services.status[second.endpoint] = 410
    reminder = make_reminder(anna, list_id, "Call grandma")
    put(anna, "reminder", reminder, {"assignees": [ben_account.id]})

    assert {url for url, _body, _headers in services.sent} == {first.endpoint, second.endpoint}
    assert services.opened(first) == [{"title": "Call grandma", "text": "anna assigned a task to you",
                                       "reminder_id": reminder, "list_id": list_id, "type": "assigned",
                                       "url": f"/lists/{list_id}?reminder={reminder}"}]
    with SessionLocal() as db:
        left = db.scalars(select(WebPushSubscription.endpoint)).all()
        assert left == [first.endpoint], "the browser its push service forgot is gone"
        sent = db.scalar(select(NotifyOutbox).where(NotifyOutbox.channel == "webpush"))
        assert sent is not None and sent.sent_at is not None and sent.attempts == 1
    [shown] = next(entry for entry in notify_state(ben)["channels"] if entry["kind"] == "webpush")["browsers"]
    assert (shown["browser"], shown["system"]) == ("Chrome", "Windows") and shown["since"]
    assert shown["mark"] == webpush.endpoint_mark(first.endpoint) and "endpoint" not in shown


def test_a_browser_is_removed_from_the_list_by_its_owner_only(services: Services) -> None:
    _anna_account, anna, _ben_account, ben, _list_id = two_people()
    signed_up(ben, FIREFOX)
    [shown] = next(entry for entry in notify_state(ben)["channels"] if entry["kind"] == "webpush")["browsers"]
    assert (shown["browser"], shown["system"]) == ("Firefox", "Android")
    assert anna.delete(f"/api/notify/browsers/{shown['id']}").status_code == 404, "not anna's browser"
    after = ben.delete(f"/api/notify/browsers/{shown['id']}")
    assert after.status_code == 200
    webpush_column = next(entry for entry in after.json()["channels"] if entry["kind"] == "webpush")
    assert webpush_column["browsers"] == [] and webpush_column["state"] == "setup"


def test_a_failed_push_is_tried_again_through_the_outbox(services: Services) -> None:
    _anna_account, anna, ben_account, ben, list_id = two_people()
    browser = signed_up(ben)
    services.status[browser.endpoint] = 503
    reminder = make_reminder(anna, list_id, "Call grandma")
    put(anna, "reminder", reminder, {"assignees": [ben_account.id]})
    assert len(services.sent) == 1 and services.opened(browser) != []
    with SessionLocal() as db:
        row = db.scalar(select(NotifyOutbox).where(NotifyOutbox.channel == "webpush"))
        assert row is not None and row.sent_at is None and row.last_error == "push_failed" and row.attempts == 1
    services.status[browser.endpoint] = 201
    assert outbox.send_round(datetime.now(UTC)) == 0, "not before its minute"
    assert outbox.send_round(datetime.now(UTC) + timedelta(minutes=2)) == 1
    assert len(services.opened(browser)) == 2
    assert outbox.send_round(datetime.now(UTC) + timedelta(minutes=30)) == 0, "once"


# --- From the start as before ----------------------------------------------------------------------------------------


def test_from_the_start_the_browser_and_the_app_get_what_they_got_before(services: Services,
                                                                          relay: base.Relay) -> None:
    anna_account, anna, ben_account, ben, list_id = two_people()
    ben.put(f"{API}/me", json={"timezone": "UTC"})
    browser = signed_up(ben)
    base.phone_of(ben)
    state = notify_state(ben)
    assert [entry["kind"] for entry in state["channels"]] == ["mail", "webpush", "app"]
    pushed = ["webpush", "app"]
    assert state["routes"] == {"daily": [], "weekly": [], "assigned": pushed, "due": pushed, "changed": pushed,
                               "joined": []}
    with SessionLocal() as db:
        assert db.scalars(select(NotifyRoute)).all() == [], "the defaults are no rows"

    # Assigned: at once, both ways.
    reminder = make_reminder(anna, list_id, "Call grandma")
    put(anna, "reminder", reminder, {"assignees": [ben_account.id]})
    assert [m["type"] for m in relay.messages()] == ["assigned"]
    assert [m["type"] for m in services.opened(browser)] == ["assigned"]
    # Due with a time: both ways, the app with its collapse id.
    due = base._due(anna, list_id, "2026-11-06", "09:00", assignees=[ben_account.id])
    assert notify.due_round(datetime(2026, 11, 6, 9, 0, tzinfo=UTC)) == 1
    assert relay.messages()[-1] == {"title": "Dentist", "text": relay.messages()[-1]["text"], "reminder_id": due,
                                    "list_id": list_id, "type": "due"}
    assert relay.sent[-1]["collapse"] == f"{due}:2026-11-06T09:00"
    assert services.opened(browser)[-1]["type"] == "due"
    # Changes by others in a followed list: bundled, both ways.
    put(ben, "list_pref", list_id, {"notify_changes": True})
    make_reminder(anna, list_id, "Bread", position="a5")
    assert notify.bundle_round(datetime.now(UTC) + timedelta(minutes=11)) == 1
    assert relay.messages()[-1]["type"] == "changed" and services.opened(browser)[-1]["type"] == "changed"
    # Reports and "joined" are off: nothing more.
    before = (len(relay.sent), len(services.sent))
    with SessionLocal() as db:
        from app.models import Account

        row = db.get(Account, ben_account.id)
        assert row is not None
        made = notifyprefs.dispatch(db, row, "joined", "x", lambda *_: None,
                                    lambda language: notify.channels.Message(title="t", text="t"), at_once=True)
        assert made == 0
    assert reports.report_round(datetime(2026, 11, 9, 7, 1, tzinfo=UTC)) == 0
    outbox.send_round()
    assert (len(relay.sent), len(services.sent)) == before
    _ = anna_account


def test_the_app_channel_is_on_from_the_start_and_needs_a_paired_device(relay: base.Relay) -> None:
    _anna_account, anna, ben_account, ben, list_id = two_people()
    ben.put(f"{API}/me", json={"language": "de"})
    column = next(entry for entry in notify_state(ben)["channels"] if entry["kind"] == "app")
    assert column["name"] == "iPhone/iPad" and column["icon"] == "smartphone"
    assert column["state"] == "setup" and column["summary"] == "Kein Gerät"
    assert column["link"] == "/account?tab=connections" and column["link_label"] == "App koppeln"
    assert column["defaults"] == ["assigned", "changed", "due"]
    base.phone_of(ben)
    column = next(entry for entry in notify_state(ben)["channels"] if entry["kind"] == "app")
    assert column["ready"] is True and column["summary"] == "1 Gerät gekoppelt"
    put(anna, "reminder", make_reminder(anna, list_id, "Milk"), {"assignees": [ben_account.id]})
    assert [m["type"] for m in relay.messages()] == ["assigned"]


# --- Per channel -----------------------------------------------------------------------------------------------------


def test_each_event_is_turned_on_and_off_per_channel_and_kept_while_a_channel_cannot_be_used(
        services: Services, relay: base.Relay) -> None:
    _anna_account, anna, ben_account, ben, list_id = two_people()
    browser = signed_up(ben)
    base.phone_of(ben)

    assert route(ben, "assigned", "webpush", False).json()["routes"]["assigned"] == ["app"]
    put(anna, "reminder", make_reminder(anna, list_id, "One", position="a1"), {"assignees": [ben_account.id]})
    assert len(relay.messages()) == 1 and services.opened(browser) == [], "the browser is off for it"

    assert route(ben, "assigned", "app", False).json()["routes"]["assigned"] == []
    put(anna, "reminder", make_reminder(anna, list_id, "Two", position="a2"), {"assignees": [ben_account.id]})
    assert len(relay.messages()) == 1 and services.opened(browser) == [], "off everywhere"

    assert route(ben, "assigned", "webpush", True).json()["routes"]["assigned"] == ["webpush"]
    put(anna, "reminder", make_reminder(anna, list_id, "Three", position="a3"), {"assignees": [ben_account.id]})
    assert [m["title"] for m in services.opened(browser)] == ["Three"] and len(relay.messages()) == 1
    with SessionLocal() as db:
        stored = {(row.event, row.channel, row.enabled) for row in db.scalars(select(NotifyRoute))}
    assert stored == {("assigned", "app", False)}, "only what differs from the default is stored"

    # No browser left: the column cannot be used; turning on is refused, the choices stay.
    browser_id = next(entry for entry in notify_state(ben)["channels"] if entry["kind"] == "webpush")["browsers"][0]
    ben.delete(f"/api/notify/browsers/{browser_id['id']}")
    refused = route(ben, "daily", "webpush", True)
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "channel_not_confirmed"
    assert route(ben, "due", "webpush", False).status_code == 200, "turning off always works"
    state = notify_state(ben)
    assert state["routes"]["assigned"] == ["webpush"] and state["routes"]["due"] == ["app"]
    refused = route(ben, "nothing", "webpush", True)
    assert refused.status_code == 422


# --- Reports by push -------------------------------------------------------------------------------------------------


def test_a_report_comes_short_by_push_and_a_click_opens_today(services: Services, relay: base.Relay) -> None:
    _account, ben = person("ben")
    ben.put(f"{API}/me", json={"timezone": "UTC", "language": "de"})
    _space, list_id = private_space(ben)
    browser = signed_up(ben)
    base.phone_of(ben)
    make_reminder(ben, list_id, "Today one", due_date="2026-11-09", due_time=None, repeat=None, repeat_from="due")
    make_reminder(ben, list_id, "Late one", position="a2", due_date="2026-11-08", due_time=None, repeat=None,
                  repeat_from="due")
    assert route(ben, "daily", "webpush", True).status_code == 200
    assert route(ben, "daily", "app", True).status_code == 200

    assert reports.report_round(datetime(2026, 11, 9, 7, 1, tzinfo=UTC)) == 2
    assert services.sent == [] and relay.sent == [], "a report goes through the outbox"
    assert outbox.send_round() == 2
    expected = {"title": "Mein Tag", "text": "1 heute fällig, 1 überfällig", "reminder_id": None, "list_id": None,
                "type": "daily"}
    assert services.opened(browser) == [expected | {"url": "/today"}]
    assert relay.messages() == [expected]
    assert reports.report_round(datetime(2026, 11, 9, 7, 30, tzinfo=UTC)) == 0, "once a day"


def test_the_week_by_push_counts_done_and_upcoming() -> None:
    _account, ben = person("ben")
    ben.put(f"{API}/me", json={"timezone": "UTC"})
    _space, list_id = private_space(ben)
    make_reminder(ben, list_id, "Soon", due_date="2026-11-10", due_time=None, repeat=None, repeat_from="due")
    with SessionLocal() as db:
        from app.models import Account

        row = db.scalar(select(Account).where(Account.name == "ben"))
        assert row is not None
        message = reports.short(db, row, "weekly", now=datetime(2026, 11, 8, 18, 0, tzinfo=UTC), since=None)
    assert message is not None
    assert (message.title, message.text, message.link) == ("The week", "1 due in the next 7 days", "/today")
