"""Setting up the first account, signing in and out, a forgotten password, and the own account.

Setup, sign-in, the profile and a forgotten password run through the shared account module (``vendor/nexkonten``,
store ``services/konten_store.py``), the same in every nex app; the routes and their field names stay as 0.8.0 had
them (``name`` is the username, at sign-in "Username or email"; answers only gain fields). The operator's list of
accounts is in ``routers/accounts.py``, invitations and links for a new password in ``routers/invites.py``, the
address in ``routers/notifications.py``.
"""

from __future__ import annotations

import logging
import threading
import unicodedata
from collections.abc import Callable
from typing import Annotated, Any

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import __version__
from ..config import get_settings
from ..deps import (
    Account,
    DbSession,
    behind_unknown_proxy,
    client_ip,
    confirmed_without_password,
    fresh_session,
    reauth_failed,
    reauth_guard,
    reauth_succeeded,
    too_many,
)
from ..errors import detail, error
from ..models import OPERATOR, SIGN_IN_PASSWORD
from ..models import Account as AccountRow
from ..models_accounts import FormerName
from ..models_accounts import Passkey as PasskeyRow
from ..security import (
    DEVICE_COOKIE,
    DEVICE_DAYS,
    MIN_PASSWORD,
    SESSION_COOKIE,
    brake,
    device_of,
    end_all_sessions,
    end_session,
    server_key,
    session_account,
    session_by_provider,
    session_cookie_age,
    session_uid,
    start_session,
)
from ..services import (
    accounts,
    clock,
    cursor,
    emailaddr,
    kontenpost,
    locales,
    post_store,
    settings_service,
    spaces,
    totp,
    visibility,
)
from ..services.accounts import AccountError
from ..services.konten_store import KontenStore, counts, pending_of, proven
from ..services.oidc_store import SqlStore
from ..vendor import nexkonten
from ..vendor.nexkonten import login as konten_login
from ..vendor.nexkonten import passkeys as konten_passkeys
from ..vendor.nexkonten import profiles, resets
from ..vendor.nexkonten import sessions as konten_sessions
from ..vendor.nexkonten import setup as konten_setup
from ..vendor.nexkonten.brake import DOOR_FORGOT, door_key
from ..vendor.nexoidc import providers

logger = logging.getLogger("nextasks.auth")

router = APIRouter(prefix="/api", tags=["auth"])

#: The languages inside the frontend; others come as files from the operator.
SHIPPED = ("en", "de")
#: Names a sign-in waiting for its second factor (``services/totp.py``), and nothing else.
PENDING_COOKIE = "nextasks_2fa" + get_settings().cookie_name_suffix()


class SetupIn(BaseModel):
    #: The username (field ``name`` as in 0.8.0); left out, a suggestion from the display name.
    name: str | None = Field(default=None, max_length=64)
    #: The display name (since the shared account module); left out, the username stands in (a page of 0.8.0).
    display_name: str | None = Field(default=None, max_length=200)
    email: str = Field(default="", max_length=255)
    password: str = Field(max_length=200)
    #: The password typed a second time; checked when given (see ``check_confirm``).
    password_confirm: str | None = Field(default=None, max_length=200)
    language: str = Field(default="", max_length=16)
    #: The setup code from the server's log (or NEXTASKS_SETUP_TOKEN).
    code: str = Field(default="", max_length=200)


class LoginIn(BaseModel):
    #: "Username or email" (the field kept its name): an address is looked up by its @.
    name: str = Field(max_length=255)
    password: str = Field(max_length=200)
    #: "Stay signed in" (on from the start): 30 days from the last use; without it the browser's session only.
    remember: bool = True


class ForgotIn(BaseModel):
    #: "Username or email".
    name: str = Field(max_length=255)


class PasswordChangeIn(BaseModel):
    current: str = Field(max_length=200)
    new: str = Field(max_length=200)
    #: The new password typed a second time; checked when given (see ``check_confirm``).
    password_confirm: str | None = Field(default=None, max_length=200)


class LanguageIn(BaseModel):
    language: str = Field(max_length=16)


class ProfileIn(BaseModel):
    #: Left out, it stays as it is; empty shows the username.
    display_name: str | None = Field(default=None, max_length=200)
    #: IANA time zone for due notifications; left out, it stays as it is; empty: the server's.
    timezone: str | None = Field(default=None, max_length=64)
    #: A new username (since the shared account module).
    name: str | None = Field(default=None, max_length=64)
    #: A new address (since the shared account module; ``PUT /api/me/email`` does the same).
    email: str | None = Field(default=None, max_length=255)
    #: The own password, for a new username or address of an account that has one.
    password: str = Field(default="", max_length=200)


