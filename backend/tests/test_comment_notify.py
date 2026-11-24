"""Notifications of comments (``services/notify.py``): to assignees and the maker of the task, never to the writer;
who is named with ``@`` hears of it as ``mention`` instead and at once; further comments on the same task within ten
minutes come in one notification at their end. Both events are on for the app and the browsers from the start."""

from __future__ import annotations

from datetime import timedelta

from app.db import SessionLocal
from app.models import Account
from app.services import clock, notify, notifyprefs

from .sync_helpers import make_list, make_reminder, new_id, now_ms, person, put, shared_space
from .test_notify import Relay, phone_of, relay  # noqa: F401


def comment(client, task: str, text: str, mentions: list[int] | None = None) -> str:  # type: ignore[no-untyped-def]
    comment_id = new_id()
    result = put(client, "comment", comment_id, {"reminder_id": task, "text": text, "mentions": mentions or []},
                 {"text": now_ms()})
    assert result["ok"], result
    return comment_id


def test_comments_and_mentions_are_on_for_the_push_channels_from_the_start() -> None:
    anna_account, _anna = person("anna")
    with SessionLocal() as db:
        routes = notifyprefs.routes_of(db, anna_account.id)
    assert routes["comment"] == ["webpush", "app"] and routes["mention"] == ["webpush", "app"]


def test_the_maker_and_assignees_hear_of_a_comment_a_mention_once_and_the_writer_never(relay: Relay) -> None:  # noqa: F811
    anna_account, anna = person("anna")
    ben_account, ben = person("ben")
    carl_account, carl = person("carl")
    space = shared_space(anna, ben, carl)
    task = make_reminder(anna, make_list(anna, space), title="Bins", assignees=[ben_account.id])
    phone_of(anna)
    phone_of(ben)
    phone_of(carl)
    relay.sent.clear()
    comment(ben, task, "Done tomorrow", [carl_account.id])
    told = relay.messages()
    assert len(told) == 2
    by_type = {message["type"]: message for message in told}
    assert by_type["comment"]["text"] == "ben: Done tomorrow" and by_type["comment"]["reminder_id"] == task
    assert by_type["mention"]["text"] == "ben mentioned you: Done tomorrow" and by_type["mention"]["title"] == "Bins"
    tickets = sorted(body["ticket"] for body in relay.sent)
    assert len(set(tickets)) == 2, "Anna (maker) and Carl (mentioned), never Ben who wrote"
    assert anna_account.id != carl_account.id


def test_more_comments_within_ten_minutes_come_together_at_their_end(relay: Relay) -> None:  # noqa: F811
    _anna_account, anna = person("anna")
    _ben_account, ben = person("ben")
    space = shared_space(anna, ben)
    task = make_reminder(anna, make_list(anna, space), title="Bins")
    phone_of(anna)
    relay.sent.clear()
    comment(ben, task, "One")
    comment(ben, task, "Two")
    comment(ben, task, "Three")
    assert [message["text"] for message in relay.messages()] == ["ben: One"]
    assert notify.comment_round() == 0, "the ten minutes are not over"
    assert notify.comment_round(clock.now() + timedelta(minutes=11)) == 1
    assert [message["text"] for message in relay.messages()][1:] == ["2 new comments from ben"]
    assert notify.comment_round(clock.now() + timedelta(minutes=30)) == 0


def test_a_mail_tells_the_comment_in_both_languages() -> None:
    from app.services import messages

    item = messages.Item(title="Bins", list_name="Home", link="https://t.example/lists/x?reminder=y", due_date=None,
                         due_time=None)
    german = messages.comment("de", base="https://t.example", by="Ben", item=item, text="Morgen", mention=False,
                              count=1, unsubscribe="https://t.example/u")
    english = messages.comment("en", base="https://t.example", by="Ben", item=item, text="", mention=True, count=1,
                               unsubscribe="https://t.example/u")
    assert german.title == "Ben hat „Bins“ kommentiert" and "„Morgen“" in german.text
    assert english.title == "Ben mentioned you in “Bins”" and "Ben sent a picture." in english.text
    many = messages.comment("de", base="https://t.example", by="", item=item, text="3 neue Kommentare von Ben",
                            mention=False, count=3, unsubscribe="https://t.example/u")
    assert many.title == "3 neue Kommentare zu „Bins“"
    with SessionLocal() as db:
        assert db.query(Account).count() == 0
