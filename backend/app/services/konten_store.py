"""nextasks' side of the shared account module ``vendor/nexkonten``: the ``Store`` over its tables.

The module runs setup, invitations, signing in with a password, the profile, a forgotten password, the second factor,
passkeys and sessions the same in every nex app; it never sees a database and asks through a ``Store``, which is this
one, over ``accounts``, ``invites``, ``auth_sessions``, ``app_devices``, ``api_tokens`` and the tables of
``models_accounts``. One instance works inside one SQLAlchemy session (one request); the module commits when an
outcome is settled and rolls back when it refuses after a write.

⚠️ **The columns keep their names.** ``accounts.name`` is the module's ``username`` (and the field ``name`` of every
route), the address is ``email``. Two answers about the address, without a break for 0.8.0 and with a way back:

- ``email_confirmed`` (text) stays what it was: the address **proven** by a link;
- ``email_counted`` (text, new) is the address that **counts** without a link (an invitation, no mail server, the
  setup).

The address counts while it is one of the two, and is proven while it is the first. In the Bestand ``email_counted``
is empty: exactly the confirmed addresses count, as before.

A waiting address stays in ``email_pending``/``email_pending_hash``/``email_pending_until`` at the account (the change's
id is the account's): the hash is the SHA-256 of the whole token, so links of 0.8.0 (``nxm_…``) keep working.
"""

from __future__ import annotations

import hashlib
import json
import logging
import secrets
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import (
    MEMBER,
    OPERATOR,
    SIGN_IN_OIDC,
    SIGN_IN_PASSWORD,
    Account,
    ApiToken,
    AppCode,
    AppDevice,
    AppPairing,
    AuthSession,
    Member,
    OidcProvider,
    Reminder,
    new_device_key,
    utcnow,
)
from ..models import Invite as InviteRow
from ..models_accounts import FailedUnknown, FormerName, PasswordReset, SetupClaim
from ..models_accounts import Passkey as PasskeyRow
from ..models_mcp import McpKey
from ..security import (
    LOCK_MINUTES,
    MAX_FAILURES,
    decrypt_secret,
    encrypt_secret,
    hash_password,
    hash_token,
    server_key,
    verify_password,
)
from ..vendor import nexkonten
from ..vendor.nexkonten import (
    Access,
    AccountId,
    EmailChange,
    Event,
    Invite,
    NewAccount,
    Picture,
    Reset,
    Taken,
    names,
)
from ..vendor.nexkonten import Account as KontoAccount
from ..vendor.nexkonten.model2 import KIND_BROWSER, KIND_DEVICE, KIND_WAITING, STAGE_FULL
from ..vendor.nexkonten.model2 import Passkey as PasskeyData
from ..vendor.nexkonten.model2 import Session as SessionData
from ..vendor.nexkonten.model3 import SignInSettings
from . import whats_new

logger = logging.getLogger("nextasks.auth")

PROVIDER = "provider"
OWN = "own"
#: The operator's switches of part 2: "Require a second factor of everybody" was nextasks' ``two_factor_required``
#: already; "Passkeys allowed" is new and on from the start.
SWITCH_FACTOR_REQUIRED = "two_factor_required"
SWITCH_PASSKEYS = "passkeys_allowed"
SWITCH_PASSWORD_LOGIN = "password_login"
#: The authenticator being set up is sealed apart from a confirmed one.
PENDING_TOTP_CONTEXT = "totp-pending"
#: A paired iPhone or iPad (``app_devices``) in the list "Signed-in devices": its uid is its id with this in front.
DEVICE_UID = "device-"

#: The codes nextasks answered with before the module, for scripts, the iPhone app and pages of 0.8.0 (the module's
#: own names stay inside; ``AccountError.public_code`` answers with these). The page maps them back.
OLD_CODES = {
    "email_invalid": "invalid_email",
    "username_taken": "name_taken",
    "username_invalid": "invalid_account_name",
}


def configure() -> None:
    """The module knows nextasks' name, log and codes from now on. At import and by the tests."""
    nexkonten.configure(
        nexkonten.AppConfig(
            app_name="nextasks",
            # The setting, not only the environment: NEXTASKS_SETUP_TOKEN may stand in a .env file.
            setup_token=lambda: get_settings().setup_token,
            logger_name="nextasks.auth",
            error_codes=OLD_CODES,
        )
    )


configure()


def _aware(moment: datetime) -> datetime:
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


def same(one: str | None, other: str | None) -> bool:
    return bool(one) and bool(other) and str(one).casefold() == str(other).casefold()


def counts(row: Account) -> bool:
    """The address counts (signing in, a forgotten password, notices): proven by a link, or counted without one."""
    return bool(row.email) and (same(row.email, row.email_confirmed) or same(row.email, row.email_counted))


def proven(row: Account) -> bool:
    """Somebody opened a link mailed to the address."""
    return bool(row.email) and same(row.email, row.email_confirmed)


def pending_of(row: Account, now: datetime | None = None) -> str:
    """The address that waits for its link while the link holds, else ""."""
    until = row.email_pending_until
    if not row.email_pending or until is None:
        return ""
    return row.email_pending if _aware(until) > (now or utcnow()) else ""


_DUMMY: str | None = None
_DUMMY_LOCK = threading.Lock()


def _dummy_hash() -> str:
    """What ``check_password`` verifies against when there is no account or no password: the answer takes as long
    as for a wrong password and tells nobody which names or addresses exist."""
    global _DUMMY
    with _DUMMY_LOCK:
        if _DUMMY is None:
            _DUMMY = hash_password(secrets.token_urlsafe(24))
    return _DUMMY


