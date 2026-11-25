"""Notifications of the own account, in the web only ("Mein Konto" › "Benachrichtigungen"): the channels with their
state (one column each on the page, drawn from what is sent here), the mail address with its confirmation, the
browsers that take notifications, the reports and events per channel, and unsubscribing from a mail. Every route acts
on the signed-in account alone; none takes the id of another. The iPhone app has no choices of its own: what goes to
it is chosen here (``/api/app/1`` is unchanged).
"""

from __future__ import annotations

import logging
from typing import Annotated, Any

from fastapi import APIRouter, Request
from fastapi import Path as PathParam
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..deps import Account, DbSession, client_ip, confirmed_without_password, too_many
from ..errors import error
from ..models import Account as AccountRow
from ..models import NotifyChannel
from ..security import brake
from ..services import channels, clock, emailaddr, kontenpost, notifyprefs, post_store, spaces, webpush
from ..services.konten_store import KontenStore
from ..vendor import nexkonten
from ..vendor.nexkonten import profiles
from .auth import change_address, fail

logger = logging.getLogger("nextasks.notify")

router = APIRouter(prefix="/api", tags=["notifications"])

Token = Annotated[str, PathParam(min_length=33, max_length=200, pattern=r"^[A-Za-z0-9_-]+$")]


def _own(db: DbSession, account: Any) -> AccountRow:
    row = db.get(AccountRow, account.id)
    assert row is not None
    return row


def _stamp(value: Any) -> str | None:
    return value.isoformat() if value is not None else None


def browsers(db: DbSession, row: AccountRow) -> list[dict[str, Any]]:
    """The browsers that take notifications: named from their ``User-Agent``, never with their push address (only its
    hash, so a browser can find itself)."""
    out = []
    for sub in webpush.subscriptions(db, row.id):
        browser, system = webpush.describe(sub.user_agent or "")
        out.append({"id": sub.id, "browser": browser, "system": system, "since": _stamp(sub.created_at),
                    "last_ok_at": _stamp(sub.last_ok_at), "mark": webpush.endpoint_mark(sub.endpoint)})
    return out


def state(db: DbSession, row: AccountRow) -> dict[str, Any]:
    """Everything the page shows. Every channel appears, with its name, symbol and state in the account's language: one
    the operator did not set up, or one with nothing to deliver to yet, cannot be turned on, but what was chosen for
    it stays."""
    language = spaces.language_of(row)
    shown: list[dict[str, Any]] = []
    for kind, channel in channels.CHANNELS.items():
        status = db.get(NotifyChannel, (row.id, kind))
        head = channel.status(db, row, language)
        entry: dict[str, Any] = {
            "kind": kind,
            "name": channel.name(language),
            "icon": channel.icon,
            "available": channel.available(db),
            "ready": channels.ready(db, row, kind) is not None,
            "state": head.state,
            "summary": head.summary,
            "hint": head.hint,
            "link": head.link,
            "link_label": head.link_label,
            "defaults": sorted(channel.defaults),
            "last_ok_at": _stamp(status.last_ok_at) if status else None,
            "last_error": status.last_error if status else "",
            "last_error_at": _stamp(status.last_error_at) if status else None,
        }
        if kind == "mail":
            entry |= emailaddr.view(db, row)
            entry["can_send"] = not emailaddr.cannot_mail(db)
        if kind == "webpush":
            entry["browsers"] = browsers(db, row)
        shown.append(entry)
    return {
        "channels": shown,
        "reports": list(notifyprefs.REPORTS),
        "events": list(notifyprefs.EVENTS),
        "routes": notifyprefs.routes_of(db, row.id),
        "schedules": notifyprefs.schedules_of(db, row.id),
        "timezone": row.timezone or clock.zone_name(),
    }


def _choice_error(exc: notifyprefs.ChoiceError) -> Exception:
    return error(exc.code, exc.message, exc.status)


@router.get("/notify", summary="The own notifications: channels, choices, report times")
def read(account: Account, db: DbSession) -> dict[str, Any]:
    return state(db, _own(db, account))


class RouteIn(BaseModel):
    event: str = Field(max_length=32)
    channel: str = Field(max_length=16)
    on: bool


