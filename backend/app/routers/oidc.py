"""Sign-in through OpenID Connect providers, their list, linking, and the authentik button.

The protocol, who an identity is, the provider list and the button live in the shared module ``vendor/nexoidc``
(the blueprint "Anmeldung mit OIDC und authentik", the same in every nex app); this router puts nextasks around it:
sessions, the sign-in brake, the password asked again before linking, the second factor, the page a direct link
asked for (``next``) and the error answers.

The return leg is a browser redirect, not an API answer: the provider sends the browser back with GET, and a human
sees whatever comes out. So every outcome of a callback ends in a redirect: to ``/`` (or the page asked for) with the
session cookie, to the sign-in page with ``?error=<code>``, to ``/login?step=code`` when the code of nextasks's own
second factor is still due, or to the account page after linking.

Paths (all below ``/api/oidc``):

| Method | Path | Who |
|---|---|---|
| GET | ``/providers`` | anybody: slug and label of the active entries (sign-in and invitation page) |
| GET, POST | ``/admin/providers`` | operator: the list (never a secret), add one |
| PUT | ``/admin/providers/order`` | operator: ``{"ids": [...]}`` |
| PUT, DELETE | ``/admin/providers/{id}`` | operator: save (``dropped`` links), remove (``count``, ``only``) |
| GET | ``/admin/providers/{id}/impact?issuer=`` | operator: the numbers for the two confirmations |
| GET | ``/{slug}/start[?invite=<token>][&next=<path>]`` | anybody: off to the provider |
| GET | ``/{slug}/callback``, ``/callback`` | anybody: the return (the second belongs to the entry ``oidc``) |
| GET | ``/me`` | signed in: every active entry with ``linked`` |
| POST, DELETE | ``/{slug}/link`` | signed in: link (``{"password"}`` → ``{"url"}``), unlink |
| DELETE | ``/admin/accounts/{account}/links/{provider}`` | operator, with the own password |
| POST | ``/authentik/setup`` | operator: ``{"url", "token", "confirm_issuer_change", "public_url"}`` → 200, the steps |
| GET, POST | ``/authentik/address`` | operator: what the card shows about the public address; "Use it only" |
| GET | ``/authentik/blueprint`` | operator: ``nextasks-authentik.yaml`` (409 without a public address) |
"""

from __future__ import annotations

import logging
import posixpath
import re
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import asdict
from typing import Annotated, Any
from urllib.parse import quote, unquote

from fastapi import APIRouter, Path, Query, Request, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field

from ..config import get_settings
from ..db import SessionLocal
from ..deps import (
    Account,
    OperatorAccount,
    client_ip,
    confirm_operator,
    reauth_failed,
    reauth_guard,
    reauth_succeeded,
)
from ..errors import error
from ..models import SIGN_IN_PASSWORD, Notice
from ..models import Account as AccountRow
from ..security import SESSION_COOKIE, brake, session_account
from ..services import accounts, logs, totp
from ..services.oidc_store import SqlStore
from ..vendor.nexoidc import OidcError, ProviderInvalid, authentik, flow, providers
from ..vendor.nexoidc import accounts as oidc_accounts
from ..vendor.nexoidc import attempt as attempts
from ..vendor.nexoidc.config import current
from .auth import PENDING_COOKIE, OperatorConfirmIn, secure_cookie, sign_in

router = APIRouter(prefix="/api/oidc", tags=["oidc"])
logger = logging.getLogger("nextasks.oidc")

#: Where the sign-in page asks for the code of nextasks's own second factor after a provider that is not trusted.
CODE_STEP = "/login?step=code"
#: The notice an account gets under "New" when the operator unlinked it from a provider.
NOTICE_UNLINKED = "operator_unlinked"
#: Codes that cost nothing to produce (a forged return, a braked sender): they do not count against the sender.
FREE_REFUSALS = ("oidc_state_mismatch", "too_many_attempts", "oidc_not_configured")
#: The page a direct link asked for, kept beside the attempt (the module's cookie holds only its own values).
NEXT_COOKIE = "nextasks_oidc_next" + get_settings().cookie_name_suffix()
#: A page of nextasks' own to land on after the provider (Prüfgang B10): a path on this server with its query. Never
#: another host (``//host``, ``/\host``, a scheme), never the API, nothing but printable characters without spaces.
_NEXT = re.compile(r"/(?![/\\])[A-Za-z0-9\-._~!$&'()*+,;=:@%/?]{0,499}")


