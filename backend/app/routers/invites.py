"""Invitations in the browser: the page behind a link (``/invite/<secret>``), the operator's invitations into nextasks
without a space, and the notices an account should see once.

Invitations into a space are made by its managers through ``/api/app/1/spaces/{id}/invites`` (``routers/app1.py``)
or, mailed, through ``POST /api/spaces/{id}/invites``. Whoever opens a link signs in or makes an account (with a
password here, or through a provider with ``?invite=`` at ``/api/oidc/{slug}/start``) and becomes a member. Paths of
the contract: ``GET /api/invites/{secret}`` and ``POST /api/invites/{secret}/accept``; the paths of the old nextasks
(``/api/invite/{token}``, with ``POST`` making an account and ``/join``) stay for the account page.

Accepting with a new account, joining with the signed-in one and the link for a new password run through the shared
account module (``vendor/nexkonten``): the invited person picks the display name (from the invitation) and the
username (a suggestion); the address of the invitation counts (proven when the link went there by mail), another one
with a mail server only after its link. A request of 0.8.0 (only ``name`` and ``password``) still makes the account:
the username stands in for the display name.
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
from ..services import accounts, kontenpost, mailer, settings_service, spaces
from ..services.accounts import AccountError
from ..services.konten_store import KontenStore
from ..services.records import format_stamp
from ..vendor import nexkonten
from ..vendor.nexkonten import invites as konten_invites
from ..vendor.nexkonten import resets
from .auth import check_confirm, check_display_name, check_password, ensure_private, fail, sign_in

logger = logging.getLogger("nextasks.auth")

router = APIRouter(prefix="/api", tags=["invites"])

Token = Annotated[str, PathParam(min_length=20, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")]
#: Invitation mails one account may send in an hour.
MAILS_PER_HOUR = 20
#: Taken names one sender may try when accepting invitations before it waits.
NAME_TRIES = 8


def link_of(db: DbSession, request: Request, token: str) -> str:
    """The public address, else the one the page was opened under (``invites.invite_link``, konten 0.3.5)."""
    return konten_invites.invite_link(settings_service.public_url(db), "/invite/", token,
                                      request_base=str(request.base_url))


def _invite_view(invite: Invite, db: DbSession) -> dict[str, Any]:
    by = db.get(AccountRow, invite.created_by) if invite.created_by else None
    return {
        "id": invite.id,
        "email": invite.email,
        "display_name": invite.display_name or "",
        "by": by.name if by else None,
        "created_at": format_stamp(invite.created_at),
        "expires_at": format_stamp(invite.expires_at),
        "expired": accounts.expired(invite),
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
    #: What the operator gives as the display name (optional; the form of the person invited shows it).
    display_name: str = Field(default="", max_length=200)
    send: bool = False
    #: The language the inviter's page shows: the mail's, when neither the receiver nor the inviter has one.
    language: str = Field(default="", max_length=16)


@router.get("/invites", summary="Open invitations into nextasks (operator)")
def list_invites(_operator: OperatorAccount, db: DbSession) -> list[dict[str, Any]]:
    # Run out ones stay listed with ``expired`` until the operator withdraws them (konten 0.3.10, ``OPEN_INVITES``).
    return [_invite_view(invite, db) for invite in accounts.invites_of(db, space_id=None, expired=True)]


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
    shown = check_display_name(payload.display_name)
    try:
        # The module's checks: an address in the right form that no account has (a new account comes of it), the
        # display name as people write it.
        email, shown = konten_invites.invite_values(KontenStore(db), email=email, display_name=shown)
    except nexkonten.AccountError as exc:
        raise fail(exc) from exc
    if email:
        for old in db.scalars(select(Invite).where(func.lower(Invite.email) == email.lower(),
                                                   Invite.space_id.is_(None))):
            db.delete(old)
    try:
        row, token = accounts.create_invite(db, operator, space_id=None, days=payload.days, email=email,
                                            display_name=shown)
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
                               until=row.expires_at.date(), language=language, days=payload.days)
            sent = True
            # Whoever comes through this link with this address proved it.
            row.mailed = True
            db.commit()
        except mailer.MailError as exc:
            db.delete(row)
            db.commit()
            raise error(exc.code, str(exc), 502) from exc
    return {**_invite_view(row, db), "link": link, "sent": sent}


class SpaceInviteIn(BaseModel):
    email: str = Field(max_length=255)
    #: How the person is called (optional; the form of the person invited shows it).
    display_name: str = Field(default="", max_length=200)
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
    # Into a space it may also reach somebody with an account (who joins signed in): no check against the
    # addresses of the accounts (``invite_values(..., existing_ok=True)``).
    try:
        email, shown = konten_invites.invite_values(KontenStore(db), email=email,
                                                    display_name=check_display_name(payload.display_name),
                                                    existing_ok=True)
    except nexkonten.AccountError as exc:
        raise fail(exc) from exc
    try:
        row, token = accounts.create_invite(db, own, space_id=space.id, days=7, email=email, display_name=shown)
    except AccountError as exc:
        raise fail(exc) from exc
    link = link_of(db, request, token)
    known = db.scalar(select(AccountRow).where(func.lower(AccountRow.email) == email.lower()).limit(1))
    language = mailer.mail_language(known.language if known else "", known.browser_language if known else "",
                                    own.language, payload.language, own.browser_language)
    try:
        mailer.send_invite(db, email, link, by=own.display_name or own.name, space=space.name,
                           until=row.expires_at.date(), language=language, days=7)
    except mailer.MailError as exc:
        db.delete(row)
        db.commit()
        raise error(exc.code, str(exc), 502) from exc
    row.mailed = True
    db.commit()
    logger.info("Invitation into a space mailed space_id=%s by=%s", space.id, own.name)
    return {"id": row.id, "link": link, "expires_at": format_stamp(row.expires_at), "email": email,
            "display_name": shown, "sent": True}


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


def _join(db: DbSession, token: str, account: Any, *, code: str = "invite_invalid") -> Invite:
    """The signed-in account follows an invitation into a space (``invites.join_invite`` of the shared module): it
    becomes a member, the invitation is used up. Who is a member already does not use it up (as in 0.8.0)."""
    row = _valid(db, token, code=code)
    if row.space_id is None:
        raise error("already_member", "You have an account already.", 409)
    own = db.get(AccountRow, account.id)
    assert own is not None
    ensure_private(db, own)
    if accounts.is_member(db, row, own.id):
        return row
    try:
        konten_invites.join_invite(KontenStore(db), token, own.id)
    except nexkonten.AccountError as exc:
        raise fail(exc) from exc
    return row


@router.post("/invites/{secret}/accept", summary="Accept an invitation with the signed-in account")
def accept_signed_in(secret: Token, account: Account, db: DbSession) -> dict[str, Any]:
    row = _join(db, secret, account, code="invite_unknown")
    return {"space_id": row.space_id}


@router.get("/invite/{token}", summary="What an invitation offers (no sign-in needed; the old path)")
def invite_state(token: Token, request: Request, db: DbSession) -> dict[str, Any]:
    row = _valid(db, token)
    state = _state(db, request, row)
    signed_in = session_account(db, request.cookies.get(SESSION_COOKIE))
    try:
        form = konten_invites.invite_form(KontenStore(db), token)
    except nexkonten.AccountError as exc:
        raise fail(exc) from exc
    return {
        **state,
        "space": state["space_name"],
        "by": state["invited_by"],
        "min_password": MIN_PASSWORD,
        "signed_in_as": signed_in.name if signed_in else None,
        # The fields as the page fills them (the shared module): the display name of the invitation, a username
        # suggested from it, the address of the invitation.
        "display_name": form.display_name,
        "name": form.username,
        "email": form.email,
        "password": bool(settings_service.get(db, "password_login")),
    }


class AcceptIn(BaseModel):
    #: The username; left out, the suggestion of the form.
    name: str | None = Field(default=None, max_length=64)
    password: str = Field(max_length=200)
    #: The display name (since the shared account module); a request of 0.8.0 has none: the username stands in.
    display_name: str | None = Field(default=None, max_length=200)
    #: The address; left out, the invitation's.
    email: str | None = Field(default=None, max_length=255)
    password_confirm: str | None = Field(default=None, max_length=200)


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
    check_confirm(payload.password, payload.password_confirm)
    if not settings_service.get(db, "password_login"):
        raise error("password_login_off", "Sign-in with a password is turned off.", 403)
    found = _valid(db, token)
    space_id, invited, mailed = found.space_id, found.email or "", bool(found.mailed)
    store = KontenStore(db)
    older = payload.display_name is None
    shown = check_display_name(payload.display_name or "")
    try:
        name = payload.name
        if name is None:
            base = nexkonten.names.suggest_username(shown)
            name = nexkonten.names.free_username(store, base) if base else \
                konten_invites.invite_form(store, token).username
        email = payload.email.strip() if payload.email is not None else invited
        accepted = konten_invites.accept_invite(
            store, token, display_name=shown, username=name, email=email, password=payload.password,
            language="", mail=kontenpost.can_mail(db), older_request=older,
            proven=bool(mailed and invited and email.lower() == invited.lower()),
        )
    except nexkonten.AccountError as exc:
        if exc.code in ("username_taken", "email_taken", "display_name_taken", "invite_invalid"):
            brake.failed(key)
        raise fail(exc) from exc
    # Another address than the invitation's waits for its link (with a mail server).
    kontenpost.send_now(db, accepted.mail)
    account = db.get(AccountRow, int(accepted.account.id))
    assert account is not None
    logger.info("Invite used name=%s space_id=%s", account.name, space_id)
    return {**sign_in(db, request, response, account), "space_id": space_id}


@router.post("/invite/{token}/join", summary="Accept an invitation with the signed-in account (the old path)")
def join(token: Token, account: Account, db: DbSession) -> dict[str, Any]:
    row = _join(db, token, account)
    space = db.get(Space, row.space_id) if row.space_id else None
    return {"space": space.name if space else None, "space_id": row.space_id}


# --- Links for a new password -------------------------------------------------------------------------------------


class ResetIn(BaseModel):
    password: str = Field(max_length=200)
    password_confirm: str | None = Field(default=None, max_length=200)


@router.get("/reset/{token}", summary="Whom a link for a new password is for (no sign-in needed)")
def reset_state(token: Token, db: DbSession) -> dict[str, Any]:
    store = KontenStore(db)
    try:
        account = resets.reset_state(store, token, password_login=bool(settings_service.get(db, "password_login")))
    except nexkonten.AccountError as exc:
        raise fail(exc) from exc
    found = store.find_reset(token)
    return {
        "name": account.display_name or account.username,
        "username": account.username,
        "min_password": MIN_PASSWORD,
        "expires_at": found.expires_at.isoformat() if found else None,
    }


@router.post("/reset/{token}", status_code=204, summary="Set a new password with a link; signs in nowhere")
def reset_password(token: Token, payload: ResetIn, request: Request, db: DbSession) -> None:
    """Through the shared module (``resets.use_reset``): every browser session and waiting sign-in of the account
    ends, paired iPhones, API tokens and passkeys stay; after the next sign-in the page lists them ("These devices
    still have access", ``GET /api/auth/access``)."""
    key = "reset:" + client_ip(request)
    wait = brake.wait_seconds(key, NAME_TRIES)
    if wait:
        raise HTTPException(
            status_code=429,
            detail=detail("too_many_attempts", "Too many attempts. Try again later.", retry_after=wait),
            headers={"Retry-After": str(wait)},
        )
    check_password(payload.password)
    check_confirm(payload.password, payload.password_confirm)
    try:
        resets.use_reset(KontenStore(db), token, payload.password,
                         password_login=bool(settings_service.get(db, "password_login")))
    except nexkonten.AccountError as exc:
        if exc.code in ("reset_invalid", "reset_expired"):
            brake.failed(key)
        raise fail(exc) from exc
