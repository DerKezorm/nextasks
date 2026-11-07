"""The files of attachments: in the media folder under their SHA-256 (hex), one file for every attachment with the same
content. Written to a temporary name first, renamed when whole; removed when no attachment names the hash any more.
The backup carries the media folder (``services/backups.py``).
"""

from __future__ import annotations

import logging
import os
import re
import secrets
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import Attachment

logger = logging.getLogger("nextasks.files")

HASH = re.compile(r"^[0-9a-f]{64}$")


def root() -> Path:
    folder = get_settings().media_dir
    assert folder is not None
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def path_of(digest: str) -> Path:
    if not HASH.match(digest):
        raise ValueError("not a sha256")
    return root() / digest


def temporary() -> Path:
    """A new temporary file in the media folder (same disk, so the rename is atomic)."""
    return root() / f".upload-{secrets.token_hex(8)}"


def keep(received: Path, digest: str) -> None:
    """The received file under its hash; a file with that content there already stays as it is."""
    target = path_of(digest)
    if target.exists():
        received.unlink(missing_ok=True)
        return
    os.replace(received, target)


def forget_if_unused(db: Session, digest: str) -> None:
    """In the caller's transaction (flushed): the file goes when no attachment names it any more."""
    if db.scalar(select(Attachment.id).where(Attachment.hash == digest).limit(1)) is None:
        try:
            path_of(digest).unlink(missing_ok=True)
        except (OSError, ValueError):
            logger.warning("A file nobody uses could not be removed")


def sweep(db: Session) -> int:
    """Files no attachment names (an upload cut off, a crash between the file and its row): gone once they are an
    hour old, so that an upload on its way between the two is never touched."""
    used = set(db.scalars(select(Attachment.hash)))
    removed = 0
    for entry in root().iterdir():
        if not entry.is_file() or entry.stat().st_mtime > _hours_ago(1):
            continue
        if (HASH.match(entry.name) and entry.name not in used) or entry.name.startswith(".upload-"):
            entry.unlink(missing_ok=True)
            removed += 1
    return removed


def _hours_ago(hours: int) -> float:
    import time

    return time.time() - hours * 3600