def safe_next(value: object) -> str | None:
    """The page to land on after signing in, or None if ``value`` is not one of nextasks' own (no open redirect).
    The API is no page: checked on the path as the server reads it, decoded and in small letters (``/%61pi/``,
    ``/API/``)."""
    if not isinstance(value, str) or not _NEXT.fullmatch(value) or value == "/":
        return None
    path = value.split("?", 1)[0]
    for _round in range(3):
        path = unquote(path)
    if path.startswith("//") or "\\" in path:
        return None
    # As a browser reads it: dot segments resolved (``/./api``, ``/x/../api``), in any case.
    path = posixpath.normpath(path).lower()
    if path == "/api" or path.startswith(("/api/", "//")):
        return None
    return value


class ProviderIn(BaseModel):
    label: str = Field(max_length=200)
    slug: str = Field(default="", max_length=100)
    issuer: str = Field(max_length=600)
    client_id: str = Field(max_length=300)
    client_secret: str = Field(default="", max_length=2000)
    scopes: str = Field(default="openid profile email", max_length=500)
    enabled: bool = True
    auto_create: bool = False
    trusts_second_factor: bool = True


class PasswordIn(BaseModel):
    password: str = Field(max_length=200)


class SetupIn(BaseModel):
    url: str = Field(min_length=1, max_length=500)
    token: str = Field(min_length=1, max_length=2000)
    #: The answer to the button's question "another issuer, {count} accounts link again" (module 1.0.8): the run stops
    #: at ``reached`` with the reason ``issuer_change`` until it comes with ``true``.
    confirm_issuer_change: bool = False
    #: The address the card proposes (the browser's own) and the operator confirmed; used only while nextasks has no
    #: public address of its own (module 1.0.10). The module cleans it and refuses an address that is none.
    public_url: str = Field(default="", max_length=500)


class AddressIn(BaseModel):
    public_url: str = Field(max_length=500)
    #: The answer to the question "the redirect address at authentik changes" (409 ``public_url_change``).
    confirm: bool = False


class OrderIn(BaseModel):
    ids: list[int] = Field(max_length=200)


@contextmanager
def store() -> Iterator[SqlStore]:
    with SessionLocal() as db:
        yield SqlStore(db)


def _base(request: Request) -> str:
    return str(request.base_url)


def _redirect(target: flow.Redirect, request: Request) -> RedirectResponse:
    # 303: the browser loads the target with GET whatever way it came.
    response = RedirectResponse(target.location, status_code=303)
    cookie = target.cookie
    secure = cookie.secure or secure_cookie(request)
    if cookie.max_age == 0:
        response.delete_cookie(cookie.name, path=cookie.path, secure=secure, httponly=True, samesite="lax")
    else:
        response.set_cookie(cookie.name, cookie.value, max_age=cookie.max_age, path=cookie.path,
                            httponly=cookie.http_only, samesite="lax", secure=secure)
    return response


def _with_next(response: RedirectResponse, landing: str | None) -> RedirectResponse:
    """A refused sign-in keeps the page asked for with the sign-in page, so a second try still lands there (B10)."""
    location = response.headers["location"]
    if landing and location.startswith(current().login_page + "?"):
        response.headers["location"] = f"{location}&next={quote(landing, safe='')}"
    return response


def _form_error(exc: ProviderInvalid) -> Exception:
    return error(exc.code, exc.message, 422, field=exc.field)


# --- The provider list -------------------------------------------------------------------------------------------


@router.get("/providers", summary="The active sign-in providers: slug and label (no sign-in needed)")
def public_providers() -> list[dict[str, str]]:
    # Public: the sign-in and invitation pages ask before anybody is signed in. Nothing but the buttons leaves.
    with store() as s:
        return providers.public_list(s)


@router.get("/admin/providers", summary="The provider list for the operator (never a secret)")
def admin_providers(_operator: OperatorAccount, request: Request) -> list[dict[str, Any]]:
    with store() as s:
        coupled = providers.coupled(s)
        return [providers.admin_view(entry, _base(request), len(s.links_of_provider(entry.id)), coupled=coupled)
                for entry in s.list_providers()]


