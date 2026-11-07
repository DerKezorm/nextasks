"""Notifications with mail: the channels (``services/channels.py``), the confirmed address, the reports "My day" and
"The week", single events, the outbox with retries, unsubscribing at one click, rights. Nothing leaves the machine: a
recorder stands in for the SMTP server, every address is made up (``example.test``)."""

from __future__ import annotations

import re
import smtplib
from datetime import UTC, datetime, timedelta
from email.message import EmailMessage
from typing import Any, ClassVar, Self
from urllib.parse import urlsplit

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, update

from app.db import SessionLocal
from app.main import app
from app.models import (
    Account,
    NotifyOutbox,
    NotifyRoute,
    NotifySchedule,
    OidcLink,
    OidcProvider,
)
from app.services import channels, emailaddr, logs, notifyprefs, outbox, reports, settings_service

from .sync_helpers import API, batch, make_list, make_reminder, person, private_space, put, shared_space

PUBLIC = "https://tasks.example.test"


class Postbox:
    sent: ClassVar[list[EmailMessage]] = []
    fail = False

    def __init__(self, host: str, port: int, timeout: float = 0, context: Any = None) -> None:
        self.host = host

    def __enter__(self) -> Self:
        if Postbox.fail:
            raise smtplib.SMTPServerDisconnected("mail.example.test hung up on robin@example.test")
        return self

    def __exit__(self, *_: object) -> None:
        pass

    def starttls(self, context: Any = None) -> None:
        pass

    def login(self, user: str, password: str) -> None:
        pass

    def send_message(self, message: EmailMessage) -> None:
        Postbox.sent.append(message)


@pytest.fixture
def postbox(monkeypatch: pytest.MonkeyPatch) -> type[Postbox]:
    Postbox.sent, Postbox.fail = [], False
    monkeypatch.setattr(smtplib, "SMTP", Postbox)
    monkeypatch.setattr(smtplib, "SMTP_SSL", Postbox)
    return Postbox


def mail_server(public: str = PUBLIC) -> None:
    with SessionLocal() as db:
        settings_service.save(db, {"smtp_host": "mail.example.test", "smtp_from": "tasks@example.test",
                                   "public_url": public})


def text_of(message: EmailMessage) -> str:
    body = message.get_body(("plain",))
    assert body is not None
    return str(body.get_content())


def html_of(message: EmailMessage) -> str:
    body = message.get_body(("html",))
    assert body is not None
    return str(body.get_content())


def confirmed(browser: TestClient, box: type[Postbox], address: str) -> None:
    """Enters ``address`` and opens the link from the mail."""
    answer = browser.put("/api/me/email", json={"address": address})
    assert answer.status_code == 200, answer.text
    link = re.search(r"https://\S+/confirm-email/(\S+)", text_of(box.sent[-1]))
    assert link is not None
    opened = TestClient(app, base_url="http://testserver", headers={"X-Nextasks-Client": "web"}).post(
        "/api/email/confirm", json={"token": link.group(1)})
    assert opened.status_code == 200, opened.text


def turn_on(browser: TestClient, event: str, channel: str = "mail") -> None:
    answer = browser.put("/api/notify/routes", json={"event": event, "channel": channel, "on": True})
    assert answer.status_code == 200, answer.text


def mail_channel(browser: TestClient) -> dict[str, Any]:
    return next(entry for entry in browser.get("/api/notify").json()["channels"] if entry["kind"] == "mail")


# --- Without a mail server ---------------------------------------------------------------------------------------------


def test_without_a_mail_server_mail_is_greyed_with_a_reason_and_cannot_be_chosen(postbox: type[Postbox]) -> None:
    _account, browser = person("robin")
    state = browser.get("/api/notify").json()
    mail = state["channels"][0]
    assert mail["kind"] == "mail" and mail["available"] is False and mail["state"] == "unavailable"
    assert mail["summary"] == "No mail server" and "mail server" in mail["hint"]
    assert state["routes"]["daily"] == []
    refused = browser.put("/api/notify/routes", json={"event": "daily", "channel": "mail", "on": True})
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "channel_unavailable"
    assert browser.put("/api/me/email", json={"address": "robin@example.test"}).json()["detail"]["code"] == "mail_off"
    mail_server()
    assert mail_channel(browser)["available"] is True and mail_channel(browser)["state"] == "setup"


