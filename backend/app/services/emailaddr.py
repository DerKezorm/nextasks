"""The mail address of an account as nextasks' notifications see it.

``Account.email`` is the address an account has. Since the shared account module (``services/konten_store.py``) two
answers belong to it: it **counts** (signing in, a forgotten password, notifications by mail) when it was proven by a
link (``email_confirmed``, as in 0.8.0) or counted without one (``email_counted``: the address of an invitation, one
set without a mail server, the setup's), and it is **proven** when its link was opened. Notifications go to an address
that counts (the module's interface: "Mitteilungen an Adressen, die zählen").

Changing, confirming and removing the address run through the module (``routers/notifications.py``,
``routers/auth.py``); this module only reads.
"""

from __future__ import annotations

import logging

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Account, OidcLink
from ..vendor.nexkonten import brake
from . import accounts, mailer, settings_service
from .konten_store import counts, pending_of, same

logger = logging.getLogger("nextasks.email")

OWN = "own"
LINK_HOURS = 24
#: Confirmation mails one account may cause before it waits: the module's brake at the door ``mail:<account>`` (five
#: free; the sixth is counted and then waits).
SENDS_PER_HOUR = brake.FREE["mail"] + 1
MAX_LENGTH = 254

__all__ = ["cannot_mail", "clean", "confirmed", "masked", "pending_of", "same", "suggestion", "view"]


class AddressError(Exception):
    def __init__(self, code: str, message: str, status: int) -> None:
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


def confirmed(account: Account) -> bool:
    """The account's address counts for mail."""
    return counts(account)


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


def cannot_mail(db: Session) -> str:
    """Why no link can go out, as an error code, or empty when it can."""
    if not mailer.configured(db):
        return "mail_off"
    if not settings_service.public_url(db):
        return "public_url_missing"
    return ""


def suggestion(db: Session, account: Account) -> str:
    """The address offered in the profile: the one a sign-in provider sends (the module keeps it as
    ``provider_email`` for an account with a password; the link names it for any other), only when it is not the
    address that counts already and passes the check typed addresses pass; else an address that does not count
    yet."""
    offer = account.provider_email
    counted_already = confirmed(account) and same(offer, account.email)
    if offer and not same(offer, account.provider_email_off) and not counted_already:
        return offer
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
        if same(address, account.provider_email_off):
            continue
        return address
    if account.email and not confirmed(account):
        return account.email
    return ""


def view(db: Session, account: Account) -> dict[str, object]:
    waiting = pending_of(account)
    until = account.email_pending_until if waiting else None
    return {
        "address": account.email if confirmed(account) else "",
        "confirmed": confirmed(account),
        "pending": waiting,
        "pending_until": until.isoformat() if until else None,
        "suggestion": suggestion(db, account),
    }


def forget() -> None:
    """For the tests: the brake of the doors starts empty (it is the module's, emptied with the sign-in brake)."""


def masked(address: str) -> str:
    local, _, domain = address.partition("@")
    return f"{local[:2]}***@{domain}" if domain else f"{local[:2]}***"
