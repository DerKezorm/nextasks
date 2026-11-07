"""The API for programs (``/api/v1``): nexmail, nexdeck, Home Assistant, n8n, scripts. An API token in
``Authorization: Bearer``.

**The promise.** What is under ``/api/v1`` stays as it is: new fields may come, nothing is renamed or taken away. A
change that would break a program goes to ``/api/v2`` beside it. ``docs/api.md`` describes every route.

Walls, in this order: a request that carries an ``Origin`` is refused (browsers send one, programs do not; no web page
can use a token it found); API tokens must be switched on by the operator; the token must be valid (not blocked, not
run out, its account neither blocked nor deleted); the token must stay under its rate. The session cookie counts for
nothing here.

A token reads as its account, limited to its spaces (``services/apiread.py``); a token that writes changes through the
same ops as the interface and the app (``services/apiwrite.py``). Errors here are ``{"detail": {"code", "message"}}``
like in the whole nexapps family (plus ``fields``); ``middleware.ApiErrorShape`` gives the framework's own a code too.
"""

from __future__ import annotations

import base64
import binascii
import json
import logging
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict

from .. import __version__
from ..db import SessionLocal
from ..errors import error
from ..models import Space as SpaceRow
from ..services import apiread, apitokens, apiwrite, clock, logs, records, sync
from ..services.apitokens import Caller

logger = logging.getLogger("nextasks.api")

router = APIRouter(prefix="/api/v1", tags=["api v1"])

#: What this server's ``/api/v1`` offers; a program asks for a word before it uses it.
FEATURES = ["tasks", "dashboard", "external_ref"]
MAX_IDS = 200
DEFAULT_LIMIT = 100
MAX_LIMIT = 500
DASHBOARD_LIMIT = 10
DASHBOARD_MAX = 50


def _token(request: Request) -> str | None:
    header = request.headers.get("authorization", "")
    return header[7:].strip() if header[:7].lower() == "bearer " else None


def caller(request: Request) -> Caller:
    if request.headers.get("origin"):
        raise error("origin_refused", "The API is for programs, not web pages.", 403)
    with SessionLocal() as db:
        if not apitokens.allowed(db):
            raise error("api_off", "The operator has not switched API tokens on.", 401)
        found = apitokens.authenticate(db, _token(request))
    if found is None:
        raise error("token_invalid", "No valid API token.", 401)
    if not apitokens.brake(found.token_id):
        exc = error("slow_down", "Too many requests with this token. Wait a minute.", 429)
        exc.headers = {"Retry-After": "60"}
        raise exc
    logs.set_actor(found.account.name)
    return found


def writer(found: Annotated[Caller, Depends(caller)]) -> Caller:
    if not found.writes:
        raise error("token_reads_only", "This token reads only. Make one that writes for changes.", 403)
    return found


Reader = Annotated[Caller, Depends(caller)]
Writer = Annotated[Caller, Depends(writer)]


def _sync_caller(found: Caller) -> sync.Caller:
    """The token as a sender of ops (``services/sync.py``)."""
    return sync.Caller(account=found.account, key=f"t:{found.token_id}")


def _refused(exc: apiwrite.Refused) -> Exception:
    values = {"fields": exc.fields} if exc.fields is not None else {}
    return error(exc.code, exc.text, exc.status, **values)


def _not_found() -> Exception:
    return error("not_found", "Not found.", 404)


# --- Models (for the description under /api/docs) -------------------------------------------------------------------


class Problem(BaseModel):
    error: str
    message: str
    fields: list[str] | None = None


class SpaceBrief(BaseModel):
    id: str
    name: str


class MeOut(BaseModel):
    name: str
    display_name: str
    #: ``read`` or ``write``.
    level: str
    #: IANA name: the days of ``today`` and the due dates are this zone's.
    time_zone: str
    spaces: list[SpaceBrief]
    version: str
    features: list[str]


class SpaceOut(BaseModel):
    id: str
    name: str
    icon: str
    #: ``admin`` (manages the space) or ``member``.
    role: str
    writable: bool
    #: Not the account's own "Private": tasks may be assigned to its members.
    shared: bool
    #: The account hid the space for itself; a program decides whether to show it.
    hidden: bool


class SpacesOut(BaseModel):
    spaces: list[SpaceOut]


class SectionOut(BaseModel):
    id: str
    name: str


class ListOut(BaseModel):
    id: str
    space_id: str
    space_name: str
    name: str
    color: str
    icon: str
    writable: bool
    #: Its space is hidden by the account.
    hidden: bool
    sections: list[SectionOut]
    #: Open top-level tasks outside the bin.
    open: int


