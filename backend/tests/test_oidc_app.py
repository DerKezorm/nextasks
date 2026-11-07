"""nextasks's own side of sign-in through providers, what the shared contract tests (``tests/nexoidc``) cannot reach:
the password sign-in that only turns off with an active provider and always lets the operator in, the code of
nextasks's own second factor after a provider that is not trusted with it, the address an account takes from its
provider, the operator's unlinking with its notice and the marks in the list of accounts, two instances on one host,
through the shared module.

The provider is the fake of the contract tests (``oidc_helpers``).
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.db import SessionLocal
from app.main import app
from app.middleware import ForwardedProtoMiddleware, forwarded_proto
from app.models import Account, OidcProvider
from app.routers.auth import PENDING_COOKIE
from app.security import SESSION_COOKIE, start_session
from app.services import settings_service, totp
from app.vendor import nexoidc

from . import oidc_helpers
from .conftest import PASSWORD, make_account, new_client
from .oidc_helpers import FakeProvider, error_in, location, sign_in_via_oidc

# The fixture of the provider, under the name pytest looks for.
provider = oidc_helpers.provider


def _row(name: str) -> Account:
    with SessionLocal() as db:
        row = db.query(Account).filter_by(name=name).one()
        db.expunge(row)
    return row


def _entries(client: TestClient) -> list[dict[str, Any]]:
    answer = client.get("/api/oidc/admin/providers")
    assert answer.status_code == 200, answer.text
    return answer.json()


def _save(client: TestClient, entry: dict[str, Any], **changes: Any) -> dict[str, Any]:
    body = {key: entry[key] for key in ("label", "issuer", "client_id", "scopes", "enabled", "auto_create",
                                        "trusts_second_factor")}
    answer = client.put(f"/api/oidc/admin/providers/{entry['id']}", json={**body, "client_secret": "", **changes})
    assert answer.status_code == 200, answer.text
    return answer.json()


def _link(client: TestClient, name: str, fake_provider: FakeProvider, subject: str, *, slug: str = "sso",
          email: str = "") -> None:
    """``name`` (password ``PASSWORD``) links itself to ``subject`` at the provider."""
    with new_client(_row(name)) as member:
        member.follow_redirects = False
        back = oidc_helpers.link(member, fake_provider, PASSWORD, slug=slug, sub=subject, email=email or None)
        assert error_in(back) is None, location(back)


def _who(browser: TestClient) -> str | None:
    me = browser.get("/api/auth/me")
    return me.json()["name"] if me.status_code == 200 else None


# --- The password sign-in (blueprint 01) -------------------------------------------------------------------------


def test_the_password_sign_in_turns_off_only_with_an_active_provider_and_the_operator_keeps_it(
        client: TestClient, operator: Account, provider: FakeProvider) -> None:
    make_account("anna")
    refused = client.put("/api/settings", json={"password_login": False})
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "provider_first"
    entry = oidc_helpers.configure(client, provider)
    assert client.put("/api/settings", json={"password_login": False}).status_code == 200
    methods = client.get("/api/auth/methods").json()
    assert methods["password"] is False and methods["providers"] == [{"slug": "sso", "label": "Test SSO"}]
    with new_client() as stranger:
        anna = stranger.post("/api/auth/login", json={"name": "anna", "password": PASSWORD})
        assert anna.status_code == 403 and anna.json()["detail"]["code"] == "password_login_off"
        assert stranger.post("/api/auth/login", json={"name": "tester", "password": PASSWORD}).status_code == 200
    # A provider switched off is no button any more.
    _save(client, entry, enabled=False)
    assert client.get("/api/auth/methods").json()["providers"] == []


# --- The second factor after a provider (blueprint 01) -------------------------------------------------------------


def _with_second_factor(name: str) -> str:
    seed = totp.generate_seed()
    with SessionLocal() as db:
        row = db.query(Account).filter_by(name=name).one()
        row.totp_secret_enc = totp.seal_seed(seed)
        db.commit()
    return seed


def test_a_provider_not_trusted_with_the_second_factor_leaves_the_code_to_nextasks(
        client: TestClient, operator: Account, provider: FakeProvider) -> None:
    entry = oidc_helpers.configure(client, provider, auto_create=False)
    make_account("anna")
    _link(client, "anna", provider, "anna-sub")
    seed = _with_second_factor("anna")
    # Trusted (from the start): in without a code.
    browser = oidc_helpers.fresh_browser()
    back = sign_in_via_oidc(browser, provider, sub="anna-sub")
    assert location(back) == "/" and _who(browser) == "anna"
    _save(client, entry, trusts_second_factor=False)
    browser = oidc_helpers.fresh_browser()
    back = sign_in_via_oidc(browser, provider, sub="anna-sub")
    assert location(back) == "/login?step=code" and _who(browser) is None
    waiting = browser.cookies.get(PENDING_COOKIE)
    assert waiting is not None and totp.get_pending(waiting) is not None
    assert totp.PENDING_SECONDS == 300 and totp.MAX_ATTEMPTS == 5
    done = browser.post("/api/auth/login/totp", json={"code": totp.code_at(seed, time.time())})
    assert done.status_code == 200, done.text
    assert _who(browser) == "anna"
    # Five wrong codes end the waiting sign-in, as after the password.
    browser = oidc_helpers.fresh_browser()
    sign_in_via_oidc(browser, provider, sub="anna-sub")
    for attempt in range(1, 6):
        wrong = browser.post("/api/auth/login/totp", json={"code": "000000"})
        expected = "second_factor_expired" if attempt == 5 else "totp_code_wrong"
        assert wrong.status_code == 401 and wrong.json()["detail"]["code"] == expected, (attempt, wrong.text)
    assert _who(browser) is None


# --- The account a provider vouches for ------------------------------------------------------------------------


def test_a_blocked_account_does_not_get_in_through_the_provider(
        client: TestClient, operator: Account, provider: FakeProvider) -> None:
    oidc_helpers.configure(client, provider, auto_create=False)
    anna = make_account("anna")
    _link(client, "anna", provider, "anna-sub")
    assert client.post(f"/api/accounts/{anna.id}/block", json={"current_password": PASSWORD}).status_code == 204
    browser = oidc_helpers.fresh_browser()
    back = sign_in_via_oidc(browser, provider, sub="anna-sub")
    assert error_in(back) == "account_blocked" and _who(browser) is None


def test_an_account_through_the_provider_only_follows_its_address_one_with_a_password_keeps_its_own(
        client: TestClient, operator: Account, provider: FakeProvider) -> None:
    entry = oidc_helpers.configure(client, provider)
    browser = oidc_helpers.fresh_browser()
    sign_in_via_oidc(browser, provider, sub="p-1", preferred_username="mia", email="mia@example.com")
    assert (_row("mia").email, _row("mia").email_source) == ("mia@example.com", "provider")
    sign_in_via_oidc(oidc_helpers.fresh_browser(), provider, sub="p-1", preferred_username="mia",
                     email="mia.new@example.com")
    assert _row("mia").email == "mia.new@example.com", "it follows the provider"
    # An address another account has is never taken.
    make_account("lena")
    with SessionLocal() as db:
        db.query(Account).filter_by(name="lena").one().email = "lena@example.com"
        db.commit()
    sign_in_via_oidc(oidc_helpers.fresh_browser(), provider, sub="p-1", preferred_username="mia",
                     email="LENA@example.com")
    assert _row("mia").email == "mia.new@example.com"
    # An account with a password keeps its own, linked or not.
    make_account("anna")
    _link(client, "anna", provider, "anna-sub", email="anna.sso@example.com")
    assert _row("anna").email == ""
    sign_in_via_oidc(oidc_helpers.fresh_browser(), provider, sub="anna-sub", email="anna.sso@example.com")
    assert _row("anna").email == ""
    # With its last link the address from the provider goes; an own one would stay.
    assert client.delete(f"/api/oidc/admin/providers/{entry['id']}").status_code == 200
    assert (_row("mia").email, _row("mia").email_source) == ("", "")
    assert _row("lena").email == "lena@example.com"


def test_a_sign_in_leaves_no_secret_in_the_log(client: TestClient, operator: Account, provider: FakeProvider,
                                               caplog: pytest.LogCaptureFixture) -> None:
    oidc_helpers.configure(client, provider)
    caplog.set_level(logging.DEBUG)
    browser = oidc_helpers.fresh_browser()
    started = browser.get("/api/oidc/sso/start", follow_redirects=False)
    target = location(started)
    query = oidc_helpers.fakes.query_of(target)
    params = provider.authorize(target)
    back = browser.get(f"{oidc_helpers.fakes.query_of(target)['redirect_uri'].split('testserver')[1]}"
                       f"?code={params['code']}&state={params['state']}")
    assert location(back) == "/" and _who(browser) == "alex"
    text = caplog.text
    for secret in (provider.client_secret, params["code"], params["state"], query["nonce"],
                   started.cookies.get(nexoidc.current().cookie_name) or "attempt-cookie"):
        assert secret not in text
    assert "alex@example.com" not in text


# --- Required second factor and the provider (decided 10.10.2026) ---------------------------------------------------


def _require_second_factor() -> None:
    with SessionLocal() as db:
        settings_service.save(db, {"two_factor_required": True})


def test_a_sign_in_at_a_provider_trusted_with_the_second_factor_forces_no_second_factor_the_password_sign_in_does(
        client: TestClient, operator: Account, provider: FakeProvider) -> None:
    """The same password account, no second factor of its own, "second factor required" on: the demand holds for its
    sign-in with the password, not for one at a provider that checks the second factor itself."""
    entry = oidc_helpers.configure(client, provider, auto_create=False)
    make_account("anna")
    _link(client, "anna", provider, "anna-sub")
    _require_second_factor()
    by_password = oidc_helpers.fresh_browser()
    assert by_password.post("/api/auth/login", json={"name": "anna", "password": PASSWORD}).status_code == 200
    assert _must_set_up(by_password) is True
    by_provider = oidc_helpers.fresh_browser()
    assert location(sign_in_via_oidc(by_provider, provider, sub="anna-sub")) == "/"
    assert _must_set_up(by_provider) is False
    assert _must_set_up(by_password) is True, "each sign-in on its own, one does not carry the other"
    # A provider that is not trusted with it is no better than the password (the operator is locked out by the demand
    # too, so the switch is turned in the database).
    with SessionLocal() as db:
        db.get(OidcProvider, entry["id"]).trusts_second_factor = False  # type: ignore[union-attr]
        db.commit()
    untrusted = oidc_helpers.fresh_browser()
    assert location(sign_in_via_oidc(untrusted, provider, sub="anna-sub")) == "/"
    assert _must_set_up(untrusted) is True
    # An account that signs in only at the provider is not forced at all.
    with SessionLocal() as db:
        db.query(Account).filter_by(name="anna").one().sign_in = "oidc"
        db.commit()
    assert _must_set_up(untrusted) is False


# --- Behind a proxy that ends TLS (module 1.0.10, "Hinter einem Proxy") ------------------------------------------------


def _seen_by(peer: str, headers: dict[str, str]) -> str:
    """The address of the request as the authentik card sees it (``seen``), from a sender at ``peer``."""
    sender = TestClient(app, base_url="http://tasks.example.com", client=(peer, 50000))
    sender.cookies.set(SESSION_COOKIE, _operator_cookie())
    answer = sender.get("/api/oidc/authentik/address", headers={"X-Nextasks-Client": "tab-proxy0000", **headers})
    assert answer.status_code == 200, answer.text
    return str(answer.json()["seen"])


def _operator_cookie() -> str:
    with SessionLocal() as db:
        row = db.query(Account).filter_by(name="tester").one()
        return start_session(db, row, "127.0.0.1", "tests")


def test_a_proxy_nextasks_trusts_hands_on_the_scheme_and_nobody_else_does(
        client: TestClient, operator: Account, monkeypatch: pytest.MonkeyPatch) -> None:
    https = {"X-Forwarded-Proto": "https"}
    # Out of the box (no trusted proxy), nothing changes: the header is not believed from anybody.
    assert _seen_by("10.9.0.5", https) == "http://tasks.example.com"
    monkeypatch.setattr(get_settings(), "trusted_proxies", "10.9.0.0/16")
    assert _seen_by("10.9.0.5", https) == "https://tasks.example.com", "the trusted proxy ends TLS"
    assert _seen_by("203.0.113.7", https) == "http://tasks.example.com", "any other sender writes what it likes"
    assert _seen_by("10.9.0.5", {}) == "http://tasks.example.com", "no header, no change"
    assert _seen_by("10.9.0.5", {"X-Forwarded-Proto": "javascript"}) == "http://tasks.example.com"
    # What stands left of the proxy's own value a sender wrote itself.
    assert _seen_by("10.9.0.5", {"X-Forwarded-Proto": "https, http"}) == "http://tasks.example.com"
    assert _seen_by("10.9.0.5", {"X-Forwarded-Proto": "http, https"}) == "https://tasks.example.com"
    # Only the scheme: the host stays the one of the request.
    assert _seen_by("10.9.0.5", {**https, "X-Forwarded-Host": "evil.example.net"}) == "https://tasks.example.com"


def test_the_forwarded_scheme_is_the_rightmost_value_of_the_last_line_and_a_known_one() -> None:
    """One reading for the scheme and the cookie (#job-231): last header line, rightmost value, any case, and only a
    scheme this kind of connection has; anything else is no value at all."""
    def lines(*values: str) -> list[tuple[bytes, bytes]]:
        return [(b"host", b"tasks.example.com"), *((b"x-forwarded-proto", value.encode()) for value in values)]

    assert forwarded_proto(lines(), "http") is None
    assert forwarded_proto(lines("https"), "http") == "https"
    assert forwarded_proto(lines(" HTTPS "), "http") == "https"
    assert forwarded_proto([(b"X-Forwarded-Proto", b"https")], "http") == "https", "the name without regard to case"
    assert forwarded_proto(lines("http, https"), "http") == "https"
    assert forwarded_proto(lines("https, http"), "http") == "http"
    assert forwarded_proto(lines("https", "http"), "http") == "http", "the last line is the proxy's"
    assert forwarded_proto(lines("http", "https"), "http") == "https"
    assert forwarded_proto(lines("javascript"), "http") is None
    assert forwarded_proto(lines("https, "), "http") is None, "an empty last value is no value"
    assert forwarded_proto(lines("wss"), "http") is None
    assert forwarded_proto(lines("wss"), "websocket") == "wss"
    assert forwarded_proto(lines("https"), "websocket") is None
    assert forwarded_proto(lines("https"), "lifespan") is None


def test_a_trusted_proxy_hands_on_the_scheme_of_a_websocket_too(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[str] = []

    async def inner(scope: dict, receive: object, send: object) -> None:
        seen.append(scope["scheme"])

    def call(kind: str, peer: str, proto: bytes) -> str:
        scope = {"type": kind, "scheme": "ws" if kind == "websocket" else "http", "client": (peer, 50000),
                 "headers": [(b"x-forwarded-proto", proto)]}
        asyncio.run(ForwardedProtoMiddleware(inner)(scope, None, None))
        return seen.pop()

    assert call("websocket", "10.9.0.5", b"wss") == "ws", "out of the box nobody is believed"
    monkeypatch.setattr(get_settings(), "trusted_proxies", "10.9.0.0/16")
    assert call("websocket", "10.9.0.5", b"wss") == "wss"
    assert call("websocket", "10.9.0.5", b"https") == "ws", "not a scheme of a WebSocket"
    assert call("websocket", "203.0.113.7", b"wss") == "ws"
    assert call("http", "10.9.0.5", b"wss") == "http", "not a scheme of a request"


def _must_set_up(browser: TestClient) -> bool:
    me = browser.get("/api/auth/me")
    assert me.status_code == 200, me.text
    blocked = browser.get("/api/api-tokens")
    required = me.json()["second_factor_setup_required"]
    assert required is (blocked.status_code == 403), (required, blocked.status_code)
    return bool(required)
