"""Version and license (open to anybody), and whether a newer nextasks is out: the routes of the shared module
``nexupdates`` (updates 0.1.1) under ``/api/about``.

Only the operator sees the state of the check, switches it and asks now (U2, U15); a member gets the old form of the
answer with every field empty and ``hidden`` true, and never makes the server ask. The ways keep the names they had in
the description of the API before the module (E53).
"""

from __future__ import annotations

from typing import Any

from ..deps import require_account, require_operator
from ..models import OPERATOR
from ..services import updates
from ..vendor.nexupdates import api

#: The names of nextasks 0.8.0 in the description (E53).
OPERATION_IDS = {
    "about": "about_api_about_get",
    "update_state": "update_state_api_about_updates_get",
    "check_now": "check_now_api_about_updates_check_post",
    "switch": "switch_api_about_updates_put",
}
SUMMARIES = {
    "about": "About nextasks",
    "update_state": "Whether a newer nextasks is out (asked once a day)",
}

REPO_URL = updates.REPO_URL


def _is_operator(account: Any) -> bool:
    return getattr(account, "role", None) == OPERATOR


router = api.router(
    account=require_account,
    operator=require_operator,
    is_operator=_is_operator,
    prefix="/api/about",
    tags=["about"],
    operation_ids=OPERATION_IDS,
    summaries=SUMMARIES,
)