class SwitchIn(BaseModel):
    on: bool


#: Longest display name, in characters.
DISPLAY_NAME_MAX = 80


def check_display_name(value: str) -> str:
    """The checks of 0.8.0 with their codes (``display_name_invalid``, ``display_name_too_long``), before the shared
    module cleans the name and checks it is unique.

    Control characters are Unicode Cc: C0, DEL and C1 (U+0080 to U+009F, which went through before, A13). Format
    characters (Cf: the right-to-left override, zero-width spaces) let a name read other than it is.
    """
    if any(unicodedata.category(char) in ("Cc", "Cf") for char in value):
        raise error("display_name_invalid", "A display name cannot hold control or invisible characters.", 422)
    clean = " ".join(value.split())
    if len(clean) > DISPLAY_NAME_MAX:
        raise error(
            "display_name_too_long", f"Use at most {DISPLAY_NAME_MAX} characters.", 422, maximum=DISPLAY_NAME_MAX
        )
    return clean


def secure_cookie(request: Request) -> bool:
    mode = get_settings().cookie_secure.lower()
    if mode == "on":
        return True
    if mode == "off":
        return False
    # The scheme a trusted proxy reported is in ``request.url`` already (``ForwardedProtoMiddleware``); the header of
    # any other sender counts for nothing, as in the other apps (blueprint "Hinter einem Proxy").
    return request.url.scheme == "https"


def _set_cookie(response: Response, request: Request, token: str, remember: bool = True) -> None:
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=session_cookie_age(remember),
        httponly=True,
        samesite="lax",
        secure=secure_cookie(request),
        path="/",
    )


def fail(exc: AccountError | nexkonten.AccountError) -> HTTPException:
    """A refusal of nextasks' own account code or of the shared module, in nextasks' form: the module's codes answer
    under the names 0.8.0 used where it had others (``public_code``); a brake answers 429 with ``Retry-After``."""
    code = getattr(exc, "public_code", exc.code)
    values = dict(getattr(exc, "extra", {}) or {})
    if code != exc.code:
        # The module's own code beside the old one (konten 0.3.10, ``as_dict``): the page tells an expired link from
        # an invalid one although the old name is the same.
        values["account_code"] = exc.code
    if exc.code == "too_many_attempts":
        wait = int(values.get("retry_after") or 1)
        return HTTPException(status_code=429, detail=detail(code, exc.message, **values),
                             headers={"Retry-After": str(wait)})
    return error(code, exc.message, exc.status, **values)


def check_password(password: str) -> None:
    """The rule for a password set from now on (the module's: at least 12 characters)."""
    try:
        nexkonten.names.check_password_rule(password)
    except nexkonten.AccountError as exc:
        raise fail(exc) from exc


def check_confirm(password: str, confirm: str | None) -> None:
    """A new password typed twice must be the same twice. The web pages send the second one; a client that leaves it
    out (a script, a page of 0.8.0) is not checked, since only a person typing can mistype."""
    if confirm is not None and confirm != password:
        raise error("password_mismatch", "The passwords do not match.", 422, field="password_confirm")


def check_language(language: str) -> str:
    """Empty (the browser decides) or a language nextasks has."""
    if language and language not in SHIPPED and not locales.known(language):
        raise error("unknown_language", "nextasks does not have this language.", 422)
    return language


def former_name(db: Session | None, account: AccountRow) -> str:
    """The username the account had before its last change ("formerly …" under the field), "" for none."""
    if db is None:
        return ""
    return db.scalar(select(FormerName.name).where(FormerName.account_id == account.id)
                     .order_by(FormerName.id.desc()).limit(1)) or ""


def passkey_count(db: Session | None, account: AccountRow) -> int:
    if db is None:
        return 0
    return len(db.scalars(select(PasskeyRow.id).where(PasskeyRow.account_id == account.id)).all())


