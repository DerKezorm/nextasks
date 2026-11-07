"""API tokens through the interface: an account's own (My account, Connections) and every token for the operator.

Only with a session: a token never makes, lists or deletes tokens (``require_account`` reads the session cookie).
A new token is narrow from the start: the spaces it may see are chosen, or all of them on purpose, and it runs out
after 90 days unless "never" is chosen on purpose (as nexbrand's F26, decided 05.10.2026).
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Path
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..deps import Account, DbSession, OperatorAccount
from ..errors import error
from ..models import Account as AccountRow
from ..models import ApiToken, Space, utcnow
from ..services import apitokens
from ..services import spaces as spaces_service
from ..services.apitokens import TokenError

logger = logging.getLogger("nextasks.api")

router = APIRouter(prefix="/api", tags=["api tokens"])

#: How long a new token holds when nothing else is said (decided 05.10.2026, as in nexbrand).
DEFAULT_DAYS = 90


class SpaceRef(BaseModel):
    id: str
    name: str


class TokenOut(BaseModel):
    id: int
    name: str
    level: str
    prefix: str
    created_at: datetime
    last_used_at: datetime | None = None
    expires_at: datetime | None = None
    #: The operator blocked it: it answers like none, for good.
    blocked: bool = False
    #: The spaces the token may see, of those the account may read now; None: all of them.
    spaces: list[SpaceRef] | None = None


class TokensOut(BaseModel):
    allowed: bool
    tokens: list[TokenOut]
    #: The spaces a new token may be given: those a token of this account reads (never by the operator's powers).
    choices: list[SpaceRef] = []


class TokenIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    level: str = Field(default="read", pattern="^(read|write)$")
    #: Ids of the spaces the token sees. Needed unless ``all_spaces``: a new token is narrow from the start.
    spaces: list[str] | None = Field(default=None, max_length=1000)
    #: Every space the account may read, now and later, instead of ``spaces``; asked for on purpose.
    all_spaces: bool = False
    #: 30, 90 or 365; ``null`` on purpose: never runs out; left out: 90.
    days: int | None = DEFAULT_DAYS


class MadeOut(BaseModel):
    token: TokenOut
    #: Shown once, never again.
    secret: str


def _out(db: Any, account: Any, row: ApiToken) -> TokenOut:
    named = None
    if row.spaces is not None:
        # Only spaces the account may still read: one it lost since tells nothing (and the token does not see it).
        readable = set(spaces_service.space_ids_of(db, account.id))
        wanted = [space_id for space_id in row.spaces if space_id in readable]
        found = db.scalars(select(Space).where(Space.id.in_(wanted))) if wanted else []
        named = sorted((SpaceRef(id=space.id, name=space.name) for space in found), key=lambda s: s.name.casefold())
    return TokenOut(id=row.id, name=row.name, level=row.level, prefix=row.prefix, created_at=row.created_at,
                    last_used_at=row.last_used_at, expires_at=row.expires_at, blocked=row.blocked_at is not None,
                    spaces=named)


@router.get("/api-tokens", response_model=TokensOut, summary="The own API tokens")
def own_tokens(account: Account, db: DbSession) -> TokensOut:
    rows = db.scalars(select(ApiToken).where(ApiToken.account_id == account.id).order_by(ApiToken.id)).all()
    ids = set(spaces_service.space_ids_of(db, account.id))
    found = db.scalars(select(Space).where(Space.id.in_(ids))) if ids else []
    choices = sorted((SpaceRef(id=space.id, name=space.name) for space in found), key=lambda s: s.name.casefold())
    return TokensOut(allowed=apitokens.allowed(db), tokens=[_out(db, account, row) for row in rows], choices=choices)


@router.post("/api-tokens", response_model=MadeOut, status_code=201, summary="Make an API token; shown once")
def make_token(body: TokenIn, account: Account, db: DbSession) -> MadeOut:
    if not apitokens.allowed(db):
        raise error("api_off", "The operator has not switched API tokens on.", 403)
    if body.all_spaces and body.spaces is not None:
        raise error("invalid_input", "Choose spaces, or all of them, not both.", 422)
    if not body.all_spaces and not body.spaces:
        raise error("choose_spaces", "Choose the spaces the token may see, or all of them on purpose.", 422)
    try:
        row, secret = apitokens.make(db, account, body.name, body.level, None if body.all_spaces else body.spaces,
                                     body.days)
    except TokenError as exc:
        raise error(exc.code, exc.text, exc.status) from exc
    return MadeOut(token=_out(db, account, row), secret=secret)


@router.delete("/api-tokens/{token_id}", status_code=204, summary="Delete an own API token")
def delete_token(token_id: Annotated[int, Path(ge=1)], account: Account, db: DbSession) -> None:
    row = db.get(ApiToken, token_id)
    if row is None or row.account_id != account.id:
        raise error("not_found", "Not found.", 404)
    db.delete(row)
    db.commit()
    logger.info("API token deleted token_id=%s", token_id)


# --- The operator ----------------------------------------------------------------------------------------------------


class AnyTokenOut(BaseModel):
    id: int
    #: The account's name and the name people see (dialogs say the second).
    account: str
    account_display: str
    #: The account is blocked: none of its tokens answers until it is let in again.
    account_blocked: bool = False
    name: str
    level: str
    prefix: str
    #: How many spaces it is limited to; None: all its account may read.
    spaces: int | None = None
    created_at: datetime
    last_used_at: datetime | None = None
    expires_at: datetime | None = None
    blocked: bool = False


def _any(row: ApiToken, owner: AccountRow | None) -> AnyTokenOut:
    return AnyTokenOut(id=row.id, account=owner.name if owner else "",
                       account_display=(owner.display_name or owner.name) if owner else "",
                       account_blocked=bool(owner and owner.blocked_at is not None), name=row.name, level=row.level,
                       prefix=row.prefix, spaces=None if row.spaces is None else len(row.spaces),
                       created_at=row.created_at, last_used_at=row.last_used_at, expires_at=row.expires_at,
                       blocked=row.blocked_at is not None)


@router.get("/admin/api-tokens", response_model=list[AnyTokenOut], summary="Every API token (operator)")
def every_token(_operator: OperatorAccount, db: DbSession) -> list[AnyTokenOut]:
    owners = {row.id: row for row in db.scalars(select(AccountRow))}
    rows = db.scalars(select(ApiToken).order_by(ApiToken.account_id, ApiToken.id)).all()
    return [_any(row, owners.get(row.account_id)) for row in rows]


@router.post("/admin/api-tokens/{token_id}/block", response_model=AnyTokenOut,
             summary="Block a token for good (operator); its account sees it blocked")
def block_token(token_id: Annotated[int, Path(ge=1)], _operator: OperatorAccount, db: DbSession) -> AnyTokenOut:
    row = db.get(ApiToken, token_id)
    if row is None:
        raise error("not_found", "Not found.", 404)
    if row.blocked_at is None:
        row.blocked_at = utcnow()
        db.commit()
        logger.info("API token blocked by the operator token_id=%s", token_id)
    return _any(row, db.get(AccountRow, row.account_id))
