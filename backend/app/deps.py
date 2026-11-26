"""Who is asking.

Every route under ``/api`` except setup, sign-in, invitations, the public reading pages, languages and health needs
the session cookie. Changing requests need ``X-Nextasks-Client`` on top (``GuardMiddleware``): a page on another site
can make a browser send a form with the cookie, but not a request with a header of its own.
"""

from __future__ import annotations

import ipaddress
import logging
from functools import lru_cache
from typing import Annotated

from fastapi import Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import get_settings
from .db import SessionLocal, get_db
from .errors import detail, error
from .models import OPERATOR, SIGN_IN_PASSWORD, OidcLink, OidcProvider, utcnow
from .models import Account as AccountRow
from .security import SESSION_COOKIE, session_account, session_by_provider, session_created_at
from .services import accounts, logs, totp
from .vendor.nexkonten.brake import BRAKE, DOOR_CONFIRM, door_key
from .vendor.nexkonten.common import FRESH_SIGN_IN_MINUTES, fresh_sign_in

DbSession = Annotated[Session, Depends(get_db)]

logger = logging.getLogger("nextasks.auth")


@lru_cache(maxsize=4)
def _trusted_networks(spec: str) -> tuple[ipaddress.IPv4Network | ipaddress.IPv6Network, ...]:
    networks = []
    for entry in spec.split(","):
        entry = entry.strip()
        if not entry:
            continue
        try:
            networks.append(ipaddress.ip_network(entry, strict=False))
        except ValueError:
            continue
    return tuple(networks)