def account_view(account: AccountRow, db: Session | None = None) -> dict[str, Any]:
    """The own account as every page of 0.8.0 read it, and what the shared module adds (answers only gain fields)."""
    return {
        "id": account.id,
        "name": account.name,
        "display_name": account.display_name,
        # "What's new" (block X3): the running version and the one the account has read.
        "version": __version__,
        "whats_new_seen": account.whats_new_seen,
        "role": account.role,
        "sign_in": account.sign_in,
        "has_password": account.sign_in == SIGN_IN_PASSWORD and bool(account.password_hash),
        # When the password was set last ("Last changed on", konten 0.3.10); None for passwords of 0.8.0.
        "password_changed_at": account.password_changed_at.isoformat() if account.password_changed_at else None,
        "email": account.email,
        # The address counts (signing in, a forgotten password, mail); proven by a link; one waiting for its link.
        "email_confirmed": counts(account),
        "email_proven": proven(account),
        "email_source": account.email_source or "",
        "pending_email": pending_of(account),
        "former_name": former_name(db, account),
        # The address a sign-in provider knows the account by, offered on the profile (konten 0.3.4).
        "provider_email": KontenStore.offered(account),
        "provider_email_from": (account.provider_email_from or "") if KontenStore.offered(account) else "",
        "new_sign_in_mail": bool(account.new_sign_in_mail),
        # A password set through a link: the page lists the ways in that stayed, until put away.
        "new_password_origin": account.new_password_origin or "",
        # The password was set through the operator's (or the server's) link: the page says so until put away.
        "password_reset_notice": bool(account.password_reset_notice),
        "language": account.language,
        "timezone": account.timezone or clock.zone_name(),
        "two_factor": bool(account.totp_secret_enc),
        # "On" or "Off" beside the heading of the second factor (``SECOND_FACTOR_STATE``, konten 0.3.6).
        "factor_state": nexkonten.factor.state(KontenStore(db), account.id) if db is not None else (
            nexkonten.SECOND_FACTOR_ACTIVE if account.totp_secret_enc else nexkonten.SECOND_FACTOR_NONE),
        # NEXTASKS_SECOND_FACTOR_OFF: the emergency hammer holds, no second factor is asked of anybody.
        "second_factor_off": nexkonten.factor.switched_off(),
        "two_factor_recovery_left": len(totp.load_recovery(account.totp_recovery)) if account.totp_secret_enc else 0,
        "passkeys": passkey_count(db, account),
        "created_at": account.created_at.isoformat(),
        "last_seen_at": account.last_seen_at.isoformat() if account.last_seen_at else None,
        "avatar": account.avatar_at.isoformat() if account.avatar_at else None,
        "avatar_hash": account.avatar_hash or None,
        # Light, dark or as the device says, for the account on every device (konten 1.1.0); "" not chosen yet.
        "theme": account.theme or "",
        # The box "Address not confirmed yet" with "Send link" (konten 1.1.0, E23).
        "email_needs_proof": _needs_proof(db, account),
    }


def _needs_proof(db: Session | None, account: AccountRow) -> bool:
    if db is None:
        return False
    konto = KontenStore(db).get_account(account.id)
    return bool(konto) and nexkonten.profiles.needs_proof(konto, mail_server=post_store.configured(db))


def known_device(db: Session, request: Request, response: Response, account: AccountRow) -> None:
    """Marks this browser as one the account signed in with (the cookie of known browsers, the shared module's
    marks: random per account, signed, no account id in it; up to five accounts per browser)."""
    store = KontenStore(db)
    mark = konten_sessions.mark(server_key(), store.device_key(account.id))
    db.commit()
    value = konten_sessions.add_mark(request.cookies.get(DEVICE_COOKIE, ""), mark)
    response.set_cookie(DEVICE_COOKIE, value, max_age=DEVICE_DAYS * 86400, httponly=True,
                        samesite="lax", secure=secure_cookie(request), path="/api/auth")


def browser_mark(db: Session, request: Request, account_id: int) -> str:
    """The mark of a browser that signed in as this account before, "" for none: a mark of the shared module, or a
    cookie of 0.8.0 (``<id>.<nonce>.<mark>``, read for one version so that owners stay known)."""
    cookie = request.cookies.get(DEVICE_COOKIE, "")
    if not cookie:
        return ""
    store = KontenStore(db)
    try:
        key = store.device_key(account_id)
    except LookupError:
        return ""
    return konten_sessions.known_mark(cookie, server_key(), key,
                                      older=lambda entry: device_of(db, entry) == account_id)


