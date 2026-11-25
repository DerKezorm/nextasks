"""The mails of the shared account module, through the shared post module: the account module says what to send
(``nexkonten.Mail``), this builds the link from the public address and the token, writes the letter
(``nexpost.letters``) in the language of the account, its browser's at the last sign-in, else the first operator's,
else English, and sends it.

Two ways out, as in 0.8.0 for what somebody waits for:

- ``send_now``: at once, through ``post_store.send_letter`` (the link for a new address, a link for a new password, the
  invitation). A server that does not take it leaves the letter in the outbox for another try
  (``services/post_store.py``), unless the caller wants to hear it failed (``keep=False``).
- ``queue``: into the outbox (a new sign-in, a new username, a changed address, a reset second factor), sent within a
  minute by the worker.
"""

from __future__ import annotations

import logging

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import OPERATOR, Account
from ..vendor import nexkonten, nexpost
from . import clock, post_store, settings_service
from .post_store import PostStore

logger = logging.getLogger("nextasks.mail")

#: Where each link leads in the interface (``/confirm-email/<token>`` as in 0.8.0).
PAGES = {
    nexkonten.MAIL_RESET: "/reset/",
    nexkonten.MAIL_CONFIRM_EMAIL: "/confirm-email/",
}


#: The page Security, where the button "See signed-in devices" of the mail "New sign-in" leads (post 1.0.0).
SECURITY_PAGE = "/settings/security"


def link_for(db: Session, mail: nexkonten.Mail) -> str:
    if mail.kind == nexkonten.MAIL_NEW_SIGN_IN:
        return f"{settings_service.public_url(db)}{SECURITY_PAGE}"
    page = PAGES.get(mail.kind)
    if not page or not mail.token:
        return ""
    return f"{settings_service.public_url(db)}{page}{mail.token}"


def can_mail(db: Session) -> bool:
    """A mail server and the public address (a link in a mail never points anywhere a request made up)."""
    return post_store.configured(db) and bool(settings_service.public_url(db))


def language_for(db: Session, account: Account | None) -> str:
    """The language of a mail to ``account``: its own, its browser's at the last sign-in, else the first operator's,
    else English (the post module has German, English and French)."""
    choices: list[str] = []
    if account is not None:
        choices += [account.language, account.browser_language]
    first = db.scalar(select(Account).where(Account.role == OPERATOR).order_by(Account.id).limit(1))
    if first is not None:
        choices += [first.language, first.browser_language]
    for choice in choices:
        short = (choice or "").strip().lower()[:2]
        if short in nexpost.letters.LANGUAGES:
            return short
    return "en"


def letter_of(db: Session, mail: nexkonten.Mail, *, by: str = "", where: str = "", days: int = 0) -> nexpost.Letter:
    """The letter of a mail of the account module; ``ValueError``/``MailError`` for an address it refuses."""
    account = db.get(Account, int(mail.account_id)) if str(mail.account_id).isdigit() else None
    # The moment of a new sign-in in the person's own zone (the profile's, else the server's); never an address of
    # the net anywhere in the letter (post 1.0.0).
    zone = (account.timezone if account is not None else "") or clock.zone_name()
    return nexpost.letters.from_account_mail(mail, language=language_for(db, account), link=link_for(db, mail),
                                             by=by, where=where, days=days, time_zone=zone)


def queue(db: Session, mail: nexkonten.Mail | None, *, by: str = "", where: str = "", days: int = 0) -> bool:
    """Into the outbox (committed here); False when nothing went in (no mail, no server, an address the post module
    refuses)."""
    if mail is None or not post_store.configured(db):
        return False
    try:
        letter = letter_of(db, mail, by=by, where=where, days=days)
    except (nexpost.MailError, ValueError) as exc:
        logger.warning("Mail not queued kind=%s reason=%s", mail.kind, type(exc).__name__)
        return False
    nexpost.outbox.queue(PostStore(db), letter)
    db.commit()
    return True


def send_now(db: Session, mail: nexkonten.Mail | None, *, days: int = 0, keep: bool = True) -> bool:
    """At once through the mail server. ``keep``: a mail the server did not take waits in the outbox for another
    try (True: it counts as on its way). ``keep=False``: ``post_store.MailError`` for the caller. False when there is
    nothing to send or no server."""
    if mail is None or not post_store.configured(db):
        return False
    try:
        letter = letter_of(db, mail, days=days)
    except (nexpost.MailError, ValueError) as exc:
        logger.warning("Mail not sent kind=%s reason=%s", mail.kind, type(exc).__name__)
        if keep:
            return False
        raise post_store.MailError("invalid_email", "This is not a mail address.") from exc
    try:
        post_store.send_letter(db, letter)
    except post_store.MailError:
        if not keep:
            raise
        nexpost.outbox.queue(PostStore(db), letter)
        db.commit()
        logger.info("Mail waits in the outbox kind=%s", mail.kind)
    return True
