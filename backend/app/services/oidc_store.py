"""nextasks's side of the shared sign-in module ``vendor/nexoidc``: the ``Store`` over its tables and the start-up
configuration. The new nextasks (November 2026) starts with the provider list; there is no single provider of the
settings to migrate from, and no way back to one (``legacy_model = "none"`` in the contract tests).

The module (the shared blueprint "Anmeldung mit OIDC und authentik") runs the protocol, decides who an identity is and
keeps the provider list; it never sees a database. What is nextasks's own lives here: accounts and their names, the
space an invitation brings into, the address an account takes from its provider, and the encryption of the client
secrets with the server secret.

A ``SqlStore`` works inside one SQLAlchemy session, one request. The module commits when an outcome is settled and
rolls back when it refuses after a write (a consumed invitation comes back that way).
"""

from __future__ import annotations

import logging
import ssl

from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session

from .. import __version__
from ..config import get_settings
from ..db import SessionLocal
from ..models import MEMBER, SIGN_IN_OIDC, SIGN_IN_PASSWORD, Account, OidcLink, OidcProvider, utcnow
from ..models import Invite as InviteRow
from ..security import decrypt_secret, encrypt_secret
from ..vendor import nexkonten, nexoidc
from ..vendor.nexoidc import (
    AccountState,
    Invite,
    Link,
    Provider,
    ProviderValues,
    secret_context,
)
from . import accounts, settings_service
from .konten_store import KontenStore
from .konten_store import provider_picture as konten_provider_picture

logger = logging.getLogger("nextasks.oidc")

APP_NAME = "nextasks"
#: Where nextasks's sign-in and account pages are, as the module sends the browser there.
LOGIN_PAGE = "/login"
ACCOUNT_PAGE = "/account"
HOME = "/"
#: ``Account.email_source`` of an address that came from a provider.
FROM_PROVIDER = "provider"


def _public_url() -> str:
    with SessionLocal() as db:
        return settings_service.public_url(db)


def _save_public_url(address: str) -> None:
    """The address the operator confirmed in the authentik card becomes the setting ``public_url``, at once and in a
    transaction of its own (module 1.0.10)."""
    with SessionLocal() as db:
        settings_service.save(db, {"public_url": address})


def _server_secret() -> str:
    return get_settings().resolved_secret_key()


def configure(*, ssl_context: ssl.SSLContext | None = None) -> None:
    """Tell the module who it runs in; called once when the app is made (and by the tests), and again at start with
    the TLS context nextasks shares for every call outside (``services/net.py``), read there outside the event loop."""
    nexoidc.configure(
        nexoidc.AppConfig(
            app_name=APP_NAME,
            server_secret=_server_secret,
            public_url=_public_url,
            save_public_url=_save_public_url,
            login_page=LOGIN_PAGE,
            account_page=ACCOUNT_PAGE,
            home=HOME,
            # Two instances on one host share cookies; the suffix keeps their sign-in attempts apart, as it does their
            # sessions.
            cookie_suffix=get_settings().cookie_name_suffix(),
            ssl_context=ssl_context,
        )
    )


def clean_name(raw: str) -> str:
    """Since ``oidc`` 1.1.0 the naming rules of the shared account module (the same in every app): lower case,
    ``a-z 0-9 . _ -``, umlauts written out (``Müller`` becomes ``mueller``), a number at the end survives the cut; ""
    when nothing usable is left."""
    return nexkonten.names.clean_username(raw)


def has_links(db: Session, account_id: int) -> bool:
    return db.scalar(select(OidcLink.id).where(OidcLink.account_id == account_id).limit(1)) is not None


