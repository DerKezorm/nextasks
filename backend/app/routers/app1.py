"""``/api/app/1``: the surface of the iPhone app and of the web's sync (``nextasks-ios/docs/vertrag-block1.md``).

**A promise.** The app in the App Store and the servers out there are never updated at the same time, and the web
builds against the same contract. As long as ``app/1`` stands in the address nothing here breaks: new fields may come,
none is renamed or taken away. ``PROMISED`` names every address, ``tests/app1_contract.json`` keeps the fields of every
answer (``tests/test_app1_contract.py``).

**Two kinds of callers, the same paths.** The app with ``Authorization: Bearer ntd_…`` (a device key, which opens
nothing outside ``/api/app/1``); the web with its session cookie and the header ``X-Nextasks-Client`` (without it 403
``bad_client``, ``middleware.GuardMiddleware``). Walls, in this order: who it is (401 ``not_signed_in``, also while a
second factor the operator requires is missing), the operator's switch for devices (403 ``app_disabled``), the rate of
the device or session (429 ``too_many``). What the caller may not see does not exist (404 ``not_found``).
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import threading
import time
import unicodedata
from typing import Annotated, Any, ClassVar

import anyio
from fastapi import APIRouter, Depends, Form, Header, Query, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from .. import __version__
from ..db import SessionLocal
from ..deps import client_ip
from ..errors import error
from ..models import (
    MANAGER,
    OPERATOR,
    SPACE_ROLES,
    Account,
    AppOp,
    Attachment,
    AuthSession,
    Gone,
    Invite,
    Member,
    Reminder,
    Space,
    utcnow,
)
from ..security import SESSION_COOKIE, hash_token, session_account, session_by_provider
from ..security import brake as sign_in_brake
from ..services import (
    accounts,
    changes,
    clock,
    cursor,
    devices,
    files,
    logs,
    media,
    notify,
    push,
    records,
    settings_service,
    spaces,
    sync,
    totp,
    webpush,
)
from ..services.devices import PairingError
from .invites import link_of

logger = logging.getLogger("nextasks.app")

router = APIRouter(prefix="/api/app/1", tags=["app"])

#: How long ``/wait`` holds a request open.
WAIT_SECONDS = 25.0
#: How often ``/wait`` looks whether something was committed meanwhile; the database itself it asks every few seconds.
WAIT_STEP = 0.25
WAIT_DB_EVERY = 5.0
BATCH_OPS = 200
#: The largest attachment there may ever be (``limits.attachment_bytes`` is at most this).
ATTACHMENT_CEILING = 50 * 1024 * 1024


# --- Who calls -------------------------------------------------------------------------------------------------------


class Caller(sync.Caller):
    """The account (detached), and the device or the browser session it calls with."""

    device_id: int | None = None
    device_name: str = ""

    def __init__(self, account: Account, key: str, device_id: int | None = None, device_name: str = "") -> None:
        super().__init__(account=account, key=key)
        self.device_id = device_id
        self.device_name = device_name


def _token(request: Request) -> str | None:
    header = request.headers.get("authorization", "")
    return header[7:].strip() if header[:7].lower() == "bearer " else None


def _refused(code: str, text: str, status: int, retry: int | None = None) -> Exception:
    exc = error(code, text, status)
    if retry is not None:
        exc.headers = {"Retry-After": str(retry)}
    return exc


_private_known: set[int] = set()
_private_lock = threading.Lock()


def _ensure_private(account: Account) -> None:
    """Every account has its space "Private"; made here at the latest (an account a provider made never signed in to
    the web before its first device)."""
    if account.id in _private_known:
        return
    with cursor.WRITE_LOCK, SessionLocal() as db:
        row = db.get(Account, account.id)
        if row is not None and spaces.private_of(db, row.id) is None:
            spaces.ensure_private(db, row)
            db.commit()
            cursor.touched_everybody()
    with _private_lock:
        _private_known.add(account.id)


def forget_private_cache() -> None:
    """For the tests: the database is emptied between them."""
    with _private_lock:
        _private_known.clear()


def caller(request: Request) -> Caller:
    token = _token(request)
    with SessionLocal() as db:
        if token is not None:
            found = devices.authenticate(db, token)
            if found is None:
                raise _refused("not_signed_in", "No valid device key.", 401)
            if not devices.enabled(db):
                raise _refused("app_disabled", "The operator has switched the app off.", 403)
            who = Caller(found.account, found.client, found.device_id, found.device_name)
        else:
            cookie = request.cookies.get(SESSION_COOKIE)
            account = session_account(db, cookie)
            if account is None or totp.setup_required(db, account, by_provider=session_by_provider(db, cookie)):
                raise _refused("not_signed_in", "Sign in first.", 401)
            session_id = db.scalar(select(AuthSession.id).where(AuthSession.token_hash == hash_token(cookie or "")))
            db.expunge(account)
            who = Caller(account, f"s:{session_id}")
    if not devices.brake(who.key):
        raise _refused("too_many", "Too many requests. Wait a minute.", 429, 60)
    logs.set_actor(who.account.name)
    _ensure_private(who.account)
    return who


Who = Annotated[Caller, Depends(caller)]


# --- Pairing (no key, behind the sign-in brake) -------------------------------------------------------------------


class KeyIn(BaseModel):
    device: str = Field(default="", max_length=200)


class CodeIn(KeyIn):
    code: str = Field(max_length=20)


class PairedAccount(BaseModel):
    id: int
    name: str


class KeyOut(BaseModel):
    key: str
    account: PairedAccount


def _pickup(request: Request, take: Any) -> JSONResponse:
    """The brake counts per sender: there is no account to count at, and 40 bits of a short code hold only with it."""
    with SessionLocal() as db:
        if not devices.enabled(db):
            raise _refused("app_disabled", "The operator has switched the app off.", 403)
        if not devices.allowed(db):
            raise _refused("app_pairing_disabled", "The operator does not allow pairing the app.", 403)
    key = "app-pairing:" + client_ip(request)
    wait = sign_in_brake.wait_seconds(key)
    if wait:
        raise _refused("too_many", "Too many attempts. Try again later.", 429, wait)
    with SessionLocal() as db:
        try:
            token, account, _row = take(db)
        except PairingError as exc:
            sign_in_brake.failed(key)
            raise error(exc.code, exc.text, exc.status) from exc
        out = KeyOut(key=token, account=PairedAccount(id=account.id, name=account.display_name or account.name))
    sign_in_brake.succeeded(key)
    return JSONResponse(content=out.model_dump(), headers={"Cache-Control": "no-store"})


@router.post("/pairing/{pairing_id}/key", response_model=KeyOut, summary="Pick the device key up with the QR code")
def pickup_by_secret(
    pairing_id: str,
    request: Request,
    body: KeyIn | None = None,
    secret: Annotated[str | None, Header(alias="X-Pairing-Secret", max_length=200)] = None,
) -> JSONResponse:
    """Unknown, wrong, expired and used answer the same (404 ``app_pairing_unknown``)."""
    return _pickup(request, lambda db: devices.by_secret(db, pairing_id, secret, body.device if body else ""))


@router.post("/pairing/code", response_model=KeyOut, summary="Pick the device key up with the short code")
def pickup_by_code(body: CodeIn, request: Request) -> JSONResponse:
    return _pickup(request, lambda db: devices.by_code(db, body.code, body.device))


# --- Who am I -----------------------------------------------------------------------------------------------------


class MeAccount(BaseModel):
    id: int
    name: str
    username: str
    operator: bool
    timezone: str
    #: ``de`` or ``en``.
    language: str
    avatar_hash: str | None = None


class MeDevice(BaseModel):
    id: int
    name: str


class Limits(BaseModel):
    attachment_bytes: int


class MeOut(BaseModel):
    version: str
    #: The server's time in ms UTC: app and web take their clocks' offset from it.
    now: int
    account: MeAccount
    device: MeDevice | None = None
    features: list[str]
    limits: Limits


class MeIn(BaseModel):
    timezone: str | None = Field(default=None, max_length=64)
    language: str | None = Field(default=None, max_length=8)


def attachment_bytes(db: Any) -> int:
    return min(settings_service.upload_max_mb(db) * 1024 * 1024, ATTACHMENT_CEILING)


def features(db: Any) -> list[str]:
    # ``space_prefs``: the kind ``space_pref`` (hiding a space) is known here (contract 0.3); older servers refuse it.
    offered = ["changes", "batch", "files", "wait", "invites", "space_prefs"]
    if push.relay_url():
        offered.append("push")
    if webpush.ready(db):
        offered.append("webpush")
    return offered


def _language(account: Account) -> str:
    return spaces.language_of(account)


def _me(found: Caller) -> MeOut:
    with SessionLocal() as db:
        account = db.get(Account, found.account.id)
        assert account is not None
        return MeOut(
            version=__version__,
            now=clock.now_ms(),
            account=MeAccount(id=account.id, name=account.display_name or account.name, username=account.name,
                              operator=account.role == OPERATOR, timezone=account.timezone or clock.zone_name(),
                              language=_language(account), avatar_hash=account.avatar_hash or None),
            device=MeDevice(id=found.device_id, name=found.device_name) if found.device_id is not None else None,
            features=features(db),
            limits=Limits(attachment_bytes=attachment_bytes(db)),
        )


@router.get("/me", response_model=MeOut, summary="The account, this device, what the server offers, the time")
def me(found: Who) -> MeOut:
    return _me(found)


@router.put("/me", response_model=MeOut, summary="The account's time zone and language")
def set_me(body: MeIn, found: Who) -> MeOut:
    bad = []
    zone = body.timezone.strip() if body.timezone is not None else None
    if zone is not None and not clock.valid_zone(zone):
        bad.append("timezone")
    if body.language is not None and body.language not in ("de", "en"):
        bad.append("language")
    if bad:
        raise error("invalid_input", "The input is not valid.", 422, fields=bad)
    with SessionLocal() as db:
        account = db.get(Account, found.account.id)
        assert account is not None
        if zone is not None:
            account.timezone = zone
        if body.language is not None:
            account.language = body.language
        db.commit()
    return _me(found)


@router.delete("/device", status_code=204, summary="Disconnect this device (device key only)")
def forget_device(found: Who) -> Response:
    if found.device_id is None:
        raise error("not_found", "Not found.", 404)
    with SessionLocal() as db:
        devices.disconnect(db, found.account.id, found.device_id)
    return Response(status_code=204)


# --- Fetching -----------------------------------------------------------------------------------------------------


class Person(BaseModel):
    id: int
    name: str | None = None
    avatar_hash: str | None = None


class Entry(BaseModel):
    #: ``space``, ``member``, ``list``, ``section``, ``reminder``, ``attachment``, ``list_pref`` or ``space_pref``.
    kind: str
    id: str
    cursor: int
    #: Gone for good, or not seen any more: ``data`` and ``clock`` are null then.
    deleted: bool
    data: dict[str, Any] | None = None
    clock: dict[str, int] | None = None


class ChangesOut(BaseModel):
    cursor: int
    more: bool
    space_ids: list[str]
    people: list[Person]
    items: list[Entry]


@router.get("/changes", response_model=ChangesOut, summary="What changed since a cursor; 0 is everything")
def get_changes(
    found: Who,
    since: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=changes.MAX_LIMIT)] = changes.DEFAULT_LIMIT,
) -> ChangesOut:
    with SessionLocal() as db:
        try:
            page = changes.page(db, found.id, since, limit)
        except changes.Expired as exc:
            raise error("cursor_expired", "The cursor is older than what the server still knows.", 410) from exc
    return ChangesOut(cursor=page.cursor, more=page.more, space_ids=page.space_ids,
                      people=[Person(**person) for person in page.people], items=[Entry(**item) for item in page.items])


class CursorOut(BaseModel):
    cursor: int


def _news(account_id: int, since: int) -> tuple[bool, int]:
    with SessionLocal() as db:
        last, _oldest = cursor.state(db)
        if since > last:
            return True, last
        return changes.has_news(db, account_id, since), last


@router.get("/wait", response_model=CursorOut, summary="Wait up to 25 s for something new for this account")
async def wait(found: Who, cursor_: Annotated[int, Query(alias="cursor", ge=0)]) -> CursorOut:
    """Async and without a thread while it waits: a hundred waiting apps hold up no other request."""
    deadline = time.monotonic() + WAIT_SECONDS
    seen = cursor.mark(found.id)
    asked = time.monotonic()
    news, last = await run_in_threadpool(_news, found.id, cursor_)
    while not news and time.monotonic() < deadline:
        await asyncio.sleep(WAIT_STEP)
        now_seen = cursor.mark(found.id)
        if now_seen != seen or time.monotonic() - asked >= WAIT_DB_EVERY:
            seen = now_seen
            asked = time.monotonic()
            news, last = await run_in_threadpool(_news, found.id, cursor_)
    return CursorOut(cursor=last if news else cursor_)


@router.get("/files/{attachment_id}", response_model=None, summary="The file of an attachment; ETag is its hash",
            responses={200: {"content": {"application/octet-stream": {}}}})
def get_file(attachment_id: str, request: Request, found: Who) -> Response:
    with SessionLocal() as db:
        row = db.get(Attachment, attachment_id) if records.is_uuid(attachment_id) else None
        if row is None or db.get(Member, (row.space_id, found.id)) is None:
            raise error("not_found", "Not found.", 404)
        db.expunge(row)
    path = files.path_of(row.hash)
    if not path.is_file():
        raise error("not_found", "Not found.", 404)
    tag = f'"{row.hash}"'
    headers = {"ETag": tag, "Cache-Control": "private, no-cache",
               "Content-Security-Policy": "default-src 'none'; sandbox"}
    if request.headers.get("if-none-match") == tag:
        return Response(status_code=304, headers=headers)
    return FileResponse(path, media_type=row.mime or "application/octet-stream", headers=headers,
                        filename=row.name, content_disposition_type="attachment")


@router.get("/people/{account_id}/avatar", response_model=None, summary="A profile picture; ETag is its hash",
            responses={200: {"content": {"image/webp": {}}}})
def avatar(account_id: int, request: Request, found: Who) -> Response:
    with SessionLocal() as db:
        seen = {person["id"] for person in changes.people(db, found.id)}
        row = db.get(Account, account_id) if account_id in seen else None
        picture = row.avatar if row is not None else None
        digest = row.avatar_hash if row is not None else ""
    if not picture:
        raise error("not_found", "Not found.", 404)
    tag = f'"{digest}"'
    headers = {"ETag": tag, "Cache-Control": "private, no-cache"}
    if request.headers.get("if-none-match") == tag:
        return Response(status_code=304, headers=headers)
    return Response(picture, media_type="image/webp", headers=headers)


# --- Sending ------------------------------------------------------------------------------------------------------


class OpIn(BaseModel):
    """One op; its other fields depend on ``type`` (``put``, ``delete``, ``complete``, ``position``)."""

    model_config = ConfigDict(extra="allow")
    op_id: str = Field(min_length=1, max_length=64)
    type: str = Field(max_length=16)


class BatchIn(BaseModel):
    ops: list[OpIn] = Field(max_length=BATCH_OPS)


class ResultOut(BaseModel):
    model_config = ConfigDict(extra="allow", populate_by_name=True)
    op_id: str
    ok: bool
    #: When ``ok`` is false: ``forbidden``, ``invalid``, ``parent_missing``, ``gone``, ``not_found``,
    #: ``already_done``, ``due_changed``.
    code: str | None = None
    #: The thing after the op, as ``/changes`` gives it, or null when the caller does not see it.
    current: Entry | None = None
    #: ``put``: the clock keys taken and left, the assignees struck.
    applied: list[str] | None = None
    ignored: list[str] | None = None
    dropped_assignees: list[int] | None = None
    #: ``invalid``: the fields at fault.
    fields: list[str] | None = None
    #: ``complete``: the completed copy of a repeating reminder, and where the original moved.
    copy_id: str | None = None
    next_due: dict[str, Any] | None = None
    copy_entry: Entry | None = Field(default=None, alias="copy")


class BatchOut(BaseModel):
    results: list[ResultOut]
    #: A hint only; ``since`` is always the cursor of ``/changes``.
    cursor: int


class _OneAtATime:
    """The same ``op_id`` twice at once (the app retries after a timeout while the first request still runs): the
    second waits for the first and then finds its answer."""

    running: ClassVar[dict[tuple[str, str], list[Any]]] = {}
    guard: ClassVar[threading.Lock] = threading.Lock()

    def __init__(self, key: str, op_id: str) -> None:
        self.key = (key, op_id)

    def __enter__(self) -> None:
        with self.guard:
            self.entry = self.running.setdefault(self.key, [threading.Lock(), 0])
            self.entry[1] += 1
        self.entry[0].acquire()

    def __exit__(self, *_exc: object) -> None:
        self.entry[0].release()
        with self.guard:
            self.entry[1] -= 1
            if not self.entry[1]:
                del self.running[self.key]


def _stored(key: str, op_id: str) -> dict[str, Any] | None:
    with SessionLocal() as db:
        return db.scalar(select(AppOp.result).where(AppOp.caller == key, AppOp.op_id == op_id))


def _store(key: str, result: dict[str, Any]) -> None:
    with SessionLocal() as db:
        db.execute(sqlite_insert(AppOp).values(caller=key, op_id=result["op_id"], result=result, created_at=utcnow())
                   .on_conflict_do_nothing())
        db.commit()


def run_op(found: Caller, op: dict[str, Any]) -> dict[str, Any]:
    """One op, at most once per ``op_id`` of this device or session; the answer with ``current`` read now."""
    with _OneAtATime(found.key, op["op_id"]):
        result = _stored(found.key, op["op_id"])
        if result is None:
            result, events = sync.apply(found, op)
            _store(found.key, result)
            notify.after_op(events, found.id)
    return sync.answer(found, op, result)


@router.post("/batch", response_model=BatchOut, summary="Changes, in order; each answered on its own")
def batch(body: BatchIn, found: Who) -> JSONResponse:
    """Every result carries ``current`` (null included); the other fields only where the op has them."""
    results = [run_op(found, op.model_dump()) for op in body.ops]
    logger.info("Batch ops=%s failed=%s", len(results), sum(1 for result in results if not result["ok"]))
    with SessionLocal() as db:
        last, _oldest = cursor.state(db)
    return JSONResponse(content={"results": results, "cursor": last})


# Vertragslücke: for ``/files`` the contract names ``too_large``, ``invalid`` and ``ok``; a reminder the server never
# had answers ``parent_missing``, a tombstone ``gone``, one the caller does not see ``not_found``, as for a ``put``.
def _upload_plan(found: Caller, attachment_id: str, reminder_id: str) -> tuple[str | None, Reminder | None]:
    """``(code, reminder)``: the reason it cannot go up, or the reminder it goes to; ``"same"`` when this very
    attachment is there already (with the hash to compare)."""
    with SessionLocal() as db:
        if not records.is_uuid(attachment_id) or not records.is_uuid(reminder_id):
            return "invalid", None
        existing = db.get(Attachment, attachment_id)
        if existing is not None:
            if db.get(Member, (existing.space_id, found.id)) is None:
                return "not_found", None
            return f"same:{existing.hash}", None
        if db.scalar(select(Gone.kind).where(Gone.kind == "attachment", Gone.id == attachment_id).limit(1)):
            return "gone", None
        row = db.get(Reminder, reminder_id)
        if row is None:
            gone = db.scalar(select(Gone.kind).where(Gone.kind == "reminder", Gone.id == reminder_id).limit(1))
            return ("gone" if gone else "parent_missing"), None
        if db.get(Member, (row.space_id, found.id)) is None:
            return "not_found", None
        db.expunge(row)
        return None, row


def _save_upload(found: Caller, attachment_id: str, reminder_id: str, name: str, mime: str, digest: str,
                 size: int, received: Any) -> dict[str, Any]:
    """The file under its hash and the row, under the write lock: a delete of another attachment with the same
    content cannot take the file away in between."""
    with cursor.WRITE_LOCK, SessionLocal() as db:
        files.keep(received, digest)
        reminder = db.get(Reminder, reminder_id)
        if reminder is None or db.get(Member, (reminder.space_id, found.id)) is None:
            return {"op_id": "", "ok": False, "code": "not_found"}
        existing = db.get(Attachment, attachment_id)
        if existing is not None:
            ok = existing.hash == digest
            if not ok:
                files.forget_if_unused(db, digest)
            return {"op_id": "", "ok": ok, **({} if ok else {"code": "invalid", "fields": ["file"]})}
        row = Attachment(id=attachment_id, reminder_id=reminder.id, space_id=reminder.space_id, name=name, mime=mime,
                         size=size, hash=digest, created_by=found.id, created_at=records.format_stamp(clock.now()))
        spaces.restamp(db, [row])
        db.add(row)
        db.commit()
    cursor.touched_everybody()
    return {"op_id": "", "ok": True}


@router.post("/files", response_model=ResultOut, summary="Upload the file of an attachment; answered like an op")
async def upload(
    found: Who,
    request: Request,
    attachment_id: Annotated[str, Form(alias="id", max_length=64)],
    reminder_id: Annotated[str, Form(max_length=64)],
    op_id: Annotated[str, Form(min_length=1, max_length=64)],
    file: UploadFile,
) -> JSONResponse:
    limit, clean = await run_in_threadpool(_rules)
    running = _OneAtATime(found.key, op_id)
    await run_in_threadpool(running.__enter__)
    try:
        stored = await run_in_threadpool(_stored, found.key, op_id)
        op = {"type": "upload", "op_id": op_id}
        if stored is not None:
            return JSONResponse(await run_in_threadpool(_answer_upload, found, op, stored, attachment_id))
        code, _reminder = await run_in_threadpool(_upload_plan, found, attachment_id, reminder_id)
        name = unicodedata.normalize("NFC", file.filename or "").strip()
        mime = (file.content_type or "application/octet-stream").strip()[:255] or "application/octet-stream"
        if code is None and not 1 <= len(name) <= 255:
            code = "invalid"
        received = files.temporary()
        digest = hashlib.sha256()
        size = 0
        try:
            if code is None or code.startswith("same:"):
                async with await anyio.open_file(received, "wb") as handle:
                    while chunk := await file.read(1024 * 1024):
                        size += len(chunk)
                        if size > limit:
                            raise error("too_large", "The file is larger than the server takes.", 413,
                                        max_bytes=limit)
                        digest.update(chunk)
                        await handle.write(chunk)
            hexdigest = digest.hexdigest()
            if clean and size and (code is None or code.startswith("same:")):
                # Before the hash is compared or kept: the row, the file and an upload sent again all agree on it.
                hexdigest, size = await run_in_threadpool(_clean_photo, received, hexdigest, size)
            if code is None and size == 0:
                code = "invalid"
            if code is not None and code.startswith("same:"):
                same = code.removeprefix("same:") == hexdigest
                result: dict[str, Any] = {"op_id": op_id, "ok": same}
                if not same:
                    result.update(code="invalid", fields=["file"])
            elif code is not None:
                result = {"op_id": op_id, "ok": False, "code": code}
                if code == "invalid":
                    result["fields"] = ["file"]
            else:
                saved = await run_in_threadpool(_save_upload, found, attachment_id, reminder_id, name, mime,
                                                hexdigest, size, received)
                result = {**saved, "op_id": op_id}
        finally:
            received.unlink(missing_ok=True)
        result["_target"] = attachment_id
        await run_in_threadpool(_store, found.key, result)
        return JSONResponse(await run_in_threadpool(_answer_upload, found, op, result, attachment_id))
    finally:
        running.__exit__(None, None, None)


def _rules() -> tuple[int, bool]:
    """The largest attachment, and whether photos lose their metadata (``strip_location``)."""
    with SessionLocal() as db:
        return attachment_bytes(db), bool(settings_service.get(db, "strip_location"))


def _clean_photo(path: Any, digest: str, size: int) -> tuple[str, int]:
    """A photo keeps of its metadata only the orientation and the colour profile (``services/media.py``); its hash
    and size are then those of what is kept. The cleaning is the same every time, so the same photo sent again (a
    retry with another ``op_id``) comes to the same hash, and one cleaned already stays as it is."""
    with open(path, "rb") as handle:
        kind = media.sniff(handle.read(64))
    if kind not in media.PICTURES:
        return digest, size
    removed = media.strip(path, kind)
    hasher = hashlib.sha256()
    size = 0
    with open(path, "rb") as handle:
        while chunk := handle.read(1024 * 1024):
            size += len(chunk)
            hasher.update(chunk)
    if removed:
        logger.info("Photo cleaned kind=%s removed=%s", kind, ",".join(sorted(removed)))
    return hasher.hexdigest(), size


def _answer_upload(found: Caller, op: dict[str, Any], stored: dict[str, Any], attachment_id: str) -> dict[str, Any]:
    attachment_id = str(stored.get("_target") or attachment_id)
    out = {key: value for key, value in stored.items() if key != "_target"}
    with SessionLocal() as db:
        out["current"] = sync.current_of(db, found, "attachment", attachment_id) if records.is_uuid(
            attachment_id) else None
    _ = op
    return out


# --- Notifications ------------------------------------------------------------------------------------------------


class PushIn(BaseModel):
    #: The relay's ticket for this device.
    ticket: str = Field(min_length=1, max_length=1024)
    #: The device's public X25519 key, base64 of 32 bytes.
    key: str = Field(max_length=200)


class Done(BaseModel):
    status: str = "ok"


@router.put("/push", response_model=Done, summary="Where notifications for this device go (device key only)")
def set_push(body: PushIn, found: Who) -> Done:
    if found.device_id is None:
        raise error("not_found", "Not found.", 404)
    if not push.key_valid(body.key):
        raise error("invalid_input", "The input is not valid.", 422, fields=["key"])
    with SessionLocal() as db:
        push.remember(db, found.account.id, found.device_id, body.ticket, body.key)
    return Done()


@router.delete("/push", response_model=Done, summary="Stop notifications for this device; it stays paired")
def stop_push(found: Who) -> Done:
    if found.device_id is None:
        raise error("not_found", "Not found.", 404)
    with SessionLocal() as db:
        push.forget(db, found.device_id)
    return Done()


class WebPushKeyOut(BaseModel):
    #: VAPID, base64url: the browser's ``applicationServerKey``.
    public_key: str


class WebPushKeys(BaseModel):
    p256dh: str = Field(max_length=200)
    auth: str = Field(max_length=100)


class WebPushIn(BaseModel):
    endpoint: str = Field(max_length=1000)
    keys: WebPushKeys


class WebPushOff(BaseModel):
    endpoint: str = Field(max_length=1000)


@router.get("/webpush/key", response_model=WebPushKeyOut, summary="The server's key for web push")
def webpush_key(found: Who) -> WebPushKeyOut:
    with SessionLocal() as db:
        return WebPushKeyOut(public_key=webpush.public_key(db))


@router.put("/webpush", response_model=Done, summary="This browser takes notifications")
def webpush_on(body: WebPushIn, request: Request, found: Who) -> Done:
    if not webpush.endpoint_valid(body.endpoint):
        raise error("invalid_input", "The input is not valid.", 422, fields=["endpoint"])
    if not webpush.valid_keys(body.keys.p256dh, body.keys.auth):
        raise error("invalid_input", "The input is not valid.", 422, fields=["keys"])
    with SessionLocal() as db:
        # Its own header names the browser on the page "Notifications" ("Chrome on Windows"); the contract is as it was.
        webpush.subscribe(db, found.id, body.endpoint, body.keys.p256dh, body.keys.auth,
                          request.headers.get("user-agent", ""))
    return Done()


@router.delete("/webpush", response_model=Done, summary="This browser takes no more notifications")
def webpush_off(body: WebPushOff, found: Who) -> Done:
    with SessionLocal() as db:
        webpush.unsubscribe(db, found.id, body.endpoint)
    return Done()


# --- Spaces and members -------------------------------------------------------------------------------------------


class InviteOut(BaseModel):
    id: int
    #: ``<address>/invite/<secret>``: shown once.
    link: str
    expires_at: records.StampOut


class InviteRow(BaseModel):
    id: int
    expires_at: records.StampOut
    created_by: int | None = None


class RoleIn(BaseModel):
    role: str = Field(max_length=16)


class MemberOut(BaseModel):
    space_id: str
    account_id: int
    role: str


def _managed_space(db: Any, found: Caller, space_id: str) -> Space:
    """The space, when the caller manages it. Not a member: 404; a member: 403."""
    space = db.get(Space, space_id) if records.is_uuid(space_id) else None
    role = spaces.role_of(db, found.id, space_id) if space is not None else None
    if space is None or role is None:
        raise error("not_found", "Not found.", 404)
    if role != MANAGER:
        raise error("forbidden", "Only a manager of this space may do this.", 403)
    return space


@router.post("/spaces/{space_id}/invites", response_model=InviteOut, status_code=201,
             summary="A link for one person into the space (managers)")
def make_invite(space_id: str, request: Request, found: Who) -> InviteOut:
    with SessionLocal() as db:
        space = _managed_space(db, found, space_id)
        if space.private:
            raise error("private_space", "The space Private is not shared.", 403)
        if not settings_service.get(db, "invites_enabled"):
            raise error("invites_disabled", "The operator has switched invitations off.", 403)
        account = db.get(Account, found.id)
        assert account is not None
        row, token = accounts.create_invite(db, account, space_id=space.id, days=7)
        return InviteOut(id=row.id, link=link_of(db, request, token), expires_at=row.expires_at)


@router.get("/spaces/{space_id}/invites", response_model=list[InviteRow], summary="Open invitations (managers)")
def list_space_invites(space_id: str, found: Who) -> list[InviteRow]:
    with SessionLocal() as db:
        space = _managed_space(db, found, space_id)
        rows = db.scalars(select(Invite).where(Invite.space_id == space.id, Invite.expires_at > utcnow())
                          .order_by(Invite.created_at))
        return [InviteRow(id=row.id, expires_at=row.expires_at, created_by=row.created_by) for row in rows]


@router.delete("/spaces/{space_id}/invites/{invite_id}", status_code=204, summary="Withdraw an invitation (managers)")
def withdraw_invite(space_id: str, invite_id: int, found: Who) -> Response:
    with SessionLocal() as db:
        space = _managed_space(db, found, space_id)
        row = db.get(Invite, invite_id)
        if row is None or row.space_id != space.id:
            raise error("not_found", "Not found.", 404)
        db.delete(row)
        db.commit()
    return Response(status_code=204)


def _last_manager(db: Any, space_id: str, account_id: int) -> bool:
    """``account_id`` is the only manager, and others are in the space."""
    rows = db.scalars(select(Member).where(Member.space_id == space_id)).all()
    managers = [row for row in rows if row.role == MANAGER]
    return len(rows) > 1 and [row.account_id for row in managers] == [account_id]


@router.put("/spaces/{space_id}/members/{account_id}", response_model=MemberOut, summary="Change a role (managers)")
def set_member_role(space_id: str, account_id: int, body: RoleIn, found: Who) -> MemberOut:
    if body.role not in SPACE_ROLES:
        raise error("invalid_input", "The input is not valid.", 422, fields=["role"])
    with cursor.WRITE_LOCK, SessionLocal() as db:
        _managed_space(db, found, space_id)
        member = db.get(Member, (space_id, account_id))
        if member is None:
            raise error("not_found", "Not found.", 404)
        if body.role != MANAGER and member.role == MANAGER and _last_manager(db, space_id, account_id):
            raise error("last_manager", "The space needs another manager first.", 409)
        if member.role != body.role:
            spaces.set_role(db, member, body.role)
            db.commit()
        out = MemberOut(space_id=space_id, account_id=account_id, role=member.role)
    cursor.touched_everybody()
    return out


@router.delete("/spaces/{space_id}/members/{account_id}", status_code=204,
               summary="Take a member out, or leave (managers, or oneself)")
def remove_member(space_id: str, account_id: int, found: Who) -> Response:
    with cursor.WRITE_LOCK, SessionLocal() as db:
        space = db.get(Space, space_id) if records.is_uuid(space_id) else None
        own_role = spaces.role_of(db, found.id, space_id) if space is not None else None
        if space is None or own_role is None:
            raise error("not_found", "Not found.", 404)
        if account_id != found.id and own_role != MANAGER:
            raise error("forbidden", "Only a manager of this space may do this.", 403)
        if space.private:
            raise error("private_space", "Nobody leaves the space Private.", 403)
        member = db.get(Member, (space_id, account_id))
        if member is None:
            raise error("not_found", "Not found.", 404)
        if member.role == MANAGER and _last_manager(db, space_id, account_id):
            raise error("last_manager", "The space needs another manager first.", 409)
        spaces.leave(db, space, account_id, now_ms=clock.now_ms())
        db.commit()
    cursor.touched_everybody()
    logger.info("Member out space_id=%s account_id=%s by=%s", space_id, account_id, found.account.name)
    return Response(status_code=204)


#: Every address of the promise. A new one is added here; none is ever taken away (``/api/app/2`` instead).
PROMISED = (
    "/api/app/1/batch",
    "/api/app/1/changes",
    "/api/app/1/device",
    "/api/app/1/files",
    "/api/app/1/files/{attachment_id}",
    "/api/app/1/me",
    "/api/app/1/pairing/code",
    "/api/app/1/pairing/{pairing_id}/key",
    "/api/app/1/people/{account_id}/avatar",
    "/api/app/1/push",
    "/api/app/1/spaces/{space_id}/invites",
    "/api/app/1/spaces/{space_id}/invites/{invite_id}",
    "/api/app/1/spaces/{space_id}/members/{account_id}",
    "/api/app/1/wait",
    "/api/app/1/webpush",
    "/api/app/1/webpush/key",
)