def test_mail_needs_the_public_address_for_its_links(postbox: type[Postbox]) -> None:
    _account, browser = person("robin")
    mail_server(public="")
    assert mail_channel(browser)["can_send"] is False
    refused = browser.put("/api/me/email", json={"address": "robin@example.test"})
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "public_url_missing"
    assert postbox.sent == []


def test_mail_is_off_from_the_start_and_the_push_channels_carry_what_they_carried_before() -> None:
    mail_server()
    _account, browser = person("robin")
    state = browser.get("/api/notify").json()
    assert all("mail" not in chosen for chosen in state["routes"].values())
    assert state["reports"] == ["daily", "weekly"] and state["events"] == ["assigned", "due", "changed", "joined"]
    pushed = {"assigned": ["webpush", "app"], "due": ["webpush", "app"], "changed": ["webpush", "app"]}
    assert state["routes"] == {"daily": [], "weekly": [], "joined": [], **pushed}


# --- The address -------------------------------------------------------------------------------------------------------


def test_an_address_counts_only_once_its_link_was_opened(postbox: type[Postbox]) -> None:
    mail_server()
    _account, browser = person("robin")
    browser.put(f"{API}/me", json={"language": "de"})
    answer = browser.put("/api/me/email", json={"address": "robin@example.test"}).json()
    assert answer["sent"] is True
    [mail] = postbox.sent
    assert mail["To"] == "robin@example.test" and mail["Subject"] == "nextasks: Mailadresse bestätigen"
    assert f"{PUBLIC}/confirm-email/nxm_" in text_of(mail) and "cid:logo" in html_of(mail)
    waiting = mail_channel(browser)
    assert waiting["pending"] == "robin@example.test" and waiting["confirmed"] is False and waiting["ready"] is False
    refused = browser.put("/api/notify/routes", json={"event": "daily", "channel": "mail", "on": True})
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "channel_not_confirmed"

    token = re.search(r"/confirm-email/(\S+)", text_of(mail)).group(1)  # type: ignore[union-attr]
    stranger = TestClient(app, base_url="http://testserver", headers={"X-Nextasks-Client": "web"})
    assert stranger.post("/api/email/confirm", json={"token": token}).json() == {"email": "robin@example.test"}
    again = stranger.post("/api/email/confirm", json={"token": token})
    assert again.status_code == 404 and again.json()["detail"]["code"] == "email_link_invalid", "once"
    done = mail_channel(browser)
    assert done["address"] == "robin@example.test" and done["confirmed"] is True and done["ready"] is True
    assert done["pending"] == ""


def test_a_link_runs_out_and_a_made_up_one_does_nothing(postbox: type[Postbox]) -> None:
    mail_server()
    account, browser = person("robin")
    browser.put("/api/me/email", json={"address": "robin@example.test"})
    token = re.search(r"/confirm-email/(\S+)", text_of(postbox.sent[-1])).group(1)  # type: ignore[union-attr]
    with SessionLocal() as db:
        db.execute(update(Account).where(Account.id == account.id)
                   .values(email_pending_until=datetime.now(UTC) - timedelta(minutes=1)))
        db.commit()
    stranger = TestClient(app, base_url="http://testserver", headers={"X-Nextasks-Client": "web"})
    assert stranger.post("/api/email/confirm", json={"token": token}).status_code == 404
    assert stranger.post("/api/email/confirm", json={"token": "nxm_" + "a" * 43}).status_code == 404
    assert mail_channel(browser)["confirmed"] is False