class SqlStore:
    """``nexoidc.Store`` over ``oidc_providers`` and ``oidc_links``, inside one session."""

    def __init__(self, db: Session) -> None:
        self.db = db

    # --- Providers -------------------------------------------------------------------------------------------------

    def _provider(self, row: OidcProvider | None) -> Provider | None:
        if row is None:
            return None
        return Provider(
            id=row.id,
            slug=row.slug,
            label=row.label,
            issuer=row.issuer,
            client_id=row.client_id,
            client_secret=decrypt_secret(row.client_secret_enc, secret_context(row.id)),
            scopes=row.scopes,
            enabled=row.enabled,
            auto_create=row.auto_create,
            trusts_second_factor=row.trusts_second_factor,
            managed=row.managed,
            position=row.position,
            redirect_path=row.redirect_path,
            created_at=row.created_at,
            registered_redirect=row.registered_redirect or "",
        )

    def list_providers(self) -> list[Provider]:
        rows = self.db.scalars(select(OidcProvider).order_by(OidcProvider.position, OidcProvider.id))
        return [provider for provider in (self._provider(row) for row in rows) if provider is not None]

    def get_provider(self, provider_id: int) -> Provider | None:
        return self._provider(self.db.get(OidcProvider, provider_id))

    def provider_by_slug(self, slug: str) -> Provider | None:
        return self._provider(self.db.scalar(select(OidcProvider).where(OidcProvider.slug == slug)))

    @staticmethod
    def _apply(row: OidcProvider, values: ProviderValues) -> None:
        row.slug, row.label, row.issuer, row.client_id = values.slug, values.label, values.issuer, values.client_id
        row.scopes, row.enabled, row.auto_create = values.scopes, values.enabled, values.auto_create
        row.trusts_second_factor, row.managed, row.position = (
            values.trusts_second_factor,
            values.managed,
            values.position,
        )
        row.redirect_path = values.redirect_path
        # None keeps what the authentik button registered last; only the button writes it.
        if values.registered_redirect is not None:
            row.registered_redirect = values.registered_redirect

    def insert_provider(self, values: ProviderValues) -> Provider:
        row = OidcProvider()
        self._apply(row, values)
        self.db.add(row)
        self.db.flush()
        row.client_secret_enc = encrypt_secret(values.client_secret or "", secret_context(row.id))
        self.db.flush()
        provider = self._provider(row)
        assert provider is not None
        return provider

    def update_provider(self, provider_id: int, values: ProviderValues) -> Provider:
        row = self.db.get(OidcProvider, provider_id)
        assert row is not None
        self._apply(row, values)
        if values.client_secret is not None:
            row.client_secret_enc = encrypt_secret(values.client_secret, secret_context(row.id))
        self.db.flush()
        provider = self._provider(row)
        assert provider is not None
        return provider

    def delete_provider(self, provider_id: int) -> None:
        # Foreign keys are on (db.py), the links would go anyway; said here so that nothing depends on a pragma.
        self.drop_links(provider_id)
        self.db.execute(delete(OidcProvider).where(OidcProvider.id == provider_id))

    # --- Links -----------------------------------------------------------------------------------------------------

    @staticmethod
    def _link(row: OidcLink) -> Link:
        return Link(row.provider_id, row.subject, row.account_id, row.issuer, row.email, row.created_at,
                    row.last_used_at)

    def find_link(self, provider_id: int, subject: str) -> Link | None:
        row = self.db.scalar(select(OidcLink).where(OidcLink.provider_id == provider_id, OidcLink.subject == subject))
        return self._link(row) if row else None

    def links_of_provider(self, provider_id: int) -> list[Link]:
        rows = self.db.scalars(select(OidcLink).where(OidcLink.provider_id == provider_id).order_by(OidcLink.id))
        return [self._link(row) for row in rows]

    def links_of_account(self, account_id: int) -> list[Link]:
        rows = self.db.scalars(select(OidcLink).where(OidcLink.account_id == account_id).order_by(OidcLink.id))
        return [self._link(row) for row in rows]

    def add_link(self, link: Link) -> None:
        self.db.add(OidcLink(provider_id=link.provider_id, subject=link.subject, account_id=link.account_id,
                             issuer=link.issuer, email=link.email))
        self.db.flush()
        self._address(link.provider_id, link.account_id, link.email)

    def remove_link(self, provider_id: int, account_id: int) -> bool:
        result = self.db.execute(
            delete(OidcLink).where(OidcLink.provider_id == provider_id, OidcLink.account_id == account_id)
        )
        removed = bool(result.rowcount)  # type: ignore[attr-defined]
        if removed:
            self._forget_provider_address(account_id)
        return removed

    def drop_links(self, provider_id: int) -> int:
        holders = set(self.db.scalars(select(OidcLink.account_id).where(OidcLink.provider_id == provider_id)))
        result = self.db.execute(delete(OidcLink).where(OidcLink.provider_id == provider_id))
        for account_id in holders:
            self._forget_provider_address(account_id)
        return int(result.rowcount or 0)  # type: ignore[attr-defined]

    def touch_link(self, provider_id: int, subject: str, email: str | None) -> None:
        self.db.execute(
            update(OidcLink)
            .where(OidcLink.provider_id == provider_id, OidcLink.subject == subject)
            .values(last_used_at=utcnow(), email=email)
        )
        account_id = self.db.scalar(
            select(OidcLink.account_id).where(OidcLink.provider_id == provider_id, OidcLink.subject == subject)
        )
        if account_id is not None:
            self._address(provider_id, account_id, email)

    # --- The address from the provider -----------------------------------------------------------------------------

    def _address(self, provider_id: int, account_id: int, email: str | None) -> None:
        """What the provider says about the address, through the shared account module
        (``profiles.provider_email``): an account through providers only follows it (it does not count and is not
        proven) while it has no address of its own; an account with a password is only offered it ("Use the address
        from <provider>?" in the profile). Never an address another account has, never one the account declined."""
        address = _usable_address(self.db, email, account_id)
        if not address:
            return
        provider = self.db.get(OidcProvider, provider_id)
        self.db.flush()
        nexkonten.profiles.provider_email(KontenStore(self.db), account_id, address,
                                          provider=provider.label if provider is not None else "")

    def _forget_provider_address(self, account_id: int) -> None:
        """No provider left for the account: an address that came from one goes too (and the offer), an own one
        stays."""
        if has_links(self.db, account_id):
            return
        account = self.db.get(Account, account_id)
        if account is None:
            return
        if account.email_source == FROM_PROVIDER:
            account.email, account.email_source = "", ""
            account.email_confirmed, account.email_counted = "", ""
        account.provider_email = ""
        account.provider_email_from = ""

    # --- Accounts --------------------------------------------------------------------------------------------------

    def account_state(self, account_id: int) -> AccountState | None:
        row = self.db.get(Account, account_id)
        if row is None:
            return None
        return AccountState(
            id=row.id,
            name=row.name,
            # Blocked: no way in, as with a password (its reminders stay where they are).
            blocked=row.shut,
            has_password=row.sign_in == SIGN_IN_PASSWORD and bool(row.password_hash),
            has_second_factor=bool(row.totp_secret_enc),
        )

    def clean_name(self, raw: str) -> str:
        return clean_name(raw)

    def name_taken(self, name: str) -> bool:
        """Taken: another account has the name now or had it, it belonged to an account deleted for good, or it is
        somebody else's display name (the shared account module)."""
        return nexkonten.names.username_taken(KontenStore(self.db), name)

    def create_account(
        self, name: str, *, invite: Invite | None, email: str | None, display_name: str = "", picture: str = ""
    ) -> int:
        """A new account through a provider only (no password).

        - **Display name:** the provider's (claim ``name``), else the invitation's, else empty; one another account
          shows stays empty (unique, the account module).
        - **Address:** the invitation's (it counts; proven when the link went by mail), else the provider's when no
          other account has it: then it follows the provider and does not count. It never finds an account.
        - **Space:** an invitation into a space makes the account a member there (``accounts.redeem``).
        - **Picture:** comes through ``provider_picture``, not here."""
        del picture
        store = KontenStore(self.db)
        invitation = invite.rights if invite is not None and isinstance(invite.rights, InviteRow) else None
        shown = nexkonten.names.provider_display_name(store, display_name or "")
        if not shown and invitation is not None:
            shown = nexkonten.names.provider_display_name(store, invitation.display_name or "")
        address = ""
        if invitation is not None and invitation.email and not _address_taken(self.db, invitation.email, 0):
            address = invitation.email
        row = Account(
            name=name,
            display_name=shown,
            role=MEMBER,
            sign_in=SIGN_IN_OIDC,
            password_hash="",
            # A new account starts "as the device says" (konten 1.1.0, E45).
            theme="system",
            email=address,
            email_counted=address,
            email_confirmed=address if invitation is not None and invitation.mailed else "",
            email_source="own" if address else "",
            whats_new_seen=__version__,
        )
        self.db.add(row)
        self.db.flush()
        if not address:
            provided = _usable_address(self.db, email, row.id)
            if provided:
                nexkonten.profiles.provider_email(store, row.id, provided)
                self.db.refresh(row)
        if invitation is not None:
            accounts.redeem(self.db, invitation, row, consumed=True, commit=False)
        logger.info("Account created name=%s role=%s sign_in=oidc", row.name, MEMBER)
        return row.id

    def provider_picture(self, account_id: int, picture: str, issuer: str) -> None:
        """After every sign-in through a provider that sends a picture: an account **without** a picture gets the
        provider's, in a thread of its own (a fetch takes up to five seconds). An own picture is never replaced."""
        row = self.db.get(Account, account_id)
        if row is None or row.avatar_at is not None:
            return
        konten_provider_picture(row.id, picture, issuer)

    # --- Invitations -----------------------------------------------------------------------------------------------

    def find_invite(self, key: str) -> Invite | None:
        row = accounts.find_invite(self.db, key)
        return Invite(key=key, id=row.id, rights=row) if row is not None else None

    def consume_invite(self, invite: Invite) -> bool:
        row = invite.rights
        return isinstance(row, InviteRow) and accounts.consume(self.db, row)

    def accept_invite(self, account_id: int, invite: Invite) -> None:
        # A known identity came through an invitation (module 1.0.8): the rights of the invitation come on top of the
        # account's own, never fewer: a member stays what it was. The address it was made for is not taken over: the
        # account has its own.
        row = self.db.get(Account, account_id)
        if row is not None and isinstance(invite.rights, InviteRow):
            accounts.redeem(self.db, invite.rights, row, consumed=True, commit=False)

    # --- Transaction -----------------------------------------------------------------------------------------------

    def commit(self) -> None:
        self.db.commit()

    def rollback(self) -> None:
        self.db.rollback()


def _address_taken(db: Session, address: str, own_id: int) -> bool:
    holder = db.scalar(
        select(Account.id).where(func.lower(Account.email) == address.lower(), Account.id != own_id).limit(1)
    )
    return holder is not None


def _usable_address(db: Session, email: str | None, own_id: int) -> str:
    """The provider's address when it passes the check typed addresses pass and no other account has it, else ""."""
    address = (email or "").strip()[:255]
    if not address or not accounts.EMAIL_PATTERN.match(address):
        return ""
    return "" if _address_taken(db, address, own_id) else address


def linked_providers(db: Session) -> dict[int, list[dict[str, object]]]:
    """Per account the providers it is linked to, in the order of the list (marks in the operator's account list)."""
    linked: dict[int, list[dict[str, object]]] = {}
    for link, entry in db.execute(
        select(OidcLink, OidcProvider)
        .join(OidcProvider, OidcProvider.id == OidcLink.provider_id)
        .order_by(OidcProvider.position, OidcProvider.id)
    ):
        linked.setdefault(link.account_id, []).append(
            {"id": entry.id, "slug": entry.slug, "label": entry.label, "managed": entry.managed}
        )
    return linked
