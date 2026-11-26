"""The history of a task for the web (``services/history.py``): what happened to it and who did it, shown between its
comments. Web only, with the session; the comments themselves travel with ``/api/app/1`` (kind ``comment``), the
history does not. Only members of the task's space see it; for anybody else the task does not exist.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from sqlalchemy import select

from ..deps import Account, DbSession
from ..errors import error
from ..models import Comment, Member, Reminder
from ..services import history, records

router = APIRouter(prefix="/api", tags=["history"])


@router.get("/reminders/{reminder_id}/history", summary="What happened to a task and who did it, oldest first")
def read_history(reminder_id: str, account: Account, db: DbSession) -> dict[str, Any]:
    task = db.get(Reminder, reminder_id) if records.is_uuid(reminder_id) else None
    if task is None or db.get(Member, (task.space_id, account.id)) is None:
        raise error("not_found", "Not found.", 404)
    events = history.read(db, account.id, task.id)
    # MCP decision 15: a comment an AI program wrote names it as a change does ("Anna (MCP · Laptop)"); the comments
    # themselves come with /api/app/1, so the web finds the way they came here, by the comment's id.
    written = db.execute(select(Comment.id, Comment.via).where(Comment.reminder_id == task.id, Comment.via != ""))
    return {"events": [{**event, "at": records.format_stamp(event["at"])} for event in events],
            "comments_via": {comment_id: via for comment_id, via in written}}
