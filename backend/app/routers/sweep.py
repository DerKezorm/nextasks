"""The look through ("Rückschau", web only): the open tasks that lie about (``services/stats.review``), one at a time
in the web, without those one chose to keep in the last 30 days. Keeping is per account; deferring, parking and
binning go the normal way (``/api/app/1/batch``). ``/api/app/1`` is unchanged.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Annotated, Any

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field
from sqlalchemy import delete, select

from ..deps import Account, DbSession
from ..errors import error
from ..models import SweepKeep
from ..services import clock, cursor, stats
from .focus import _seen

router = APIRouter(prefix="/api", tags=["review"])

#: How long a kept task stays out of the look through.
KEEP_DAYS = 30
#: How many candidates are read before the kept ones are taken out.
READ = 500


class KeepIn(BaseModel):
    id: Annotated[str, Field(max_length=36)]


def _kept(db: DbSession, account_id: int) -> set[str]:
    now = clock.now()
    return set(db.scalars(select(SweepKeep.reminder_id).where(SweepKeep.account_id == account_id,
                                                              SweepKeep.until > now)))


@router.get("/sweep", summary="Open tasks to look through, without those kept in the last 30 days")
def read_sweep(account: Account, db: DbSession,
               space: Annotated[str, Query(max_length=36, description="A space's id, or `all`")] = "all",
               limit: Annotated[int, Query(ge=1, le=500)] = 100) -> dict[str, Any]:
    scope = stats.scope_of(db, account.id, space)
    if scope is None:
        raise error("not_found", "Not found.", 404)
    found = stats.review(db, scope, READ)
    kept = _kept(db, account.id)
    tasks = [task for task in found["tasks"] if task["id"] not in kept]
    left_out = len(found["tasks"]) - len(tasks)
    return {**found, "total": found["total"] - left_out, "tasks": tasks[:limit], "keep_days": KEEP_DAYS}


@router.post("/sweep/keep", summary="Keeps a task out of the look through for 30 days")
def keep(body: KeepIn, account: Account, db: DbSession) -> dict[str, Any]:
    if not _seen(db, account.id, [body.id]):
        raise error("not_found", "Not found.", 404)
    now = clock.now()
    until = now + timedelta(days=KEEP_DAYS)
    with cursor.WRITE_LOCK:
        # What ran out is of no use any more.
        db.execute(delete(SweepKeep).where(SweepKeep.account_id == account.id, SweepKeep.until <= now))
        row = db.get(SweepKeep, (account.id, body.id))
        if row is None:
            db.add(SweepKeep(account_id=account.id, reminder_id=body.id, until=until))
        else:
            row.until = until
        db.commit()
    return {"id": body.id, "until": until.isoformat()}


@router.delete("/sweep/keep/{reminder_id}", summary="Lets a kept task come into the look through again")
def unkeep(reminder_id: str, account: Account, db: DbSession) -> dict[str, Any]:
    with cursor.WRITE_LOCK:
        db.execute(delete(SweepKeep).where(SweepKeep.account_id == account.id, SweepKeep.reminder_id == reminder_id))
        db.commit()
    return {"id": reminder_id}