def test_no_two_accounts_confirm_the_same_address(postbox: type[Postbox]) -> None:
    mail_server()
    _robin, robin = person("robin")
    _alex, alex = person("alex")
    confirmed(robin, postbox, "family@example.test")
    alex.put("/api/me/email", json={"address": "FAMILY@example.test"})
    token = re.search(r"/confirm-email/(\S+)", text_of(postbox.sent[-1])).group(1)  # type: ignore[union-attr]
    taken = alex.post("/api/email/confirm", json={"token": token})
    assert taken.status_code == 409 and taken.json()["detail"]["code"] == "email_taken"
    assert mail_channel(alex)["confirmed"] is False


def test_a_failing_mail_server_leaves_nothing_waiting(postbox: type[Postbox]) -> None:
    mail_server()
    _account, browser = person("robin")
    postbox.fail = True
    failed = browser.put("/api/me/email", json={"address": "robin@example.test"})
    assert failed.status_code == 502 and failed.json()["detail"]["code"] == "mail_failed"
    assert mail_channel(browser)["pending"] == ""
    with SessionLocal() as db:
        assert settings_service.get(db, "mail_last_error") == "mail_failed"


def test_confirmation_mails_are_braked(postbox: type[Postbox]) -> None:
    mail_server()
    _account, browser = person("robin")
    for number in range(emailaddr.SENDS_PER_HOUR):
        assert browser.put("/api/me/email", json={"address": f"r{number}@example.test"}).status_code == 200
    braked = browser.put("/api/me/email", json={"address": "late@example.test"})
    assert braked.status_code == 429


def test_the_providers_address_is_offered_but_never_mailed_unconfirmed(postbox: type[Postbox]) -> None:
    mail_server()
    account, browser = person("robin")
    with SessionLocal() as db:
        provider = OidcProvider(slug="pocket", label="Pocket ID", issuer="https://id.example.test", client_id="x")
        db.add(provider)
        db.flush()
        db.add(OidcLink(provider_id=provider.id, subject="sub-1", account_id=account.id,
                        issuer="https://id.example.test", email="robin@example.test"))
        # An account through a provider has the provider's address, not confirmed.
        db.execute(update(Account).where(Account.id == account.id).values(email="robin@example.test"))
        db.add(NotifyRoute(account_id=account.id, event="assigned", channel="mail"))
        db.commit()
    state = mail_channel(browser)
    assert state["suggestion"] == "robin@example.test" and state["confirmed"] is False and state["ready"] is False
    with SessionLocal() as db:
        row = db.get(Account, account.id)
        assert row is not None
        made = notifyprefs.dispatch(db, row, "assigned", "x", lambda *_: channels.Message("t", "x"))
    assert made == 0, "an unconfirmed address gets nothing"
    confirmed(browser, postbox, "robin@example.test")
    assert mail_channel(browser)["suggestion"] == ""


# --- Channels and the outbox ---------------------------------------------------------------------------------------------


class Recorder(channels.Channel):
    kind = "test"

    def __init__(self) -> None:
        self.got: list[tuple[str, channels.Message]] = []
        self.down = False

    def available(self, db: Any) -> bool:
        return True

    def target(self, db: Any, account: Account) -> channels.Target | None:
        return channels.Target(self.kind, f"hook-{account.id}", True)

    def deliver(self, db: Any, target: channels.Target, message: channels.Message) -> None:
        if self.down:
            raise channels.DeliveryError("hook_down")
        self.got.append((target.address, message))


@pytest.fixture
def recorder(monkeypatch: pytest.MonkeyPatch) -> Recorder:
    channel = Recorder()
    monkeypatch.setitem(channels.CHANNELS, "test", channel)
    return channel


