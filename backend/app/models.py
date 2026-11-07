"""The data model.

Everything lives in SQLite, except the files of attachments: those lie in the media folder, named by their SHA-256
(``services/files.py``).

Two parts. The **foundation** (accounts, sessions, sign-in providers, API tokens, devices of the app) is the frame every
nex app shares. The **things** after it follow ``nextasks-ios/docs/datenmodell.md`` one to one: spaces, members, lists,
sections, reminders, attachments and the per-person list settings. Every thing carries ``clock`` (the time of the last
change per field or group, ``services/records.py``) and ``cursor`` (its place in the server's one change counter,
``services/cursor.py``). What went for good leaves a ``Gone`` row (tombstone); what an account no longer sees leaves a
``Hidden`` row for that account.
"""

from __future__ import annotations

import secrets
from datetime import UTC, datetime
from typing import Any, ClassVar

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
    event,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.types import TypeDecorator


def utcnow() -> datetime:
    return datetime.now(UTC)


class UtcDateTime(TypeDecorator[datetime]):
    """SQLite forgets the time zone. Stored as UTC, read back as UTC with the zone attached."""

    impl = DateTime
    cache_ok = True

    def process_bind_param(self, value: datetime | None, dialect: Any) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None:
            raise ValueError("naive datetime")
        return value.astimezone(UTC).replace(tzinfo=None)

    def process_result_value(self, value: datetime | None, dialect: Any) -> datetime | None:
        return None if value is None else value.replace(tzinfo=UTC)


class Base(DeclarativeBase):
    pass


class Setting(Base):
    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[Any] = mapped_column(JSON, nullable=True)


OPERATOR = "operator"
MEMBER = "member"
ROLES = (OPERATOR, MEMBER)

SIGN_IN_PASSWORD = "password"
SIGN_IN_OIDC = "oidc"

#: Roles in a space (``member.role``): the manager invites, removes, changes roles, renames and deletes the space; a
#: member does everything with lists, sections and reminders.
MANAGER = "manager"
SPACE_MEMBER = "member"
SPACE_ROLES = (MANAGER, SPACE_MEMBER)


class Account(Base):
    """A person. The first account is the operator; the others come by invitation or through OIDC."""

    __tablename__ = "accounts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    #: Lower case, the name people sign in with (``username`` in ``/api/app/1``). What people see is the display
    #: name, when there is one (``name`` there).
    name: Mapped[str] = mapped_column(String(64), unique=True)
    display_name: Mapped[str] = mapped_column(String(80), default="")
    #: The version whose "What's new" the account has read or put away.
    whats_new_seen: Mapped[str] = mapped_column(String(32), default="")
    role: Mapped[str] = mapped_column(String(16), default=MEMBER)
    sign_in: Mapped[str] = mapped_column(String(16), default=SIGN_IN_PASSWORD)
    #: Argon2id. Empty for accounts that sign in through OIDC only.
    password_hash: Mapped[str] = mapped_column(String(255), default="")
    email: Mapped[str] = mapped_column(String(255), default="")
    #: ``provider`` when ``email`` came from a sign-in provider (``services/oidc_store``): it goes with the account's
    #: last link. Empty for any other address (an invitation).
    email_source: Mapped[str] = mapped_column(String(16), default="")
    #: The address whose link the account opened (``services/emailaddr.py``). Mail goes out only while it is the same
    #: as ``email``: an address a provider or an invitation brought in counts only once it was confirmed.
    email_confirmed: Mapped[str] = mapped_column(String(255), default="")
    #: An address entered in the profile that waits for its link: the address, the SHA-256 of the link's secret and
    #: until when the link works.
    email_pending: Mapped[str] = mapped_column(String(255), default="")
    email_pending_hash: Mapped[str] = mapped_column(String(64), default="")
    email_pending_until: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    #: The interface language chosen in the account menu; empty: the browser's.
    language: Mapped[str] = mapped_column(String(16), default="")
    #: The browser's language at the last sign-in (``de``, ``en``): what the server writes in for the account while
    #: ``language`` is empty (the first list, mails, notifications).
    browser_language: Mapped[str] = mapped_column(String(16), default="")
    #: IANA time zone: when "due at 9:00" is for this person. The app reports the device's at every start, the web
    #: sets it in the profile; empty means the server's (``services/clock.py``).
    timezone: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    last_seen_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    failed_logins: Mapped[int] = mapped_column(Integer, default=0)
    locked_until: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    #: Set when the operator blocked the account: no sign-in, sessions and devices end at once.
    blocked_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    #: The second factor (``services/totp.py``): the seed encrypted with the server secret, empty while off; the
    #: recovery codes as a JSON list of SHA-256 hashes; the time step of the last code taken (no replay).
    totp_secret_enc: Mapped[str] = mapped_column(Text, default="")
    totp_recovery: Mapped[str] = mapped_column(Text, default="")
    totp_last_step: Mapped[int] = mapped_column(Integer, default=0)
    #: The profile picture (``services/avatars.py``): a square WebP drawn anew, loaded only when asked for.
    avatar: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True, deferred=True)
    avatar_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    #: SHA-256 (hex) of ``avatar``: the ``ETag`` of ``/people/{id}/avatar``; empty without a picture.
    avatar_hash: Mapped[str] = mapped_column(String(64), default="")
    #: The account's own preferences of the interface; only what it chose.
    preferences: Mapped[Any] = mapped_column(JSON, nullable=True)
    #: What the device cookies of this account are signed with (``security.device_token``): random per account, so
    #: an account made later under the id of a deleted one knows none of its browsers, and drawn anew on a new
    #: password, a block or unblock, "sign out everywhere" and a reset second factor.
    device_key: Mapped[str] = mapped_column(String(64), default="")
    #: Not stored. Set on the account an API token acts as when the token may see only some spaces.
    key_spaces: ClassVar[frozenset[str] | None] = None
    #: Not stored. True on the account a token acts as.
    via_key: ClassVar[bool] = False