def sign_in(db: Session, request: Request, response: Response, account: AccountRow, *,
            by_provider: bool = False, remember: bool = True, tell: bool = False) -> dict[str, Any]:
    """The session starts. ``tell``: a sign-in by its owner (password, provider, passkey), not right after a setup
    or an invitation; from a browser that never signed in as the account, an address that counts hears of it ("New
    sign-in", unless the person turned that off)."""
    accounts.note_browser_language(account, request.headers.get("accept-language", ""))
    ensure_private(db, account)
    known = bool(browser_mark(db, request, account.id))
    token = start_session(db, account, client_ip(request), request.headers.get("user-agent", ""),
                          by_provider=by_provider, remember=remember)
    _set_cookie(response, request, token, remember)
    # This browser is known from now on: a lock that strangers cause by guessing does not keep it out, and the brake
    # counts it in a pot of its own.
    if not known:
        known_device(db, request, response, account)
        if tell:
            konto = KontenStore(db).get_account(account.id)
            mail = konten_sessions.new_sign_in(konto, known=False, wanted=bool(account.new_sign_in_mail)) \
                if konto else None
            if kontenpost.queue(db, mail, where=request.headers.get("user-agent", "")):
                logger.info("Mail about a new sign-in queued name=%s", account.name)
    logger.info("Signed in name=%s", account.name)
    return account_view(account, db)


def ensure_private(db: Session, account: AccountRow) -> None:
    """Every account has its space "Private" with a first list, named in its language: made at its first sign-in
    (the browser's language is known by then). # Vertragslücke: "with every account" is read as "before the account
    sees anything": at the first sign-in or the first call of ``/api/app/1``, not when the row is written."""
    with cursor.WRITE_LOCK:
        if spaces.private_of(db, account.id) is None:
            spaces.ensure_private(db, account)
            db.commit()
            cursor.touched_everybody()


@router.get("/setup", summary="Does nextasks still need its first account, and is this browser signed in?")
def setup_state(request: Request, db: DbSession) -> dict[str, Any]:
    # ``signed_in`` lets the page ask for the account only when there is one: a 401 would show as an error in the
    # browser's console on every visit of the sign-in page.
    needs_setup = accounts.count(db) == 0
    return {
        "needs_setup": needs_setup,
        # The first account needs the setup code from the server's log.
        "code_required": True,
        "signed_in": session_account(db, request.cookies.get(SESSION_COOKIE)) is not None,
        "version": __version__,
        "min_password": MIN_PASSWORD,
        # The folder NEXTASKS_DATA_DIR names, as the container sees it: whoever sets up checks that the volume is
        # where they meant it. Gone once set up.
        "data_dir": str(get_settings().data_dir) if needs_setup else None,
    }


@router.post("/setup", summary="Create the operator account")
def setup(payload: SetupIn, request: Request, response: Response, db: DbSession) -> dict[str, Any]:
    """Through the shared module (``setup.setup``): the code first, then display name, username, address, password.
    A page of 0.8.0 sends ``name`` and no display name: the username stands in for it."""
    key = "setup:" + client_ip(request)
    wait = brake.wait_seconds(key)
    if wait:
        raise too_many(wait)
    language = check_language(payload.language)
    check_confirm(payload.password, payload.password_confirm)
    shown = payload.display_name if payload.display_name is not None and payload.display_name.strip() else (
        payload.name or "")
    username = payload.name if payload.name is not None else nexkonten.names.suggest_username(shown)
    try:
        done = konten_setup.setup(
            KontenStore(db), code=payload.code, display_name=shown, username=username, email=payload.email,
            password=payload.password, language=language,
        )
    except nexkonten.AccountError as exc:
        if exc.code == "setup_code_wrong":
            brake.failed(key)
        raise fail(exc) from exc
    account = db.get(AccountRow, int(done.account.id))
    assert account is not None
    # The space "Private" with its first list comes with the sign-in, named in the language chosen here.
    return sign_in(db, request, response, account)


@router.get("/auth/methods", summary="How one can sign in here (no sign-in needed)")
def methods(db: DbSession) -> dict[str, Any]:
    password = bool(settings_service.get(db, "password_login"))
    return {
        "password": password,
        # The buttons of the sign-in and invitation pages: slug and label of each active provider, nothing else
        # (vendor/nexoidc).
        "providers": providers.public_list(SqlStore(db)),
        # "Sign in with a passkey" (the operator's switch, on from the start).
        "passkeys": bool(settings_service.get(db, "passkeys_allowed")),
        # "Forgot your password?" by mail: a mail server, the public address and signing in by password.
        "forgot_mail": password and kontenpost.can_mail(db),
    }


