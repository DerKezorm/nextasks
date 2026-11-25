"""Server › Mail: the routes of the shared post module (post 1.1.0) under ``/api/server/mail``, operator only: the mail
server (the password never comes back), saving it, and the test mail with nextasks' logo in the page's language. The
old ways (``/api/settings`` with ``smtp_*``, ``/api/settings/mail-test``) stay for scripts and older pages."""

from __future__ import annotations

from ..deps import DbSession, require_operator
from ..errors import error
from ..services.post_store import PostStore
from ..vendor.nexpost import api as nexpost_api


def _store(db: DbSession) -> PostStore:
    return PostStore(db)


router = nexpost_api.router(operator=require_operator, store=_store, error=error)
