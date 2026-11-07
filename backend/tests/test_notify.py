"""Notifications (``datenmodell.md``, "Mitteilungen"): due with a time in the person's zone (summer time included),
assigned at once, changes by others bundled over ten minutes; to the app through the relay (encrypted for the device,
test value of ``pruefsaetze/push.json``) and to browsers by web push. Nothing goes to the network: recorders stand in
for the relay and the push services."""

from __future__ import annotations

import base64
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import SessionLocal
from app.main import app
from app.models import WebPushSubscription
from app.services import notify, push, push_crypto, webpush

from .sync_helpers import API, batch, make_list, make_reminder, now_ms, person, private_space, put, shared_space

VECTOR = json.loads(Path(__file__).with_name("pruefsaetze").joinpath("push.json").read_text(encoding="utf-8"))


class Relay:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []
        self.status = 200

    def __call__(self, url: str, body: dict[str, Any]) -> int:
        assert url.endswith("/v1/send")
        self.sent.append(body)
        return self.status

    def messages(self) -> list[dict[str, Any]]:
        return [json.loads(push_crypto.decrypt(str(body["enc"]), VECTOR["device_private_key"])) for body in self.sent]


@pytest.fixture
def relay(monkeypatch: pytest.MonkeyPatch) -> Relay:
    recorder = Relay()
    monkeypatch.setattr(push, "POST", recorder)
    return recorder


def phone_of(browser: TestClient) -> TestClient:
    """A paired device that handed its ticket and the test key over."""
    pairing = browser.post("/api/app-pairing", json={"address": "https://tasks.example.com"}).json()
    secret = parse_qs(urlsplit(pairing["link"]).query)["secret"][0]
    key = TestClient(app, base_url="http://testserver").post(
        f"{API}/pairing/{pairing['id']}/key", json={"device": "iPhone"}, headers={"X-Pairing-Secret": secret}
    ).json()["key"]
    phone = TestClient(app, base_url="http://testserver", headers={"Authorization": f"Bearer {key}"})
    answer = phone.put(f"{API}/push", json={"ticket": "ticket-" + key[-6:], "key": VECTOR["device_public_key"]})
    assert answer.status_code == 200, answer.text
    return phone


def test_the_relay_is_offered_and_a_wrong_key_is_refused(relay: Relay) -> None:
    _account, browser = person("anna")
    phone = phone_of(browser)
    assert "push" in phone.get(f"{API}/me").json()["features"]
    wrong = phone.put(f"{API}/push", json={"ticket": "t", "key": "AAAA"})
    assert wrong.status_code == 422 and wrong.json()["detail"]["fields"] == ["key"]
    assert phone.delete(f"{API}/push").json() == {"status": "ok"}


# --- Due ----------------------------------------------------------------------------------------------------------


def test_the_moment_in_summer_time_gaps_comes_later_and_in_doubled_hours_the_first_time() -> None:
    gap = notify.moment("2026-03-29", "02:30", "Europe/Berlin")
    assert gap.astimezone(UTC) == datetime(2026, 3, 29, 1, 30, tzinfo=UTC), "03:30 summer time"
    doubled = notify.moment("2026-10-25", "02:30", "Europe/Berlin")
    assert doubled.astimezone(UTC) == datetime(2026, 10, 25, 0, 30, tzinfo=UTC), "the first 02:30"
    assert notify.moment("2026-11-06", "09:00", "America/New_York").astimezone(UTC).hour == 14


def _due(browser: TestClient, list_id: str, day: str, at: str, **fields: Any) -> str:
    return make_reminder(browser, list_id, "Dentist", due_date=day, due_time=at, repeat=None, repeat_from="due",
                         **fields)