@router.post("/admin/providers", status_code=201, summary="Add a provider; the issuer is checked by discovery")
async def add_provider(payload: ProviderIn, operator: OperatorAccount, request: Request) -> dict[str, Any]:
    with store() as s:
        try:
            created = await providers.create(s, providers.Form(**payload.model_dump()))
        except ProviderInvalid as exc:
            raise _form_error(exc) from exc
        logger.info("OIDC provider %s added by=%s", created.slug, operator.name)
        return providers.admin_view(created, _base(request), 0)


@router.put("/admin/providers/order", summary="Put the providers in this order (the drag handle)")
def order_providers(payload: OrderIn, _operator: OperatorAccount) -> list[dict[str, str]]:
    with store() as s:
        try:
            providers.reorder(s, payload.ids)
        except ProviderInvalid as exc:
            raise _form_error(exc) from exc
        return providers.public_list(s)


@router.put("/admin/providers/{provider_id}", summary="Save a provider; another issuer drops its links")
async def save_provider(
    provider_id: Annotated[int, Path(ge=1)], payload: ProviderIn, operator: OperatorAccount, request: Request
) -> dict[str, Any]:
    with store() as s:
        try:
            saved, dropped = await providers.update(s, provider_id, providers.Form(**payload.model_dump()))
        except ProviderInvalid as exc:
            raise _form_error(exc) from exc
        logger.info("OIDC provider %s saved by=%s", saved.slug, operator.name)
        view = providers.admin_view(saved, _base(request), len(s.links_of_provider(saved.id)))
        return {**view, "dropped": dropped}


@router.get("/admin/providers/{provider_id}/impact", summary="Who loses a link when the issuer changes or it goes")
def provider_impact(
    provider_id: Annotated[int, Path(ge=1)],
    _operator: OperatorAccount,
    issuer: Annotated[str, Query(max_length=600)] = "",
) -> dict[str, Any]:
    with store() as s:
        if s.get_provider(provider_id) is None:
            raise error("provider_unknown", "No such provider.", 404, field="id")
        removal = providers.removal_impact(s, provider_id)
        change = providers.issuer_change_impact(s, provider_id, issuer) if issuer else 0
        return {"issuer_change": change, **asdict(removal)}


@router.delete("/admin/providers/{provider_id}", summary="Remove a provider with its links")
def remove_provider(provider_id: Annotated[int, Path(ge=1)], operator: OperatorAccount) -> dict[str, Any]:
    with store() as s:
        try:
            impact = providers.remove(s, provider_id)
        except ProviderInvalid as exc:
            raise _form_error(exc) from exc
    logger.info("OIDC provider id=%s removed by=%s", provider_id, operator.name)
    return asdict(impact)


# --- Start and return --------------------------------------------------------------------------------------------


def _brake_key(request: Request) -> str:
    return "oidc:" + client_ip(request)


@router.get("/{slug}/start", summary="Send the browser to the provider (no sign-in needed)")
async def start(
    slug: Annotated[str, Path(max_length=40)],
    request: Request,
    invite: Annotated[str | None, Query(max_length=64, pattern=r"^[A-Za-z0-9_-]+$")] = None,
    # No length rule here: a ``next`` too long or not one of ours is dropped by ``safe_next``, never a JSON refusal.
    next_path: Annotated[str | None, Query(alias="next")] = None,
) -> RedirectResponse:
    # Public: this is the sign-in button. Failures land on the sign-in page with a code. ``next`` is the page the
    # button was pressed for (a direct link); only a page of nextasks' own goes along (Prüfgang B10).
    landing = safe_next(next_path)
    with store() as s:
        try:
            if brake.wait_seconds(_brake_key(request)):
                raise OidcError("too_many_attempts", "sender is braked")
            target = await flow.begin(s, slug, request_base=_base(request), invite=invite)
        except OidcError as exc:
            return _with_next(_redirect(flow.refused(exc, None), request), landing)
    response = _redirect(target, request)
    if landing:
        response.set_cookie(NEXT_COOKIE, landing, max_age=target.cookie.max_age, path=current().cookie_path,
                            httponly=True, samesite="lax", secure=target.cookie.secure or secure_cookie(request))
    else:
        response.delete_cookie(NEXT_COOKIE, path=current().cookie_path)
    return response