@router.put("/notify/routes", summary="Turn one report or event on one channel on or off")
def set_route(payload: RouteIn, account: Account, db: DbSession) -> dict[str, Any]:
    row = _own(db, account)
    try:
        notifyprefs.set_route(db, row, payload.event, payload.channel, payload.on)
    except notifyprefs.ChoiceError as exc:
        raise _choice_error(exc) from exc
    logger.info("Notification choice event=%s channel=%s on=%s", payload.event, payload.channel, payload.on)
    return state(db, row)


class ScheduleIn(BaseModel):
    time: str = Field(max_length=5)
    weekday: int | None = None


@router.put("/notify/schedules/{report}", summary="When a report comes (in the account's time zone)")
def set_schedule(report: Annotated[str, PathParam(max_length=16)], payload: ScheduleIn, account: Account,
                 db: DbSession) -> dict[str, Any]:
    row = _own(db, account)
    try:
        notifyprefs.set_schedule(db, row.id, report, payload.time, payload.weekday)
    except notifyprefs.ChoiceError as exc:
        raise _choice_error(exc) from exc
    return state(db, row)


@router.delete("/notify/browsers/{subscription_id}", summary="One of the own browsers takes no more notifications")
def remove_browser(subscription_id: int, account: Account, db: DbSession) -> dict[str, Any]:
    row = _own(db, account)
    if not webpush.remove(db, row.id, subscription_id):
        raise error("not_found", "Not found.", 404)
    logger.info("Browser removed from notifications")
    return state(db, row)


# --- The mail address ------------------------------------------------------------------------------------------------
#
# Through the shared account module (``vendor/nexkonten``, ``services/konten_store.py``): a new address needs the own
# password (an account without one: a fresh sign-in at its provider); with a mail server and the public address it
# waits for the link mailed to it (at once: a server that does not take it leaves nothing waiting), without them it
# counts at once. The paths and fields of 0.8.0 stay; the link of 0.8.0 (``nxm_…``) keeps working.


class EmailIn(BaseModel):
    address: str = Field(max_length=320)
    #: The own password (since the shared account module); an account without one confirms by a fresh sign-in.
    password: str = Field(default="", max_length=200)


@router.put("/me/email", summary="Enter the own mail address (with the password); with a mail server it waits for "
                                 "its link")
def set_email(payload: EmailIn, request: Request, account: Account, db: DbSession) -> dict[str, Any]:
    row = _own(db, account)
    address = payload.address.strip()
    if not address:
        raise error("invalid_email", "This is not a mail address.", 422)
    try:
        fresh = confirmed_without_password(request, db, row)
        pending = change_address(db, row, address, password=payload.password, fresh=fresh)
    except nexkonten.AccountError as exc:
        db.rollback()
        raise fail(exc) from exc
    db.refresh(row)
    return {**state(db, row), "sent": bool(pending)}


@router.post("/me/email/resend", summary="Mail the link for the waiting address once more")
def resend_email(account: Account, db: DbSession) -> dict[str, Any]:
    row = _own(db, account)
    try:
        mail = profiles.resend_email_link(KontenStore(db), row.id)
    except nexkonten.AccountError as exc:
        if exc.code == "no_pending_email":
            # The code of 0.8.0.
            raise error("email_nothing_waits", "No address waits for its confirmation.", 404) from exc
        raise fail(exc) from exc
    try:
        kontenpost.send_now(db, mail, keep=False)
    except post_store.MailError as exc:
        profiles.withdraw_email_change(KontenStore(db), row.id)
        status = 409 if exc.code == "mail_off" else 502
        raise error(exc.code, "The mail server did not take the mail.", status) from exc
    db.refresh(row)
    return state(db, row)


@router.post("/me/email/prove", summary="Mail a link that proves the address the account has (konten 1.1.0)")
def prove_email(account: Account, db: DbSession) -> dict[str, Any]:
    """The box "Address not confirmed yet" in the profile: an address that counts but was never proven by link."""
    row = _own(db, account)
    try:
        mail = profiles.prove_email(KontenStore(db), row.id)
    except nexkonten.AccountError as exc:
        raise fail(exc) from exc
    try:
        kontenpost.send_now(db, mail, keep=False)
    except post_store.MailError as exc:
        profiles.withdraw_email_change(KontenStore(db), row.id)
        status = 409 if exc.code == "mail_off" else 502
        raise error(exc.code, "The mail server did not take the mail.", status) from exc
    db.refresh(row)
    return state(db, row)