def test_a_due_reminder_rings_once_in_the_persons_own_zone(relay: Relay) -> None:
    account, browser = person("anna")
    browser.put(f"{API}/me", json={"timezone": "Europe/Berlin"})
    _space, list_id = private_space(browser)
    phone_of(browser)
    reminder = _due(browser, list_id, "2026-11-06", "09:00")
    ringing = datetime(2026, 11, 6, 8, 1, tzinfo=UTC)
    assert notify.due_round(ringing - timedelta(minutes=2)) == 0, "not yet"
    assert notify.due_round(ringing) == 1
    assert notify.due_round(ringing + timedelta(seconds=30)) == 0, "once"
    [message] = relay.messages()
    assert message == {"title": "Dentist", "text": message["text"], "reminder_id": reminder, "list_id": list_id,
                       "type": "due"}
    assert relay.sent[0]["collapse"] == f"{reminder}:2026-11-06T09:00"
    _ = account


def test_a_notification_carries_the_note_as_plain_text_never_markdown(relay: Relay) -> None:
    _account, browser = person("anna")
    browser.put(f"{API}/me", json={"timezone": "UTC", "language": "de"})
    _space, list_id = private_space(browser)
    phone_of(browser)
    _due(browser, list_id, "2026-11-06", "09:00",
         notes="# Wichtig\n- [ ] **Karte** mitnehmen\n![Zettel](attachment:0b3e4c1a-5d6f-4a7b-8c9d-0e1f2a3b4c5d)")
    assert notify.due_round(datetime(2026, 11, 6, 9, 0, tzinfo=UTC)) == 1
    [message] = relay.messages()
    assert message["text"].split("\n")[1] == "Wichtig ☐ Karte mitnehmen [Bild]"
    assert "**" not in message["text"] and "attachment:" not in message["text"]


def test_a_moment_more_than_five_minutes_past_does_not_ring(relay: Relay) -> None:
    _account, browser = person("anna")
    browser.put(f"{API}/me", json={"timezone": "UTC"})
    _space, list_id = private_space(browser)
    phone_of(browser)
    _due(browser, list_id, "2026-11-06", "09:00")
    assert notify.due_round(datetime(2026, 11, 6, 9, 6, tzinfo=UTC)) == 0
    assert notify.due_round(datetime(2026, 11, 6, 9, 4, tzinfo=UTC)) == 1


def test_a_new_moment_rings_again_and_done_or_binned_ones_never(relay: Relay) -> None:
    _account, browser = person("anna")
    browser.put(f"{API}/me", json={"timezone": "UTC"})
    _space, list_id = private_space(browser)
    phone_of(browser)
    reminder = _due(browser, list_id, "2026-11-06", "09:00")
    assert notify.due_round(datetime(2026, 11, 6, 9, 0, tzinfo=UTC)) == 1
    put(browser, "reminder", reminder, {"due_date": "2026-11-06", "due_time": "10:00", "repeat": None,
                                        "repeat_from": "due"})
    assert notify.due_round(datetime(2026, 11, 6, 10, 0, tzinfo=UTC)) == 1
    done = _due(browser, list_id, "2026-11-06", "11:00")
    batch(browser, {"type": "complete", "id": done, "occurrence": None, "at": "2026-11-06T10:30:00.000Z",
                    "on": "2026-11-06"})
    binned = _due(browser, list_id, "2026-11-06", "11:00")
    put(browser, "list", list_id, {"deleted_at": "2026-11-06T10:40:00.000Z"})
    assert notify.due_round(datetime(2026, 11, 6, 11, 0, tzinfo=UTC)) == 0
    _ = binned


