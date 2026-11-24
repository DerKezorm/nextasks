"""The focus of the day ("Fokus für heute", web only): up to three tasks one picked for today. Kept per account and
day (the account's day, in its time zone); the next day it reads as empty. Only tasks the account sees count: in a
space it is a member of, not in the bin. Nobody else sees it, and ``/api/app/1`` is unchanged.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..deps import Account, DbSession
from ..errors import error
from ..models import Focus, Member, Reminder, Space, TaskList, utcnow
from ..services import clock, cursor

router = APIRouter(prefix="/api", tags=["focus"])

#: The most tasks one can hold in focus.
MOST = 3


class FocusIn(BaseModel):
    ids: Annotated[list[Annotated[str, Field(max_length=36)]], Field(max_length=MOST)]


def _today(account: Any) -> str:
    return clock.now().astimezone(clock.zone_of(account.timezone)).date().isoformat()


def _seen(db: Session, account_id: int, ids: list[str]) -> list[str]:
    """Of ``ids``, in their order and each once, those the account sees: its spaces, nothing in the bin."""
    wanted = list(dict.fromkeys(ids))
    if not wanted:
        return []
    found = db.execute(
        select(Reminder.id, Reminder.parent_id)
        .join(TaskList, TaskList.id == Reminder.list_id)
        .join(Space, Space.id == Reminder.space_id)
        .join(Member, (Member.space_id == Reminder.space_id) & (Member.account_id == account_id))
        .where(Reminder.id.in_(wanted), Reminder.deleted_at.is_(None), TaskList.deleted_at.is_(None),
               Space.deleted_at.is_(None))
    ).all()
    parents = {parent for _id, parent in found if parent}
    gone = set(db.scalars(select(Reminder.id).where(Reminder.id.in_(parents), Reminder.deleted_at.is_not(None))))
    kept = {item for item, parent in found if parent not in gone}
    return [item for item in wanted if item in kept]


def _answer(day: str, ids: list[str]) -> dict[str, Any]:
    return {"date": day, "ids": ids, "most": MOST}


@router.get("/focus", summary="The own focus of today: up to three task ids, in order")
def read_focus(account: Account, db: DbSession) -> dict[str, Any]:
    day = _today(account)
    row = db.get(Focus, account.id)
    if row is None or row.day != day:
        return _answer(day, [])
    return _answer(day, _seen(db, account.id, list(row.reminder_ids or [])))


@router.put("/focus", summary="Sets the own focus of today (up to three task ids, in order)")
def write_focus(body: FocusIn, account: Account, db: DbSession) -> dict[str, Any]:
    day = _today(account)
    ids = _seen(db, account.id, body.ids)
    if len(ids) != len(dict.fromkeys(body.ids)):
        raise error("not_found", "Not found.", 404)
    with cursor.WRITE_LOCK:
        row = db.get(Focus, account.id)
        if row is None:
            db.add(Focus(account_id=account.id, day=day, reminder_ids=ids, updated_at=utcnow()))
        else:
            row.day = day
            row.reminder_ids = ids
            row.updated_at = utcnow()
        db.commit()
    return _answer(day, ids)