@router.post("/auth/login", summary="Sign in with username or email and password")
def login(payload: LoginIn, request: Request, response: Response, db: DbSession) -> dict[str, Any]:
    """The shared account module checks (``login.sign_in``, since konten 0.3.10): one answer for everything wrong, as
    long for an unknown name as for a wrong password, failures counted at the account and its lock after ten (a
    browser that signed in as the account before passes the lock). The brake counts at the sender (30 free) and at
    the account it names (or what was typed, five free); a browser that knows the account counts in a pot of its own.
    A full sender's pot answers 429 ``Retry-After``; a waiting account answers ``wrong_credentials`` like the lock of
    0.8.0 (test "Bestand")."""
    ip = client_ip(request)
    behind_unknown_proxy(request)
    store = KontenStore(db)
    meant = konten_login.resolve_login(store, payload.name)
    mark = browser_mark(db, request, int(meant.id)) if meant is not None else ""
    try:
        konto = konten_login.sign_in(store, payload.name, payload.password, sender=ip, browser=mark)
    except nexkonten.AccountError as exc:
        raise fail(exc) from exc
    account = db.get(AccountRow, int(konto.id))
    assert account is not None
    if not settings_service.get(db, "password_login") and account.role != OPERATOR:
        # The operator keeps the password as the way in when the provider is down.
        raise error("password_login_off", "Sign-in with a password is turned off.", 403)
    step = nexkonten.common.next_step(store, konto)
    if step in (nexkonten.NEXT_SECOND_FACTOR, nexkonten.NEXT_PASSKEY):
        # Nothing opens yet: the browser gets a short-lived cookie that names the waiting sign-in and nothing else.
        # Where the operator asks a second factor of everybody, a passkey is one: then it is the only second step.
        response.set_cookie(
            PENDING_COOKIE,
            totp.start_pending(account.id, remember=payload.remember),
            max_age=totp.PENDING_SECONDS,
            httponly=True,
            samesite="lax",
            secure=secure_cookie(request),
            path="/api/auth",
        )
        logger.info("Password accepted, second factor waiting name=%s", account.name)
        # The answer of 0.8.0 stays as it was; ``code: false`` is the module's ``next`` = ``passkey``.
        answer: dict[str, Any] = {"second_factor": True}
        if store.passkeys_of(account.id):
            # The code step offers "Use a passkey" (only then: the answer of 0.8.0 stays as it was).
            answer["passkey"] = True
        if step == nexkonten.NEXT_PASSKEY:
            answer["code"] = False
        return answer
    konten_login.succeeded(store, account.id)
    return sign_in(db, request, response, account, remember=payload.remember, tell=True)


@router.post("/auth/forgot", status_code=202, summary="Forgot your password? A link by mail (with a mail server)")
def forgot(payload: ForgotIn, request: Request, background: BackgroundTasks, db: DbSession) -> dict[str, Any]:
    """Answered at once, the same whatever was typed (``resets.forgot_in_background``): the search, the link and the
    mail run after the answer. The requests of one sender count at the module's brake (``forgot:<sender>``, ten
    free), also without a mail server; the account counts in the worker (``mail:<id>``)."""
    sender = client_ip(request)

    def send(mail: nexkonten.Mail) -> None:
        # At once through the mail server (``nexpost.send.deliver``), never through the outbox: a mail the server does
        # not take raises, and the module throws the link away (konten 0.3.10).
        from ..db import SessionLocal

        with SessionLocal() as own:
            if not kontenpost.send_now(own, mail, keep=False):
                raise RuntimeError("the mail did not go out")

    try:
        if settings_service.get(db, "password_login") and kontenpost.can_mail(db):
            resets.forgot_in_background(payload.name, open_store=_own_store, send=send, later=_later(background),
                                        sender=sender)
        else:
            nexkonten.common.counted((door_key(DOOR_FORGOT, sender),))
    except nexkonten.AccountError as exc:
        raise fail(exc) from exc
    return {"sent": True}


def _own_store():
    from ..services.konten_store import own_store

    return own_store()


#: Tests run the work of "Forgot your password?" in a thread when asked (``FORGOT_IN_THREAD``); the route itself hands
#: it to FastAPI's background tasks, which run after the answer went out.
FORGOT_IN_THREAD = False


def _later(background: BackgroundTasks) -> Callable[[Callable[[], None]], None]:
    def run(job: Callable[[], None]) -> None:
        if FORGOT_IN_THREAD:
            threading.Thread(target=job, name="nextasks-forgot", daemon=True).start()
        else:
            background.add_task(job)

    return run


@router.post("/auth/logout", status_code=204, summary="Sign out in this browser")
def logout(request: Request, response: Response, db: DbSession) -> None:
    token = request.cookies.get(SESSION_COOKIE)
    account = session_account(db, token)
    end_session(db, token)
    if account is not None:
        logger.info("Signed out name=%s", account.name)
    response.delete_cookie(SESSION_COOKIE, path="/")