def new_device_key() -> str:
    return secrets.token_urlsafe(24)


@event.listens_for(Account, "before_insert")
def _first_device_key(_mapper: Any, _connection: Any, target: Account) -> None:
    if not target.device_key:
        target.device_key = new_device_key()


@event.listens_for(Account.password_hash, "set")
@event.listens_for(Account.blocked_at, "set")
def _forget_devices(target: Account, value: Any, old: Any, _initiator: Any) -> None:
    """A new password, a block or an unblock: the browsers known before are not known any more."""
    if value != old:
        target.device_key = new_device_key()


class AuthSession(Base):
    """A browser session. Only the hash of the token is stored; the token itself lives in the cookie."""

    __tablename__ = "auth_sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(UtcDateTime)
    last_seen_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    ip: Mapped[str] = mapped_column(String(64), default="")
    user_agent: Mapped[str] = mapped_column(String(255), default="")
    #: Began at a provider that checks the second factor itself (the entry says so): the operator's demand for a
    #: second factor of the own does not hold in this sign-in, only in one with the password.
    by_provider: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0")


class OidcProvider(Base):
    """A sign-in provider (OpenID Connect), one row each; the columns as the shared blueprint names them. Read and
    written only through ``services/oidc_store.py`` for the shared module ``vendor/nexoidc``."""

    __tablename__ = "oidc_providers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    #: Part of the callback address ``/api/oidc/<slug>/callback``; fixed once made.
    slug: Mapped[str] = mapped_column(String(40), unique=True)
    #: The name on the sign-in button.
    label: Mapped[str] = mapped_column(String(64))
    #: Stored without blanks and without a slash at the end.
    issuer: Mapped[str] = mapped_column(String(500))
    client_id: Mapped[str] = mapped_column(String(255))
    #: Encrypted with the server secret under the context ``oidc-provider:<id>``; empty for a public client.
    client_secret_enc: Mapped[str] = mapped_column(Text, default="")
    scopes: Mapped[str] = mapped_column(String(500), default="openid profile email")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    #: "New people get an account": off from the start.
    auto_create: Mapped[bool] = mapped_column(Boolean, default=False)
    #: "The provider checks the second factor itself": on from the start.
    trusts_second_factor: Mapped[bool] = mapped_column(Boolean, default=True)
    #: "" by hand, "authentik" made by the authentik button.
    managed: Mapped[str] = mapped_column(String(20), default="")
    position: Mapped[int] = mapped_column(Integer, default=0)
    #: A callback path the provider knew before; "" is the standard one.
    redirect_path: Mapped[str] = mapped_column(String(300), default="")
    #: The redirect address the authentik button last registered at authentik for this entry, "" for none.
    registered_redirect: Mapped[str] = mapped_column(String(500), default="", server_default="")
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)