def test_a_new_channel_takes_the_same_message_through_the_outbox(recorder: Recorder) -> None:
    mail_server()
    anna_account, anna = person("anna")
    ben_account, ben = person("ben")
    space = shared_space(anna, ben)
    list_id = make_list(anna, space)
    turn_on(ben, "assigned", "test")
    reminder = make_reminder(anna, list_id, "Take the bins out")
    put(anna, "reminder", reminder, {"assignees": [ben_account.id]})
    assert outbox.send_round() == 1
    [(address, message)] = recorder.got
    assert address == f"hook-{ben_account.id}"
    assert message.title == "anna assigned a task to you" and "Take the bins out" in message.text
    assert message.link == f"{PUBLIC}/lists/{list_id}?reminder={reminder}"
    assert message.unsubscribe.startswith(f"{PUBLIC}/api/notify/unsubscribe/")
    assert outbox.send_round() == 0, "once"
    _ = anna_account


def test_a_failure_is_tried_again_later_then_given_up_and_shown(recorder: Recorder) -> None:
    mail_server()
    account, browser = person("robin")
    turn_on(browser, "joined", "test")
    recorder.down = True
    with SessionLocal() as db:
        row = db.get(Account, account.id)
        assert row is not None
        assert notifyprefs.dispatch(db, row, "joined", "k", lambda *_: channels.Message("Hello", "text")) == 1
        db.commit()
    start = datetime.now(UTC)
    assert outbox.send_round(start) == 0
    assert outbox.send_round(start + timedelta(seconds=30)) == 0
    with SessionLocal() as db:
        [queued] = db.scalars(select(NotifyOutbox)).all()
        assert queued.attempts == 1, "not before its minute is up"
    moment = start
    for minutes in outbox.RETRY_MINUTES:
        moment += timedelta(minutes=minutes, seconds=1)
        outbox.send_round(moment)
    with SessionLocal() as db:
        [queued] = db.scalars(select(NotifyOutbox)).all()
        assert queued.failed_at is not None and queued.attempts == len(outbox.RETRY_MINUTES) + 1
    shown = next(entry for entry in browser.get("/api/notify").json()["channels"] if entry["kind"] == "test")
    assert shown["last_error"] == "hook_down" and shown["last_error_at"]
    recorder.down = False
    assert outbox.send_round(moment + timedelta(hours=5)) == 0, "given up stays given up"


def test_a_queued_message_waits_for_a_confirmed_address(postbox: type[Postbox]) -> None:
    mail_server()
    account, browser = person("robin")
    confirmed(browser, postbox, "robin@example.test")
    turn_on(browser, "joined")
    with SessionLocal() as db:
        row = db.get(Account, account.id)
        assert row is not None
        notifyprefs.dispatch(db, row, "joined", "k", lambda *_: channels.Message("Hello", "text"))
        db.commit()
    browser.delete("/api/me/email")
    before = len(postbox.sent)
    assert outbox.send_round() == 0
    assert len(postbox.sent) == before, "removed address: nothing goes out"


# --- Reports -----------------------------------------------------------------------------------------------------------

# Saturday 7 November 2026, 07:00 in Berlin.
MORNING = datetime(2026, 11, 7, 6, 0, tzinfo=UTC)


def _ready(name: str, box: type[Postbox], *, language: str = "de") -> tuple[Account, TestClient]:
    account, browser = person(name)
    browser.put(f"{API}/me", json={"timezone": "Europe/Berlin", "language": language})
    confirmed(browser, box, f"{name}@example.test")
    return account, browser


