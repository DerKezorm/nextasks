"""The operator's list of accounts: roles, blocking, deleting, names, the address, reset links.

The operator never sets somebody else's password (a link lets the person set their own, ``POST …/reset-link``; the
route of 0.8.0 that set one answers 410 for one version). Every act that a stolen session must not be enough for asks
for the operator's own password once more (``deps.confirm_operator``; an operator without one: a fresh sign-in at the
provider). The fields of the list are those of 0.8.0 and what the shared module's list of accounts (konten 0.3.9,
``ListedAccount``) reads.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from ..deps import DbSession, OperatorAccount, confirm_operator
from ..errors import error
from ..models import OPERATOR, ROLES, Member, utcnow
from ..models import Account as AccountRow
from ..security import end_all_sessions
from ..services import accounts, kontenpost, mailer, settings_service
from ..services.konten_store import KontenStore
from ..services.oidc_store import linked_providers
from ..vendor import nexkonten
from ..vendor.nexkonten import invites, profiles, resets
from ..vendor.nexkonten import login as konten_login
from .auth import OperatorConfirmIn, account_view, fail

logger = logging.getLogger("nextasks.auth")

router = APIRouter(prefix="/api/accounts", tags=["accounts"])


class RoleIn(BaseModel):
    role: str = Field(max_length=16)
    #: The operator's own password once more (see ``confirm_operator``); empty for an account from a provider.
    current_password: str = Field(default="", max_length=200)


class PasswordSetIn(BaseModel):
    password: str = Field(default="", max_length=200)
    current_password: str = Field(default="", max_length=200)


class ResetLinkIn(BaseModel):
    #: How long the link holds: 1, 7 or 30 days (the shared module's ``OPERATOR_DAYS``, one from the start).
    days: int = resets.OPERATOR_DAYS_DEFAULT
    #: Mail it to the account's address that counts, where a mail server is there; False shows the link once.
    send: bool = True
    current_password: str = Field(default="", max_length=200)


class NameIn(BaseModel):
    name: str = Field(max_length=64)
    current_password: str = Field(default="", max_length=200)


class DisplayNameIn(BaseModel):
    display_name: str = Field(max_length=200)
    current_password: str = Field(default="", max_length=200)


def _row(db: DbSession, account_id: int) -> AccountRow:
    row = db.get(AccountRow, account_id)
    if row is None:
        raise error("not_found", "No such account.", 404)
    return row


#: What the list does not show of somebody else's account (their own page does).
PRIVATE = ("two_factor_recovery_left", "new_password_origin", "new_sign_in_mail", "password_reset_notice",
           "second_factor_off", "provider_email", "provider_email_from")


def listed(db: DbSession, row: AccountRow, linked: dict[int, list[dict[str, object]]],
           spaces: dict[int, int] | None = None) -> dict[str, Any]:
    """One row of the list: the fields of 0.8.0 (``spaces``, ``locked``, ``blocked``, ``has_password``,
    ``providers``) and those of the module's list (``email_duplicate``, ``authenticator``, ``passkeys``,
    ``blocked_at``, ``former_name``; ``email_confirmed`` says the address counts)."""
    view = account_view(row, db)
    for private in PRIVATE:
        view.pop(private, None)
    store = KontenStore(db)
    konto = store.get_account(row.id)
    if spaces is None:
        spaces = {row.id: int(db.scalar(select(func.count()).select_from(Member)
                                       .where(Member.account_id == row.id)) or 0)}
    return {
        **view,
        "spaces": spaces.get(row.id, 0),
        # The address is held by another account too (left by 0.8.0): it signs nobody in, the list says so.
        "email_duplicate": bool(konto and konten_login.duplicate_email(store, konto)),
        "authenticator": bool(row.totp_secret_enc),
        "locked": accounts.is_locked(row),
        "blocked": row.blocked_at is not None,
        "blocked_at": row.blocked_at.isoformat() if row.blocked_at else None,
        "providers": linked.get(row.id, []),
    }


@router.get("", summary="All accounts")
def list_accounts(_operator: OperatorAccount, db: DbSession) -> list[dict[str, Any]]:
    spaces: dict[int, int] = {}
    for account_id in db.scalars(select(Member.account_id)):
        spaces[account_id] = spaces.get(account_id, 0) + 1
    # The providers each account is linked to, as marks in the operator's list (the shared sign-in blueprint 04).
    linked = linked_providers(db)
    return [listed(db, row, linked, spaces) for row in db.scalars(select(AccountRow).order_by(AccountRow.created_at))]


@router.delete("/{account_id}", status_code=204, summary="Delete an account for good (its tasks stay)")
def delete_account(
    account_id: int, payload: OperatorConfirmIn, request: Request, operator: OperatorAccount, db: DbSession,
) -> None:
    """It leaves every space (its reminders stay; where it was the last manager, the member who joined first becomes
    manager), its space "Private" goes for good. Its username stays reserved for good (the draft: nobody inherits
    another's mentions or history)."""
    confirm_operator(request, db, operator, payload.current_password)
    if account_id == operator.id:
        raise error("cannot_delete_self", "You cannot delete your own account.", 409)
    row = _row(db, account_id)
    name = row.name
    accounts.delete_account(db, row)
    logger.warning("Account deleted name=%s by=%s", name, operator.name)


@router.post("/{account_id}/sign-out", status_code=204, summary="End every session of an account")
def sign_out_account(account_id: int, operator: OperatorAccount, db: DbSession) -> None:
    row = _row(db, account_id)
    end_all_sessions(db, row.id)
    logger.warning("All sessions ended name=%s by=%s", row.name, operator.name)


@router.post("/{account_id}/block", status_code=204, summary="Block an account (its sessions end)")
def block_account(
    account_id: int, payload: OperatorConfirmIn, request: Request, operator: OperatorAccount, db: DbSession,
) -> None:
    """Blocked, the account gets in nowhere, by no session, device or token; its reminders stay where they are."""
    confirm_operator(request, db, operator, payload.current_password)
    if account_id == operator.id:
        raise error("cannot_block_self", "You cannot block yourself.", 409)
    row = _row(db, account_id)
    row.blocked_at = utcnow()
    db.commit()
    end_all_sessions(db, row.id)
    logger.warning("Account blocked name=%s by=%s", row.name, operator.name)


@router.post("/{account_id}/unblock", status_code=204, summary="Let a blocked account in again")
def unblock_account(
    account_id: int, payload: OperatorConfirmIn, request: Request, operator: OperatorAccount, db: DbSession,
) -> None:
    confirm_operator(request, db, operator, payload.current_password)
    row = _row(db, account_id)
    row.blocked_at = None
    db.commit()
    logger.warning("Account unblocked name=%s by=%s", row.name, operator.name)


@router.put("/{account_id}/role", summary="Make an account operator or member")
def set_role(
    account_id: int, payload: RoleIn, request: Request, operator: OperatorAccount, db: DbSession,
) -> dict[str, Any]:
    confirm_operator(request, db, operator, payload.current_password)
    if payload.role not in ROLES:
        raise error("invalid_role", "Unknown role.", 422)
    row = _row(db, account_id)
    if row.id == operator.id and payload.role != OPERATOR:
        raise error("cannot_demote_self", "You cannot take the operator role from yourself.", 409)
    row.role = payload.role
    db.commit()
    logger.warning("Role changed name=%s role=%s by=%s", row.name, payload.role, operator.name)
    return account_view(row, db)


@router.put("/{account_id}/password", status_code=410, summary="Gone: the operator makes a reset link instead")
def set_password(account_id: int, payload: PasswordSetIn, _operator: OperatorAccount) -> None:
    """0.8.0 let the operator set somebody else's password. Since the shared account module the operator never does
    (the draft): ``POST /api/accounts/{id}/reset-link`` makes a link with which the person sets their own. This route
    answers 410 for one version, so that a script notices."""
    del account_id, payload
    raise error("use_reset_link", "The operator no longer sets passwords. Make a link for a new password instead: "
                "POST /api/accounts/{id}/reset-link.", 410)


@router.post("/{account_id}/reset-link", status_code=201,
             summary="A link with which the person sets a new password themselves (mailed, or shown once)")
def reset_link(
    account_id: int, payload: ResetLinkIn, request: Request, operator: OperatorAccount, db: DbSession,
) -> dict[str, Any]:
    """Through the shared account module (``resets.reset_link``), after the operator's own confirmation: with a mail
    server, the public address and an address that counts it goes there at once (``sent``), otherwise the answer
    shows it once. Also for a blocked account (the block stays), never for the operator's own; an account through a
    provider only gets its first password this way, while signing in by password is on."""
    confirm_operator(request, db, operator, payload.current_password)
    row = _row(db, account_id)
    try:
        made = resets.reset_link(
            KontenStore(db), row.id, actor_id=operator.id, actor_confirmed=True,
            mail=payload.send and kontenpost.can_mail(db),
            password_login=bool(settings_service.get(db, "password_login")), days=payload.days,
        )
    except nexkonten.AccountError as exc:
        raise fail(exc) from exc
    logger.warning("Password reset link made name=%s by=%s", row.name, operator.name)
    if made.mail is not None:
        try:
            kontenpost.send_now(db, made.mail, days=payload.days, keep=False)
        except mailer.MailError as exc:
            resets.reset_mail_failed(KontenStore(db), row.id)
            raise error(exc.code, "The mail server did not take the mail.", 409 if exc.code == "mail_off" else 502) \
                from exc
        return {"link": None, "sent": True, "expires_at": made.expires_at.isoformat()}
    link = invites.invite_link(settings_service.public_url(db), "/reset/", made.token,
                               request_base=str(request.base_url))
    return {"link": link, "sent": False, "expires_at": made.expires_at.isoformat()}


@router.put("/{account_id}/name", summary="Give an account another username")
def set_name(account_id: int, payload: NameIn, request: Request, operator: OperatorAccount,
             db: DbSession) -> dict[str, Any]:
    confirm_operator(request, db, operator, payload.current_password)
    row = _row(db, account_id)
    try:
        notice = profiles.change_username(KontenStore(db), row.id, payload.name, actor_id=operator.id,
                                          actor_confirmed=True)
    except nexkonten.AccountError as exc:
        raise fail(exc) from exc
    kontenpost.queue(db, notice)
    db.refresh(row)
    logger.warning("Username changed account_id=%s by=%s", row.id, operator.name)
    return listed(db, row, linked_providers(db))


@router.put("/{account_id}/display-name", summary="Give an account another display name")
def set_display_name(account_id: int, payload: DisplayNameIn, request: Request, operator: OperatorAccount,
                     db: DbSession) -> dict[str, Any]:
    confirm_operator(request, db, operator, payload.current_password)
    row = _row(db, account_id)
    try:
        profiles.change_display_name(KontenStore(db), row.id, payload.display_name, actor_id=operator.id,
                                     actor_confirmed=True)
    except nexkonten.AccountError as exc:
        raise fail(exc) from exc
    db.refresh(row)
    return listed(db, row, linked_providers(db))


@router.delete("/{account_id}/email", summary="Take an account's address away (never set one)")
def remove_email(account_id: int, payload: OperatorConfirmIn, request: Request, operator: OperatorAccount,
                 db: DbSession) -> dict[str, Any]:
    confirm_operator(request, db, operator, payload.current_password)
    row = _row(db, account_id)
    try:
        changed = profiles.remove_email(KontenStore(db), row.id, actor_id=operator.id, actor_confirmed=True,
                                        mail=kontenpost.can_mail(db))
    except nexkonten.AccountError as exc:
        raise fail(exc) from exc
    kontenpost.queue(db, changed.notice)
    db.refresh(row)
    logger.warning("Address removed account_id=%s by=%s", row.id, operator.name)
    return listed(db, row, linked_providers(db))
