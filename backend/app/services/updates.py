"""Whether a newer nextasks is out: the shared module ``nexupdates`` (updates 0.1.1) on nextasks' storage.

At most once a day the public GitHub API is asked for the newest release, and only while the operator wants it (the
switch ``update_check`` under Settings › About nextasks, asked once at setup). Nothing goes out but the question
itself: no names, no notes, no settings, no version of this server. Off means "not by itself": the button still asks.
Only an operator sees the state (U2, U15); a member gets the old form of the answer, every field empty.

nextasks has no bell, so it never looks in the background (U19): it asks when an operator opens "About".

The names of before stay in this module for whoever imported them (``parse``, ``is_newer``, ``state``, ``forget``,
``State``, ``INTERVAL``, ``RETRY``, ``MAX_ANSWER``, ``REPO``, ``REPO_URL``, ``RELEASES_URL``).
"""

from __future__ import annotations

from .. import __version__
from ..config import get_settings
from ..db import SessionLocal
from ..models import Setting
from ..vendor import nexupdates
from ..vendor.nexupdates import INTERVAL, MAX_ANSWER, RETRY, State, at_setup, forget, is_newer, parse, state
from . import settings_service

__all__ = [
    "INTERVAL", "MAX_ANSWER", "PROJECT_URL", "RELEASES_URL", "REPO", "REPO_URL", "RETRY", "State", "at_setup",
    "configure", "forget", "is_newer", "parse", "state",
]

REPO = "DerKezorm/nextasks"
REPO_URL = f"https://github.com/{REPO}"
RELEASES_URL = f"{REPO_URL}/releases"
#: The project page: none while the project pages are switched off (U18), so the page shows no line for it.
PROJECT_URL = ""
#: Where the switch is stored, as before the module.
KEY = "update_check"


def _read_switch() -> bool | None:
    """The switch as stored; None while nothing is stored (an installation from before that never switched keeps
    the default, on)."""
    with SessionLocal() as db:
        row = db.get(Setting, KEY)
        return None if row is None or row.value is None else bool(row.value)


def _write_switch(on: bool) -> None:
    with SessionLocal() as db:
        settings_service.save(db, {KEY: bool(on)})


def configure() -> nexupdates.AppConfig:
    """Tell the module who it runs in (at import of the app and again at its start)."""
    return nexupdates.configure(
        nexupdates.AppConfig(
            app_name="nextasks",
            version=lambda: __version__,
            repo=REPO,
            read_switch=_read_switch,
            write_switch=_write_switch,
            project_url=PROJECT_URL,
            update_url=lambda: get_settings().update_url,
            logger_name="nextasks.updates",
        )
    )
