"""Tables of the AI tools (MCP, shared module ``vendor/nexmcp``, mcp 1.1.0): MCP keys made by hand and the keys of
programs that connected themselves by OAuth, the programs, their codes and spent tokens, the rights per tool and the
requests that wait for the account's yes.

Everything here is new and starts empty; nothing of before is renamed or dropped. The keys stand in a table of their
own, not among ``api_tokens``: an older nextasks (the way back) reads ``api_tokens`` and would take a program's row
there for an API key. Only SHA-256 of codes and tokens is stored.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, Boolean, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from .models import Base, UtcDateTime, utcnow


class McpKey(Base):
    """An MCP key (``ntm_``): made by hand under My account › Connections, or a program's after the account's consent
    (``client_id`` set; its access token is the key, renewed with the refresh token)."""

    __tablename__ = "mcp_keys"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    #: ``read`` or ``write``.
    level: Mapped[str] = mapped_column(String(8))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    prefix: Mapped[str] = mapped_column(String(16))
    #: The ids of the spaces the key may see; None: all its account may read, later ones too.
    spaces: Mapped[Any] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    last_used_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    #: A key by hand: when it runs out (None: never); a program's: when its access token runs out.
    expires_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    blocked_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    #: The program it was issued to; None for a key made by hand.
    client_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    refresh_hash: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    signed_in_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    refreshed_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)


class McpClient(Base):
    """A program that registered itself (RFC 7591): public, with PKCE."""

    __tablename__ = "mcp_clients"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    redirect_uris: Mapped[Any] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    last_used_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)


class McpCode(Base):
    """A code the account gave a program on the consent page: traded once, within ten minutes."""

    __tablename__ = "mcp_codes"

    code_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    client_id: Mapped[str] = mapped_column(String(64))
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    redirect_uri: Mapped[str] = mapped_column(String(2000))
    challenge: Mapped[str] = mapped_column(String(128))
    level: Mapped[str] = mapped_column(String(8))
    spaces: Mapped[Any] = mapped_column(JSON, nullable=True)
    extras: Mapped[Any] = mapped_column(JSON, nullable=True)
    expires_at: Mapped[datetime] = mapped_column(UtcDateTime)
    resource: Mapped[str] = mapped_column(String(2000), default="")


class McpSpent(Base):
    """A traded code or refresh token of a program, to know it again when it is brought a second time."""

    __tablename__ = "mcp_spent"

    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    key_id: Mapped[int] = mapped_column(ForeignKey("mcp_keys.id", ondelete="CASCADE"), index=True)
    spent_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)


class McpToolRight(Base):
    """A key's own right for one tool, only where it differs from the group's default (allow, ask, deny)."""

    __tablename__ = "mcp_tool_rights"

    key_id: Mapped[int] = mapped_column(ForeignKey("mcp_keys.id", ondelete="CASCADE"), primary_key=True)
    tool: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[str] = mapped_column(String(8))


class McpRequest(Base):
    """A call of a tool set to "ask": its arguments fixed, waiting for the account's answer (24 hours)."""

    __tablename__ = "mcp_requests"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    #: The key's id as the key module names it (``mcp-12``); the request stays when the key goes.
    key_id: Mapped[str] = mapped_column(String(32), index=True)
    key_name: Mapped[str] = mapped_column(String(200))
    tool: Mapped[str] = mapped_column(String(64))
    arguments: Mapped[str] = mapped_column(Text)
    digest: Mapped[str] = mapped_column(String(64))
    #: ``waiting``, ``running``, ``done``, ``failed``, ``declined``, ``expired``.
    status: Mapped[str] = mapped_column(String(12), index=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(UtcDateTime)
    decided_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    decided_by: Mapped[str] = mapped_column(String(200), default="")
    result: Mapped[str | None] = mapped_column(Text, nullable=True)
    summary: Mapped[str] = mapped_column(String(500), default="")
    dangerous: Mapped[bool] = mapped_column(Boolean, default=False)


__all__ = ["McpClient", "McpCode", "McpKey", "McpRequest", "McpSpent", "McpToolRight"]