def test_my_day_with_tasks_goes_out_once_with_its_parts(postbox: type[Postbox]) -> None:
    mail_server()
    robin_account, robin = _ready("robin", postbox)
    alex_account, alex = person("alex")
    _space, private_list = private_space(robin)
    make_reminder(robin, private_list, "Pay the rent", due_date="2026-11-05")
    make_reminder(robin, private_list, "Water the plants", due_date="2026-11-07", due_time="18:00")
    make_reminder(robin, private_list, "Next week", due_date="2026-11-12")
    family = shared_space(alex, robin)
    shared = make_list(alex, family, "Home")
    make_reminder(alex, shared, "Only alex's", due_date="2026-11-07")
    given = make_reminder(alex, shared, "Bring the parcel")
    put(alex, "reminder", given, {"assignees": [robin_account.id]})
    turn_on(robin, "daily")
    robin.put("/api/notify/schedules/daily", json={"time": "07:00"})
    before = len(postbox.sent)

    assert reports.report_round(MORNING - timedelta(minutes=1)) == 0, "not yet"
    assert reports.report_round(MORNING) == 1
    assert outbox.send_round() == 1
    [mail] = postbox.sent[before:]
    assert mail["To"] == "robin@example.test" and mail["Subject"] == "Mein Tag: 3 Aufgaben"
    text = text_of(mail)
    assert "Überfällig:" in text and "Pay the rent" in text
    assert "Heute fällig:" in text and "Water the plants" in text and "18:00" in text
    assert "Dir neu zugewiesen:" in text and "Bring the parcel" in text and "alex" in text
    assert "Next week" not in text and "Only alex's" not in text
    html = html_of(mail)
    assert "Pay the rent" in html and f'href="{PUBLIC}/account?tab=notifications"' in html
    assert "Benachrichtigungen ändern" in html and "cid:logo" in html
    assert any(part.get_content_type() == "image/png" for part in mail.walk())
    assert reports.report_round(MORNING + timedelta(hours=1)) == 0, "one a day"
    _ = alex_account


def test_a_task_newly_assigned_and_due_today_shows_once(postbox: type[Postbox]) -> None:
    mail_server()
    robin_account, robin = _ready("robin", postbox)
    _alex_account, alex = person("alex")
    family = shared_space(alex, robin)
    shared = make_list(alex, family, "Home")
    given = make_reminder(alex, shared, "Bring the parcel", due_date="2026-11-07")
    put(alex, "reminder", given, {"assignees": [robin_account.id]})
    turn_on(robin, "daily")
    assert reports.report_round(MORNING) == 1
    outbox.send_round()
    text = text_of(postbox.sent[-1])
    assert postbox.sent[-1]["Subject"] == "Mein Tag: 1 Aufgabe"
    assert text.count("Bring the parcel") == 1 and "neu von alex" in text
    assert "Dir neu zugewiesen:" not in text


def test_an_empty_day_sends_no_mail(postbox: type[Postbox]) -> None:
    mail_server()
    _account, robin = _ready("robin", postbox)
    turn_on(robin, "daily")
    before = len(postbox.sent)
    assert reports.report_round(MORNING) == 0
    assert outbox.send_round() == 0
    assert len(postbox.sent) == before
    with SessionLocal() as db:
        assert db.scalars(select(NotifyOutbox)).all() == []


def test_an_empty_day_stays_done_when_something_comes_later(postbox: type[Postbox]) -> None:
    mail_server()
    _account, robin = _ready("robin", postbox)
    turn_on(robin, "daily")
    assert reports.report_round(MORNING) == 0, "nothing at seven"
    _space, private_list = private_space(robin)
    make_reminder(robin, private_list, "Pay the rent", due_date="2026-11-07")
    assert reports.report_round(MORNING + timedelta(minutes=30)) == 0, "the day had its report (an empty one)"
    assert reports.report_round(MORNING + timedelta(days=1)) == 1, "the next day it comes"


def test_the_log_never_shows_the_links_of_a_mail() -> None:
    line = "GET /confirm-email/nxm_abcdefghijklmnopqrstuvwxyz0123 and /api/notify/unsubscribe/MTI6ZGFpbHk6bWFpbA0123456789"
    shown = logs.redact(line)
    assert "nxm_abcdefghijklmnop" not in shown and "MTI6ZGFpbHk6bWFpbA0123456789" not in shown


