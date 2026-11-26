"""Tables of the connections with other nex apps (shared module ``vendor/nexverbinden``, verbinden 0.1.1): one row per
account and partner app (both directions in one), the connections started here and the codes given on the consent
page (each good once), spent refresh tokens, and revocations that wait for a partner out of reach.

Everything here is new and starts empty; nothing of before is renamed or dropped. The API keys other apps typed in
(``api_tokens``) stay as they are and keep working. Only SHA-256 of codes and tokens this app gave is stored; what a
partner gave is sealed with the server's secret (``security.encrypt_secret``)."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .models import Base, UtcDateTime


class Connection(Base):
    __tablename__ = "connections"
    __table_args__ = (UniqueConstraint("account_id", "partner"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    #: The partner app's name (``nexmail``) and address.
    partner: Mapped[str] = mapped_column(String(32))
    partner_base: Mapped[str] = mapped_column(String(500))
    partner_account: Mapped[str] = mapped_column(String(200))
    #: What this app uses at the partner, and what the partner may here (purposes of the catalog).
    uses: Mapped[Any] = mapped_column(JSON)
    grants: Mapped[Any] = mapped_column(JSON)
    #: Spaces the partner may reach (None: all, later ones too), and what the partner let this app reach.
    areas_granted: Mapped[Any] = mapped_column(JSON, nullable=True)
    areas_used: Mapped[Any] = mapped_column(JSON, nullable=True)
    #: The partner's access and refresh token for this app, sealed.
    held: Mapped[str] = mapped_column(Text)
    issued_access_hash: Mapped[str] = mapped_column(String(64), unique=True)
    issued_refresh_hash: Mapped[str] = mapped_column(String(64), unique=True)
    issued_access_expires: Mapped[datetime] = mapped_column(UtcDateTime)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime)
    used_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    ok_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    state: Mapped[str] = mapped_column(String(16), default="connected")
    stale_since: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    problem: Mapped[str | None] = mapped_column(String(64), nullable=True)
    partner_version: Mapped[str] = mapped_column(String(40), default="")


class ConnectionPending(Base):
    """A connection started here: the account went to the partner's consent page (ten minutes, once)."""

    __tablename__ = "connection_pending"

    state_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    partner: Mapped[str] = mapped_column(String(32))
    partner_base: Mapped[str] = mapped_column(String(500))
    #: The PKCE verifier, sealed.
    verifier: Mapped[str] = mapped_column(Text)
    areas_granted: Mapped[Any] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime)


class ConnectionCode(Base):
    """A code this app gave on its consent page, for the app that asked (ten minutes, once)."""

    __tablename__ = "connection_codes"

    code_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    partner: Mapped[str] = mapped_column(String(32))
    partner_base: Mapped[str] = mapped_column(String(500))
    redirect_uri: Mapped[str] = mapped_column(String(2048))
    challenge: Mapped[str] = mapped_column(String(200))
    areas_granted: Mapped[Any] = mapped_column(JSON, nullable=True)
    expires_at: Mapped[datetime] = mapped_column(UtcDateTime)


class ConnectionSpent(Base):
    """A spent code or refresh token of a connection; only the last few per connection."""

    __tablename__ = "connection_spent"

    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    connection_id: Mapped[str] = mapped_column(String(64), index=True)
    at: Mapped[int] = mapped_column(Integer)


class ConnectionWaiting(Base):
    """A revocation a partner out of reach has not heard yet (``nexverbinden.retry_waiting``)."""

    __tablename__ = "connection_waiting"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    partner_base: Mapped[str] = mapped_column(String(500))
    #: The form to bring, sealed.
    token: Mapped[str] = mapped_column(Text)
    since: Mapped[datetime] = mapped_column(UtcDateTime)


__all__ = ["Connection", "ConnectionCode", "ConnectionPending", "ConnectionSpent", "ConnectionWaiting"]