@router.post("/auth/logout-all", status_code=204, summary="Sign out every other browser of the own account")
def logout_everywhere(request: Request, response: Response, account: Account, db: DbSession) -> None:
    end_all_sessions(db, account.id, except_token=request.cookies.get(SESSION_COOKIE))
    # The other browsers are not known any more; this one stays known.
    row = db.get(AccountRow, account.id)
    if row is not None:
        db.refresh(row)
        known_device(db, request, response, row)
    logger.info("All other sessions ended by their owner name=%s", account.name)


def passkey_base(request: Request, db: Session) -> str:
    """The address passkeys belong to: the public one, else the one this request came to (``routers/passkeys``)."""
    return settings_service.public_url(db) or str(request.base_url).rstrip("/")


def passkeys_can_add(request: Request, db: Session) -> bool:
    """Since konten 1.1.0 (E49): whether the box "Passkeys" offers "Add a passkey" here: a public address set counts
    alone and only with https; without one, the page on localhost. Only the address set goes in, never the one this
    request came to (that would count as set)."""
    return konten_passkeys.can_add(settings_service.public_url(db), origin=request.headers.get("origin", ""),
                                   request_url=str(request.url))


@router.get("/auth/me", summary="The signed-in account, and what this server offers it")
def me(account: Account, db: DbSession, request: Request) -> dict[str, Any]:
    spared = session_by_provider(db, request.cookies.get(SESSION_COOKIE))
    return {
        **account_view(account, db),
        "mail": post_store.configured(db),
        # A link for a new address can go out (a mail server and the public address); without, an address counts at
        # once.
        "mail_links": kontenpost.can_mail(db),
        "second_factor_setup_required": totp.setup_required(db, account, by_provider=spared),
        # This sign-in began at a provider that checks the second factor, so the browser is spared the setup; an API
        # token (no sign-in behind it) still waits for it. The page says so beside them.
        "keys_wait_for_second_factor": spared and totp.setup_required(db, account),
        "upload_max_mb": settings_service.upload_max_mb(db),
        "preferences": preferences_of(account.preferences),
        "min_password": MIN_PASSWORD,
        "passkeys_allowed": bool(settings_service.get(db, "passkeys_allowed")),
        # The box "Passkeys" under My account › Security (E49): the button, or what is missing for it.
        "passkeys_can_add": passkeys_can_add(request, db),
        # Signed in at a provider within the last minutes: an account without a password may confirm with that.
        "fresh_sign_in": fresh_session(request, db, account),
    }


@router.put("/auth/password", status_code=204, summary="Change the own password")
def change_password(payload: PasswordChangeIn, request: Request, response: Response, account: Account,
                    db: DbSession) -> None:
    row = db.get(AccountRow, account.id)
    assert row is not None
    if row.sign_in != SIGN_IN_PASSWORD:
        raise error("oidc_account", "This account signs in through OIDC.", 409)
    check_password(payload.new)
    check_confirm(payload.new, payload.password_confirm)
    reauth_guard(request, row)
    try:
        accounts.change_password(db, row, payload.current, payload.new)
    except AccountError as exc:
        if exc.code == "wrong_password":
            reauth_failed(request, db, row)
        raise fail(exc) from exc
    reauth_succeeded(request, db, row)
    # Other browsers must sign in again and are not known any more; this one stays, and stays known.
    end_all_sessions(db, row.id, except_token=request.cookies.get(SESSION_COOKIE))
    db.refresh(row)
    known_device(db, request, response, row)


def change_address(db: Session, row: AccountRow, address: str, *, password: str, fresh: bool) -> str:
    """A new address through the shared module (``profiles.change_email``): with the own password, and with a mail
    server and the public address it waits for the link sent there (at once, as in 0.8.0: a server that does not take
    it leaves nothing waiting, 502 ``mail_failed``); without, it counts at once. "" takes the address away. The
    address that now waits for its link, "" for none."""
    store = KontenStore(db)
    changed = profiles.change_email(store, row.id, address, password=password, actor_confirmed=fresh,
                                    mail=kontenpost.can_mail(db))
    if changed.mail is not None:
        try:
            kontenpost.send_now(db, changed.mail, keep=False)
        except post_store.MailError as exc:
            profiles.withdraw_email_change(KontenStore(db), row.id)
            raise error(exc.code, "The mail server did not take the mail.", 409 if exc.code == "mail_off" else 502) \
                from exc
        logger.info("Address confirmation sent name=%s address=%s", row.name, emailaddr.masked(changed.pending))
    kontenpost.queue(db, changed.notice)
    return changed.pending