async def _returned(slug: str, request: Request) -> RedirectResponse:
    """The return from the provider. The order is the module's: the provider's own error, our cookie and state,
    the single use of the state, then the provider; nothing is written before all that passed."""
    cookie = request.cookies.get(current().cookie_name)
    key = _brake_key(request)
    # Checked again coming back: the rule may have grown since the cookie was set.
    landing = safe_next(request.cookies.get(NEXT_COOKIE))

    def refused(exc: OidcError) -> RedirectResponse:
        response = _with_next(_redirect(flow.refused(exc, cookie), request), landing)
        response.delete_cookie(NEXT_COOKIE, path=current().cookie_path)
        return response

    with store() as s:
        try:
            if brake.wait_seconds(key):
                raise OidcError("too_many_attempts", "sender is braked")
            arrival = await flow.finish(s, slug, cookie=cookie, params=dict(request.query_params))
            if arrival.started.purpose == attempts.LINK:
                current_account = session_account(s.db, request.cookies.get(SESSION_COOKIE))
                oidc_accounts.link(s, arrival, current_account.id if current_account else None)
                brake.succeeded(key)
                done = _redirect(flow.arrived(arrival, flow.linked_page(slug)), request)
                done.delete_cookie(NEXT_COOKIE, path=current().cookie_path)
                return done
            signed = oidc_accounts.sign_in(s, arrival)
        except OidcError as exc:
            if exc.code not in FREE_REFUSALS:
                brake.failed(key)
            return refused(exc)
        brake.succeeded(key)
        row = s.db.get(AccountRow, signed.account_id)
        assert row is not None
        logs.set_actor(row.name)
        if signed.second_factor_due:
            # The provider is not trusted with the second factor and the account has one here: the same waiting
            # sign-in as after the password, the code step of the sign-in page finishes it.
            response = _redirect(flow.arrived(arrival, CODE_STEP), request)
            response.set_cookie(PENDING_COOKIE, totp.start_pending(row.id), max_age=totp.PENDING_SECONDS,
                                httponly=True, samesite="lax", secure=secure_cookie(request), path="/api/auth")
            logger.info("Provider accepted, second factor waiting name=%s", row.name)
            return response
        response = _redirect(flow.arrived(arrival, landing), request)
        response.delete_cookie(NEXT_COOKIE, path=current().cookie_path)
        # The module logged the sign-in with its provider already; ``sign_in`` adds nextasks's own line.
        sign_in(s.db, request, response, row, by_provider=arrival.provider.trusts_second_factor)
        return response


@router.get("/callback", summary="The return from the provider of the entry oidc (the address before the list)")
async def legacy_callback(request: Request) -> RedirectResponse:
    return await _returned("oidc", request)


@router.get("/{slug}/callback", summary="The return from the provider (no sign-in needed)")
async def callback(slug: Annotated[str, Path(max_length=40)], request: Request) -> RedirectResponse:
    return await _returned(slug, request)


# --- My account --------------------------------------------------------------------------------------------------


@router.get("/me", summary="The active providers and whether the own account is linked to each")
def my_providers(account: Account) -> list[dict[str, Any]]:
    with store() as s:
        linked = {link.provider_id for link in s.links_of_account(account.id)}
        return [{"slug": entry.slug, "label": entry.label, "linked": entry.id in linked,
                 "managed": entry.managed}
                for entry in s.list_providers() if entry.enabled]


@router.post("/{slug}/link", summary="Start linking the own account to a provider; needs the password")
async def link_start(
    slug: Annotated[str, Path(max_length=40)], payload: PasswordIn, request: Request, response: Response,
    account: Account,
) -> dict[str, str]:
    """Linking hands the account to whoever the browser is at the provider, so it asks for the password: a page
    elsewhere cannot start it (the tab header), and neither can somebody at an unattended browser."""
    with store() as s:
        row = s.db.get(AccountRow, account.id)
        assert row is not None
        # The same brake as before start and return (blueprint 02, "Ablauf" 4): a braked sender links nothing.
        wait = brake.wait_seconds(_brake_key(request))
        if wait:
            raise error("too_many_attempts", "Too many attempts. Try again later.", 429, retry_after=wait)
        if row.sign_in != SIGN_IN_PASSWORD:
            raise error("oidc_only_account", "This account has no password; it signs in through a provider.", 409)
        reauth_guard(request, row)
        if not accounts.check_password(row, payload.password):
            reauth_failed(request, s.db, row)
            raise error("wrong_password", "The password is wrong.", 401)
        reauth_succeeded(request, s.db, row)
        try:
            target = await flow.begin(s, slug, request_base=_base(request), link_account_id=row.id)
        except OidcError as exc:
            raise error(exc.code, exc.message, 409) from exc
    cookie = target.cookie
    response.set_cookie(cookie.name, cookie.value, max_age=cookie.max_age, path=cookie.path, httponly=True,
                        samesite="lax", secure=cookie.secure or secure_cookie(request))
    logger.info("Linking to provider %s started name=%s", slug, account.name)
    return {"url": target.location}