def parse_address(text: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    """The address in a peer or a forwarded hop, without port, brackets or zone; IPv4 in IPv6 dress unwrapped."""
    text = text.strip()
    candidates = [text]
    if text.startswith("[") and "]" in text:
        candidates.insert(0, text[1 : text.index("]")])
    elif text.count(":") == 1:
        candidates.insert(0, text.split(":")[0])
    for candidate in candidates:
        try:
            address = ipaddress.ip_address(candidate.split("%")[0])
        except ValueError:
            continue
        if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
            return address.ipv4_mapped
        return address
    return None


def normal_address(text: str) -> str:
    """One sender, one spelling, for the brake: IPv6 as its /64 (one connection usually holds a whole /64). Before,
    every port and every way of writing an address counted as a new sender."""
    address = parse_address(text)
    if address is None:
        return text.strip()[:64]
    if isinstance(address, ipaddress.IPv6Address) and not address.is_loopback:
        return str(ipaddress.ip_network(f"{address}/64", strict=False))
    return str(address)


def is_trusted_proxy(text: str) -> bool:
    networks = _trusted_networks(get_settings().trusted_proxies)
    address = parse_address(text) if networks else None
    return address is not None and any(address in network for network in networks)


_warned_unknown_proxy = False
#: Headers a reverse proxy adds; any of them without a trusted proxy configured means one stands in front unnamed.
PROXY_HEADERS = ("x-forwarded-for", "x-real-ip", "forwarded")


def behind_unknown_proxy(request: Request) -> bool:
    """A request that came through a proxy nextasks was not told to believe: all senders look alike then. Noted once
    in the log, and remembered for the server's settings (``unknown_proxy_seen``, ``proxy_unknown``)."""
    global _warned_unknown_proxy
    if _trusted_networks(get_settings().trusted_proxies) or not any(request.headers.get(h) for h in PROXY_HEADERS):
        return False
    if not _warned_unknown_proxy:
        _warned_unknown_proxy = True
        logger.warning("Requests arrive with proxy headers, but NEXTASKS_TRUSTED_PROXIES is not set: every sender "
                       "looks like the proxy. Set it to the proxy's address so the sign-in brake can tell them apart.")
    return True


def unknown_proxy_seen(request: Request) -> bool:
    """Whether this request or one before came through a proxy that is not configured (while none is)."""
    return behind_unknown_proxy(request) or (
        _warned_unknown_proxy and not _trusted_networks(get_settings().trusted_proxies))


def client_ip(request: Request) -> str:
    """The sender's address, for the brake. ``X-Forwarded-For`` counts only from a configured trusted proxy, and
    then its rightmost hop that is not itself a trusted proxy: everything left of it the sender wrote itself."""
    peer = request.client.host if request.client else "-"
    forwarded = request.headers.get("x-forwarded-for", "")
    if not forwarded or not is_trusted_proxy(peer):
        return normal_address(peer)
    hops = [hop.strip() for hop in forwarded.split(",") if hop.strip()]
    for hop in reversed(hops):
        if not is_trusted_proxy(hop):
            return normal_address(hop)
    return normal_address(hops[0] if hops else peer)


#: What an account that must set up its second factor may still reach: itself, the way out, and the setup.
SETUP_ONLY_PATHS = {
    "/api/auth/me", "/api/auth/logout", "/api/auth/totp/begin", "/api/auth/totp/setup", "/api/auth/totp/confirm",
    "/api/auth/passkeys", "/api/auth/passkeys/begin", "/api/auth/passkeys/finish",
    # The module schluessel's rule (decided E33): an account that owes its second factor still lists and makes its API
    # keys, told that they rest; they open nothing until the factor is there (``apitokens.authenticate``).
    "/api/connections/keys",
}


def require_account(request: Request) -> AccountRow:
    """The signed-in account, detached from the database session (routes open their own)."""
    with SessionLocal() as db:
        account = session_account(db, request.cookies.get(SESSION_COOKIE))
        if account is None:
            raise error("sign_in_required", "Sign in first.", 401)
        if request.url.path not in SETUP_ONLY_PATHS and totp.setup_required(
            db, account, by_provider=session_by_provider(db, request.cookies.get(SESSION_COOKIE))
        ):
            raise error("second_factor_setup_required", "Set up your second factor first.", 403)
        db.expunge(account)
    logs.set_actor(account.name)
    return account


def require_operator(request: Request, account: Annotated[AccountRow, Depends(require_account)]) -> AccountRow:
    if account.role != OPERATOR:
        raise error("operator_only", "Only the operator may do this.", 403)
    networks = _trusted_networks(get_settings().operator_networks)
    if networks:
        try:
            sender = ipaddress.ip_address(client_ip(request).split("/")[0])
        except ValueError:
            sender = None
        # An IPv6 sender stands as its /64 here: its network's first address is inside the operator's networks
        # exactly when the /64 is (they are not smaller than /64 in a home network).
        if sender is None or not any(sender in network for network in networks):
            raise error("operator_network", "The operator's settings are open only from the home network.", 403)
    return account


Account = Annotated[AccountRow, Depends(require_account)]
OperatorAccount = Annotated[AccountRow, Depends(require_operator)]


# --- The password once more, while signed in ------------------------------------------------------------------------
#
# Changing the password or linking the account to a provider asks for the password again, and a wrong answer counts
# the way it does at sign-in: otherwise a stolen cookie would be a place to guess without limit. The count is the
# shared module's (``confirm:<account>``, five free), the same the module's own doors use: a route of nextasks' own
# and one of the module never count apart.


def _reauth_keys(account: AccountRow) -> tuple[str, ...]:
    return (door_key(DOOR_CONFIRM, account.id),)


def too_many(wait: float) -> HTTPException:
    seconds = max(1, int(wait + 0.999))
    return HTTPException(
        status_code=429,
        detail=detail("too_many_attempts", "Too many attempts. Try again later.", retry_after=seconds),
        headers={"Retry-After": str(seconds)},
    )


def reauth_guard(request: Request, account: AccountRow) -> None:
    """One password typed to confirm: refused while the account is locked or its count waits; counted as a failure
    until ``reauth_succeeded`` takes it back."""
    if accounts.is_locked(account):
        raise error("account_locked", "Too many failed attempts. Try again later.", 429)
    wait = BRAKE.claim(_reauth_keys(account))
    if wait > 0:
        raise too_many(wait)


def reauth_failed(request: Request, db: Session, account: AccountRow) -> None:
    accounts.note_failure(db, account)


def reauth_succeeded(request: Request, db: Session, account: AccountRow) -> None:
    BRAKE.succeeded(_reauth_keys(account))
    accounts.note_success(db, account)


#: How old the session of an account without a password may be to confirm an act a stolen session must not be enough
#: for: the shared module's window (``nexkonten.common.FRESH_SIGN_IN_MINUTES``, five minutes).
FRESH_MINUTES = FRESH_SIGN_IN_MINUTES


def fresh_session(request: Request, db: Session, account: AccountRow) -> bool:
    """The browser session of this request began within ``FRESH_MINUTES``: a fresh sign-in."""
    started = session_created_at(db, request.cookies.get(SESSION_COOKIE))
    return started is not None and fresh_sign_in(started, utcnow())


def fresh_from_provider(request: Request, db: Session, row: AccountRow) -> None:
    """An account without a password of its own confirms by a fresh sign-in at its provider: refused with
    ``fresh_sign_in_required`` (and the providers to sign in with) when the session is older."""
    if fresh_session(request, db, row):
        return
    providers = [
        {"slug": entry.slug, "label": entry.label}
        for entry in db.scalars(
            select(OidcProvider).join(OidcLink, OidcLink.provider_id == OidcProvider.id)
            .where(OidcLink.account_id == row.id, OidcProvider.enabled.is_(True))
        )
    ]
    raise error("fresh_sign_in_required", "Sign in again at your provider first: this needs a sign-in from the "
                f"last {FRESH_MINUTES} minutes.", 403, minutes=FRESH_MINUTES, providers=providers)


def has_password(row: AccountRow) -> bool:
    return row.sign_in == SIGN_IN_PASSWORD and bool(row.password_hash)


def confirmed_without_password(request: Request, db: Session, row: AccountRow) -> bool:
    """For the module's ``actor_confirmed``: an account with a password confirms with it (False here, the module
    checks); one without proves it is still them by a fresh sign-in at its provider (True, or refused)."""
    if has_password(row):
        return False
    fresh_from_provider(request, db, row)
    return True


def confirm_operator(request: Request, db: Session, operator: AccountRow, password: str) -> None:
    """The operator's password once more, before an act a stolen session must not be enough for: carrying a backup
    away, making a reset link for another account, taking its second factor, changing a role or a name, deleting an
    account. An operator who signs in through the provider confirms by a fresh sign-in there."""
    row = db.get(AccountRow, operator.id)
    assert row is not None
    if not has_password(row):
        fresh_from_provider(request, db, row)
        return
    reauth_guard(request, row)
    if not accounts.check_password(row, password):
        reauth_failed(request, db, row)
        raise error("wrong_password", "The current password is wrong.", 401)
    reauth_succeeded(request, db, row)


# --- Spaces -----------------------------------------------------------------------------------------------------------


def space_ids(account: AccountRow) -> set[str]:
    """The spaces the account is a member of (for a token limited to some, only those)."""
    from .services import spaces

    with SessionLocal() as db:
        found = set(spaces.space_ids_of(db, account.id))
    return found if account.key_spaces is None else found & set(account.key_spaces)
