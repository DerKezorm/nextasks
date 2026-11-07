"""Request id, timing and security headers for every request."""

from __future__ import annotations

import json
import logging
import re
import secrets
import sqlite3
import time
from collections.abc import Callable
from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse

from .deps import is_trusted_proxy
from .services import logs

logger = logging.getLogger("nextasks.api")


def _database_busy(exc: BaseException) -> bool:
    """SQLite's "database is locked" (or "busy"), however deep in the chain of causes."""
    seen: BaseException | None = exc
    while seen is not None:
        if isinstance(seen, sqlite3.OperationalError) and ("locked" in str(seen) or "busy" in str(seen)):
            return True
        # SQLAlchemy keeps the driver's error as ``orig`` (and as the cause, when it raised it itself).
        seen = getattr(seen, "orig", None) or seen.__cause__ or seen.__context__
    return False


#: Paths whose calls explain nothing but fill the log.
QUIET_PATHS = ("/api/health", "/api/logs")
SLOW_MS = 3000
#: What takes long by nature: backups grow with the vault, ``/wait`` holds every app and browser up to 25 s on
#: purpose (a warning each time filled the log with one line per device every 25 s), and files go in and out in
#: their own time.
SLOW_EXPECTED = ("/api/backups", "/api/app/1/wait", "/api/app/1/files")

#: The editor and the graph set inline styles, hence 'unsafe-inline' for styles only. Scripts stay strict.
#: ``blob:`` for images: a pasted picture is shown before it is uploaded. The installable app: its manifest and its
#: service worker (``/sw.js``) come from the own origin only, said outright rather than left to ``default-src``.
CSP = (
    b"default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; "
    b"connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; "
    b"form-action 'self'; object-src 'none'"
)
SECURITY_HEADERS: tuple[tuple[bytes, bytes], ...] = (
    (b"content-security-policy", CSP),
    (b"x-content-type-options", b"nosniff"),
    (b"referrer-policy", b"same-origin"),
    (b"x-frame-options", b"DENY"),
    (b"permissions-policy", b"camera=(), microphone=(), geolocation=()"),
)


#: The schemes a trusted proxy may hand on, per kind of connection.
_SCHEMES = {"http": ("http", "https"), "websocket": ("ws", "wss")}


def forwarded_proto(headers: list[tuple[bytes, bytes]], kind: str) -> str | None:
    """The scheme the last proxy wrote into ``X-Forwarded-Proto``: the rightmost value of the last such header (what
    stands left of it a sender may have written itself), without regard to case, and only one this kind of connection
    has (http, https; ws, wss for a WebSocket). None for anything else."""
    values = [value for name, value in headers if name.lower() == b"x-forwarded-proto"]
    if not values:
        return None
    proto = values[-1].decode("latin-1").split(",")[-1].strip().lower()
    return proto if proto in _SCHEMES.get(kind, ()) else None


class ForwardedProtoMiddleware:
    """The scheme a proxy that ends TLS reports. uvicorn runs with ``--no-proxy-headers`` (it would believe any sender
    that writes ``X-Forwarded-For``), so behind such a proxy every request looked like plain http: the return address
    of a sign-in, links in mails and ``request.base_url`` said ``http://``. Only a peer in ``NEXTASKS_TRUSTED_PROXIES``
    is believed (none from the start), only its ``X-Forwarded-Proto`` (read by ``forwarded_proto``) and only the
    scheme: host and address of the sender stay as they were. Without trusted proxies nothing changes. The ``Secure``
    flag of the cookies follows this scheme alone (``routers.auth.secure_cookie``)."""

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: dict, receive: Callable, send: Callable) -> None:
        kind = scope.get("type")
        if kind in _SCHEMES and scope.get("client") and is_trusted_proxy(str(scope["client"][0])):
            proto = forwarded_proto(scope.get("headers", []), kind)
            if proto:
                scope = {**scope, "scheme": proto}
        await self.app(scope, receive, send)


