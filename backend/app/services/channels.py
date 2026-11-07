"""Channels: the ways a finished message reaches one person.

A channel has a kind (``mail``, ``webpush``, ``app``), a target per account with its state of confirmation, and it
delivers a ``Message`` (title, text, link, optionally HTML). What a person gets on which channel is not the channel's
business: that is ``services/notifyprefs.py`` (event or report × channel per person), and the way there with retries
is ``services/outbox.py``.

The channels today:

* ``mail``: to the account's confirmed address, through the operator's mail server; off from the start.
* ``webpush`` ("Browser"): to every browser the person signed up for notifications (``services/webpush.py``).
* ``app`` ("iPhone/iPad"): through the relay to every paired device that handed a ticket over (``services/push.py``).
  The app has no choices of its own; the server decides what goes there, and ``/api/app/1`` is unchanged.

Both push channels are on from the start for exactly what went to them before there were choices (``due``,
``assigned``, ``changed``): somebody who never opens the page gets what he got before.

A new channel (ntfy, Gotify, a webhook, Telegram, Discord) is a subclass of ``Channel`` in ``CHANNELS``:

* ``names``, ``icon``: its column on the page "Notifications" (``icon`` names a Lucide symbol, the web knows a few and
  takes a bell for the rest);
* ``available``: the operator set it up (or, for a channel that needs nothing from the operator, always);
* ``target``: where it goes for this account and whether that is confirmed. Its settings live in
  ``NotifyChannel.config`` (secrets sealed with ``security.encrypt_secret``), its confirmation in ``confirmed_at``,
  e.g. after a test message with a code;
* ``status``: what the head of its column says: ready, or what is missing, in the account's language;
* ``deliver``: sends one message or raises ``DeliveryError`` with a short code (never the far side's answer, which can
  quote addresses or keys);
* ``defaults``: the reports and events that are on until the person turns them off (most channels: none);
* ``short``: takes the short form (title and one line, a path as link, ``data`` for the device) and is tried at once,
  in the moment of the event, before it goes through the outbox for a retry.

The rest (choices, reports, outbox, unsubscribing, the page "Notifications") takes every channel in ``CHANNELS``; the
page draws one column per channel from what the server sends.
"""

from __future__ import annotations

import json
from abc import ABC, abstractmethod
from dataclasses import asdict, dataclass, field
from typing import Any, ClassVar

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import Account, AppDevice, WebPushSubscription


@dataclass(frozen=True)
class Message:
    """A finished message, the same for every channel: one that knows only text takes ``title``, ``text`` and
    ``link``; mail also takes ``html``, the push channels ``data``."""

    title: str
    text: str
    link: str = ""
    html: str | None = None
    #: The address that unsubscribes exactly this report or event at one click ("" for none).
    unsubscribe: str = ""
    #: ``de`` or ``en``: the language the message is written in.
    language: str = "en"
    #: Images the HTML shows by ``cid:`` (name → file name in ``app/static``).
    inline: dict[str, str] = field(default_factory=dict)
    #: For the push channels: ``type`` (``due``, ``assigned``, ``changed``, ``daily`` …), ``reminder_id``, ``list_id``,
    #: ``collapse`` (a second message with the same one replaces the first).
    data: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Message:
        known = {name: data[name] for name in cls.__dataclass_fields__ if name in data}
        return cls(**known)


@dataclass(frozen=True)
class Target:
    """Where a channel delivers for one account: an address it shows (``robin@example.test``, ``2``) and whether its
    owner confirmed it."""

    kind: str
    address: str
    confirmed: bool
    account_id: int = 0


@dataclass(frozen=True)
class Status:
    """The head of a channel's column: ``ready``, ``setup`` (the person has something to do) or ``unavailable`` (the
    operator has), a few words and a hint, optionally a link inside the web (``/account?tab=connections``)."""

    state: str
    summary: str
    hint: str = ""
    link: str = ""
    link_label: str = ""


