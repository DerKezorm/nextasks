"""Accounts: the first is the operator, the others come by invitation or through OIDC.

An invitation is a link with an end date for one person. It may name a space: whoever follows it gets an account (when
they have none yet) and becomes a member there. Signed in already, following it only makes the account a member.
Managers invite into their spaces (never into "Private"); the operator also invites into nextasks without a space.

Setting up, signing in, accepting an invitation with a new account, the profile and a forgotten password run through
the shared account module (``vendor/nexkonten``, store ``services/konten_store.py``). What stays here is nextasks' own:
making and finding invitations (they lead into spaces), joining a space, the lock per account for the password typed
again on nextasks' own pages, and the address check of the operator's settings.
"""

from __future__ import annotations

import logging
import re
import secrets
from datetime import timedelta
from functools import lru_cache

from sqlalchemy import delete, func, select
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from .. import __version__
from ..models import (
    MANAGER,
    MEMBER,
    ROLES,
    SIGN_IN_PASSWORD,
    SPACE_MEMBER,
    Account,
    Invite,
    Space,
    utcnow,
)
from ..security import LOCK_MINUTES, MAX_FAILURES, hash_password, hash_token, verify_password

logger = logging.getLogger("nextasks.auth")

NAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]{1,63}$")
#: Enough to catch a typo, not a validation of the address: the mail server has the last word.
#: No control character (NUL, ESC, DEL went through into the mail before, A13), and ``\Z``: ``$`` lets a closing
#: line break pass.
_PART = r"[^@\s<>,;\x00-\x1f\x7f-\x9f]+"
EMAIL_PATTERN = re.compile(rf"^{_PART}@{_PART}\.{_PART}\Z")
#: How long an invitation may run, in days; the one who invites picks within this.
INVITE_DAYS = (1, 7, 30)