class ListsOut(BaseModel):
    lists: list[ListOut]


class Person(BaseModel):
    id: int
    #: Null for an account deleted since.
    name: str | None = None
    display_name: str | None = None


class SubtasksOut(BaseModel):
    open: int
    total: int
    #: Only in ``GET /tasks/{id}``.
    items: list[TaskOut] | None = None


class TaskOut(BaseModel):
    id: str
    list_id: str
    section_id: str | None = None
    parent_id: str | None = None
    title: str
    #: Markdown as the interface writes it.
    notes: str
    #: The same as plain text.
    notes_text: str
    url: str | None = None
    due_date: str | None = None
    due_time: str | None = None
    repeat: str | None = None
    flagged: bool
    #: 0 none, 1 low, 2 medium, 3 high.
    priority: int
    tags: list[str]
    assignees: list[Person]
    completed: bool
    completed_at: str | None = None
    completed_by: Person | None = None
    trashed: bool
    trashed_at: str | None = None
    subtasks: SubtasksOut
    #: The program's own key; only the account that set it sees it.
    external_ref: str | None = None
    created_at: str
    updated_at: str
    #: Opens the task in the web interface; null without the operator's public address.
    link: str | None = None


SubtasksOut.model_rebuild()
TaskOut.model_rebuild()


class GoneOut(BaseModel):
    id: str
    gone: bool = True


class TasksOut(BaseModel):
    tasks: list[TaskOut | GoneOut]
    next_cursor: str | None = None
    #: The server's time when it read: the ``updated_since`` of the next call.
    as_of: str


class ChangedOut(TaskOut):
    #: After ticking off a repeating task: the id of the open occurrence (the task keeps its id and moves on).
    next: str | None = None
    #: After ticking off a repeating task: the id of the completed copy of the occurrence ticked off.
    completed_copy: str | None = None


class TaskIn(BaseModel):
    """A new task; only ``title`` is needed."""

    model_config = ConfigDict(extra="forbid")
    title: Any = None
    list_id: Any = None
    section_id: Any = None
    parent_id: Any = None
    notes: Any = None
    url: Any = None
    due_date: Any = None
    due_time: Any = None
    priority: Any = None
    flagged: Any = None
    tags: Any = None
    assignees: Any = None
    external_ref: Any = None


class TaskChange(BaseModel):
    """Any of these; ``null`` clears a field."""

    model_config = ConfigDict(extra="forbid")
    title: Any = None
    notes: Any = None
    url: Any = None
    due_date: Any = None
    due_time: Any = None
    priority: Any = None
    flagged: Any = None
    tags: Any = None
    assignees: Any = None
    list_id: Any = None
    section_id: Any = None
    completed: Any = None
    trashed: Any = None


class CountsOut(BaseModel):
    overdue: int
    today: int
    upcoming: int
    assigned_to_me: int
    flagged: int
    open: int


class DashboardOut(BaseModel):
    counts: CountsOut
    overdue: list[TaskOut]
    today: list[TaskOut]
    upcoming: list[TaskOut]
    link: str | None = None
    time_zone: str
    as_of: str


ERRORS: dict[int | str, dict[str, Any]] = {status: {"model": Problem} for status in (401, 403, 404, 422, 429)}
WRITE_ERRORS: dict[int | str, dict[str, Any]] = {**ERRORS, 409: {"model": Problem}}


# --- Who am I ------------------------------------------------------------------------------------------------------


@router.get("/me", response_model=MeOut, responses=ERRORS, summary="Who the token speaks for, and what it may")
def me(found: Reader) -> MeOut:
    with SessionLocal() as db:
        sight = apiread.sight_of(db, found.account)
        rows = [db.get(SpaceRow, space_id) for space_id in sight.space_ids]
    spaces = sorted((row for row in rows if row is not None and row.deleted_at is None),
                    key=lambda row: row.name.casefold())
    return MeOut(name=found.account.name, display_name=found.account.display_name or found.account.name,
                 level=found.level, time_zone=sight.zone_name,
                 spaces=[SpaceBrief(id=row.id, name=row.name) for row in spaces], version=__version__,
                 features=FEATURES)


# --- Spaces and lists -----------------------------------------------------------------------------------------------


@router.get("/spaces", response_model=SpacesOut, responses=ERRORS, summary="The spaces the token sees, by name")
def get_spaces(found: Reader) -> SpacesOut:
    with SessionLocal() as db:
        sight = apiread.sight_of(db, found.account)
        world = apiread.World.read(db, sight)
    shown = sorted((row for row in world.spaces.values() if row.deleted_at is None),
                   key=lambda row: (row.name.casefold(), row.id))
    return SpacesOut(spaces=[
        SpaceOut(id=row.id, name=row.name, icon=row.icon,
                 role="admin" if sight.roles.get(row.id) == "manager" else "member", writable=True,
                 shared=not row.private, hidden=row.id in sight.hidden)
        for row in shown
    ])


