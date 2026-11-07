"""The mail address of an account, confirmed by a link (as nexlore 1.5.1 does it).

``Account.email`` is the address an account has: typed in the profile, brought by an invitation, or sent by a sign-in
provider. Mail goes out only to a **confirmed** address (``Account.email_confirmed`` equal to ``email``): its owner
opened the link that went there. An address a provider sends is offered in the profile and counts once confirmed like
any other. An address never finds an account (the sign-in blueprint): providers find accounts by their identity only.

Entering an address mails a link (24 hours, once); until it is opened the address waits in ``email_pending`` and the
confirmed one stays in force. No two accounts confirm the same address. Mail needs the operator's SMTP server and the
public address of nextasks (the link must never point to an address a request made up).
"""

from __future__ import annotations

import hashlib
import logging
import secrets
import threading
import time
from collections import deque
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import Account, OidcLink
from . import accounts, mailer, messages, settings_service, spaces

logger = logging.getLogger("nextasks.email")

OWN = "own"
LINK_HOURS = 24
#: Confirmation mails one account may cause in an hour: a link goes to any address typed in, no relay for spam.
SENDS_PER_HOUR = 5
MAX_LENGTH = 254
TOKEN_PREFIX = "nxm_"

_sends: dict[int, deque[float]] = {}
_sends_lock = threading.Lock()


class AddressError(Exception):
    def __init__(self, code: str, message: str, status: int) -> None:
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


def same(one: str, other: str) -> bool:
    return bool(one) and bool(other) and one.casefold() == other.casefold()


def confirmed(account: Account) -> bool:
    """The account's address counts for mail: its link was opened."""
    return same(account.email, account.email_confirmed)


def clean(address: str) -> str:
    address = address.strip()
    if (
        not address
        or len(address) > MAX_LENGTH
        or any(ord(char) < 32 or ord(char) == 127 for char in address)
        or not accounts.EMAIL_PATTERN.match(address)
    ):
        raise AddressError("invalid_email", "This is not a mail address.", 422)
    return address


def taken(db: Session, address: str, but: int) -> bool:
    """Another account confirmed this address (any case)."""
    return db.scalar(
        select(Account.id).where(func.lower(Account.email_confirmed) == address.lower(), Account.id != but).limit(1)
    ) is not None


def cannot_mail(db: Session) -> str:
    """Why no link can go out, as an error code, or empty when it can."""
    if not mailer.configured(db):
        return "mail_off"
    if not settings_service.public_url(db):
        return "public_url_missing"
    return ""


def pending_of(account: Account, now: datetime | None = None) -> str:
    until = account.email_pending_until
    if not account.email_pending or until is None:
        return ""
    return account.email_pending if until > (now or datetime.now(UTC)) else ""


def suggestion(db: Session, account: Account) -> str:
    """The address the account's sign-in provider sends, offered in the profile: only when it is not the confirmed
    one already and passes the check typed addresses pass."""
    found = db.scalars(select(OidcLink.email).where(OidcLink.account_id == account.id)
                       .order_by(OidcLink.last_used_at.desc().nulls_last(), OidcLink.id.desc())).all()
    for address in found:
        if not address:
            continue
        try:
            address = clean(address)
        except AddressError:
            continue
        if confirmed(account) and same(address, account.email):
            return ""
        return address
    # An address an invitation or a provider brought in, not yet confirmed: the same offer.
    if account.email and not confirmed(account):
        return account.email
    return ""


def view(db: Session, account: Account) -> dict[str, object]:
    until = account.email_pending_until if pending_of(account) else None
    return {
        "address": account.email if confirmed(account) else "",
        "confirmed": confirmed(account),
        "pending": pending_of(account),
        "pending_until": until.isoformat() if until else None,
        "suggestion": suggestion(db, account),
    }


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _brake(account_id: int) -> None:
    now = time.monotonic()
    with _sends_lock:
        sent = _sends.setdefault(account_id, deque())
        while sent and now - sent[0] > 3600:
            sent.popleft()
        if len(sent) >= SENDS_PER_HOUR:
            raise AddressError("too_many_attempts", "Too many mails in an hour; try again later.", 429)
        sent.append(now)


def forget() -> None:
    """For the tests: the brake starts empty."""
    with _sends_lock:
        _sends.clear()


def _clear_pending(account: Account) -> None:
    account.email_pending = ""
    account.email_pending_hash = ""
    account.email_pending_until = None


def request(db: Session, account: Account, address: str) -> bool:
    """An address entered in the profile: a link goes to it, it counts once that is opened. False when it is the
    confirmed address already (nothing is sent then)."""
    address = clean(address)
    if confirmed(account) and same(address, account.email):
        _clear_pending(account)
        db.commit()
        return False
    reason = cannot_mail(db)
    if reason:
        raise AddressError(reason, "nextasks cannot send mail yet.", 409)
    _brake(account.id)
    token = TOKEN_PREFIX + secrets.token_urlsafe(32)
    account.email_pending = address
    account.email_pending_hash = _hash(token)
    account.email_pending_until = datetime.now(UTC) + timedelta(hours=LINK_HOURS)
    db.commit()
    link = f"{settings_service.public_url(db)}/confirm-email/{token}"
    message = messages.confirm(spaces.language_of(account), link=link, name=account.display_name or account.name,
                               hours=LINK_HOURS)
    try:
        mailer.send_message(db, address, message)
    except mailer.MailError as exc:
        # Not sent, nothing waits: the profile shows what counts, not an address nobody can confirm.
        _clear_pending(account)
        db.commit()
        raise AddressError(exc.code, "The mail server did not take the mail.", 502) from exc
    logger.info("Address confirmation sent name=%s address=%s", account.name, masked(address))
    return True


def resend(db: Session, account: Account) -> None:
    waiting = pending_of(account)
    if not waiting:
        raise AddressError("email_nothing_waits", "No address waits for its confirmation.", 404)
    request(db, account, waiting)


def cancel(db: Session, account: Account) -> None:
    _clear_pending(account)
    db.commit()


def confirm(db: Session, token: str) -> Account:
    """The link from the mail was opened: the waiting address counts from now on. No sign-in needed (the link is the
    proof); used once, or late, it does nothing."""
    if not token.startswith(TOKEN_PREFIX) or len(token) > 100:
        raise AddressError("email_link_invalid", "This link does not work any more.", 404)
    account = db.scalar(select(Account).where(Account.email_pending_hash == _hash(token)))
    if account is None or not pending_of(account):
        raise AddressError("email_link_invalid", "This link does not work any more.", 404)
    address = account.email_pending
    _clear_pending(account)
    if taken(db, address, account.id):
        db.commit()
        logger.warning("Address confirmation refused, another account has it name=%s address=%s",
                       account.name, masked(address))
        raise AddressError("email_taken", "Another account has this address already.", 409)
    account.email = address
    account.email_confirmed = address
    account.email_source = OWN
    db.commit()
    logger.info("Address confirmed name=%s address=%s", account.name, masked(address))
    return account


def remove(db: Session, account: Account) -> None:
    account.email = ""
    account.email_confirmed = ""
    account.email_source = ""
    _clear_pending(account)
    db.commit()
    logger.info("Address removed name=%s", account.name)


def masked(address: str) -> str:
    local, _, domain = address.partition("@")
    return f"{local[:2]}***@{domain}" if domain else f"{local[:2]}***"