@router.delete("/me/email/pending", summary="Forget the address that waits for its confirmation")
def cancel_email(account: Account, db: DbSession) -> dict[str, Any]:
    row = _own(db, account)
    profiles.withdraw_email_change(KontenStore(db), row.id)
    db.refresh(row)
    return state(db, row)


class RemoveEmailIn(BaseModel):
    #: The own password (an account without one: a fresh sign-in at its provider instead).
    password: str = Field(default="", max_length=200)


@router.delete("/me/email", summary="Remove the own mail address (no more mail); needs the own password")
def remove_email(payload: RemoveEmailIn, request: Request, account: Account, db: DbSession) -> dict[str, Any]:
    """Taking the own address away asks for the own password (konten 0.3.10, replaces "Entfernen geht immer"); an
    account without one proves it by a fresh sign-in at its provider. The old address hears of it where a mail can
    go."""
    row = _own(db, account)
    try:
        fresh = confirmed_without_password(request, db, row)
        changed = profiles.remove_email(KontenStore(db), row.id, actor_id=row.id, password=payload.password,
                                        actor_confirmed=fresh, mail=kontenpost.can_mail(db))
    except nexkonten.AccountError as exc:
        db.rollback()
        raise fail(exc) from exc
    kontenpost.queue(db, changed.notice)
    db.refresh(row)
    return state(db, row)


class ConfirmIn(BaseModel):
    token: str = Field(max_length=100)


def _link_brake(request: Request) -> str:
    return "email-link:" + client_ip(request)


@router.get("/email/{token}", summary="Which address a confirmation link confirms (no sign-in needed)")
def email_link_state(token: Annotated[str, PathParam(max_length=100)], db: DbSession) -> dict[str, Any]:
    try:
        change = profiles.email_change_state(KontenStore(db), token)
    except nexkonten.AccountError as exc:
        raise fail(exc) from exc
    return {"email": change.address}


@router.post("/email/confirm", summary="The link from the mail: the waiting address counts (no sign-in needed)")
def confirm_email(payload: ConfirmIn, request: Request, db: DbSession) -> dict[str, str]:
    key = _link_brake(request)
    wait = brake.wait_seconds(key)
    if wait:
        raise too_many(wait)
    try:
        changed = profiles.confirm_email(KontenStore(db), payload.token)
    except nexkonten.AccountError as exc:
        if exc.code in ("email_link_invalid", "email_link_expired"):
            brake.failed(key)
        if exc.code == "email_link_expired":
            # 0.8.0 knew one answer for a link that does not work any more.
            raise error("email_link_invalid", "This link does not work any more.", 404) from exc
        raise fail(exc) from exc
    kontenpost.queue(db, changed.notice)
    logger.info("Address confirmed name=%s address=%s", changed.account.username,
                emailaddr.masked(changed.account.email))
    return {"email": changed.account.email}


# --- Unsubscribing ---------------------------------------------------------------------------------------------------


def _token(token: str) -> tuple[int, str, str]:
    found = notifyprefs.read_token(token)
    if found is None:
        raise error("unsubscribe_invalid", "This link does not work.", 404)
    return found


@router.get("/notify/unsubscribe/{token}", summary="What a link from a mail would turn off (no sign-in needed)")
def unsubscribe_info(token: Token, db: DbSession) -> dict[str, Any]:
    account_id, event, channel = _token(token)
    on = db.scalar(select(AccountRow.id).where(AccountRow.id == account_id)) is not None and notifyprefs.is_on(
        db, account_id, event, channel)
    return {"event": event, "channel": channel, "on": bool(on)}


@router.post("/notify/unsubscribe/{token}", summary="Turn off the report or event of a mail (one click, RFC 8058)")
def unsubscribe(token: Token, db: DbSession) -> dict[str, Any]:
    # The body a mail program sends (``List-Unsubscribe=One-Click``) says nothing more than the address.
    account_id, event, channel = _token(token)
    was_on = notifyprefs.off(db, account_id, event, channel)
    if was_on:
        logger.info("Unsubscribed by link account_id=%s event=%s channel=%s", account_id, event, channel)
    return {"event": event, "channel": channel, "on": False}