@router.get("/lists", response_model=ListsOut, responses=ERRORS,
            summary="The lists the token sees, in the order of the interface")
def get_lists(found: Reader, space_id: Annotated[str | None, Query(max_length=36)] = None) -> ListsOut:
    with SessionLocal() as db:
        sight = apiread.sight_of(db, found.account)
        world = apiread.World.read(db, sight)
    if space_id is not None and (space_id not in world.spaces or world.spaces[space_id].deleted_at is not None):
        raise _not_found()
    # As the sidebar: hidden spaces at the end, below "Hidden spaces".
    ordered = sorted((space for space in world.spaces.values() if space.deleted_at is None),
                     key=lambda space: (space.id in sight.hidden, world.space_order.get(space.id, 9999)))
    out: list[ListOut] = []
    for space in ordered:
        if space_id is not None and space.id != space_id:
            continue
        for row in world.lists_of(space.id):
            open_count = sum(1 for task in world.tasks.values()
                             if task.list_id == row.id and task.parent_id is None and task.open
                             and task.trashed_at is None)
            out.append(ListOut(id=row.id, space_id=space.id, space_name=space.name, name=row.name, color=row.color,
                               icon=row.icon, writable=True, hidden=space.id in sight.hidden,
                               sections=[SectionOut(id=section.id, name=section.name)
                                         for section in world.sections_of(row.id)],
                               open=open_count))
    return ListsOut(lists=out)


# --- Tasks ----------------------------------------------------------------------------------------------------------


def _page_cursor(text: str | None) -> int:
    if text is None:
        return 0
    try:
        offset = json.loads(base64.urlsafe_b64decode(text.encode() + b"==").decode())["o"]
    except (ValueError, KeyError, TypeError, binascii.Error, UnicodeDecodeError) as exc:
        raise error("invalid_input", "The input is not valid.", 422, fields=["cursor"]) from exc
    if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0:
        raise error("invalid_input", "The input is not valid.", 422, fields=["cursor"])
    return offset


def _next_cursor(offset: int) -> str:
    return base64.urlsafe_b64encode(json.dumps({"o": offset}).encode()).decode().rstrip("=")


def _day(value: str | None, name: str, bad: list[str]) -> str | None:
    if value is None:
        return None
    try:
        return records.day(value)
    except ValueError:
        bad.append(name)
        return None


def _moment(value: str | None, bad: list[str]) -> datetime | None:
    if value is None:
        return None
    try:
        # A "+" in an address arrives as a blank when nobody encoded it.
        moment = datetime.fromisoformat(value.strip().replace("Z", "+00:00").replace(" ", "+"))
    except ValueError:
        bad.append("updated_since")
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


@router.get("/tasks", response_model=TasksOut, responses=ERRORS,
            summary="Tasks, filtered; ids, external_ref and updated_since keep a program in step")
def get_tasks(
    found: Reader,
    list_id: Annotated[str | None, Query(max_length=36)] = None,
    space_id: Annotated[str | None, Query(max_length=36)] = None,
    state: Annotated[str | None, Query(pattern="^(open|completed|all)$")] = None,
    include_trashed: bool | None = None,
    due: Annotated[str | None, Query(pattern="^(overdue|today|upcoming|none)$")] = None,
    due_before: Annotated[str | None, Query(max_length=10)] = None,
    due_after: Annotated[str | None, Query(max_length=10)] = None,
    assigned: Annotated[str | None, Query(max_length=12)] = None,
    flagged: bool | None = None,
    ids: Annotated[str | None, Query(max_length=MAX_IDS * 37)] = None,
    external_ref: Annotated[str | None, Query(min_length=1, max_length=200)] = None,
    updated_since: Annotated[str | None, Query(max_length=40)] = None,
    subtasks: bool = False,
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT,
    cursor: Annotated[str | None, Query(max_length=100)] = None,
) -> JSONResponse:
    as_of = records.format_stamp(clock.now())
    bad: list[str] = []
    wanted_ids: list[str] | None = None
    if ids is not None:
        wanted_ids = []
        for part in ids.split(","):
            part = part.strip().lower()
            if not part:
                continue
            if not records.is_uuid(part):
                bad.append("ids")
                break
            if part not in wanted_ids:
                wanted_ids.append(part)
        if len(wanted_ids) > MAX_IDS:
            bad.append("ids")
    who: int | None = None
    if assigned is not None:
        if assigned == "me":
            who = found.account.id
        elif assigned.isdigit():
            who = int(assigned)
        else:
            bad.append("assigned")
    query = apiread.Query(
        list_id=list_id, space_id=space_id, state=state, include_trashed=include_trashed, due=due,
        due_before=_day(due_before, "due_before", bad), due_after=_day(due_after, "due_after", bad), assigned=who,
        flagged=flagged, ids=wanted_ids, external_ref=external_ref, updated_since=_moment(updated_since, bad),
        subtasks=subtasks,
    )
    offset = _page_cursor(cursor)
    if bad:
        raise error("invalid_input", "The input is not valid.", 422, fields=sorted(set(bad)))
    with SessionLocal() as db:
        sight = apiread.sight_of(db, found.account)
        world = apiread.World.read(db, sight)
        if list_id is not None and list_id not in world.lists:
            raise _not_found()
        if space_id is not None and space_id not in world.spaces:
            raise _not_found()
        tasks, gone = apiread.select_tasks(world, query)
        everything: list[Any] = [*tasks, *gone]
        page = everything[offset:offset + limit]
        out = [world.out(item) if isinstance(item, apiread.Task) else {"id": item, "gone": True} for item in page]
    more = offset + limit < len(everything)
    return JSONResponse({"tasks": out, "next_cursor": _next_cursor(offset + limit) if more else None,
                         "as_of": as_of})


