"""The review in the web only ("Rückblick", the right column of "Today", "Oft gekauft", the look through what lies
about): numbers from the record of completions (``services/stats.py``). Every route reads, as the signed-in account,
only from the spaces it is a member of. The iPhone app does not use them (``/api/app/1`` is unchanged).
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from fastapi import APIRouter, Query

from ..deps import Account, DbSession
from ..errors import error
from ..services import clock, stats

router = APIRouter(prefix="/api", tags=["review"])

SpaceParam = Annotated[str, Query(max_length=36, description="A space's id, or `all`")]


def _scope(db: DbSession, account: Any, space: str) -> stats.Scope:
    found = stats.scope_of(db, account.id, space)
    if found is None:
        raise error("not_found", "Not found.", 404)
    return found


@router.get("/stats", summary="The review: what was done, when, by whom, in a period (week, month, year)")
def read_stats(
    account: Account,
    db: DbSession,
    space: SpaceParam = "all",
    period: Annotated[Literal["week", "month", "year"], Query(alias="range")] = "week",
    year: Annotated[int | None, Query(ge=2000, le=9999, description="A calendar year (with range=year)")] = None,
) -> dict[str, Any]:
    if year is not None and (period != "year" or year > clock.today().year + 1):
        raise error("invalid_input", "The input is not valid.", 422, fields=["year"])
    return stats.page(db, _scope(db, account, space), period, year)


@router.get("/review", summary="Open tasks for a look through: unchanged for long or overdue, the oldest first")
def read_review(account: Account, db: DbSession, space: SpaceParam = "all",
                limit: Annotated[int, Query(ge=1, le=500)] = 100) -> dict[str, Any]:
    return stats.review(db, _scope(db, account, space), limit)


@router.get("/lists/{list_id}/suggestions", summary="Often done in this list and not open now; known titles' sections")
def read_suggestions(list_id: str, account: Account, db: DbSession,
                     limit: Annotated[int, Query(ge=1, le=50)] = 12) -> dict[str, Any]:
    found = stats.suggestions(db, account.id, list_id, limit)
    if found is None:
        raise error("not_found", "Not found.", 404)
    return found
