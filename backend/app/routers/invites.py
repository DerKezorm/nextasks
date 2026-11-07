"""Invitations in the browser: the page behind a link (``/invite/<secret>``), the operator's invitations into nextasks
without a space, and the notices an account should see once.

Invitations into a space are made by its managers through ``/api/app/1/spaces/{id}/invites`` (``routers/app1.py``).
Whoever opens a link signs in or makes an account (with a password here, or through a provider with ``?invite=`` at
``/api/oidc/{slug}/start``) and becomes a member. Paths of the contract: ``GET /api/invites/{secret}`` and
``POST /api/invites/{secret}/accept``; the paths of the old nextasks (``/api/invite/{token}``, with ``POST`` making an
account and ``/join``) stay for the account page.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi import Path as PathParam
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from ..deps import Account, DbSession, OperatorAccount, client_ip
from ..errors import detail, error
from ..models import Account as AccountRow
from ..models import Invite, Notice, Space, utcnow
from ..security import MIN_PASSWORD, SESSION_COOKIE, brake, session_account
from ..services import accounts, mailer, settings_service, spaces
from ..services.accounts import AccountError
from ..services.records import format_stamp
from .auth import check_password, ensure_private, fail, sign_in

logger = logging.getLogger("nextasks.auth")

router = APIRouter(prefix="/api", tags=["invites"])

Token = Annotated[str, PathParam(min_length=20, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")]
#: Invitation mails one account may send in an hour.
MAILS_PER_HOUR = 20
#: Taken names one sender may try when accepting invitations before it waits.
NAME_TRIES = 8


def link_of(db: DbSession, request: Request, token: str) -> str:
    base = settings_service.public_url(db) or str(request.base_url).rstrip("/")
    return f"{base}/invite/{token}"


def _invite_view(invite: Invite, db: DbSession) -> dict[str, Any]:
    by = db.get(AccountRow, invite.created_by) if invite.created_by else None
    return {
        "id": invite.id,
        "email": invite.email,
        "by": by.name if by else None,
        "created_at": format_stamp(invite.created_at),
        "expires_at": format_stamp(invite.expires_at),
    }


# --- Notices ------------------------------------------------------------------------------------------------------


class NoticeOut(BaseModel):
    id: int
    kind: str
    actor: str
    subject: str
    created_at: datetime


@router.get("/notices", response_model=list[NoticeOut], summary="What the account should see once")
def open_notices(account: Account, db: DbSession) -> list[NoticeOut]:
    rows = db.scalars(select(Notice).where(Notice.account_id == account.id, Notice.done_at.is_(None))
                      .order_by(Notice.id))
    return [NoticeOut(id=row.id, kind=row.kind, actor=row.actor, subject=row.subject, created_at=row.created_at)
            for row in rows]


@router.post("/notices/{notice_id}/decline", status_code=204, summary="Mark a notice seen")
def notice_seen(notice_id: Annotated[int, PathParam(ge=1)], account: Account, db: DbSession) -> None:
    row = db.get(Notice, notice_id)
    if row is None or row.account_id != account.id:
        raise error("not_found", "Not found.", 404)
    row.done_at = utcnow()
    db.commit()


# --- The operator's invitations into nextasks ---------------------------------------------------------------------


class InviteIn(BaseModel):
    days: int = 7
    email: str = Field(default="", max_length=255)
    send: bool = False
    #: The language the inviter's page shows: the mail's, when neither the receiver nor the inviter has one.
    language: str = Field(default="", max_length=16)


@router.get("/invites", summary="Open invitations into nextasks (operator)")
def list_invites(_operator: OperatorAccount, db: DbSession) -> list[dict[str, Any]]:
    return [_invite_view(invite, db) for invite in accounts.invites_of(db, space_id=None)]


@router.post("/invites", status_code=201, summary="Invite into nextasks without a space (operator)")
def invite(payload: InviteIn, request: Request, operator: OperatorAccount, db: DbSession) -> dict[str, Any]:
    email = payload.email.strip()
    if email and not accounts.EMAIL_PATTERN.match(email):
        raise error("invalid_email", "This is not a mail address.", 422)
    if payload.send and not email:
        raise error("invalid_email", "Sending needs a mail address.", 422)
    if payload.send:
        if not settings_service.public_url(db):
            raise error("public_url_missing", "Mail needs the public address of nextasks; the operator sets it.", 409)
        key = f"invite-mail:{operator.id}"
        if brake.wait_seconds(key, MAILS_PER_HOUR):
            raise error("too_many_attempts", "Too many invitation mails. Try again later.", 429)
        brake.failed(key)
    if email:
        for old in db.scalars(select(Invite).where(func.lower(Invite.email) == email.lower(),
                                                   Invite.space_id.is_(None))):
            db.delete(old)
    try:
        row, token = accounts.create_invite(db, operator, space_id=None, days=payload.days, email=email)
    except AccountError as exc:
        raise fail(exc) from exc
    link = link_of(db, request, token)
    sent = False
    if payload.send:
        try:
            known = db.scalar(select(AccountRow).where(func.lower(AccountRow.email) == email.lower()).limit(1))
            language = mailer.mail_language(known.language if known else "", known.browser_language if known else "",
                                            operator.language, payload.language, operator.browser_language)
            mailer.send_invite(db, email, link, by=operator.display_name or operator.name, space=None,
                               until=row.expires_at.date(), language=language)
            sent = True
        except mailer.MailError as exc:
            db.delete(row)
            db.commit()
            raise error(exc.code, str(exc), 502) from exc
    return {**_invite_view(row, db), "link": link, "sent": sent}


class SpaceInviteIn(BaseModel):
    email: str = Field(max_length=255)
    #: The language the inviter's page shows: the mail's, when neither the receiver nor the inviter has one.
    language: str = Field(default="", max_length=16)


@router.post("/spaces/{space_id}/invites", status_code=201,
             summary="A link for one person into a space, sent by mail (managers; the web only)")
def invite_to_space(space_id: Annotated[str, PathParam(max_length=36)], payload: SpaceInviteIn, request: Request,
                    account: Account, db: DbSession) -> dict[str, Any]:
    """The same invitation as ``POST /api/app/1/spaces/{id}/invites`` (seven days, once), mailed to an address
    through the operator's server. The contract of the app stays as it is; this is the web's way to mail it."""
    space = db.get(Space, space_id)
    role = spaces.role_of(db, account.id, space_id) if space is not None else None
    if space is None or role is None:
        raise error("not_found", "Not found.", 404)
    if role != "manager":
        raise error("forbidden", "Only a manager of this space may do this.", 403)
    if space.private:
        raise error("private_space", "The space Private is not shared.", 403)
    if not settings_service.get(db, "invites_enabled"):
        raise error("invites_disabled", "The operator has switched invitations off.", 403)
    email = payload.email.strip()
    if not accounts.EMAIL_PATTERN.match(email):
        raise error("invalid_email", "This is not a mail address.", 422)
    if not mailer.configured(db):
        raise error("mail_off", "No mail server is set up.", 409)
    if not settings_service.public_url(db):
        raise error("public_url_missing", "Mail needs the public address of nextasks; the operator sets it.", 409)
    key = f"invite-mail:{account.id}"
    if brake.wait_seconds(key, MAILS_PER_HOUR):
        raise error("too_many_attempts", "Too many invitation mails. Try again later.", 429)
    brake.failed(key)
    own = db.get(AccountRow, account.id)
    assert own is not None
    try:
        row, token = accounts.create_invite(db, own, space_id=space.id, days=7, email=email)
    except AccountError as exc:
        raise fail(exc) from exc
    link = link_of(db, request, token)
    known = db.scalar(select(AccountRow).where(func.lower(AccountRow.email) == email.lower()).limit(1))
    language = mailer.mail_language(known.language if known else "", known.browser_language if known else "",
                                    own.language, payload.language, own.browser_language)
    try:
        mailer.send_invite(db, email, link, by=own.display_name or own.name, space=space.name,
                           until=row.expires_at.date(), language=language)
    except mailer.MailError as exc:
        db.delete(row)
        db.commit()
        raise error(exc.code, str(exc), 502) from exc
    logger.info("Invitation into a space mailed space_id=%s by=%s", space.id, own.name)
    return {"id": row.id, "link": link, "expires_at": format_stamp(row.expires_at), "email": email, "sent": True}


@router.delete("/invites/{invite_id}", status_code=204, summary="Withdraw an invitation")
def withdraw(invite_id: Annotated[int, PathParam(ge=1)], account: Account, db: DbSession) -> None:
    row = db.get(Invite, invite_id)
    allowed = row is not None and (
        account.role == "operator" and row.space_id is None
        or row.created_by == account.id
        or (row.space_id is not None and spaces.role_of(db, account.id, row.space_id) == "manager")
    )
    if row is None or not allowed:
        raise error("not_found", "Not found.", 404)
    db.delete(row)
    db.commit()


# --- The page behind a link ---------------------------------------------------------------------------------------


def _valid(db: DbSession, token: str, *, code: str = "invite_invalid") -> Invite:
    row = accounts.find_invite(db, token)
    if row is None:
        if code == "invite_unknown":
            raise error("invite_unknown", "This invitation is not valid.", 404)
        if accounts.invite_ran_out(db, token):
            raise error("invite_expired", "This invitation has run out.", 404)
        raise error("invite_invalid", "This invitation is not valid any more.", 404)
    return row


def _state(db: DbSession, request: Request, row: Invite) -> dict[str, Any]:
    space = db.get(Space, row.space_id) if row.space_id else None
    signed_in = session_account(db, request.cookies.get(SESSION_COOKIE))
    by = db.get(AccountRow, row.created_by) if row.created_by else None
    return {
        "space_name": space.name if space else None,
        "invited_by": (by.display_name or by.name) if by else None,
        "expires_at": format_stamp(row.expires_at),
        "already_member": bool(signed_in is not None and accounts.is_member(db, row, signed_in.id)),
        "signed_in": signed_in is not None,
    }


@router.get("/invites/{secret}", summary="What an invitation offers (no sign-in needed)")
def invite_page(secret: Token, request: Request, db: DbSession) -> dict[str, Any]:
    return _state(db, request, _valid(db, secret, code="invite_unknown"))


@router.post("/invites/{secret}/accept", summary="Accept an invitation with the signed-in account")
def accept_signed_in(secret: Token, account: Account, db: DbSession) -> dict[str, Any]:
    row = _valid(db, secret, code="invite_unknown")
    if row.space_id is None:
        raise error("already_member", "You have an account already.", 409)
    own = db.get(AccountRow, account.id)
    assert own is not None
    space_id = row.space_id
    ensure_private(db, own)
    try:
        accounts.redeem(db, row, own)
    except AccountError as exc:
        raise fail(exc) from exc
    return {"space_id": space_id}


@router.get("/invite/{token}", summary="What an invitation offers (no sign-in needed; the old path)")
def invite_state(token: Token, request: Request, db: DbSession) -> dict[str, Any]:
    row = _valid(db, token)
    state = _state(db, request, row)
    signed_in = session_account(db, request.cookies.get(SESSION_COOKIE))
    return {
        **state,
        "space": state["space_name"],
        "by": state["invited_by"],
        "min_password": MIN_PASSWORD,
        "signed_in_as": signed_in.name if signed_in else None,
    }


class AcceptIn(BaseModel):
    name: str = Field(max_length=64)
    password: str = Field(max_length=200)


@router.post("/invite/{token}", summary="Accept an invitation with a new account (password)")
def accept(token: Token, payload: AcceptIn, request: Request, response: Response, db: DbSession) -> dict[str, Any]:
    key = "invite-name:" + client_ip(request)
    wait = brake.wait_seconds(key, NAME_TRIES)
    if wait:
        raise HTTPException(
            status_code=429,
            detail=detail("too_many_attempts", "Too many attempts. Try again later.", retry_after=wait),
            headers={"Retry-After": str(wait)},
        )
    check_password(payload.password)
    if not settings_service.get(db, "password_login"):
        raise error("password_login_off", "Sign-in with a password is turned off.", 403)
    found = accounts.find_invite(db, token)
    space_id = found.space_id if found is not None else None
    try:
        account = accounts.accept_invite(db, token, payload.name, payload.password)
    except AccountError as exc:
        if exc.code == "name_taken":
            brake.failed(key)
        raise fail(exc) from exc
    return {**sign_in(db, request, response, account), "space_id": space_id}


@router.post("/invite/{token}/join", summary="Accept an invitation with the signed-in account (the old path)")
def join(token: Token, account: Account, db: DbSession) -> dict[str, Any]:
    row = _valid(db, token)
    if row.space_id is None:
        raise error("already_member", "You have an account already.", 409)
    own = db.get(AccountRow, account.id)
    assert own is not None
    space = db.get(Space, row.space_id)
    try:
        accounts.redeem(db, row, own)
    except AccountError as exc:
        raise fail(exc) from exc
    return {"space": space.name if space else None, "space_id": row.space_id}
