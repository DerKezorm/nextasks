"""Whom an account sees: itself and everybody it shares at least one space with. Only of those does it learn the
display name and the picture, on every way out (the web, ``/api/app/1``, ``/api/v1``, mails and reports).

Somebody named in what one sees but sharing no space any more (they made, finished or added something and left
since) shows as a former member, exactly like an account deleted since: the task keeps saying that somebody did it,
not who. The operator sees every account, but only where accounts are managed (``routers/auth.py``, the avatar of
``routers/avatars.py``), never through the tasks.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session, aliased

from ..models import Member

#: How a former member is named in text the server writes (mails, notifications, reports).
FORMER = {"de": "Ehemaliges Mitglied", "en": "Former member"}


def former(language: str) -> str:
    return FORMER.get(language, FORMER["en"])


def seen_by(db: Session, viewer_id: int) -> set[int]:
    """The account itself and every account that shares a space with it."""
    mine = select(Member.space_id).where(Member.account_id == viewer_id)
    return {viewer_id} | set(db.scalars(select(Member.account_id).where(Member.space_id.in_(mine))))


def sees(db: Session, viewer_id: int, other_id: int | None) -> bool:
    """Whether ``viewer_id`` may learn name and picture of ``other_id``."""
    if other_id is None:
        return False
    if other_id == viewer_id:
        return True
    theirs = aliased(Member)
    return db.scalar(
        select(Member.space_id)
        .join(theirs, theirs.space_id == Member.space_id)
        .where(Member.account_id == viewer_id, theirs.account_id == other_id)
        .limit(1)
    ) is not None