def test_no_report_twice_after_a_restart(postbox: type[Postbox]) -> None:
    mail_server()
    account, robin = _ready("robin", postbox)
    _space, private_list = private_space(robin)
    make_reminder(robin, private_list, "Pay the rent", due_date="2026-11-05")
    turn_on(robin, "daily")
    assert reports.report_round(MORNING) == 1
    assert outbox.send_round() == 1
    # As after a restart: the next round finds the day made already.
    assert reports.report_round(MORNING + timedelta(seconds=30)) == 0
    # Even when the note of the day got lost, the outbox knows the day's report and queues it no second time.
    with SessionLocal() as db:
        db.execute(update(NotifySchedule).where(NotifySchedule.account_id == account.id).values(last_period=""))
        db.commit()
    assert reports.report_round(MORNING + timedelta(minutes=2)) == 0
    assert outbox.send_round() == 0
    sent = [mail for mail in postbox.sent if mail["Subject"].startswith("Mein Tag")]
    assert len(sent) == 1


def test_a_report_follows_the_persons_time_zone_and_skips_a_long_gone_moment(postbox: type[Postbox]) -> None:
    mail_server()
    _account, robin = _ready("robin", postbox)
    _space, private_list = private_space(robin)
    make_reminder(robin, private_list, "Pay the rent", due_date="2026-11-05")
    turn_on(robin, "daily")
    robin.put(f"{API}/me", json={"timezone": "America/New_York"})
    assert reports.report_round(MORNING) == 0, "07:00 in Berlin is 01:00 in New York"
    assert reports.report_round(datetime(2026, 11, 7, 12, 0, tzinfo=UTC)) == 1, "07:00 in New York"
    robin.put(f"{API}/me", json={"timezone": "Europe/Berlin"})
    assert reports.report_round(datetime(2026, 11, 8, 14, 0, tzinfo=UTC)) == 0, "15:00: more than six hours late"


def test_the_week_names_what_others_did_in_shared_spaces(postbox: type[Postbox]) -> None:
    mail_server()
    _robin_account, robin = _ready("robin", postbox, language="en")
    _alex_account, alex = person("alex")
    family = shared_space(alex, robin)
    shared = make_list(alex, family, "Home")
    done = make_reminder(alex, shared, "Fix the bike")
    batch(alex, {"type": "complete", "id": done, "occurrence": None, "at": "2026-11-05T10:00:00.000Z",
                 "on": "2026-11-05"})
    old = make_reminder(alex, shared, "Long ago")
    batch(alex, {"type": "complete", "id": old, "occurrence": None, "at": "2026-10-20T10:00:00.000Z",
                 "on": "2026-10-20"})
    _alex_private, alex_list = private_space(alex)
    secret = make_reminder(alex, alex_list, "Alex's own")
    batch(alex, {"type": "complete", "id": secret, "occurrence": None, "at": "2026-11-05T10:00:00.000Z",
                 "on": "2026-11-05"})
    make_reminder(alex, shared, "Dentist", due_date="2026-11-10", due_time="09:00")
    make_reminder(alex, shared, "Far away", due_date="2026-11-30")
    turn_on(robin, "weekly")
    robin.put("/api/notify/schedules/weekly", json={"time": "18:00", "weekday": 6})
    sunday = datetime(2026, 11, 8, 17, 0, tzinfo=UTC)
    assert reports.report_round(sunday - timedelta(days=1)) == 0, "Saturday is not the day"
    assert reports.report_round(sunday) == 1
    outbox.send_round()
    mail = postbox.sent[-1]
    assert mail["Subject"] == "Your week in nextasks"
    text = text_of(mail)
    assert "Fix the bike" in text and "done by alex" in text and "Dentist" in text
    assert "Long ago" not in text and "Alex's own" not in text and "Far away" not in text


# --- Single events ---------------------------------------------------------------------------------------------------------