class RequestContextMiddleware:
    """Pure ASGI, so streaming responses and WebSockets are not buffered."""

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: dict, receive: Callable, send: Callable) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        request_id = secrets.token_hex(3)
        scope.setdefault("state", {})["request_id"] = request_id
        token = logs.bind_request(request_id)
        start = time.perf_counter()
        status = 0
        path = scope.get("path", "?")

        async def send_wrapper(message: dict) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
                headers = message.setdefault("headers", [])
                headers.append((b"x-request-id", request_id.encode("ascii")))
                # A response that brings its own policy keeps it (a plugin's frame, M7); every other gets the app's.
                present = {name.lower() for name, _value in headers}
                headers.extend(header for header in SECURITY_HEADERS if header[0] not in present)
            await send(message)

        method = scope.get("method", "WS")
        try:
            await self.app(scope, receive, send_wrapper)
        except Exception:
            duration = (time.perf_counter() - start) * 1000
            logger.exception("Unhandled error on %s %s after %dms", method, path, duration)
            raise
        else:
            if scope["type"] != "http":
                return
            duration = (time.perf_counter() - start) * 1000
            if status >= 500:
                logger.error("%s %s -> %s in %dms", method, path, status, duration)
            elif duration >= SLOW_MS and not path.startswith(QUIET_PATHS + SLOW_EXPECTED):
                logger.warning("Slow request: %s %s -> %s in %dms", method, path, status, duration)
            elif not path.startswith(QUIET_PATHS):
                logger.debug("%s %s -> %s in %dms", method, path, status, duration)
        finally:
            logs.unbind_request(token)


#: Methods that change something. They must name their browser tab (see ``GuardMiddleware``).
CHANGING = frozenset({"POST", "PUT", "PATCH", "DELETE"})
CLIENT_HEADER = b"x-nextasks-client"
#: The web names itself ``web`` (the contract); the old interface sent a tab id of 8 to 64 characters.
#: Vertragslücke: any name of 3 to 64 such characters is taken, not only ``web``.
CLIENT_PATTERN = re.compile(rb"^[A-Za-z0-9_-]{3,64}$")
#: The API for programs: a token in ``Authorization``, no tab, an ``Origin`` refused (``routers/v1.py``).
API_PREFIX = "/api/v1/"
#: The surface of the iPhone app and the web's sync (``routers/app1.py``): a device key in ``Authorization`` instead of
#: the tab header; a browser session there must name itself (403 ``bad_client`` without, as the contract says).
APP_PREFIX = "/api/app/1/"
#: One click from a mail program (``List-Unsubscribe-Post``, RFC 8058): it sends no tab, the signed token in the address
#: is all it may do (turn off one report or event of one account, ``routers/notifications.py``).
UNSUBSCRIBE_PREFIX = "/api/notify/unsubscribe/"
#: Largest body an ordinary request may carry.
MAX_BODY = 16 * 1024 * 1024
#: Where another limit holds, checked while streaming: ``/batch`` takes 2 MB (``vertrag-block1.md``); an upload's
#: limit is the operator's setting, checked by the route while the file arrives, this is only the ceiling above it.
LARGE_BODIES = {"/api/app/1/batch": 2 * 1024 * 1024, "/api/app/1/files": 51 * 1024 * 1024,
                "/api/backups/upload": 64 * 1024**3}


class BodyTooLarge(Exception):
    pass


def _refuse(status: int, code: str, text: str) -> tuple[dict, dict]:
    body = json.dumps({"detail": {"code": code, "message": text}}).encode()
    start = {
        "type": "http.response.start",
        "status": status,
        "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())],
    }
    return start, {"type": "http.response.body", "body": body}


