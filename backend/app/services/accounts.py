"""Accounts: the first is the operator, the others come by invitation or through OIDC.

An invitation is a link with an end date for one person. It may name a space: whoever follows it gets an account (when
they have none yet) and becomes a member there. Signed in already, following it only makes the account a member.
Managers invite into their spaces (never into "Private"); the operator also invites into nextasks without a space.

After nextrmnl's accounts: the name is checked before the password, and an unknown name costs the same time as a
wrong password, so that neither answer nor timing tells which names exist.
"""

from __future__ import annotations

import logging
import re
import secrets
import threading
from datetime import timedelta
from functools import lru_cache

from sqlalchemy import delete, func, select
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from .. import __version__
from ..config import get_settings
from ..models import (
    MANAGER,
    MEMBER,
    OPERATOR,
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


#: One setup at a time: two at once each counted no account yet and made two operators.
_setup_lock = threading.Lock()
_generated_code: str | None = None


def setup_code() -> str:
    """What the first account must bring: ``NEXTASKS_SETUP_TOKEN``, else a code made at start and written to the log.
    Whoever reaches a fresh instance first would otherwise become its operator."""
    global _generated_code
    given = get_settings().setup_token.strip()
    if given:
        return given
    if _generated_code is None:
        _generated_code = "-".join(secrets.token_hex(2).upper() for _ in range(3))
    return _generated_code


def announce_setup_code(db: Session) -> None:
    """At start, while nobody has set nextasks up: the code in the log, where only whoever runs the server reads it."""
    if count(db) == 0:
        if get_settings().setup_token.strip():
            logger.warning("nextasks is not set up yet. Open it and give NEXTASKS_SETUP_TOKEN as the setup code.")
        else:
            logger.warning("nextasks is not set up yet. The setup code is %s (new at every start until set up).",
                           setup_code())


def create_operator(db: Session, name: str, password: str, code: str) -> Account:
    with _setup_lock:
        if count(db) > 0:
            raise AccountError("already_set_up", "nextasks is already set up.", 409)
        if not secrets.compare_digest(code.strip().upper().encode(), setup_code().upper().encode()):
            raise AccountError("setup_code_wrong", "The setup code is wrong. It is in the server's log.", 403)
        return create_with_password(db, name, password, OPERATOR)


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


_account_locks: dict[int, threading.Lock] = {}
_account_locks_guard = threading.Lock()


def _one_check_at_a_time(account_id: int) -> threading.Lock:
    """Checks of one account's password in turn: 60 wrong ones at once all passed the lock test before the first
    failure was counted, and 46 were checked instead of 10."""
    with _account_locks_guard:
        return _account_locks.setdefault(account_id, threading.Lock())


def authenticate(db: Session, name: str, password: str, device: int | None = None) -> Account:
    """Checks name and password; counts failures and locks the account after too many.

    A locked account answers like a wrong password (no hint that the name exists), except to a browser that signed in
    as it before (``device``, the account its cookie names): a stranger guessing can lock the account against the
    world, not against its owner.
    Failures from that browser do not count towards the lock.

    A blocked account hears that it is blocked and whom to ask, but only after its right password; a wrong one answers
    as for anybody (Prüfgang 05.10.2026 A16, as decided). The caller counts it for the brakes like a failure. The same
    for the emergency account while connected (``/notzugang`` signs in here too).
    """
    account = by_name(db, name)
    if account is None or account.sign_in != SIGN_IN_PASSWORD:
        verify_password(password, _dummy_hash())
        logger.warning("Sign-in failed for an unknown account")
        raise AccountError("wrong_credentials", "Name or password is wrong.", 401)
    known_device = device == account.id
    with _one_check_at_a_time(account.id):
        db.refresh(account)
        if is_locked(account) and not known_device:
            # Locked says nothing more, blocked or not.
            verify_password(password, _dummy_hash())
            logger.warning("Sign-in refused, account locked name=%s", account.name)
            raise AccountError("wrong_credentials", "Name or password is wrong.", 401)
        if not verify_password(password, account.password_hash):
            # A blocked account counts wrong passwords like any other: otherwise it would tell from changing senders,
            # without end, whether a guess was right.
            if not known_device:
                note_failure(db, account)
            raise AccountError("wrong_credentials", "Name or password is wrong.", 401)
        if account.blocked_at is not None:
            # The right password: it hears that it is blocked and whom to ask (A16). The count of failures stays.
            logger.warning("Sign-in refused, account blocked name=%s", account.name)
            raise AccountError("account_blocked", "This account is blocked. Ask the operator to unblock it.", 403)
        if not account.totp_secret_enc:
            # With a second factor, only the code resets the count of failures: otherwise whoever knows the password
            # could guess codes forever, a new password step before each lockout.
            note_success(db, account)
    return account


def check_password(account: Account, password: str) -> bool:
    return account.sign_in == SIGN_IN_PASSWORD and verify_password(password, account.password_hash)


def change_password(db: Session, account: Account, current: str, new: str) -> None:
    if not verify_password(current, account.password_hash):
        raise AccountError("wrong_password", "The current password is wrong.", 401)
    if new == current:
        # Taken before, and it ended the other sessions as if something had changed (Prüfgang E25).
        raise AccountError("password_unchanged", "The new password is the same as the current one.", 422)
    account.password_hash = hash_password(new)
    db.commit()
    logger.info("Password changed name=%s", account.name)


def set_password(db: Session, account: Account, new: str) -> None:
    """The operator gives an account a new password (it forgot its own); it signs in with a password from now on."""
    account.password_hash = hash_password(new)
    account.sign_in = SIGN_IN_PASSWORD
    account.failed_logins = 0
    account.locked_until = None
    db.commit()
    logger.info("Password set by the operator name=%s", account.name)


# --- Invitations ---------------------------------------------------------------------------------------------------


def create_invite(db: Session, by: Account, *, space_id: str | None, days: int, email: str = "") -> tuple[Invite, str]:
    if days not in INVITE_DAYS:
        raise AccountError("invalid_days", "Choose 1, 7 or 30 days.", 422)
    token = secrets.token_urlsafe(24)
    invite = Invite(
        token_hash=hash_token(token), space_id=space_id, email=email.strip()[:255], created_by=by.id,
        expires_at=utcnow() + timedelta(days=days),
    )
    db.add(invite)
    db.commit()
    logger.info("Invite created by=%s space_id=%s", by.name, space_id or "-")
    return invite, token


def expired(invite: Invite) -> bool:
    return invite.expires_at <= utcnow()


def find_invite(db: Session, token: str) -> Invite | None:
    """A usable invitation: not run out, and into a space only while the one who made it still manages the space
    (a manager who lost the role must not keep bringing people in with an old link) and the space is not private."""
    from . import spaces

    invite = db.scalar(select(Invite).where(Invite.token_hash == hash_token(token)))
    if invite is None or invite.expires_at <= utcnow():
        return None
    if invite.space_id is not None:
        space = db.get(Space, invite.space_id)
        if space is None or space.private or invite.created_by is None:
            return None
        if spaces.role_of(db, invite.created_by, invite.space_id) != MANAGER:
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


def redeem(db: Session, invite: Invite, account: Account, *, consumed: bool = False, commit: bool = True) -> None:
    """The invitation is used: it goes first (``consume``), then the account becomes a member of its space. Who is a
    member already does not use it up."""
    from . import cursor, spaces

    if invite.space_id is not None and is_member(db, invite, account.id):
        if commit:
            db.commit()
        return
    if not consumed and not consume(db, invite):
        db.rollback()
        raise AccountError("invite_invalid", "This invitation is not valid any more.", 404)
    if invite.space_id is not None:
        space = db.get(Space, invite.space_id)
        if space is not None:
            with cursor.WRITE_LOCK:
                spaces.join(db, space, account.id, SPACE_MEMBER)
                _tell_joined(db, space, account)
                if commit:
                    db.commit()
            cursor.touched_everybody()
    if commit:
        db.commit()
    logger.info("Invite used name=%s space_id=%s", account.name, invite.space_id)


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


def accept_invite(db: Session, token: str, name: str, password: str) -> Account:
    invite = find_invite(db, token)
    if invite is None:
        if invite_ran_out(db, token):
            raise AccountError("invite_expired", "This invitation has run out.", 404)
        raise AccountError("invite_invalid", "This invitation is not valid any more.", 404)
    check_name(db, name)
    # The invitation goes before the account comes, in one transaction: two requests with the same link at the same
    # moment make one account, not two.
    if not consume(db, invite):
        db.rollback()
        raise AccountError("invite_invalid", "This invitation is not valid any more.", 404)
    try:
        account = create_with_password(db, name, password, commit=False)
    except AccountError:
        db.rollback()
        raise
    if invite.email and not account.email:
        account.email = invite.email
    redeem(db, invite, account, consumed=True)
    return account


def invites_of(db: Session, *, space_id: str | None, all_spaces: bool = False) -> list[Invite]:
    query = select(Invite).where(Invite.expires_at > utcnow())
    if not all_spaces:
        query = query.where(Invite.space_id.is_(None) if space_id is None else Invite.space_id == space_id)
    return list(db.scalars(query.order_by(Invite.created_at)))