def test_assigned_and_joined_go_out_by_mail_when_chosen(postbox: type[Postbox]) -> None:
    mail_server()
    alex_account, alex = _ready("alex", postbox, language="en")
    robin_account, robin = _ready("robin", postbox, language="en")
    turn_on(alex, "joined")
    turn_on(robin, "assigned")
    family = shared_space(alex, robin)
    outbox.send_round()
    joined = postbox.sent[-1]
    assert joined["To"] == "alex@example.test" and joined["Subject"] == "robin is in “Family” now"
    shared = make_list(alex, family, "Home")
    task = make_reminder(alex, shared, "Bring the parcel")
    put(alex, "reminder", task, {"assignees": [robin_account.id]})
    outbox.send_round()
    assigned = postbox.sent[-1]
    assert assigned["To"] == "robin@example.test" and assigned["Subject"] == "alex assigned a task to you"
    assert assigned["List-Unsubscribe-Post"] == "List-Unsubscribe=One-Click"
    _ = alex_account


# --- Unsubscribing -----------------------------------------------------------------------------------------------------


def test_one_click_unsubscribes_exactly_this_report(postbox: type[Postbox]) -> None:
    mail_server()
    account, robin = _ready("robin", postbox)
    _space, private_list = private_space(robin)
    make_reminder(robin, private_list, "Pay the rent", due_date="2026-11-05")
    turn_on(robin, "daily")
    turn_on(robin, "weekly")
    reports.report_round(MORNING)
    outbox.send_round()
    mail = postbox.sent[-1]
    header = mail["List-Unsubscribe"]
    assert header.startswith(f"<{PUBLIC}/api/notify/unsubscribe/") and header.endswith(">")
    path = urlsplit(header[1:-1]).path
    assert f"{PUBLIC}/unsubscribe/" in text_of(mail), "the link in the text asks first"
    # A mail program: no session, no tab header, the body of RFC 8058.
    program = TestClient(app, base_url="http://testserver")
    assert program.get(path).json() == {"event": "daily", "channel": "mail", "on": True}
    answer = program.post(path, content=b"List-Unsubscribe=One-Click",
                          headers={"Content-Type": "application/x-www-form-urlencoded"})
    assert answer.status_code == 200, answer.text
    routes = robin.get("/api/notify").json()["routes"]
    assert routes["daily"] == [] and routes["weekly"] == ["mail"], "only this report"
    token = path.rsplit("/", 1)[1]
    assert notifyprefs.read_token(token) == (account.id, "daily", "mail")


def test_a_changed_unsubscribe_link_does_nothing() -> None:
    mail_server()
    robin_account, _robin = person("robin")
    alex_account, alex = person("alex")
    with SessionLocal() as db:
        db.add(NotifyRoute(account_id=alex_account.id, event="daily", channel="mail"))
        db.commit()
    own = notifyprefs.unsubscribe_token(robin_account.id, "daily", "mail")
    # The same mark with another account's id in front.
    forged = notifyprefs.unsubscribe_token(alex_account.id, "daily", "mail")[:-32] + own[-32:]
    program = TestClient(app, base_url="http://testserver")
    refused = program.post(f"/api/notify/unsubscribe/{forged}")
    assert refused.status_code == 404 and refused.json()["detail"]["code"] == "unsubscribe_invalid"
    assert program.post(f"/api/notify/unsubscribe/{own[:-1]}x").status_code == 404
    assert alex.get("/api/notify").json()["routes"]["daily"] == ["mail"]


# --- Rights ------------------------------------------------------------------------------------------------------------


def test_nobody_sees_or_changes_the_notifications_of_another(postbox: type[Postbox]) -> None:
    mail_server()
    _robin_account, robin = _ready("robin", postbox)
    alex_account, alex = person("alex")
    turn_on(robin, "daily")
    robin.put("/api/notify/schedules/daily", json={"time": "06:30"})
    seen = alex.get("/api/notify").json()
    assert seen["routes"]["daily"] == [] and seen["schedules"]["daily"]["time"] == "07:00"
    assert mail_channel(alex)["address"] == "" and "robin@example.test" not in str(seen)
    # Every change acts on the caller: alex turning "daily" off leaves robin's on.
    alex.put("/api/notify/routes", json={"event": "daily", "channel": "mail", "on": False})
    alex.delete("/api/me/email")
    mine = robin.get("/api/notify").json()
    assert mine["routes"]["daily"] == ["mail"] and mine["schedules"]["daily"]["time"] == "06:30"
    assert mail_channel(robin)["confirmed"] is True
    nobody = TestClient(app, base_url="http://testserver", headers={"X-Nextasks-Client": "web"})
    assert nobody.get("/api/notify").status_code == 401
    assert nobody.put("/api/notify/routes", json={"event": "daily", "channel": "mail", "on": False}).status_code == 401
    _ = alex_account


