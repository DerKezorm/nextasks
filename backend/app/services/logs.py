"""Logging, from the shared module ``log`` (``app/vendor/nexlog``, bauplaene/log 1.0.0).

nextasks writes its log to ``data/logs/nextasks.log``. The file rolls over at a size limit, three older files are kept,
and files older than 14 days are deleted. Four levels (``quiet``, ``normal``, ``detailed``, ``trace``); the two deep
ones switch themselves off; ``NEXTASKS_LOG_LEVEL`` overrides the stored level. All of it lives in the module now; this
file only tells it what is nextasks' own and keeps the names every caller used (``from app.services import logs``).

Messages are English on purpose: log lines end up in bug reports and web searches. ``tests/test_log_language.py``
keeps that rule.

⚠️ What never goes into the log, at any level: the content of a task, a note or an attachment, search terms,
passwords, tokens, keys, session identifiers. Paths, sizes, counts, accounts and results do.
``tests/test_log_secrets.py`` scans the code for the obvious mistakes; the module's blacking out is the net below that
rule.
"""

from __future__ import annotations

from pathlib import Path

from .. import private
from ..config import get_settings
from ..vendor import nexlog

# The names of the module, as nextasks' callers know them.
from ..vendor.nexlog import *

#: The keys nextasks' log blacked out before the module (a calendar subscription's key travels in its address, the
#: API tokens), and the prefixes of the other tokens of nextasks (devices of the iPhone app, the link that confirms an
#: address; MCP keys and a program's refresh token and code, mcp 1.1.0; the tokens of a connection with another nex
#: app, verbinden 0.1.1): what follows them never reaches the log.
KEY_PREFIXES = ("nxa_", "nxc_", "nxl_", "nxr_", "ntk_", "ntd_", "nxm_", "ntm_", "ntmr_", "ntmc_", "ntc_", "ntcr_",
                "ntco_")
#: Path segments followed by a token that are nextasks' own (the common ones come with the module).
TOKEN_PATHS = ("calendar", "unsubscribe", "notify/unsubscribe")


def configure(log_dir: Path | None = None) -> None:
    """What the module needs of nextasks: its name, folder, environment variable and rules. Done once on import, so
    every caller (the start, the tests) finds it configured. ``log_dir``: another folder (the contract tests)."""
    nexlog.configure(
        nexlog.AppConfig(
            app_name="nextasks",
            log_dir=log_dir if log_dir is not None else (lambda: get_settings().data_dir / "logs"),
            env_level=lambda: get_settings().log_level or "",
            key_prefixes=KEY_PREFIXES,
            token_paths=TOKEN_PATHS,
            tighten=private.tighten,
        )
    )


configure()