class OidcLink(Base):
    """One identity at one provider, bound to one account. Found only by ``(provider_id, subject)``, never by an
    address: ``email`` is for display."""

    __tablename__ = "oidc_links"
    __table_args__ = (
        UniqueConstraint("provider_id", "subject"),
        UniqueConstraint("provider_id", "account_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    provider_id: Mapped[int] = mapped_column(ForeignKey("oidc_providers.id", ondelete="CASCADE"), index=True)
    subject: Mapped[str] = mapped_column(String(255))
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    #: The ``iss`` of the token that made the link (with Entra ``common`` the real tenant).
    issuer: Mapped[str] = mapped_column(String(500))
    email: Mapped[str | None] = mapped_column(String(320), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    last_used_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)


class ApiToken(Base):
    """A token an account made for programs (``/api/v1``). Only the SHA-256 is stored."""

    __tablename__ = "api_tokens"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(100))
    #: ``read`` or ``write``.
    level: Mapped[str] = mapped_column(String(8))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    prefix: Mapped[str] = mapped_column(String(16))
    #: The ids of the spaces the token may see, of those its account is in; empty (None): all of them.
    spaces: Mapped[Any] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    last_used_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    blocked_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    warned_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)


class AppPairing(Base):
    """A pairing of the iPhone app, made in the browser (``services/devices.py``): ten minutes, one device. Secret and
    short code are stored as SHA-256 only."""

    __tablename__ = "app_pairings"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    secret_hash: Mapped[str] = mapped_column(String(64))
    code_hash: Mapped[str] = mapped_column(String(64), index=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(UtcDateTime)
    used_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    device_name: Mapped[str] = mapped_column(String(80), default="")


class AppDevice(Base):
    """A paired iPhone or iPad: its key (``ntd_…``) opens ``/api/app/1`` and nothing else. Only the SHA-256 is kept."""

    __tablename__ = "app_devices"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(80))
    key_hash: Mapped[str] = mapped_column(String(64), unique=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    last_seen_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    #: Where notifications for this device go (``PUT /api/app/1/push``): the relay's ticket and the device's public
    #: X25519 key, base64. Empty: none.
    push_ticket: Mapped[str] = mapped_column(String(1024), default="")
    push_key: Mapped[str] = mapped_column(String(64), default="")


class WebPushSubscription(Base):
    """A browser that takes notifications (``PUT /api/app/1/webpush``)."""

    __tablename__ = "webpush_subscriptions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    endpoint: Mapped[str] = mapped_column(String(1000), unique=True)
    p256dh: Mapped[str] = mapped_column(String(200))
    auth: Mapped[str] = mapped_column(String(100))
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    last_ok_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    #: The browser's ``User-Agent`` when it signed up, cut short: the page "Notifications" names it ("Chrome on
    #: Windows"). Empty for browsers that signed up before.
    user_agent: Mapped[str] = mapped_column(String(300), default="")


class AppOp(Base):
    """The answer to an ``op_id`` of a device or a browser session, kept seven days: nothing happens twice."""

    __tablename__ = "app_ops"

    #: ``d:<device id>`` or ``s:<session id>``.
    caller: Mapped[str] = mapped_column(String(24), primary_key=True)
    op_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    result: Mapped[Any] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow, index=True)


# --- The things (datenmodell.md) -----------------------------------------------------------------------------------
#
# Ids are lower-case UUIDs the maker gives. Times that come from a client (``created_at``, ``completed_at``,
# ``deleted_at``) are kept as the text ``YYYY-MM-DDTHH:MM:SS.sssZ`` they arrived as; times the server keeps for itself
# (``trashed_at``) are ``UtcDateTime``.

ID = String(36)
STAMP = String(24)


class SyncState(Base):
    """The one change counter: ``last`` is the newest cursor handed out, ``oldest`` the cursor below which the server
    cannot tell any more what went (``/changes`` answers 410 for an older ``since``)."""

    __tablename__ = "sync_state"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    last: Mapped[int] = mapped_column(Integer, default=0)
    oldest: Mapped[int] = mapped_column(Integer, default=0)


class PageCursor(Base):
    """A cursor ``/changes`` handed out with ``more: true``, kept a day: asking on with it never answers 410, even
    when tombstones were cleared away in between."""

    __tablename__ = "page_cursors"

    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), primary_key=True)
    cursor: Mapped[int] = mapped_column(Integer, primary_key=True)
    issued_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow, index=True)