#: Whether the provider's picture is fetched in a thread of its own. Tests switch this off and do not wait.
PICTURE_IN_THREAD = True


class KontenStore:
    """``nexkonten.Store`` and the stores of part 2 over nextasks' tables, inside one session."""

    def __init__(self, db: Session) -> None:
        self.db = db
        #: A space was joined in this transaction: the waiting devices hear it after the commit (``notify``).
        self.joined_space = False

    # --- Accounts ------------------------------------------------------------------------------------------------
    def _row(self, account_id: AccountId | None) -> Account | None:
        if account_id is None:
            return None
        try:
            return self.db.get(Account, int(account_id))
        except (TypeError, ValueError):
            return None

    def _account(self, row: Account) -> KontoAccount:
        if row.avatar_at is None:
            picture = nexkonten.PICTURE_NONE
        else:
            picture = nexkonten.PICTURE_PROVIDER if row.avatar_source == PROVIDER else nexkonten.PICTURE_OWN
        offered = self.offered(row)
        return KontoAccount(
            id=row.id,
            username=row.name,
            display_name=row.display_name or "",
            email=row.email or "",
            email_confirmed=counts(row) if row.email else True,
            email_proven=proven(row),
            email_source=(nexkonten.EMAIL_PROVIDER if row.email and row.email_source == PROVIDER
                          else nexkonten.EMAIL_OWN),
            pending_email=pending_of(row),
            has_password=row.sign_in == SIGN_IN_PASSWORD and bool(row.password_hash),
            blocked=row.shut,
            operator=row.role == OPERATOR,
            picture=picture,
            language=row.language or "",
            offered_email=offered,
            offered_email_provider=(row.provider_email_from or "") if offered else "",
            declined_email=row.provider_email_off or "",
            password_changed_at=_aware(row.password_changed_at) if row.password_changed_at else None,
            blocked_at=_aware(row.blocked_at) if row.blocked_at else None,
            deleted_at=_aware(row.deleted_at) if row.deleted_at else None,
            theme=row.theme or "",
        )

    @staticmethod
    def offered(row: Account) -> str:
        """The provider's address on offer: not the own one, not one the account declined."""
        offer = row.provider_email or ""
        if not offer or same(row.email, offer):
            return ""
        if same(row.provider_email_off, offer):
            return ""
        return offer

    def set_offered_email(self, account_id: AccountId, address: str, provider: str = "") -> None:
        row = self._row(account_id)
        if row is None:
            return
        row.provider_email = address
        row.provider_email_from = provider[:80] if address else ""
        self.db.flush()

    def set_declined_email(self, account_id: AccountId, address: str) -> None:
        row = self._row(account_id)
        if row is None:
            return
        row.provider_email_off = address
        self.db.flush()

    def count_accounts(self) -> int:
        return int(self.db.scalar(select(func.count()).select_from(Account)) or 0)

    def get_account(self, account_id: AccountId) -> KontoAccount | None:
        row = self._row(account_id)
        return self._account(row) if row is not None else None

    def find_by_username(self, username: str) -> list[KontoAccount]:
        wanted = (username or "").strip().lower()
        if not wanted:
            return []
        rows = self.db.scalars(select(Account).where(func.lower(Account.name) == wanted))
        return [self._account(row) for row in rows]

    def find_by_email(self, address: str) -> list[KontoAccount]:
        wanted = (address or "").strip().lower()
        if not wanted:
            return []
        rows = self.db.scalars(select(Account).where(func.lower(Account.email) == wanted))
        return [self._account(row) for row in rows]

    def name_reserved(self, username: str, except_id: AccountId | None) -> bool:
        query = select(FormerName.id).where(func.lower(FormerName.name) == (username or "").strip().lower())
        if except_id is not None:
            query = query.where(or_(FormerName.account_id.is_(None), FormerName.account_id != int(except_id)))
        return self.db.scalar(query.limit(1)) is not None

    def find_by_former_name(self, username: str) -> list[KontoAccount]:
        ids = set(
            self.db.scalars(
                select(FormerName.account_id).where(
                    func.lower(FormerName.name) == (username or "").strip().lower(), FormerName.account_id.is_not(None)
                )
            )
        )
        return [account for account in (self.get_account(i) for i in ids) if account is not None]

    def display_name_taken(self, display_name: str, except_id: AccountId | None) -> bool:
        wanted = names.display_key(display_name)
        if not wanted:
            return False
        rows = self.db.execute(select(Account.id, Account.display_name).where(Account.display_name != ""))
        other = int(except_id) if except_id is not None else None
        return any(row.id != other and names.display_key(row.display_name) == wanted for row in rows)

    def _flush(self) -> None:
        """Writes what waits; a unique index that refuses becomes ``Taken``."""
        try:
            self.db.flush()
        except IntegrityError as exc:
            self.db.rollback()
            raise Taken("email" if "email" in str(exc.orig) else "username") from exc

    def add_account(self, new: NewAccount) -> AccountId:
        """A new account; with an invitation into a space it joins that space in the same transaction (as
        ``accounts.redeem`` did), and the devices waiting hear it after the commit (``notify``)."""
        if new.display_name and self.display_name_taken(new.display_name, None):
            raise Taken("display_name")
        if self.find_by_username(new.username):
            raise Taken("username")
        address = new.email or ""
        row = Account(
            name=new.username,
            display_name=new.display_name,
            email=address,
            email_counted=address if address and new.email_confirmed else "",
            email_confirmed=address if address and new.email_proven else "",
            email_source=OWN if address else "",
            role=OPERATOR if new.operator else MEMBER,
            sign_in=SIGN_IN_PASSWORD if new.password else SIGN_IN_OIDC,
            password_hash=hash_password(new.password) if new.password else "",
            password_changed_at=utcnow() if new.password else None,
            language=new.language or "",
            whats_new_seen=whats_new.seen_for_new_account(),
            # A new account starts "as the device says" (E45); only accounts of before take a browser's value once.
            theme=getattr(new, "theme", "system") or "system",
        )
        self.db.add(row)
        self._flush()
        invitation = new.invite.rights if new.invite is not None else None
        if isinstance(invitation, InviteRow):
            self._join(row, invitation)
        logger.info("Account created name=%s role=%s sign_in=%s", row.name, row.role, row.sign_in)
        return row.id

    def _join(self, row: Account, invitation: InviteRow) -> None:
        from . import accounts

        if accounts.join_space(self.db, invitation, row):
            self.joined_space = True

    def set_username(self, account_id: AccountId, username: str) -> None:
        """The new name; the old one becomes a former name of the account, reserved for good. Nothing in nextasks
        hangs on the name (assignees, members, comments, mentions, history, turns, push all carry the id), so
        nothing else moves."""
        row = self._row(account_id)
        if row is None:
            return
        old = row.name
        if any(other.id != row.id for other in self.find_by_username(username)):
            raise Taken("username")
        row.name = username
        self._flush()
        if old.lower() != username.lower():
            self.db.add(FormerName(account_id=row.id, name=old))
            self.db.flush()

    def set_display_name(self, account_id: AccountId, display_name: str) -> None:
        if display_name and self.display_name_taken(display_name, account_id):
            raise Taken("display_name")
        row = self._row(account_id)
        if row is not None:
            row.display_name = display_name
            self.db.flush()

    def set_email(self, account_id: AccountId, address: str, *, confirmed: bool, proven: bool, source: str) -> None:
        """``email_confirmed`` holds the address only when it is proven, ``email_counted`` only when it counts; the
        source is ``provider`` or ``own``, empty without an address."""
        row = self._row(account_id)
        if row is None:
            return
        row.email = address
        row.email_confirmed = address if address and proven else ""
        row.email_counted = address if address and confirmed else ""
        row.email_source = (PROVIDER if source == nexkonten.EMAIL_PROVIDER else OWN) if address else ""
        if address and same(row.provider_email, address):
            row.provider_email = ""
            row.provider_email_from = ""
        self._flush()

    def set_language(self, account_id: AccountId, language: str) -> None:
        row = self._row(account_id)
        if row is not None:
            row.language = language
            self.db.flush()

    # --- Passwords, failures, sessions ---------------------------------------------------------------------------
    def check_password(self, account_id: AccountId | None, password: str) -> bool:
        row = self._row(account_id)
        if row is None or row.sign_in != SIGN_IN_PASSWORD or not row.password_hash:
            verify_password(password or "", _dummy_hash())
            return False
        return verify_password(password or "", row.password_hash)

    def set_password(self, account_id: AccountId, password: str) -> None:
        row = self._row(account_id)
        if row is None:
            return
        # Through the ORM: a new password hash draws a new device key (``models._forget_devices``).
        row.password_hash = hash_password(password)
        row.password_changed_at = utcnow()
        row.sign_in = SIGN_IN_PASSWORD
        row.failed_logins = 0
        row.locked_until = None
        self.db.flush()

    def is_locked(self, account_id: AccountId) -> bool:
        row = self._row(account_id)
        return bool(row and row.locked_until is not None and _aware(row.locked_until) > utcnow())

    def note_failure(self, account_id: AccountId | None) -> None:
        """A wrong password at the account; after ``MAX_FAILURES`` locked for ``LOCK_MINUTES`` (as 0.8.0). Without an
        account the same work on the counter row: as costly, the time tells nothing."""
        row = self._row(account_id)
        if row is None:
            counted = self.db.execute(update(FailedUnknown).where(FailedUnknown.id == 1)
                                      .values(count=FailedUnknown.count + 1))
            if not counted.rowcount:
                self.db.add(FailedUnknown(id=1, count=1))
            self.db.flush()
            return
        row.failed_logins = (row.failed_logins or 0) + 1
        if row.failed_logins >= MAX_FAILURES:
            row.locked_until = utcnow() + timedelta(minutes=LOCK_MINUTES)
            row.failed_logins = 0
            logger.warning("Account locked after %s failures name=%s minutes=%s", MAX_FAILURES, row.name, LOCK_MINUTES)
        else:
            logger.warning("Check failed name=%s (%s of %s before lockout)", row.name, row.failed_logins, MAX_FAILURES)
        self.db.flush()

    def note_success(self, account_id: AccountId) -> None:
        row = self._row(account_id)
        if row is not None:
            row.failed_logins = 0
            row.locked_until = None
            row.last_seen_at = utcnow()
            self.db.flush()

    def end_sessions(self, account_id: AccountId) -> None:
        """A new password from a link: every browser session and every sign-in waiting for its code ends, and no
        browser counts as known any more. Paired iPhones, API tokens and passkeys stay (they are listed)."""
        from ..vendor.nexkonten import factor
        from . import totp

        self.db.execute(delete(AuthSession).where(AuthSession.account_id == int(account_id),
                                                  AuthSession.kind != KIND_DEVICE))
        totp.forget_account(int(account_id))
        factor.drop_waiting(int(account_id))
        self.renew_device_key(account_id)

    def list_access(self, account_id: AccountId) -> list[Access]:
        from ..vendor import nexgeraete
        from .devices import GeraeteStore

        devices = self.db.scalars(
            select(AppDevice).where(AppDevice.account_id == int(account_id)).order_by(AppDevice.created_at)
        )
        # Named as the device module names them (geraete 0.1.0): the name, and the model where it says more.
        found = [Access(f"{DEVICE_UID}{row.id}", "device", nexgeraete.describe(GeraeteStore._device(row)),
                        row.last_seen_at) for row in devices]
        tokens = self.db.scalars(
            select(ApiToken).where(ApiToken.account_id == int(account_id), ApiToken.blocked_at.is_(None))
            .order_by(ApiToken.created_at)
        )
        found += [Access(f"token-{row.id}", "api_key", row.name, row.last_used_at) for row in tokens]
        # MCP keys and connected programs (mcp 1.1.0) are keys too: listed and disconnected with the API keys.
        mcp_keys = self.db.scalars(
            select(McpKey).where(McpKey.account_id == int(account_id), McpKey.blocked_at.is_(None))
            .order_by(McpKey.created_at)
        )
        found += [Access(f"mcp-{row.id}", "api_key", row.name, row.last_used_at) for row in mcp_keys]
        found += [Access(key.uid, "passkey", key.name, key.last_used_at) for key in self.passkeys_of(account_id)]
        return found

    def revoke_access(self, account_id: AccountId) -> int:
        gone = int(self.db.execute(delete(AppDevice).where(AppDevice.account_id == int(account_id))).rowcount or 0)
        gone += int(self.db.execute(delete(ApiToken).where(ApiToken.account_id == int(account_id))).rowcount or 0)
        gone += self._end_mcp_keys(account_id)
        gone += self.remove_passkeys(account_id)
        # A QR code nobody scanned yet, or a code of the sign-in in the browser, would bring a device right back.
        self.db.execute(delete(AppPairing).where(AppPairing.account_id == int(account_id)))
        self.db.execute(delete(AppCode).where(AppCode.account_id == int(account_id)))
        return gone

    def second_factor(self, account_id: AccountId) -> str:
        row = self._row(account_id)
        if row is None:
            return nexkonten.SECOND_FACTOR_NONE
        if nexkonten.factor.switched_off():
            return nexkonten.SECOND_FACTOR_NONE
        if row.totp_secret_enc:
            # Also a seed that does not open any more: the second factor fails closed.
            return nexkonten.SECOND_FACTOR_ACTIVE
        state = nexkonten.factor.state(self, account_id)
        if state == nexkonten.SECOND_FACTOR_REQUIRED and row.sign_in != SIGN_IN_PASSWORD:
            # An account through a provider brings the provider's second factor.
            return nexkonten.SECOND_FACTOR_NONE
        return state

    # --- Pictures ------------------------------------------------------------------------------------------------
    def set_provider_picture(self, account_id: AccountId, picture: Picture) -> bool:
        """Through nextasks' own picture handling like an upload, and only while the account has none (one statement
        with that condition)."""
        from . import avatars

        try:
            webp = avatars.make(picture.data)
        except avatars.AvatarError:
            return False
        result = self.db.execute(
            update(Account)
            .where(Account.id == int(account_id), Account.avatar_at.is_(None))
            .values(avatar=webp, avatar_at=utcnow(), avatar_source=PROVIDER,
                    avatar_hash=hashlib.sha256(webp).hexdigest())
        )
        self._refresh(account_id)
        return int(result.rowcount or 0) == 1

    def _refresh(self, account_id: AccountId) -> None:
        row = self.db.get(Account, int(account_id))
        if row is not None:
            self.db.expire(row)

    # --- Invitations ---------------------------------------------------------------------------------------------
    def find_invite(self, key: str) -> Invite | None:
        """The invitation of a link, also when it ran out (``expires_at`` says so); None when unknown, used, or when
        its maker may not invite any more (``accounts.invite_allowed``: into a space only while managing it, never
        into "Private"; into nextasks only an operator)."""
        from . import accounts

        if not key:
            return None
        row = self.db.scalar(select(InviteRow).where(InviteRow.token_hash == hash_token(key)))
        if row is None or not accounts.invite_allowed(self.db, row):
            return None
        return Invite(
            key=key,
            id=row.id,
            email=row.email or "",
            display_name=row.display_name or "",
            username="",
            expires_at=_aware(row.expires_at),
            rights=row,
        )

    def consume_invite(self, invite: Invite) -> bool:
        return int(self.db.execute(delete(InviteRow).where(InviteRow.id == int(invite.id))).rowcount or 0) == 1

    def accept_invite(self, account_id: AccountId, invite: Invite) -> None:
        """An account that has one already follows an invitation into a space: it joins (a member stays what it
        was)."""
        row = self._row(account_id)
        if row is not None and isinstance(invite.rights, InviteRow):
            self._join(row, invite.rights)

    # --- Address changes (the columns of 0.8.0 at the account) ---------------------------------------------------
    def start_email_change(self, account_id: AccountId, address: str, token: str, expires_at: datetime) -> None:
        row = self._row(account_id)
        if row is None:
            return
        row.email_pending = address
        row.email_pending_hash = hash_token(token)
        row.email_pending_until = expires_at
        self.db.flush()

    def find_email_change(self, token: str) -> EmailChange | None:
        if not token:
            return None
        row = self.db.scalar(select(Account).where(Account.email_pending_hash == hash_token(token),
                                                   Account.email_pending != ""))
        if row is None or row.email_pending_until is None:
            return None
        return EmailChange(id=row.id, account_id=row.id, address=row.email_pending,
                           expires_at=_aware(row.email_pending_until))

    def consume_email_change(self, change: EmailChange) -> bool:
        gone = self.db.execute(
            update(Account).where(Account.id == int(change.account_id), Account.email_pending != "",
                                  func.lower(Account.email_pending) == change.address.lower())
            .values(email_pending="", email_pending_hash="", email_pending_until=None)
        )
        self._refresh(change.account_id)
        return int(gone.rowcount or 0) == 1

    def drop_email_change(self, account_id: AccountId) -> None:
        row = self._row(account_id)
        if row is not None:
            row.email_pending = ""
            row.email_pending_hash = ""
            row.email_pending_until = None
            self.db.flush()

    # --- Links for a new password --------------------------------------------------------------------------------
    def start_reset(
        self, account_id: AccountId, token: str, expires_at: datetime, *, created_by: AccountId | None, origin: str
    ) -> None:
        # One open link per account: an earlier one stops counting.
        self.db.execute(delete(PasswordReset).where(PasswordReset.account_id == int(account_id)))
        self.db.add(
            PasswordReset(
                token_hash=hash_token(token),
                account_id=int(account_id),
                created_by=int(created_by) if created_by is not None else None,
                expires_at=expires_at,
                origin=origin,
            )
        )
        self.db.flush()

    def find_reset(self, token: str) -> Reset | None:
        if not token:
            return None
        row = self.db.scalar(select(PasswordReset).where(PasswordReset.token_hash == hash_token(token)))
        if row is None:
            return None
        return Reset(id=row.id, account_id=row.account_id, expires_at=_aware(row.expires_at),
                     created_by=row.created_by, origin=row.origin or nexkonten.RESET_SELF)

    def consume_reset(self, reset: Reset) -> bool:
        return int(self.db.execute(delete(PasswordReset).where(PasswordReset.id == int(reset.id))).rowcount or 0) == 1

    def drop_resets(self, account_id: AccountId, *, origin: str | None = None) -> None:
        conditions = [PasswordReset.account_id == int(account_id)]
        if origin is not None:
            conditions.append(PasswordReset.origin == origin)
        self.db.execute(delete(PasswordReset).where(*conditions))

    def claim_setup(self) -> bool:
        try:
            self.db.add(SetupClaim(id=1))
            self.db.flush()
        except IntegrityError:
            self.db.rollback()
            return False
        return True

    # --- After the commit ----------------------------------------------------------------------------------------
    def notify(self, event: Event) -> None:
        """What follows a settled outcome. A space joined (a new account through an invitation, or a signed-in one
        following it): the devices waiting for changes hear it now, after the commit. A password set through a link
        leaves the list "These devices still have access" for the next sign-in, and after the operator's or the
        server's link the notice that somebody else made it."""
        if event.kind in (nexkonten.EVENT_CREATED, nexkonten.EVENT_JOINED) and self.joined_space:
            from . import cursor

            self.joined_space = False
            cursor.touched_everybody()
        elif event.kind == nexkonten.EVENT_PASSWORD_SET:
            origin = str(event.details.get("origin") or nexkonten.RESET_SELF)
            row = self._row(event.account_id)
            if row is not None:
                row.new_password_origin = origin
                row.password_reset_notice = origin != nexkonten.RESET_SELF
                self.db.commit()
        elif event.kind == nexkonten.EVENT_RENAMED:
            logger.info("Username changed account_id=%s", event.account_id)

    # === Part 2: second factor, passkeys, sessions, pictures ========================================================

    # --- Second factor -------------------------------------------------------------------------------------------
    def totp_seed(self, account_id: AccountId) -> str | None:
        """The seed of the account's authenticator, opened; sealed as in 0.8.0 (``totp.seal_seed``), so that every
        authenticator app set up before keeps working."""
        from . import totp

        row = self._row(account_id)
        if row is None or not row.totp_secret_enc:
            return None
        try:
            return totp.open_seed(row.totp_secret_enc)
        except totp.SeedUnreadable:
            logger.error("Second factor seed unreadable name=%s (secret.key changed?)", row.name)
            return None

    def set_totp(self, account_id: AccountId, seed: str | None) -> None:
        from . import totp

        row = self._row(account_id)
        if row is None:
            return
        if seed:
            row.totp_secret_enc = totp.seal_seed(seed)
        else:
            row.totp_secret_enc = ""
            row.totp_last_step = 0
        self.db.flush()

    def pending_totp(self, account_id: AccountId) -> tuple[str, datetime] | None:
        row = self._row(account_id)
        if row is None or not row.totp_pending or row.totp_pending_until is None:
            return None
        seed = decrypt_secret(row.totp_pending, PENDING_TOTP_CONTEXT)
        return (seed, _aware(row.totp_pending_until)) if seed else None

    def set_pending_totp(self, account_id: AccountId, seed: str | None, until: datetime | None) -> None:
        row = self._row(account_id)
        if row is None:
            return
        row.totp_pending = encrypt_secret(seed, PENDING_TOTP_CONTEXT) if seed and until else ""
        row.totp_pending_until = until if seed and until else None
        self.db.flush()

    def claim_step(self, account_id: AccountId, step: int) -> bool:
        result = self.db.execute(
            update(Account)
            .where(Account.id == int(account_id), Account.totp_last_step < step)
            .values(totp_last_step=step)
        )
        self._refresh(account_id)
        return int(result.rowcount or 0) == 1

    def recovery_hashes(self, account_id: AccountId) -> list[str]:
        from . import totp

        row = self._row(account_id)
        return totp.load_recovery(row.totp_recovery) if row is not None else []

    def set_recovery(self, account_id: AccountId, hashes: list[str]) -> None:
        row = self._row(account_id)
        if row is not None:
            row.totp_recovery = json.dumps(list(hashes)) if hashes else ""
            self.db.flush()

    def claim_recovery(self, account_id: AccountId, stored: str) -> bool:
        """The code goes with one statement that only succeeds against the list it was read from: two requests with
        the same code at once, one of them wins."""
        row = self._row(account_id)
        if row is None:
            return False
        before = row.totp_recovery or ""
        hashes = self.recovery_hashes(account_id)
        if stored not in hashes:
            return False
        remaining = [entry for entry in hashes if entry != stored]
        result = self.db.execute(
            update(Account)
            .where(Account.id == int(account_id), Account.totp_recovery == before)
            .values(totp_recovery=json.dumps(remaining))
        )
        self._refresh(account_id)
        return int(result.rowcount or 0) == 1

    def recovery_key(self) -> bytes:
        return hashlib.sha256(b"nextasks-recovery:" + server_key()).digest()

    def factor_required(self) -> bool:
        from . import settings_service

        return bool(settings_service.get(self.db, SWITCH_FACTOR_REQUIRED))

    # --- Passkeys ------------------------------------------------------------------------------------------------
    def passkeys_allowed(self) -> bool:
        from . import settings_service

        return bool(settings_service.get(self.db, SWITCH_PASSKEYS))

    @staticmethod
    def _passkey(row: PasskeyRow) -> PasskeyData:
        return PasskeyData(
            uid=row.id,
            account_id=row.account_id,
            credential_id=bytes(row.credential_id),
            public_key=bytes(row.public_key),
            sign_count=row.sign_count,
            name=row.name,
            created_at=_aware(row.created_at),
            last_used_at=_aware(row.last_used_at) if row.last_used_at else None,
        )

    def passkeys_of(self, account_id: AccountId) -> list[PasskeyData]:
        rows = self.db.scalars(
            select(PasskeyRow).where(PasskeyRow.account_id == int(account_id)).order_by(PasskeyRow.created_at)
        )
        return [self._passkey(row) for row in rows]

    def find_passkey(self, credential_id: bytes) -> PasskeyData | None:
        row = self.db.scalar(select(PasskeyRow).where(PasskeyRow.credential_id == credential_id))
        return self._passkey(row) if row is not None else None

    def add_passkey(self, passkey: PasskeyData) -> None:
        self.db.add(
            PasskeyRow(
                id=passkey.uid,
                account_id=int(passkey.account_id),
                credential_id=passkey.credential_id,
                public_key=passkey.public_key,
                sign_count=passkey.sign_count,
                name=passkey.name,
                created_at=passkey.created_at,
            )
        )
        self.db.flush()

    def claim_counter(self, uid: str, old: int, new: int) -> bool:
        result = self.db.execute(
            update(PasskeyRow).where(PasskeyRow.id == uid, PasskeyRow.sign_count == old)
            .values(sign_count=new, last_used_at=utcnow())
        )
        return int(result.rowcount or 0) == 1

    def remove_passkey(self, account_id: AccountId, uid: str) -> bool:
        result = self.db.execute(
            delete(PasskeyRow).where(PasskeyRow.account_id == int(account_id), PasskeyRow.id == uid)
        )
        return int(result.rowcount or 0) == 1

    def remove_passkeys(self, account_id: AccountId) -> int:
        return int(self.db.execute(delete(PasskeyRow).where(PasskeyRow.account_id == int(account_id))).rowcount or 0)

    def user_handle(self, account_id: AccountId) -> bytes:
        row = self._row(account_id)
        if row is None:
            raise LookupError(account_id)
        if not row.passkey_handle:
            row.passkey_handle = secrets.token_urlsafe(32)
            self.db.flush()
        return row.passkey_handle.encode("ascii")

    # --- Sessions ------------------------------------------------------------------------------------------------
    @staticmethod
    def _session(row: AuthSession) -> SessionData:
        return SessionData(
            uid=row.uid or f"s{row.id}",
            account_id=row.account_id,
            kind=row.kind or KIND_BROWSER,
            created_at=_aware(row.created_at),
            expires_at=_aware(row.expires_at),
            last_seen_at=_aware(row.last_seen_at) if row.last_seen_at else None,
            remember=bool(row.remember),
            stage=row.stage or STAGE_FULL,
            provider_checked=bool(row.by_provider),
            label=row.user_agent or "",
            address=row.ip or "",
        )

    @staticmethod
    def _device(row: AppDevice) -> SessionData:
        from ..vendor import nexgeraete
        from .devices import GeraeteStore

        created = _aware(row.created_at)
        return SessionData(
            uid=f"{DEVICE_UID}{row.id}",
            account_id=row.account_id,
            kind=KIND_DEVICE,
            created_at=created,
            expires_at=created + timedelta(days=36500),
            last_seen_at=_aware(row.last_seen_at) if row.last_seen_at else None,
            label=nexgeraete.describe(GeraeteStore._device(row)),
        )

    def add_session(self, session: SessionData, token_hash: str) -> None:
        self.db.add(
            AuthSession(
                token_hash=token_hash,
                uid=session.uid,
                account_id=int(session.account_id),
                created_at=session.created_at,
                expires_at=session.expires_at,
                last_seen_at=session.last_seen_at or session.created_at,
                ip=session.address[:64],
                user_agent=session.label[:255],
                by_provider=session.provider_checked,
                remember=session.remember,
                stage=session.stage,
                kind=session.kind,
            )
        )
        self.db.flush()

    def session_by_hash(self, token_hash: str) -> SessionData | None:
        row = self.db.scalar(select(AuthSession).where(AuthSession.token_hash == token_hash))
        if row is not None:
            return self._session(row)
        device = self.db.scalar(select(AppDevice).where(AppDevice.key_hash == token_hash))
        return self._device(device) if device is not None else None

    def _by_uid(self, uid: str) -> AuthSession | None:
        if uid.startswith("s") and uid[1:].isdigit():
            return self.db.get(AuthSession, int(uid[1:]))
        return self.db.scalar(select(AuthSession).where(AuthSession.uid == uid))

    def touch_session(self, uid: str, last_seen_at: datetime, expires_at: datetime) -> None:
        if uid.startswith(DEVICE_UID):
            return
        row = self._by_uid(uid)
        if row is not None:
            row.last_seen_at = last_seen_at
            row.expires_at = expires_at
            self.db.flush()

    def set_stage(self, uid: str, stage: str) -> None:
        row = self._by_uid(uid)
        if row is not None:
            row.stage = stage
            self.db.flush()

    def sessions_of(self, account_id: AccountId) -> list[SessionData]:
        now = utcnow()
        rows = self.db.scalars(
            select(AuthSession).where(AuthSession.account_id == int(account_id), AuthSession.expires_at > now,
                                      AuthSession.kind != KIND_WAITING)
        )
        devices = self.db.scalars(select(AppDevice).where(AppDevice.account_id == int(account_id)))
        return [self._session(row) for row in rows] + [self._device(row) for row in devices]

    def end_session(self, account_id: AccountId, uid: str) -> bool:
        if uid.startswith(DEVICE_UID) and uid[len(DEVICE_UID):].isdigit():
            result = self.db.execute(
                delete(AppDevice).where(AppDevice.id == int(uid[len(DEVICE_UID):]),
                                        AppDevice.account_id == int(account_id))
            )
            return int(result.rowcount or 0) == 1
        row = self._by_uid(uid)
        if row is None or row.account_id != int(account_id):
            return False
        self.db.delete(row)
        self.db.flush()
        return True

    def end_everywhere(self, account_id: AccountId, keep_uid: str | None) -> int:
        """Browsers, waiting sign-ins and paired iPhones (as "sign out everywhere" of 0.8.0); API tokens and passkeys
        stay."""
        from ..vendor.nexkonten import factor
        from . import totp

        keep = self._by_uid(keep_uid) if keep_uid else None
        statement = delete(AuthSession).where(AuthSession.account_id == int(account_id))
        if keep is not None:
            statement = statement.where(AuthSession.id != keep.id)
        gone = int(self.db.execute(statement).rowcount or 0)
        gone += int(self.db.execute(delete(AppDevice).where(AppDevice.account_id == int(account_id))).rowcount or 0)
        totp.forget_account(int(account_id))
        factor.drop_waiting(int(account_id))
        return gone

    def device_key(self, account_id: AccountId) -> str:
        row = self._row(account_id)
        if row is None:
            raise LookupError(account_id)
        if not row.device_key:
            row.device_key = new_device_key()
            self.db.flush()
        return row.device_key

    def renew_device_key(self, account_id: AccountId) -> None:
        row = self._row(account_id)
        if row is not None:
            row.device_key = new_device_key()
            self.db.flush()

    # --- Pictures (part 2) ---------------------------------------------------------------------------------------
    def picture_of(self, account_id: AccountId) -> tuple[bytes, datetime] | None:
        row = self._row(account_id)
        if row is None or row.avatar_at is None or not row.avatar:
            return None
        return bytes(row.avatar), _aware(row.avatar_at)

    def set_picture(self, account_id: AccountId, data: bytes, at: datetime, source: str) -> None:
        row = self._row(account_id)
        if row is not None:
            row.avatar = data
            row.avatar_at = at
            row.avatar_hash = hashlib.sha256(data).hexdigest()
            row.avatar_source = PROVIDER if source == PROVIDER else ""
            self.db.flush()

    def remove_picture(self, account_id: AccountId) -> None:
        row = self._row(account_id)
        if row is not None:
            row.avatar = None
            row.avatar_at = None
            row.avatar_hash = ""
            row.avatar_source = ""
            self.db.flush()

    # --- The operator's functions, the theme, the sign-in switches (konten 1.1.0, ``model3``) ----------------------
    def active_operators(self) -> int:
        return int(self.db.scalar(
            select(func.count()).select_from(Account)
            .where(Account.role == OPERATOR, Account.blocked_at.is_(None), Account.deleted_at.is_(None))
        ) or 0)

    def set_operator(self, account_id: AccountId, operator: bool) -> None:
        row = self._row(account_id)
        if row is not None:
            row.role = OPERATOR if operator else MEMBER
            self.db.flush()

    def set_blocked(self, account_id: AccountId, at: datetime | None) -> None:
        row = self._row(account_id)
        if row is None:
            return
        row.blocked_at = at
        if at is None:
            row.failed_logins = 0
            row.locked_until = None
        self.db.flush()

    def set_deleted(self, account_id: AccountId, at: datetime | None) -> None:
        """Deleted or back: its memberships stay (decided E33), but its member rows go to every device anew, gone while
        deleted and back again after (``changes.page`` gives a deleted account's member row as gone)."""
        from . import cursor

        row = self._row(account_id)
        if row is None:
            return
        row.deleted_at = at
        members = list(self.db.scalars(select(Member).where(Member.account_id == row.id)))
        if members:
            first = cursor.take(self.db, len(members))
            for number, member in enumerate(members):
                member.cursor = first + number
        # Its tasks too, where it is assigned: every device shows them anew, without it or with it again (E35).
        given = [task for task in self.db.scalars(select(Reminder)) if row.id in (task.assignees or [])
                 or row.id in (task.rotation or [])]
        if given:
            first = cursor.take(self.db, len(given))
            for number, task in enumerate(given):
                task.cursor = first + number
        self.members_moved = True
        self.db.flush()

    def shut_out(self, account_id: AccountId) -> None:
        """Blocking, or deleting with its days to bring it back: every browser session and sign-in that waits, the key
        of known browsers, the QR codes nobody used yet. Paired iPhones, iPads and Macs rest (konten 1.1.5, G26): they
        stay and are refused while the account is out (``nexgeraete.authenticate`` answers ``account_blocked``), and
        work again once it is back, without pairing anew. API tokens and calendar subscriptions stay too, refused
        while the account is shut (``Account.shut``)."""
        from ..vendor.nexkonten import factor
        from . import totp

        self.db.execute(delete(AuthSession).where(AuthSession.account_id == int(account_id)))
        self.db.execute(delete(AppPairing).where(AppPairing.account_id == int(account_id)))
        self.db.execute(delete(AppCode).where(AppCode.account_id == int(account_id)))
        # Connected AI programs end like the sessions (E42); MCP keys made by hand rest like API tokens (E41).
        from .schluessel_store import SchluesselStore

        SchluesselStore(self.db).end_programs_of(int(account_id))
        totp.forget_account(int(account_id))
        factor.drop_waiting(int(account_id))
        self.renew_device_key(account_id)

    def _end_mcp_keys(self, account_id: AccountId) -> int:
        """Every MCP key and connected program of the account, with what they spent and their rights per tool."""
        from .schluessel_store import SchluesselStore

        store = SchluesselStore(self.db)
        ids = list(self.db.scalars(select(McpKey.id).where(McpKey.account_id == int(account_id))))
        for number in ids:
            store.end_program(f"mcp-{number}")
        return len(ids)

    def on_shut_out(self, account: KontoAccount) -> None:
        """Konten 1.1.0 (E38), after the commit: the account went out. Nothing is pushed or mailed to it while it is
        out (``channels.ready`` answers none for a shut account; its browser subscriptions and its address stay), and
        nextasks keeps no syncs of its own in the background that would need holding. Its paired devices rest: the
        device module sends nothing while ``Holder.out`` (G26)."""
        logger.info("Account out, its pushes held account_id=%s", account.id)

    def on_back(self, account: KontoAccount) -> None:
        """Konten 1.1.0 (E38), after the commit: the account can sign in again; its pushes go out again by themselves
        (``channels.ready``)."""
        logger.info("Account back, its pushes go out again account_id=%s", account.id)

    def deleted_before(self, moment: datetime) -> list[AccountId]:
        return list(self.db.scalars(
            select(Account.id).where(Account.deleted_at.is_not(None), Account.deleted_at <= moment)
        ))

    def purge_account(self, account_id: AccountId) -> None:
        """As deleting did in 0.8.0 (``accounts.delete_account``): every space left (its reminders stay; where it was
        the last manager, the member who joined first becomes manager), its space "Private" gone, the name reserved
        for good."""
        from . import accounts, gone, verbinden

        row = self._row(account_id)
        if row is not None:
            # Its connections with other nex apps end first, and the partners hear it (verbinden 0.1.1).
            verbinden.end_all(self.db, int(account_id))
            accounts.delete_account(self.db, row)
        gone.forget()

    def set_storage_limit(self, account_id: AccountId, limit: int | None) -> None:
        """nextasks has no storage limit per account (the module's table): never called."""
        raise NotImplementedError("nextasks has no storage limit per account")

    def set_right(self, account_id: AccountId, right: str, allowed: bool) -> None:
        """nextasks has no rights per account (the module's table): never called."""
        raise NotImplementedError("nextasks has no rights per account")

    def set_theme(self, account_id: AccountId, theme: str) -> None:
        row = self._row(account_id)
        if row is not None:
            row.theme = theme
            self.db.flush()

    def sign_in_settings(self) -> SignInSettings:
        from . import settings_service

        return SignInSettings(
            password_login=bool(settings_service.get(self.db, SWITCH_PASSWORD_LOGIN)),
            factor_required=self.factor_required(),
            passkeys_allowed=self.passkeys_allowed(),
        )

    def save_sign_in_settings(self, settings: SignInSettings) -> None:
        from . import settings_service

        settings_service.save(self.db, {
            SWITCH_PASSWORD_LOGIN: settings.password_login,
            SWITCH_FACTOR_REQUIRED: settings.factor_required,
            SWITCH_PASSKEYS: settings.passkeys_allowed,
        }, commit=False)

    def active_providers(self) -> int:
        return int(self.db.scalar(
            select(func.count()).select_from(OidcProvider).where(OidcProvider.enabled.is_(True))
        ) or 0)

    # --- Transaction ---------------------------------------------------------------------------------------------
    def commit(self) -> None:
        self.db.commit()
        if getattr(self, "members_moved", False):
            from . import cursor, gone

            self.members_moved = False
            gone.forget()
            cursor.touched_everybody()

    def rollback(self) -> None:
        self.joined_space = False
        self.members_moved = False
        self.db.rollback()


def store_of(db: Session) -> KontenStore:
    return KontenStore(db)


@contextmanager
def own_store() -> Iterator[KontenStore]:
    """A store with a session of its own, for work after the answer (a forgotten password, a provider's picture)."""
    from ..db import SessionLocal

    with SessionLocal() as db:
        yield KontenStore(db)


def provider_picture(account_id: int, address: str, issuer: str) -> None:
    """The provider's picture for an account without one, in a thread of its own (a fetch takes up to five seconds).
    Whatever fails, the account stays without a picture; the sign-in went through long before."""

    def work() -> None:
        with own_store() as store:
            nexkonten.pictures.take_provider_picture(store, account_id, address, issuer)

    if PICTURE_IN_THREAD:
        threading.Thread(target=work, name="nextasks-provider-picture", daemon=True).start()
    else:
        work()