@router.delete("/{slug}/link", status_code=204, summary="Unlink the own account from a provider")
def unlink(slug: Annotated[str, Path(max_length=40)], account: Account) -> None:
    with store() as s:
        entry = s.provider_by_slug(slug)
        if entry is None:
            raise error("oidc_not_configured", "This provider is not set up.", 404)
        try:
            oidc_accounts.unlink(s, account.id, entry.id)
        except OidcError as exc:
            raise error(exc.code, exc.message, 409) from exc


@router.delete("/admin/accounts/{account_id}/links/{provider_id}", status_code=204,
               summary="Operator: unlink an account from a provider (with the own password)")
def operator_unlink(
    account_id: Annotated[int, Path(ge=1)],
    provider_id: Annotated[int, Path(ge=1)],
    payload: OperatorConfirmIn,
    request: Request,
    operator: OperatorAccount,
) -> None:
    with store() as s:
        confirm_operator(request, s.db, operator, payload.current_password)
        entry = s.get_provider(provider_id)
        if s.db.get(AccountRow, account_id) is None or entry is None:
            raise error("not_found", "Not found.", 404)
        try:
            removed = oidc_accounts.unlink(s, account_id, provider_id)
        except OidcError as exc:
            raise error(exc.code, exc.message, 409) from exc
        if not removed:
            raise error("not_found", "Not found.", 404)
        if account_id != operator.id:
            # Never unseen (blueprint 01): the account finds it under "New", with the provider's name.
            s.db.add(Notice(account_id=account_id, kind=NOTICE_UNLINKED, actor=operator.name,
                            subject=entry.label[:64]))
            s.db.commit()
    logger.warning("Operator unlinked account id=%s from provider id=%s by=%s", account_id, provider_id, operator.name)


# --- authentik ---------------------------------------------------------------------------------------------------


@router.post("/authentik/setup", summary="Set up provider and application in authentik with a one-time token")
async def authentik_setup(payload: SetupIn, operator: OperatorAccount, request: Request) -> dict[str, Any]:
    # Always 200 with the steps that ran, a failed one included: the page says why in the operator's language.
    logger.info("authentik setup started by=%s", operator.name)
    with store() as s:
        result = await authentik.setup(s, payload.url, payload.token, _base(request),
                                       confirm_issuer_change=payload.confirm_issuer_change,
                                       public_url=payload.public_url, headers=request.headers)
    return result.as_dict()


@router.get("/authentik/address", summary="What the authentik card shows about the public address")
def authentik_address(_operator: OperatorAccount, request: Request) -> dict[str, Any]:
    with store() as s:
        return authentik.address_view(s, _base(request), request.headers)


@router.post("/authentik/address", summary="Use the address as nextasks's public address, without setting up")
def authentik_save_address(payload: AddressIn, operator: OperatorAccount, request: Request) -> dict[str, Any]:
    # "Use it only" in the card.
    with store() as s:
        try:
            saved = authentik.save_public_url(s, payload.public_url, _base(request), confirm=payload.confirm)
        except ValueError as exc:
            raise error("public_url_invalid", "This is not an address nextasks can be reached at.", 422) from exc
        except authentik.PublicUrlChange as asked:
            raise error("public_url_change", "The redirect address at authentik changes.", 409,
                        **asked.question) from asked
        except authentik.PublicUrlNotKept as exc:
            raise error("public_url_needed", "nextasks could not keep the address.", 409) from exc
    logger.info("Public address set from the authentik card by=%s", operator.name)
    return saved


@router.get("/authentik/blueprint", summary="Download a blueprint that creates the same objects in authentik")
def authentik_blueprint(_operator: OperatorAccount, request: Request) -> Response:
    with store() as s:
        try:
            redirect = authentik.blueprint_redirect(s, _base(request))
        except authentik.PublicUrlNeeded as exc:
            raise error("public_url_needed", "nextasks has no public address yet; confirm one in the card.",
                        409) from exc
        text = authentik.blueprint(redirect)
    return Response(content=text, media_type="application/yaml",
                    headers={"Content-Disposition": f'attachment; filename="{authentik.blueprint_filename()}"'})