class Space(Base):
    __tablename__ = "spaces"

    id: Mapped[str] = mapped_column(ID, primary_key=True)
    name: Mapped[str] = mapped_column(String(80))
    color: Mapped[str] = mapped_column(String(16), default="blue")
    icon: Mapped[str] = mapped_column(String(64), default="list")
    #: The space "Private" of one account: exactly one per account, only that member, never shared nor deleted.
    private: Mapped[bool] = mapped_column(Boolean, default=False)
    #: For a private space: whose it is.
    owner_id: Mapped[int | None] = mapped_column(ForeignKey("accounts.id", ondelete="SET NULL"), nullable=True,
                                                 index=True)
    deleted_at: Mapped[str | None] = mapped_column(STAMP, nullable=True)
    #: When the server received the deletion: the 30 days of the bin run from here.
    trashed_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    #: Since when nobody is a member any more: gone for good 30 days later.
    orphaned_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    clock: Mapped[Any] = mapped_column(JSON, default=dict)
    cursor: Mapped[int] = mapped_column(Integer, default=0, index=True)


class Member(Base):
    __tablename__ = "members"

    space_id: Mapped[str] = mapped_column(ForeignKey("spaces.id", ondelete="CASCADE"), primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), primary_key=True,
                                            index=True)
    role: Mapped[str] = mapped_column(String(16), default=SPACE_MEMBER)
    #: The place of the space in this account's sidebar; None: "Private" first, the rest by name.
    position: Mapped[str | None] = mapped_column(String(200), nullable=True)
    joined_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    #: The server's cursor when the account joined: for this account, everything in the space counts as changed at
    #: least then (``/changes``).
    granted_cursor: Mapped[int] = mapped_column(Integer, default=0)
    cursor: Mapped[int] = mapped_column(Integer, default=0, index=True)


class TaskList(Base):
    __tablename__ = "lists"

    id: Mapped[str] = mapped_column(ID, primary_key=True)
    space_id: Mapped[str] = mapped_column(ForeignKey("spaces.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(80))
    color: Mapped[str] = mapped_column(String(16), default="blue")
    icon: Mapped[str] = mapped_column(String(64), default="list")
    view: Mapped[str] = mapped_column(String(16), default="list")
    position: Mapped[str] = mapped_column(String(200))
    deleted_at: Mapped[str | None] = mapped_column(STAMP, nullable=True)
    trashed_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    clock: Mapped[Any] = mapped_column(JSON, default=dict)
    cursor: Mapped[int] = mapped_column(Integer, default=0, index=True)


class Section(Base):
    __tablename__ = "sections"

    id: Mapped[str] = mapped_column(ID, primary_key=True)
    list_id: Mapped[str] = mapped_column(ForeignKey("lists.id", ondelete="CASCADE"), index=True)
    #: The list's space, kept here for the rights and ``/changes``; follows the list.
    space_id: Mapped[str] = mapped_column(ID, index=True)
    name: Mapped[str] = mapped_column(String(80))
    position: Mapped[str] = mapped_column(String(200))
    clock: Mapped[Any] = mapped_column(JSON, default=dict)
    cursor: Mapped[int] = mapped_column(Integer, default=0, index=True)


class Reminder(Base):
    __tablename__ = "reminders"

    id: Mapped[str] = mapped_column(ID, primary_key=True)
    list_id: Mapped[str] = mapped_column(ForeignKey("lists.id", ondelete="CASCADE"), index=True)
    #: The space of ``list_id``, kept here for the rights and ``/changes``; follows the list.
    space_id: Mapped[str] = mapped_column(ID, index=True)
    #: May name a section the server never had (read as none).
    section_id: Mapped[str | None] = mapped_column(ID, nullable=True)
    parent_id: Mapped[str | None] = mapped_column(ID, nullable=True, index=True)
    position: Mapped[str] = mapped_column(String(200))
    title: Mapped[str] = mapped_column(String(500))
    notes: Mapped[str] = mapped_column(Text, default="")
    url: Mapped[str | None] = mapped_column(String(2000), nullable=True)
    due_date: Mapped[str | None] = mapped_column(String(10), nullable=True)
    due_time: Mapped[str | None] = mapped_column(String(5), nullable=True)
    repeat: Mapped[str | None] = mapped_column(String(200), nullable=True)
    repeat_from: Mapped[str] = mapped_column(String(16), default="due")
    location: Mapped[Any] = mapped_column(JSON, nullable=True)
    flagged: Mapped[bool] = mapped_column(Boolean, default=False)
    priority: Mapped[int] = mapped_column(Integer, default=0)
    tags: Mapped[Any] = mapped_column(JSON, default=list)
    assignees: Mapped[Any] = mapped_column(JSON, default=list)
    completed_at: Mapped[str | None] = mapped_column(STAMP, nullable=True)
    completed_by: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_by: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[str] = mapped_column(STAMP)
    deleted_at: Mapped[str | None] = mapped_column(STAMP, nullable=True)
    trashed_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    clock: Mapped[Any] = mapped_column(JSON, default=dict)
    cursor: Mapped[int] = mapped_column(Integer, default=0, index=True)


class Attachment(Base):
    __tablename__ = "attachments"

    id: Mapped[str] = mapped_column(ID, primary_key=True)
    reminder_id: Mapped[str] = mapped_column(ForeignKey("reminders.id", ondelete="CASCADE"), index=True)
    space_id: Mapped[str] = mapped_column(ID, index=True)
    name: Mapped[str] = mapped_column(String(255))
    mime: Mapped[str] = mapped_column(String(255))
    size: Mapped[int] = mapped_column(Integer)
    #: SHA-256, hex: the file's name in the media folder.
    hash: Mapped[str] = mapped_column(String(64), index=True)
    created_by: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[str] = mapped_column(STAMP)
    cursor: Mapped[int] = mapped_column(Integer, default=0, index=True)


class ListPref(Base):
    """One person's settings for one list (``list_pref``, id = the list's): nobody else ever sees them."""

    __tablename__ = "list_prefs"

    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), primary_key=True)
    list_id: Mapped[str] = mapped_column(ForeignKey("lists.id", ondelete="CASCADE"), primary_key=True, index=True)
    space_id: Mapped[str] = mapped_column(ID, index=True)
    show_completed: Mapped[bool] = mapped_column(Boolean, default=False)
    notify_changes: Mapped[bool] = mapped_column(Boolean, default=False)
    clock: Mapped[Any] = mapped_column(JSON, default=dict)
    cursor: Mapped[int] = mapped_column(Integer, default=0, index=True)