def test_due_goes_to_the_assignees_who_are_members_else_to_the_maker(relay: Relay) -> None:
    _anna, anna = person("anna")
    ben_account, ben = person("ben")
    for browser in (anna, ben):
        browser.put(f"{API}/me", json={"timezone": "UTC"})
    space = shared_space(anna, ben)
    list_id = make_list(anna, space)
    phone_of(anna)
    phone_of(ben)
    _due(anna, list_id, "2026-11-06", "09:00", assignees=[ben_account.id])
    assert [m["type"] for m in relay.messages()] == ["assigned"], "assigned when made, to Ben"
    notify.due_round(datetime(2026, 11, 6, 9, 0, tzinfo=UTC))
    due = [body for body, message in zip(relay.sent, relay.messages(), strict=True) if message["type"] == "due"]
    with SessionLocal() as db:
        from app.models import AppDevice

        bens = db.scalar(select(AppDevice.push_ticket).where(AppDevice.account_id == ben_account.id))
    assert [body["ticket"] for body in due] == [bens], "only Ben, the assignee"
    alone = _due(anna, list_id, "2026-11-06", "09:30")
    notify.due_round(datetime(2026, 11, 6, 9, 30, tzinfo=UTC))
    last = relay.messages()[-1]
    assert last["reminder_id"] == alone and relay.sent[-1]["ticket"] != bens, "without assignees: the maker"


def test_a_ticket_the_relay_says_is_gone_is_forgotten(relay: Relay) -> None:
    _account, browser = person("anna")
    browser.put(f"{API}/me", json={"timezone": "UTC"})
    _space, list_id = private_space(browser)
    phone = phone_of(browser)
    relay.status = 410
    _due(browser, list_id, "2026-11-06", "09:00")
    notify.due_round(datetime(2026, 11, 6, 9, 0, tzinfo=UTC))
    assert len(relay.sent) == 1
    _due(browser, list_id, "2026-11-06", "09:05")
    notify.due_round(datetime(2026, 11, 6, 9, 5, tzinfo=UTC))
    assert len(relay.sent) == 1, "no ticket, nothing goes out"
    assert phone.get(f"{API}/me").status_code == 200, "the device stays paired"


# --- Assigned -----------------------------------------------------------------------------------------------------


def test_who_is_newly_assigned_hears_at_once_but_not_who_assigns_himself(relay: Relay) -> None:
    anna_account, anna = person("anna")
    ben_account, ben = person("ben")
    ben.put(f"{API}/me", json={"language": "de"})
    space = shared_space(anna, ben)
    list_id = make_list(anna, space)
    phone_of(ben)
    phone_of(anna)
    reminder = make_reminder(anna, list_id, "Take the bins out")
    put(anna, "reminder", reminder, {"assignees": [anna_account.id, ben_account.id]})
    messages = relay.messages()
    assert len(messages) == 1 and messages[0]["type"] == "assigned" and messages[0]["reminder_id"] == reminder
    assert messages[0]["text"] == "anna hat dir eine Aufgabe zugewiesen"
    put(anna, "reminder", reminder, {"assignees": [anna_account.id, ben_account.id]}, now_ms() + 5)
    assert len(relay.messages()) == 1, "nobody new"
    batch(anna, {"type": "complete", "id": reminder, "occurrence": None, "at": "2026-11-06T10:00:00.000Z",
                 "on": "2026-11-06"})
    put(anna, "reminder", reminder, {"assignees": [ben_account.id]}, now_ms() + 10)
    put(anna, "reminder", reminder, {"assignees": [ben_account.id, anna_account.id]}, now_ms() + 20)
    assert len(relay.messages()) == 1, "a done reminder assigns quietly"


# --- Changes by others --------------------------------------------------------------------------------------------


def test_changes_by_others_come_bundled_after_ten_minutes_for_who_follows_the_list(relay: Relay) -> None:
    _anna, anna = person("anna")
    _ben, ben = person("ben")
    _carl, carl = person("carl")
    ben.put(f"{API}/me", json={"language": "de"})
    space = shared_space(anna, ben, carl)
    list_id = make_list(anna, space, "Einkauf")
    put(ben, "list_pref", list_id, {"notify_changes": True})
    phone_of(ben)
    phone_of(carl)
    make_reminder(anna, list_id, "Milk")
    make_reminder(anna, list_id, "Bread", position="a1")
    make_reminder(ben, list_id, "Own one", position="a2")
    assert relay.sent == [], "nothing before the ten minutes are over"
    later = datetime.now(UTC) + timedelta(minutes=11)
    assert notify.bundle_round(later) == 1
    [message] = relay.messages()
    assert message == {"title": "Einkauf", "text": "anna hat 2 Aufgaben hinzugefügt", "reminder_id": None,
                       "list_id": list_id, "type": "changed"}
    assert notify.bundle_round(later) == 0