class AccountError(Exception):
    def __init__(self, code: str, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


def count(db: Session) -> int:
    return int(db.scalar(select(func.count()).select_from(Account)) or 0)


def by_name(db: Session, name: str) -> Account | None:
    return db.scalar(select(Account).where(Account.name == name.strip().lower()))


def check_name(db: Session, name: str) -> str:
    cleaned = name.strip().lower()
    if not NAME_PATTERN.match(cleaned):
        raise AccountError("invalid_account_name", "Use 2 to 64 letters, digits, dots, dashes or underscores.", 422)
    if by_name(db, cleaned) is not None:
        raise AccountError("name_taken", "This name is already taken.", 409)
    return cleaned


def create_with_password(db: Session, name: str, password: str, role: str = MEMBER, *, commit: bool = True) -> Account:
    if role not in ROLES:
        raise ValueError("unknown role")
    account = Account(
        name=check_name(db, name),
        role=role,
        sign_in=SIGN_IN_PASSWORD,
        password_hash=hash_password(password),
        whats_new_seen=__version__,
    )
    db.add(account)
    if commit:
        db.commit()
    else:
        db.flush()
    logger.info("Account created name=%s role=%s sign_in=password", account.name, role)
    return account


def setup_code() -> str:
    """What the first account must bring: ``NEXTASKS_SETUP_TOKEN`` (16 characters at least), else a code made at
    start and written to the log (the shared account module, ``setup.setup_code``)."""
    from ..vendor.nexkonten import setup

    return setup.setup_code()


def announce_setup_code(db: Session) -> None:
    """At start, while nobody has set nextasks up: the code in the log (the shared account module)."""
    from ..vendor.nexkonten import setup
    from .konten_store import KontenStore

    setup.announce_setup(KontenStore(db))


#: The first language of an ``Accept-Language`` header: ``de`` from ``de-DE,de;q=0.9,en;q=0.8``.
_FIRST_LANGUAGE = re.compile(r"\s*([A-Za-z]{2,3})(?:[-_][A-Za-z0-9]{1,8})*\s*(?:[;,]|$)")


def note_browser_language(account: Account, header: str) -> None:
    """Remembers the browser's language at a sign-in, for what the server writes for the account while it has no
    language of its own (Prüfgang E33). Stored with the session the sign-in starts."""
    found = _FIRST_LANGUAGE.match(header or "")
    if found:
        account.browser_language = found.group(1).lower()


@lru_cache(maxsize=1)
def _dummy_hash() -> str:
    """A hash to verify against for an unknown name: the answer takes as long as for a wrong password."""
    return hash_password(secrets.token_urlsafe(24))


def is_locked(account: Account) -> bool:
    return account.locked_until is not None and account.locked_until > utcnow()


def note_failure(db: Session, account: Account) -> None:
    """A wrong password: counted per account, locked after too many, whoever the sender is."""
    account.failed_logins += 1
    if account.failed_logins >= MAX_FAILURES:
        account.locked_until = utcnow() + timedelta(minutes=LOCK_MINUTES)
        account.failed_logins = 0
        logger.warning("Account locked after %s failures name=%s minutes=%s", MAX_FAILURES, account.name, LOCK_MINUTES)
    else:
        logger.warning(
            "Check failed name=%s (%s of %s before lockout)", account.name, account.failed_logins, MAX_FAILURES
        )
    db.commit()


def note_success(db: Session, account: Account) -> None:
    account.failed_logins = 0
    account.locked_until = None
    account.last_seen_at = utcnow()
    db.commit()


def check_password(account: Account, password: str) -> bool:
    return account.sign_in == SIGN_IN_PASSWORD and verify_password(password, account.password_hash)


def change_password(db: Session, account: Account, current: str, new: str) -> None:
    if not verify_password(current, account.password_hash):
        raise AccountError("wrong_password", "The current password is wrong.", 401)
    if new == current:
        # Taken before, and it ended the other sessions as if something had changed (Prüfgang E25).
        raise AccountError("password_unchanged", "The new password is the same as the current one.", 422)
    account.password_hash = hash_password(new)
    account.password_changed_at = utcnow()
    db.commit()
    logger.info("Password changed name=%s", account.name)


# --- Invitations ---------------------------------------------------------------------------------------------------


def create_invite(db: Session, by: Account, *, space_id: str | None, days: int, email: str = "",
                  display_name: str = "") -> tuple[Invite, str]:
    if days not in INVITE_DAYS:
        raise AccountError("invalid_days", "Choose 1, 7 or 30 days.", 422)
    token = secrets.token_urlsafe(24)
    invite = Invite(
        token_hash=hash_token(token), space_id=space_id, email=email.strip()[:255], created_by=by.id,
        expires_at=utcnow() + timedelta(days=days), display_name=display_name[:80],
    )
    db.add(invite)
    db.commit()
    logger.info("Invite created by=%s space_id=%s", by.name, space_id or "-")
    return invite, token


def expired(invite: Invite) -> bool:
    return invite.expires_at <= utcnow()


def invite_allowed(db: Session, invite: Invite) -> bool:
    """Whether the maker may still bring people in with it: into a space only while it still manages the space (a
    manager who lost the role must not keep bringing people in with an old link) and the space is not private."""
    from . import spaces

    if invite.space_id is not None:
        space = db.get(Space, invite.space_id)
        if space is None or space.private or invite.created_by is None:
            return False
        if spaces.role_of(db, invite.created_by, invite.space_id) != MANAGER:
            return False
    return True


def find_invite(db: Session, token: str) -> Invite | None:
    """A usable invitation: not run out, and its maker may still invite (``invite_allowed``)."""
    invite = db.scalar(select(Invite).where(Invite.token_hash == hash_token(token)))
    if invite is None or invite.expires_at <= utcnow() or not invite_allowed(db, invite):
        return None
    return invite


def invite_ran_out(db: Session, token: str) -> bool:
    """Whether the link's invitation is still there and only ran out (to say so instead of "not valid any more")."""
    invite = db.scalar(select(Invite).where(Invite.token_hash == hash_token(token)))
    return invite is not None and invite.expires_at <= utcnow()


def consume(db: Session, invite: Invite) -> bool:
    """Takes the invitation away, in the open transaction; False when another request took it first. Of two requests
    at the same moment the database lets exactly one delete the row, so a link is used once whatever the timing."""
    try:
        return int(db.execute(delete(Invite).where(Invite.id == invite.id)).rowcount or 0) == 1
    except OperationalError:
        db.rollback()
        return False


def is_member(db: Session, invite: Invite, account_id: int) -> bool:
    from . import spaces

    return invite.space_id is not None and spaces.role_of(db, account_id, invite.space_id) is not None


def join_space(db: Session, invite: Invite, account: Account) -> bool:
    """The account becomes a member of the invitation's space, in the caller's transaction (no commit); the other
    members hear of it on their channels. False when there is no space or it is a member already. The caller wakes
    the waiting devices after its commit (``cursor.touched_everybody``)."""
    from . import cursor, spaces

    if invite.space_id is None or is_member(db, invite, account.id):
        return False
    space = db.get(Space, invite.space_id)
    if space is None:
        return False
    with cursor.WRITE_LOCK:
        spaces.join(db, space, account.id, SPACE_MEMBER)
        _tell_joined(db, space, account)
        db.flush()
    logger.info("Invite used name=%s space_id=%s", account.name, invite.space_id)
    return True


def redeem(db: Session, invite: Invite, account: Account, *, consumed: bool = False, commit: bool = True) -> None:
    """The invitation is used: it goes first (``consume``), then the account becomes a member of its space. Who is a
    member already does not use it up. (The sign-in provider's store; the module's ``join_invite`` does the same for
    the routes.)"""
    from . import cursor

    if invite.space_id is not None and is_member(db, invite, account.id):
        if commit:
            db.commit()
        return
    if not consumed and not consume(db, invite):
        db.rollback()
        raise AccountError("invite_invalid", "This invitation is not valid any more.", 404)
    joined = join_space(db, invite, account)
    if commit:
        db.commit()
    if joined:
        # Without ``commit`` the caller's commit follows right away (the sign-in provider's module), as in 0.8.0.
        cursor.touched_everybody()


def _tell_joined(db: Session, space: Space, joined: Account) -> None:
    """The other members hear on the channels they chose for ``joined`` (``services/notifyprefs.py``); in the
    caller's transaction."""
    from . import clock, messages, notifyprefs, outbox, spaces

    name = joined.display_name or joined.name
    for member_id in spaces.member_ids(db, space.id):
        other = db.get(Account, member_id)
        if other is None or member_id == joined.id:
            continue

        def make(language: str, base: str, unsubscribe: str) -> messages.Message:
            return messages.joined(language, base=base, name=name, space=space.name, link=f"{base}/?space={space.id}",
                                   unsubscribe=unsubscribe)

        notifyprefs.dispatch(db, other, "joined", f"{space.id}:{joined.id}:{clock.now_ms()}", make)
    outbox.wake()


def invites_of(db: Session, *, space_id: str | None, all_spaces: bool = False, expired: bool = False) -> list[Invite]:
    """Open invitations; with ``expired`` also those that ran out (they stay listed until withdrawn, konten 0.3.10)."""
    query = select(Invite) if expired else select(Invite).where(Invite.expires_at > utcnow())
    if not all_spaces:
        query = query.where(Invite.space_id.is_(None) if space_id is None else Invite.space_id == space_id)
    return list(db.scalars(query.order_by(Invite.created_at)))


def delete_account(db: Session, account: Account) -> None:
    """For good: it leaves every space (its reminders stay; where it was the last manager, the member who joined first
    becomes manager), its space "Private" goes. Its username stays reserved for good (``former_names`` without an
    account): nobody inherits another's mentions or history. Waiting devices hear it after the commit."""
    from ..models_accounts import FormerName
    from ..vendor.nexkonten import factor
    from . import cursor, totp, trash

    account_id, name = account.id, account.name
    with cursor.WRITE_LOCK:
        trash.remove_account(db, account_id)
        db.add(FormerName(account_id=None, name=name))
        db.delete(account)
        db.commit()
    cursor.touched_everybody()
    totp.forget_account(account_id)
    factor.drop_waiting(account_id)