class SpacePref(Base):
    """One person's settings for one space (``space_pref``, id = the space's): hidden in the own sidebar, the
    collections and the search. Nobody else ever sees them."""

    __tablename__ = "space_prefs"

    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), primary_key=True)
    space_id: Mapped[str] = mapped_column(ForeignKey("spaces.id", ondelete="CASCADE"), primary_key=True, index=True)
    hidden: Mapped[bool] = mapped_column(Boolean, default=False)
    clock: Mapped[Any] = mapped_column(JSON, default=dict)
    cursor: Mapped[int] = mapped_column(Integer, default=0, index=True)


class SavedFilter(Base):
    """One person's own filter (``filter``, id = the maker's): a name in the sidebar and the conditions it shows tasks
    by. Nobody else ever sees it. The server keeps ``rules`` as it came and never evaluates them: app and web do, so
    a newer condition passes an older server unchanged."""

    __tablename__ = "filters"

    id: Mapped[str] = mapped_column(ID, primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(80))
    color: Mapped[str] = mapped_column(String(16), default="blue")
    icon: Mapped[str] = mapped_column(String(64), default="filter")
    position: Mapped[str] = mapped_column(String(200))
    rules: Mapped[Any] = mapped_column(JSON, default=dict)
    hidden: Mapped[bool] = mapped_column(Boolean, default=False)
    clock: Mapped[Any] = mapped_column(JSON, default=dict)
    cursor: Mapped[int] = mapped_column(Integer, default=0, index=True)


class TilePref(Base):
    """One person's setting for one of the six built-in tiles (``tile_pref``, id = the tile's fixed one): hidden on
    the own main page. Nobody else ever sees it."""

    __tablename__ = "tile_prefs"

    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), primary_key=True)
    tile_id: Mapped[str] = mapped_column(ID, primary_key=True)
    hidden: Mapped[bool] = mapped_column(Boolean, default=False)
    clock: Mapped[Any] = mapped_column(JSON, default=dict)
    cursor: Mapped[int] = mapped_column(Integer, default=0, index=True)