class GuardMiddleware:
    """Two walls in front of every route, including routes still to come.

    * **A change must name its tab** in ``X-Nextasks-Client``. A page on another site can make a browser
      send a form, but not a request with a header of its own (that needs CORS, which nextasks does not allow): so
      the header is the wall against cross-site requests too.
    * **A body has a size limit** before anything reads it: the declared length is checked first, and a body sent
      without one is counted while it arrives.
    """

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: dict, receive: Callable, send: Callable) -> None:
        if scope["type"] != "http" or not scope.get("path", "").startswith("/api/"):
            await self.app(scope, receive, send)
            return
        headers = dict(scope.get("headers") or [])
        path = scope["path"]
        named = CLIENT_PATTERN.match(headers.get(CLIENT_HEADER, b"")) is not None
        if path.startswith(APP_PREFIX):
            # A device key opens it; a cookie only together with the header, for every method (a page elsewhere can
            # make a browser send the cookie, never the header).
            bearer = headers.get(b"authorization", b"")[:7].lower() == b"bearer "
            if not bearer and not named and b"cookie" in headers:
                text = "Requests with the session need the header X-Nextasks-Client."
                for message in _refuse(403, "bad_client", text):
                    await send(message)
                return
        # The API for programs needs a token in ``Authorization`` instead, and refuses a request with an ``Origin``.
        exempt = path.startswith((API_PREFIX, APP_PREFIX, UNSUBSCRIBE_PREFIX))
        if scope.get("method") in CHANGING and not exempt and not named:
            for message in _refuse(400, "client_required", "Changes need the header X-Nextasks-Client."):
                await send(message)
            return
        limit = LARGE_BODIES.get(path, MAX_BODY)
        declared = headers.get(b"content-length")
        if declared is not None and (not declared.isdigit() or int(declared) > limit):
            for message in _refuse(413, "too_large", "The request is too large."):
                await send(message)
            return
        received = 0
        overflow = False

        async def counting_receive() -> dict:
            nonlocal received, overflow
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    overflow = True
                    raise BodyTooLarge
            return message

        started = False

        async def tracking_send(message: dict) -> None:
            nonlocal started
            # The framework turns the aborted read into an answer of its own (400); the caller gets the true one.
            if overflow:
                if message["type"] == "http.response.start" and not started:
                    started = True
                    for refusal in _refuse(413, "too_large", "The request is too large."):
                        await send(refusal)
                return
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, counting_receive, tracking_send)
        except BodyTooLarge:
            if not started:
                for message in _refuse(413, "too_large", "The request is too large."):
                    await send(message)


#: An error under ``/api/v1`` that carries no code of its own (a method the route does not have, a bare text).
_STATUS_CODES = {400: "invalid_input", 404: "not_found", 405: "method_not_allowed", 413: "too_large",
                 422: "invalid_input"}


def v1_error(content: Any, status: int) -> dict[str, Any]:
    """An error as ``docs/api.md`` writes it, the form of the whole nexapps family: ``{"detail": {"code",
    "message"}}`` plus ``fields`` and the like inside ``detail``. Answers without a code (the framework's own) get one
    from the status."""
    found = content.get("detail") if isinstance(content, dict) else None
    if isinstance(found, dict) and "code" in found:
        return {"detail": {**found, "message": str(found.get("message") or "")}}
    code = _STATUS_CODES.get(status, "internal_error" if status >= 500 else "invalid_input")
    return {"detail": {"code": code, "message": found if isinstance(found, str) else "The request failed."}}


class ApiErrorShape:
    """Errors under ``/api/v1`` in the form of the API for programs (``v1_error``), whoever wrote them: a route, the
    framework's checks, the guard below. Only error answers with JSON are read and written anew."""

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: dict, receive: Callable, send: Callable) -> None:
        if scope["type"] != "http" or not scope.get("path", "").startswith(API_PREFIX):
            await self.app(scope, receive, send)
            return
        held: dict | None = None
        body = b""

        async def shaping_send(message: dict) -> None:
            nonlocal held, body
            if message["type"] == "http.response.start":
                headers = dict(message.get("headers") or [])
                if message["status"] >= 400 and headers.get(b"content-type", b"").startswith(b"application/json"):
                    held = message
                    return
                await send(message)
                return
            if held is None or message["type"] != "http.response.body":
                await send(message)
                return
            body += message.get("body", b"")
            if message.get("more_body"):
                return
            try:
                shaped = json.dumps(v1_error(json.loads(body or b"null"), held["status"])).encode()
            except ValueError:
                shaped = body
            headers = [(key, value) for key, value in held.get("headers") or [] if key != b"content-length"]
            headers.append((b"content-length", str(len(shaped)).encode()))
            await send({**held, "headers": headers})
            await send({"type": "http.response.body", "body": shaped})

        await self.app(scope, receive, shaping_send)


async def unhandled_error(request: Request, exc: Exception) -> JSONResponse:
    request_id = getattr(request.state, "request_id", None) or "-"
    if _database_busy(exc):
        # The database stayed busy past the wait (SQLite's busy timeout): a moment later it works. The browser gets
        # something to say and to retry instead of "went wrong".
        return JSONResponse(
            status_code=503,
            content={"detail": {"code": "busy", "message": "nextasks is busy. Try again in a moment.",
                                "request_id": request_id}},
            headers={"X-Request-Id": request_id, "Retry-After": "2"},
        )
    return JSONResponse(
        status_code=500,
        content={
            "detail": {
                "code": "internal_error",
                "message": f"Something went wrong on the server. Request id: {request_id}",
                "request_id": request_id,
            }
        },
        headers={"X-Request-Id": request_id},
    )