@router.put("/me/profile", summary="The own display name, username, address and time zone")
def set_profile(payload: ProfileIn, request: Request, account: Account, db: DbSession) -> dict[str, Any]:
    """Field by field, through the shared module where it rules: the display name without a password (it may be
    empty: then the username shows), a new username and a new address with the own password (an account without
    one: a fresh sign-in at its provider), one "Save" for all. The time zone is nextasks' own."""
    row = db.get(AccountRow, account.id)
    assert row is not None
    changes_email = payload.email is not None and payload.email.strip().lower() != (row.email or "").lower()
    changes_name = payload.name is not None and payload.name.strip().lower() != row.name.lower()
    zone = None
    if payload.timezone is not None:
        zone = payload.timezone.strip()
        if zone and not clock.valid_zone(zone):
            raise error("unknown_timezone", "This is not a time zone nextasks knows.", 422)
    store = KontenStore(db)
    try:
        if payload.display_name is not None:
            shown = check_display_name(payload.display_name)
            if shown != row.display_name:
                profiles.change_display_name(store, row.id, shown, actor_id=row.id)
        fresh = confirmed_without_password(request, db, row) if (changes_email or changes_name) else False
        if changes_name:
            notice = profiles.change_username(store, row.id, payload.name or "", actor_id=row.id,
                                              password=payload.password, actor_confirmed=fresh)
            kontenpost.queue(db, notice)
            logger.info("Username changed by its owner account_id=%s", row.id)
        if changes_email:
            change_address(db, row, payload.email or "", password=payload.password, fresh=fresh)
    except nexkonten.AccountError as exc:
        db.rollback()
        raise fail(exc) from exc
    db.refresh(row)
    if zone is not None:
        row.timezone = zone
        db.commit()
    return account_view(row, db)


@router.post("/me/whats-new/seen", summary="\"What's new\" of the running version is read or put away")
def whats_new_seen(account: Account, db: DbSession) -> dict[str, Any]:
    row = db.get(AccountRow, account.id)
    assert row is not None
    row.whats_new_seen = __version__
    db.commit()
    return account_view(row, db)


@router.put("/me/new-sign-in-mail", summary="A mail when a browser signs in for the first time: on or off")
def set_new_sign_in_mail(payload: SwitchIn, account: Account, db: DbSession) -> dict[str, Any]:
    row = db.get(AccountRow, account.id)
    assert row is not None
    row.new_sign_in_mail = payload.on
    db.commit()
    return account_view(row, db)


@router.post("/me/password-reset-notice/seen",
             summary="The notice that the password was set through the operator's link is read")
def password_reset_notice_seen(account: Account, db: DbSession) -> dict[str, Any]:
    row = db.get(AccountRow, account.id)
    assert row is not None
    row.password_reset_notice = False
    db.commit()
    return account_view(row, db)


# --- Where am I signed in, and what still has access ---------------------------------------------------------------


@router.get("/auth/sessions", summary="Where the own account is signed in: browsers and paired iPhones")
def my_sessions(request: Request, account: Account, db: DbSession) -> list[dict[str, Any]]:
    current = session_uid(db, request.cookies.get(SESSION_COOKIE))
    # Browsers by name ("Firefox on Linux") in the account's language, never the stored User-Agent.
    language = (account.language or account.browser_language or "en")[:2].lower()
    return konten_sessions.listing(KontenStore(db), account.id, current, language=language)


@router.delete("/auth/sessions/{uid}", status_code=204, summary="Sign one browser or iPhone of the own account out")
def end_one_session(uid: str, request: Request, account: Account, db: DbSession) -> None:
    if uid == session_uid(db, request.cookies.get(SESSION_COOKIE)):
        raise error("use_logout", "Sign out of this browser with Sign out.", 409)
    if not konten_sessions.sign_out(KontenStore(db), account.id, uid[:40]):
        raise error("not_found", "Not found.", 404)
    db.commit()
    logger.info("Session ended by its owner name=%s", account.name)


@router.get("/auth/access", summary="What still has access after a password set through a link")
def remaining_access(account: Account, db: DbSession) -> dict[str, Any]:
    row = db.get(AccountRow, account.id)
    assert row is not None
    return {
        "origin": row.new_password_origin or "",
        "access": [
            {"id": str(item.id), "kind": item.kind, "label": item.label,
             "last_used_at": item.last_used_at.isoformat() if item.last_used_at else None}
            for item in KontenStore(db).list_access(account.id)
        ],
    }