class Gone(Base):
    """A tombstone: the thing went for good (bin run out or emptied, a section, attachment or filter deleted, a member
    gone). Kept at least 90 days; a change to it is refused (``gone``). ``account_id`` names the owner of a
    ``list_pref``, ``space_pref`` or ``filter`` (0 for everything else); a filter lies in no space, its ``space_id``
    is empty."""

    __tablename__ = "gone"

    kind: Mapped[str] = mapped_column(String(16), primary_key=True)
    id: Mapped[str] = mapped_column(String(80), primary_key=True)
    account_id: Mapped[int] = mapped_column(Integer, primary_key=True, default=0)
    #: The space it was in, for whom it is told.
    space_id: Mapped[str] = mapped_column(ID, index=True)
    gone_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    cursor: Mapped[int] = mapped_column(Integer, default=0, index=True)


class Hidden(Base):
    """A thing one account does not see any more (it left the space, or the thing moved into a space it is not in):
    told to that account as ``deleted: true`` with a new cursor."""

    __tablename__ = "hidden"

    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), primary_key=True)
    kind: Mapped[str] = mapped_column(String(16), primary_key=True)
    id: Mapped[str] = mapped_column(String(80), primary_key=True)
    at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    cursor: Mapped[int] = mapped_column(Integer, default=0, index=True)
    #: The space the thing was in when the account lost sight of it: an API token limited to some spaces hears only
    #: of those (``/api/v1/tasks?updated_since=``). Null in rows from before it was kept.
    space_id: Mapped[str | None] = mapped_column(ID, nullable=True)


class CursorTime(Base):
    """When the server handed out a cursor (``services/cursor.py``): one row per handing out, with its first number.
    ``/api/v1/tasks?updated_since=`` turns a time into a cursor with it, so a change counts by when the server got it,
    not by the clock of the device that made it. Kept as long as tombstones are."""

    __tablename__ = "cursor_times"

    cursor: Mapped[int] = mapped_column(Integer, primary_key=True)
    at: Mapped[datetime] = mapped_column(UtcDateTime, index=True)


class ExternalRef(Base):
    """A program's own key for a task (``external_ref`` of ``/api/v1``): one task per account and key, so that making
    it again gives the same task. Only the account that set it sees it. It stays while the task lies in the bin and
    goes with the task when that goes for good."""

    __tablename__ = "external_refs"

    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), primary_key=True)
    key: Mapped[str] = mapped_column(String(200), primary_key=True)
    reminder_id: Mapped[str] = mapped_column(ForeignKey("reminders.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)


class Invite(Base):
    """A link for one person: into a space (``space_id``), or, made by the operator, only into nextasks (a new account).
    Seven days, once. Only the hash of the secret is stored; used, it goes."""

    __tablename__ = "invites"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    space_id: Mapped[str | None] = mapped_column(ForeignKey("spaces.id", ondelete="CASCADE"), nullable=True,
                                                 index=True)
    email: Mapped[str] = mapped_column(String(255), default="")
    created_by: Mapped[int | None] = mapped_column(ForeignKey("accounts.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(UtcDateTime)


class Notice(Base):
    """Something an account should hear of once, in the interface: the operator unlinked it from a provider
    (``operator_unlinked``, the sign-in blueprint: never unseen)."""

    __tablename__ = "notices"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(24))
    actor: Mapped[str] = mapped_column(String(64), default="")
    subject: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    done_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)


# --- Notifications ---------------------------------------------------------------------------------------------------


class NotifySent(Base):
    """A due notification that went out, per person: ``<reminder_id>:<due_date>T<due_time>``
    (``services/notify.py``)."""

    __tablename__ = "notify_sent"

    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), primary_key=True)
    key: Mapped[str] = mapped_column(String(80), primary_key=True)
    sent_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow, index=True)


class ChangeBundle(Base):
    """Changes by others in a list one person follows (``notify_changes``): the first opens ten minutes, at their end
    one notification tells all of them."""

    __tablename__ = "change_bundles"

    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), primary_key=True)
    list_id: Mapped[str] = mapped_column(ID, primary_key=True)
    opened_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow, index=True)
    #: ``[{"by": account id, "type": "added"|"completed", "reminder_id": …}]``
    events: Mapped[Any] = mapped_column(JSON, default=list)


