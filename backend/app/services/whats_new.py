""""What's new" through the shared module ``nexwasneu`` (wasneu 0.1.0): the texts per version and language lie in
``app/whatsnew/`` (``de.json``, ``en.json``, ``released.json`` with the frozen ones), the account keeps the version it
read in ``whats_new_seen``. The module's routes are ``/api/whats-new``; the route of before, ``POST
/api/me/whats-new/seen``, stays and calls ``nexwasneu.mark_seen``.

Configured at import: a new account (setup, invitation, sign-in provider) starts on the running version
(``seen_for_new_account``) even before the app's start ran."""

from __future__ import annotations

from pathlib import Path

from sqlalchemy.orm import Session

from .. import __version__
from ..models import OPERATOR, Account
from ..vendor import nexwasneu

#: Where the texts lie: inside the package ``app``, so the image carries them.
FOLDER = Path(__file__).resolve().parents[1] / "whatsnew"


def configure() -> nexwasneu.AppConfig:
    return nexwasneu.configure(
        nexwasneu.AppConfig(app_name="nextasks", version=lambda: __version__, folder=FOLDER, languages=("de", "en"))
    )


def seen_for_new_account() -> str:
    """What a new account starts with: the running version, so a fresh account is not greeted with news."""
    return nexwasneu.seen_for_new_account()


def viewer_of(db: Session, account: Account) -> nexwasneu.Viewer:
    """The signed-in account as the module needs it; ``mark`` writes the version into its row and saves."""
    account_id = account.id

    def mark(version: str) -> None:
        row = db.get(Account, account_id)
        if row is not None:
            row.whats_new_seen = version
            db.commit()

    return nexwasneu.Viewer(
        seen=account.whats_new_seen or "",
        operator=account.role == OPERATOR,
        mark=mark,
        language=account.language or None,
    )


configure()