class DeliveryError(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _say(texts: dict[str, dict[str, str]], language: str, key: str, **values: Any) -> str:
    return texts.get(language, texts["en"])[key].format(**values)


GENERIC_TEXTS = {
    "de": {"off": "Nicht eingerichtet", "setup": "Noch nicht bestätigt"},
    "en": {"off": "Not set up", "setup": "Not confirmed yet"},
}


class Channel(ABC):
    kind: ClassVar[str]
    #: Its name per language; without one, the kind.
    names: ClassVar[dict[str, str]] = {}
    icon: ClassVar[str] = "bell"
    #: On until the person turns them off.
    defaults: ClassVar[frozenset[str]] = frozenset()
    short: ClassVar[bool] = False
    #: Minutes to wait after the 1st, 2nd, … failure; after the last one the message is given up.
    retry_minutes: ClassVar[tuple[int, ...]] = (1, 5, 15, 60, 180)

    def name(self, language: str) -> str:
        return self.names.get(language) or self.names.get("en") or self.kind

    @abstractmethod
    def available(self, db: Session) -> bool:
        """The operator set the channel up; without that it cannot be chosen (the page shows why)."""

    @abstractmethod
    def target(self, db: Session, account: Account) -> Target | None:
        """Where it goes for this account, or None when the account has nothing there."""

    def status(self, db: Session, account: Account, language: str) -> Status:
        """What the head of the channel's column says; a channel with more to tell says it itself."""
        if not self.available(db):
            return Status("unavailable", _say(GENERIC_TEXTS, language, "off"))
        target = self.target(db, account)
        if target is None or not target.confirmed:
            return Status("setup", _say(GENERIC_TEXTS, language, "setup"))
        return Status("ready", target.address)

    @abstractmethod
    def deliver(self, db: Session, target: Target, message: Message) -> None:
        """Delivers or raises ``DeliveryError``."""


MAIL_TEXTS = {
    "de": {"off": "Kein Mailserver", "off_hint": "Mail gibt es erst, wenn der Betreiber einen Mailserver einrichtet.",
           "setup": "Erst Adresse bestätigen", "setup_hint": "Trag unten deine Mailadresse ein und öffne den Link.",
           "ready_hint": "bestätigt"},
    "en": {"off": "No mail server", "off_hint": "Mail comes once the operator sets up a mail server.",
           "setup": "Confirm an address first", "setup_hint": "Enter your mail address below and open the link.",
           "ready_hint": "confirmed"},
}


class MailChannel(Channel):
    """Mail through the operator's SMTP server, to the account's confirmed address."""

    kind = "mail"
    names: ClassVar[dict[str, str]] = {"de": "Mail", "en": "Mail"}
    icon = "mail"

    def available(self, db: Session) -> bool:
        from . import mailer

        return mailer.configured(db)

    def target(self, db: Session, account: Account) -> Target | None:
        from . import emailaddr

        if not account.email:
            return None
        return Target(self.kind, account.email, emailaddr.confirmed(account), account.id)

    def status(self, db: Session, account: Account, language: str) -> Status:
        if not self.available(db):
            return Status("unavailable", _say(MAIL_TEXTS, language, "off"), _say(MAIL_TEXTS, language, "off_hint"))
        target = self.target(db, account)
        if target is None or not target.confirmed:
            return Status("setup", _say(MAIL_TEXTS, language, "setup"), _say(MAIL_TEXTS, language, "setup_hint"))
        return Status("ready", target.address, _say(MAIL_TEXTS, language, "ready_hint"))

    def deliver(self, db: Session, target: Target, message: Message) -> None:
        from . import mailer, settings_service

        if not settings_service.public_url(db):
            # Every message carries links; never one to an address a request made up.
            raise DeliveryError("public_url_missing")
        try:
            mailer.send_message(db, target.address, message)
        except mailer.MailError as exc:
            raise DeliveryError(exc.code) from exc


#: What went to the browsers and the app before there were choices; on from the start there.
PUSH_DEFAULTS = frozenset({"due", "assigned", "changed"})
#: A push that could not go out is worth little hours later: three tries, then it is given up.
PUSH_RETRIES = (1, 5, 15)

WEBPUSH_TEXTS = {
    "de": {"setup": "Kein Browser", "setup_hint": "Schalte Mitteilungen in einem Browser ein.",
           "one": "1 Browser", "many": "{n} Browser"},
    "en": {"setup": "No browser", "setup_hint": "Turn notifications on in a browser.",
           "one": "1 browser", "many": "{n} browsers"},
}


class WebPushChannel(Channel):
    """Web push to every browser of the person (``services/webpush.py``). A browser whose push service forgot it is
    removed on the way."""

    kind = "webpush"
    names: ClassVar[dict[str, str]] = {"de": "Browser", "en": "Browser"}
    icon = "globe"
    defaults = PUSH_DEFAULTS
    short = True
    retry_minutes = PUSH_RETRIES

    def available(self, db: Session) -> bool:
        # Needs nothing from the operator: the key pair is made at the start, or at its first need.
        return True

    def _count(self, db: Session, account_id: int) -> int:
        return int(db.scalar(select(func.count()).select_from(WebPushSubscription)
                             .where(WebPushSubscription.account_id == account_id)) or 0)

    def target(self, db: Session, account: Account) -> Target | None:
        count = self._count(db, account.id)
        return Target(self.kind, str(count), True, account.id) if count else None

    def status(self, db: Session, account: Account, language: str) -> Status:
        count = self._count(db, account.id)
        if not count:
            return Status("setup", _say(WEBPUSH_TEXTS, language, "setup"),
                          _say(WEBPUSH_TEXTS, language, "setup_hint"))
        return Status("ready", _say(WEBPUSH_TEXTS, language, "one" if count == 1 else "many", n=count))

    def deliver(self, db: Session, target: Target, message: Message) -> None:
        from . import push, webpush

        data = message.data
        body: dict[str, Any] = {"title": message.title[:push.TITLE_MAX], "text": message.text[:push.TEXT_MAX],
                                "reminder_id": data.get("reminder_id"), "list_id": data.get("list_id"),
                                "type": data.get("type", "")}
        if message.link.startswith("/") and not message.link.startswith("//"):
            # Where a click leads, inside the own origin (the service worker takes nothing else).
            body["url"] = message.link
        plaintext = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        taken, failed = webpush.send_all(db, target.account_id, plaintext, topic=str(data.get("type", "")))
        if not taken:
            raise DeliveryError("push_failed" if failed else "no_browser")


APP_TEXTS = {
    "de": {"off": "Nicht eingerichtet", "off_hint": "Der Betreiber hat keine Weiterleitung für Push eingerichtet.",
           "setup": "Kein Gerät", "setup_hint": "Kopple die App unter Verbindungen.", "link": "App koppeln",
           "one": "1 Gerät gekoppelt", "many": "{n} Geräte gekoppelt"},
    "en": {"off": "Not set up", "off_hint": "The operator has not set up a relay for push.",
           "setup": "No device", "setup_hint": "Pair the app under Connections.", "link": "Pair the app",
           "one": "1 device paired", "many": "{n} devices paired"},
}


class AppPushChannel(Channel):
    """Push to the iPhone and iPad app through the relay (``services/push.py``), to every paired device with a
    ticket; the message as the contract has it (``{"title", "text", "reminder_id", "list_id", "type"}``)."""

    kind = "app"
    names: ClassVar[dict[str, str]] = {"de": "iPhone/iPad", "en": "iPhone/iPad"}
    icon = "smartphone"
    defaults = PUSH_DEFAULTS
    short = True
    retry_minutes = PUSH_RETRIES

    def available(self, db: Session) -> bool:
        from . import push

        return bool(push.relay_url())

    def target(self, db: Session, account: Account) -> Target | None:
        from . import push

        count = len(push.targets(db, account.id))
        return Target(self.kind, str(count), True, account.id) if count else None

    def status(self, db: Session, account: Account, language: str) -> Status:
        if not self.available(db):
            return Status("unavailable", _say(APP_TEXTS, language, "off"), _say(APP_TEXTS, language, "off_hint"))
        paired = int(db.scalar(select(func.count()).select_from(AppDevice)
                               .where(AppDevice.account_id == account.id, AppDevice.push_ticket != "")) or 0)
        if not paired:
            return Status("setup", _say(APP_TEXTS, language, "setup"), _say(APP_TEXTS, language, "setup_hint"),
                          link="/account?tab=connections", link_label=_say(APP_TEXTS, language, "link"))
        return Status("ready", _say(APP_TEXTS, language, "one" if paired == 1 else "many", n=paired))

    def deliver(self, db: Session, target: Target, message: Message) -> None:
        from . import push

        data = message.data
        taken, failed = push.send_all(db, target.account_id, push.Message(
            title=message.title, text=message.text, reminder_id=data.get("reminder_id"), list_id=data.get("list_id"),
            type=str(data.get("type", "")), collapse=str(data.get("collapse", ""))))
        if not taken:
            raise DeliveryError("push_failed" if failed else "no_device")


CHANNELS: dict[str, Channel] = {channel.kind: channel for channel in (MailChannel(), WebPushChannel(),
                                                                      AppPushChannel())}


def ready(db: Session, account: Account, kind: str) -> Target | None:
    """The account's target at this channel when the channel is set up and the target confirmed; else None."""
    channel = CHANNELS.get(kind)
    if channel is None or not channel.available(db):
        return None
    target = channel.target(db, account)
    return target if target is not None and target.confirmed else None


def available_kinds(db: Session) -> list[str]:
    return [kind for kind, channel in CHANNELS.items() if channel.available(db)]