def test_mixed_changes_and_several_people_are_told_as_such() -> None:
    from types import SimpleNamespace

    _anna, _a = person("anna")
    with SessionLocal() as db:
        from app.models import Account

        anna = db.scalar(select(Account).where(Account.name == "anna"))
        # The reader is anna herself here: she sees her own name.
        reader = SimpleNamespace(id=anna.id, language="en", browser_language="")
        listed = SimpleNamespace(name="Shopping")
        mixed = [{"by": anna.id, "type": "added"}, {"by": anna.id, "type": "completed"}]
        assert notify.bundle_text(db, reader, listed, mixed) == "2 changes in Shopping"
        others = [{"by": anna.id, "type": "completed"}, {"by": 999, "type": "completed"}]
        assert notify.bundle_text(db, reader, listed, others) == "anna and others completed 2 tasks"
        assert notify.bundle_text(db, reader, listed, [{"by": anna.id, "type": "added"}]) == "anna added 1 task"


# --- Web push -----------------------------------------------------------------------------------------------------


class Services:
    def __init__(self) -> None:
        self.sent: list[tuple[str, bytes, dict[str, str]]] = []
        self.status = 201

    def __call__(self, url: str, body: bytes, headers: dict[str, str]) -> int:
        self.sent.append((url, body, headers))
        return self.status


def _browser_keys() -> tuple[str, str]:
    private = ec.generate_private_key(ec.SECP256R1())
    point = private.public_key().public_bytes(serialization.Encoding.X962,
                                              serialization.PublicFormat.UncompressedPoint)
    return webpush.b64url(point), webpush.b64url(b"0123456789abcdef")


def test_a_browser_signs_up_gets_notifications_and_goes_when_its_service_forgets_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    services = Services()
    monkeypatch.setattr(webpush, "POST", services)
    anna_account, anna = person("anna")
    ben_account, ben = person("ben")
    key = anna.get(f"{API}/webpush/key").json()["public_key"]
    assert len(base64.urlsafe_b64decode(key + "==")) == 65
    p256dh, auth = _browser_keys()
    endpoint = "https://push.example.com/send/abc"
    assert ben.put(f"{API}/webpush", json={"endpoint": endpoint, "keys": {"p256dh": p256dh, "auth": auth}}
                   ).status_code == 200
    refused = ben.put(f"{API}/webpush", json={"endpoint": "http://10.0.0.1/x", "keys": {"p256dh": p256dh,
                                                                                        "auth": auth}})
    assert refused.status_code == 422
    space = shared_space(anna, ben)
    reminder = make_reminder(anna, make_list(anna, space), "Call grandma")
    put(anna, "reminder", reminder, {"assignees": [ben_account.id]})
    [(url, body, headers)] = services.sent
    assert url == endpoint and headers["Content-Encoding"] == "aes128gcm" and headers["Authorization"].startswith(
        "vapid t=")
    assert len(body) > 100
    services.status = 410
    put(anna, "reminder", reminder, {"assignees": []}, now_ms() + 5)
    put(anna, "reminder", reminder, {"assignees": [ben_account.id]}, now_ms() + 10)
    with SessionLocal() as db:
        assert db.scalar(select(WebPushSubscription)) is None
    assert ben.request("DELETE", f"{API}/webpush", json={"endpoint": endpoint}).status_code == 200
    _ = anna_account