def _one(found: Caller, task_id: str, *, items: bool = True) -> dict[str, Any]:
    with SessionLocal() as db:
        world = apiread.World.read(db, apiread.sight_of(db, found.account))
        task = world.tasks.get(task_id)
        if task is None:
            raise _not_found()
        return world.out(task, items=items)


@router.get("/tasks/{task_id}", response_model=TaskOut, responses=ERRORS, summary="One task, its subtasks listed")
def get_task(task_id: str, found: Reader) -> JSONResponse:
    return JSONResponse(_one(found, task_id.lower()))


@router.post("/tasks", response_model=TaskOut, status_code=201, responses={**WRITE_ERRORS, 200: {"model": TaskOut}},
             summary="Make a task; with external_ref safe to repeat (200 with the task made before)")
def make_task(body: TaskIn, found: Writer) -> JSONResponse:
    try:
        fields = apiwrite.clean(body.model_dump(exclude_unset=True))
        with SessionLocal() as db:
            sight = apiread.sight_of(db, found.account)
            default = apiread.World.read(db, sight).default_list()
        done = apiwrite.create(_sync_caller(found), sight, fields, default.id if default is not None else None)
    except apiwrite.Refused as exc:
        raise _refused(exc) from exc
    if done.created:
        logger.info("API task made token_id=%s", found.token_id)
    return JSONResponse(_one(found, done.task_id, items=False), status_code=201 if done.created else 200)


@router.patch("/tasks/{task_id}", response_model=ChangedOut, responses=WRITE_ERRORS,
              summary="Change, tick off, reopen or restore a task")
def change_task(task_id: str, body: TaskChange, found: Writer) -> JSONResponse:
    try:
        fields = apiwrite.clean(body.model_dump(exclude_unset=True))
        with SessionLocal() as db:
            sight = apiread.sight_of(db, found.account)
        done = apiwrite.change_task(_sync_caller(found), sight, task_id.lower(), fields)
    except apiwrite.Refused as exc:
        raise _refused(exc) from exc
    out = _one(found, done.task_id, items=False)
    if done.next_id:
        out["next"] = done.next_id
        out["completed_copy"] = done.copy_id
    return JSONResponse(out)


@router.delete("/tasks/{task_id}", status_code=204, responses=WRITE_ERRORS,
               summary="Move a task, with its subtasks, to the bin")
def trash_task(task_id: str, found: Writer) -> Response:
    try:
        with SessionLocal() as db:
            sight = apiread.sight_of(db, found.account)
        apiwrite.trash(_sync_caller(found), sight, task_id.lower())
    except apiwrite.Refused as exc:
        raise _refused(exc) from exc
    return Response(status_code=204)


# --- Dashboard ------------------------------------------------------------------------------------------------------


@router.get("/dashboard", response_model=DashboardOut, responses=ERRORS,
            summary="The numbers and the soonest tasks for a dashboard card")
def dashboard(found: Reader, limit: Annotated[int, Query(ge=1, le=DASHBOARD_MAX)] = DASHBOARD_LIMIT) -> JSONResponse:
    with SessionLocal() as db:
        world = apiread.World.read(db, apiread.sight_of(db, found.account))
        return JSONResponse(apiread.dashboard(world, limit))