def test_bad_choices_are_refused(postbox: type[Postbox]) -> None:
    mail_server()
    _account, robin = _ready("robin", postbox)
    assert robin.put("/api/notify/routes", json={"event": "everything", "channel": "mail", "on": True}).status_code \
        == 422
    assert robin.put("/api/notify/routes", json={"event": "daily", "channel": "pigeon", "on": True}).status_code == 422
    assert robin.put("/api/notify/schedules/daily", json={"time": "25:00"}).status_code == 422
    assert robin.put("/api/notify/schedules/weekly", json={"time": "07:00", "weekday": 7}).status_code == 422
    assert robin.put("/api/notify/schedules/monthly", json={"time": "07:00"}).status_code == 422


# --- Invitations into a space by mail ----------------------------------------------------------------------------------


def test_a_manager_mails_an_invitation_into_a_space(postbox: type[Postbox]) -> None:
    mail_server()
    _alex_account, alex = person("alex")
    _robin_account, robin = person("robin")
    family = shared_space(alex, robin)
    answer = alex.post(f"/api/spaces/{family}/invites", json={"email": "sam@example.test", "language": "de"})
    assert answer.status_code == 201, answer.text
    made = answer.json()
    assert made["sent"] is True and made["link"].startswith(f"{PUBLIC}/invite/")
    mail = postbox.sent[-1]
    assert mail["To"] == "sam@example.test" and mail["Subject"] == "alex lädt dich zu nextasks ein"
    assert "„Family“" in text_of(mail) and made["link"] in text_of(mail)
    assert "List-Unsubscribe" not in mail
    member = robin.post(f"/api/spaces/{family}/invites", json={"email": "sam@example.test"})
    assert member.status_code == 403, "members do not invite"
    private, _first = private_space(alex)
    assert alex.post(f"/api/spaces/{private}/invites", json={"email": "sam@example.test"}).status_code == 403
    _x, outsider = person("toni")
    assert outsider.post(f"/api/spaces/{family}/invites", json={"email": "sam@example.test"}).status_code == 404


def test_a_space_invitation_by_mail_needs_a_mail_server_and_is_withdrawn_when_it_fails(
    postbox: type[Postbox],
) -> None:
    _alex_account, alex = person("alex")
    family = shared_space(alex)
    off = alex.post(f"/api/spaces/{family}/invites", json={"email": "sam@example.test"})
    assert off.status_code == 409 and off.json()["detail"]["code"] == "mail_off"
    mail_server()
    postbox.fail = True
    failed = alex.post(f"/api/spaces/{family}/invites", json={"email": "sam@example.test"})
    assert failed.status_code == 502
    assert alex.get(f"{API}/spaces/{family}/invites").json() == [], "a link nobody got is withdrawn"


def test_the_operator_sees_the_last_mail_and_the_last_failure(client: TestClient, operator: Account,
                                                              postbox: type[Postbox]) -> None:
    mail_server()
    assert client.post("/api/settings/mail-test", json={"to": "robin@example.test"}).status_code == 204
    shown = client.get("/api/settings").json()
    assert shown["mail_last_ok_at"] and shown["mail_last_error"] == ""
    postbox.fail = True
    client.post("/api/settings/mail-test", json={"to": "robin@example.test"})
    shown = client.get("/api/settings").json()
    assert shown["mail_last_error"] == "mail_failed" and shown["mail_last_error_at"]
