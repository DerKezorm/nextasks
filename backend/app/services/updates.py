"""Whether a newer nextasks is out: the shared module ``nexupdates`` (updates 0.1.3) on nextasks' storage.

At most once a day the public GitHub API is asked for the newest release, and only while the operator wants it (the
switch ``update_check`` under Settings › About nextasks, asked once at setup). Nothing goes out but the question
itself: no names, no notes, no settings, no version of this server. Off means "not by itself": the button still asks.
Only an operator sees the state (U2, U15); a member gets the old form of the answer, every field empty.

nextasks has no bell (``on_newer`` None). The operators' iPhones and iPads hear of a newer version once (U24, G56):
while a device of an operator understands and wants ``update`` (``devices_want`` → ``devices.update_wanted``), the
background (``run_forever`` in ``main.py``, a look an hour) asks at most once a day, and only while the switch is on;
``on_devices`` → ``devices.announce`` tells them. Without such a device the background asks nothing (U19): the question
goes out when an operator opens "About".

The names of before stay in this module for whoever imported them (``parse``, ``is_newer``, ``state``, ``forget``,
``State``, ``INTERVAL``, ``RETRY``, ``MAX_ANSWER``, ``REPO``, ``REPO_URL``, ``RELEASES_URL``).
"""

from __future__ import annotations

from .. import __version__
from ..config import get_settings
from ..db import SessionLocal
from ..models import Setting
from ..vendor import nexupdates
from ..vendor.nexupdates import (
    INTERVAL,
    MAX_ANSWER,
    RETRY,
    State,
    at_setup,
    forget,
    is_newer,
    look_once,
    parse,
    run_forever,
    state,
)
from . import settings_service

__all__ = [
    "INTERVAL", "MAX_ANSWER", "PROJECT_URL", "RELEASES_URL", "REPO", "REPO_URL", "RETRY", "State", "at_setup",
    "configure", "forget", "is_newer", "look_once", "parse", "run_forever", "state",
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


#: The version the operators' devices were last told about (``on_devices``), so nobody hears of one twice.
TOLD = "update_told"


def _read_told() -> str | None:
    with SessionLocal() as db:
        row = db.get(Setting, TOLD)
        return str(row.value) if row is not None and row.value else None


def _write_told(version: str) -> None:
    with SessionLocal() as db:
        settings_service.save(db, {TOLD: version})


def _devices_want() -> bool:
    from . import devices

    return devices.update_wanted()


def _on_devices(version: str) -> None:
    from . import devices

    devices.announce(version)


def configure() -> nexupdates.AppConfig:
    """Tell the module who it runs in (at import of the app and again at its start)."""
    return nexupdates.configure(
        nexupdates.AppConfig(
            app_name="nextasks",
            version=lambda: __version__,
            repo=REPO,
            read_switch=_read_switch,
            write_switch=_write_switch,
            read_told=_read_told,
            write_told=_write_told,
            on_newer=None,
            devices_want=_devices_want,
            on_devices=_on_devices,
            project_url=PROJECT_URL,
            update_url=lambda: get_settings().update_url,
            logger_name="nextasks.updates",
        )
    )