@router.post("/auth/access/disconnect", summary="Disconnect all: every iPhone, API token and passkey of the account")
def disconnect_all(request: Request, account: Account, db: DbSession) -> dict[str, Any]:
    if not fresh_session(request, db, account):
        raise error("fresh_sign_in_required", "Sign in again first: this needs a sign-in from the last minutes.", 403,
                    minutes=nexkonten.common.FRESH_SIGN_IN_MINUTES, providers=[])
    count = resets.disconnect_all(KontenStore(db), account.id)
    row = db.get(AccountRow, account.id)
    assert row is not None
    row.new_password_origin = ""
    db.commit()
    return {"disconnected": count}


@router.post("/auth/access/seen", summary="The list of what still has access is put away")
def remaining_access_seen(account: Account, db: DbSession) -> dict[str, Any]:
    row = db.get(AccountRow, account.id)
    assert row is not None
    row.new_password_origin = ""
    db.commit()
    return account_view(row, db)


@router.get("/people", summary="Display names for account names: of the own account and of those sharing a space")
def people(
    account: Account, db: DbSession, name: Annotated[list[str] | None, Query(max_length=64)] = None
) -> dict[str, str]:
    """Only names with a display name come back; one the caller may not see is left out like an unknown one, so
    nothing tells which names exist."""
    wanted = sorted({item.strip().lower() for item in (name or []) if item.strip()})[:200]
    if not wanted:
        return {}
    out: dict[str, str] = {}
    for row in db.scalars(select(AccountRow).where(AccountRow.name.in_(wanted), AccountRow.display_name != "")):
        if visibility.sees(db, account.id, row.id):
            out[row.name] = row.display_name
    return out


@router.put("/me/language", summary="The language of the own account; empty follows the browser")
def set_language(payload: LanguageIn, account: Account, db: DbSession) -> dict[str, Any]:
    row = db.get(AccountRow, account.id)
    assert row is not None
    row.language = check_language(payload.language)
    db.commit()
    return account_view(row, db)


class ThemeIn(BaseModel):
    theme: str = Field(max_length=16)


class BrowserThemeIn(BaseModel):
    #: What this browser kept before (``localStorage``, raw); taken once while the account has chosen nothing.
    value: str = Field(default="", max_length=40)


@router.put("/me/theme", summary="Light, dark or as the device says, for the own account on every device")
def set_theme(payload: ThemeIn, account: Account, db: DbSession) -> dict[str, Any]:
    try:
        profiles.change_theme(KontenStore(db), account.id, payload.theme)
    except nexkonten.AccountError as exc:
        raise fail(exc) from exc
    row = db.get(AccountRow, account.id)
    assert row is not None
    db.refresh(row)
    return account_view(row, db)


@router.post("/me/theme/adopt", summary="Take the theme this browser kept, once, while the account has none")
def adopt_theme(payload: BrowserThemeIn, account: Account, db: DbSession) -> dict[str, str]:
    return {"theme": profiles.adopt_theme(KontenStore(db), account.id, payload.value)}


#: What an account may set for itself, with the values allowed; the first one is the default.
PREFERENCES: dict[str, tuple[Any, ...]] = {
    #: The tile nextasks opens on.
    "start": ("today", "scheduled", "all", "flagged", "assigned"),
}


def preferences_of(stored: Any) -> dict[str, Any]:
    stored = stored if isinstance(stored, dict) else {}
    return {key: stored[key] if stored.get(key) in allowed else allowed[0] for key, allowed in PREFERENCES.items()}


@router.put("/me/preferences", summary="The own preferences; only the values sent change")
def set_preferences(payload: dict[str, Any], account: Account, db: DbSession) -> dict[str, Any]:
    row = db.get(AccountRow, account.id)
    assert row is not None
    current = preferences_of(row.preferences)
    for key, value in payload.items():
        allowed = PREFERENCES.get(key)
        if allowed is None or value not in allowed or type(value) is not type(allowed[0]):
            raise error("bad_preference", "This value is not one nextasks offers.", 422, field=key)
        current[key] = value
    row.preferences = current
    db.commit()
    return current


class OperatorConfirmIn(BaseModel):
    #: The operator's own password once more (``deps.confirm_operator``); empty for an operator from a provider, who
    #: confirms by a fresh sign-in there.
    current_password: str = Field(default="", max_length=200)