class NotifyRoute(Base):
    """Who gets what where (``services/notifyprefs.py``): one row per account, event or report, and channel that
    differs from the channel's default (``Channel.defaults``). Rows from before the defaults are all "on"."""

    __tablename__ = "notify_routes"

    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), primary_key=True)
    #: ``daily``, ``weekly`` (reports) or an event: ``assigned``, ``due``, ``changed``, ``joined``.
    event: Mapped[str] = mapped_column(String(32), primary_key=True)
    #: The kind of channel (``services/channels.py``): ``mail``, ``webpush``, ``app``.
    channel: Mapped[str] = mapped_column(String(16), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    #: On or off; off is stored only where the channel's default is on.
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)


class NotifySchedule(Base):
    """When one account's report comes, in the account's own time zone, and which one went out last."""

    __tablename__ = "notify_schedules"

    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), primary_key=True)
    #: ``daily`` or ``weekly``.
    report: Mapped[str] = mapped_column(String(16), primary_key=True)
    #: ``HH:MM`` in the account's zone.
    time: Mapped[str] = mapped_column(String(5), default="07:00")
    #: For ``weekly``: 0 Monday … 6 Sunday.
    weekday: Mapped[int] = mapped_column(Integer, default=0)
    #: The day (``2026-11-07``) or week (``2026-W45``) the last report was made for, sent or empty: never twice.
    last_period: Mapped[str] = mapped_column(String(16), default="")
    #: When it was made: "assigned to me since the last report" counts from here.
    last_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)


class NotifyChannel(Base):
    """One account's state at one channel: what was delivered last, the last failure. A channel that needs settings
    of its own (a topic, an address of a hook) keeps them in ``config`` and its confirmation in ``confirmed_at``; the
    mail channel takes the account's confirmed address instead."""

    __tablename__ = "notify_channels"

    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), primary_key=True)
    kind: Mapped[str] = mapped_column(String(16), primary_key=True)
    config: Mapped[Any] = mapped_column(JSON, nullable=True)
    confirmed_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    last_ok_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    #: The kind of the last failure (an error code, never the server's answer), and when.
    last_error: Mapped[str] = mapped_column(String(64), default="")
    last_error_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)


class NotifyOutbox(Base):
    """A finished message on its way to one channel of one account (``services/outbox.py``): sent in the background,
    tried again after a failure. ``key`` names what it is (``daily:2026-11-07``, ``assigned:<id>:<ms>``): the same key
    is never queued twice, also not after a restart."""

    __tablename__ = "notify_outbox"
    __table_args__ = (UniqueConstraint("account_id", "channel", "key"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    channel: Mapped[str] = mapped_column(String(16))
    key: Mapped[str] = mapped_column(String(120))
    #: ``channels.Message`` as a dict.
    payload: Mapped[Any] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow, index=True)
    next_try_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow, index=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    sent_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    #: Given up after the last try.
    failed_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    last_error: Mapped[str] = mapped_column(String(64), default="")


class AssignedLog(Base):
    """A reminder newly given to an account, for "assigned to me since the last report" (kept eight days)."""

    __tablename__ = "notify_assigned"

    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), primary_key=True)
    reminder_id: Mapped[str] = mapped_column(ID, primary_key=True)
    at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow, index=True)
    by_id: Mapped[int | None] = mapped_column(Integer, nullable=True)


Index("reminders_due", Reminder.due_date, Reminder.due_time)
Index("hidden_account_cursor", Hidden.account_id, Hidden.cursor)

__all__ = [
    "MANAGER",
    "MEMBER",
    "OPERATOR",
    "ROLES",
    "SIGN_IN_OIDC",
    "SIGN_IN_PASSWORD",
    "SPACE_MEMBER",
    "SPACE_ROLES",
    "Account",
    "ApiToken",
    "AppDevice",
    "AppOp",
    "AppPairing",
    "AssignedLog",
    "Attachment",
    "AuthSession",
    "Base",
    "ChangeBundle",
    "CursorTime",
    "ExternalRef",
    "Gone",
    "Hidden",
    "Invite",
    "ListPref",
    "Member",
    "Notice",
    "NotifyChannel",
    "NotifyOutbox",
    "NotifyRoute",
    "NotifySchedule",
    "NotifySent",
    "OidcLink",
    "OidcProvider",
    "PageCursor",
    "Reminder",
    "SavedFilter",
    "Section",
    "Setting",
    "Space",
    "SpacePref",
    "SyncState",
    "TaskList",
    "TilePref",
    "WebPushSubscription",
    "utcnow",
]
