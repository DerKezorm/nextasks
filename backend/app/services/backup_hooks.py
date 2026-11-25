"""What goes into a backup of nextasks and how it comes back: the hooks of the shared module ``sicherung``
(``app/vendor/nexsicherung``, bauplaene/sicherung 1.0.1). The module runs everything around them (names, list,
schedule, keeping, upload, download, the copy before a restore, staging and the start).

The archive keeps nextasks' format, so every backup made before the module stays readable and restorable:

* ``nextasks-backup.json`` (the manifest, written last), ``database/nextasks.db`` (through SQLite's backup API, never
  as a file: it runs in WAL mode), ``secret.key``, and every media file under ``media/`` (named by its SHA-256);
* the manifest lists every media file with its size and sha256, so the check before a restore tells a damaged archive
  from a good one and says what a restore would change in the media folder;
* a restore swaps the media folder as a whole, then the database and the key, ends every session and moves the change
  counter on past everything handed out before (every older cursor answers 410 ``cursor_expired``).

The archive is not encrypted: it lies in the data folder next to the database it copies. Downloading it asks for the
operator's password once more (the module).
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import sqlite3
import time
import zipfile
from pathlib import Path
from typing import Any

from .. import private
from ..config import get_settings
from ..vendor import nexsicherung
from ..vendor.nexsicherung import Checked, Described, Schedule, tools
from ..vendor.nexsicherung.errors import BackupError
from . import settings_service

logger = logging.getLogger("nextasks.backups")

MANIFEST = "nextasks-backup.json"
DATABASE_ENTRY = "database/nextasks.db"
MEDIA_PREFIX = "media/"
#: The key the server encrypts its own secrets with (OIDC client secret, mail password): without it a restore on
#: another machine would bring those back unreadable. Whoever holds a backup holds the database anyway.
SECRET_ENTRY = "secret.key"
#: The files of attachments are named by their SHA-256 (``services/files.py``). Nothing else is packed or unpacked.
MEDIA_NAME = re.compile(r"^[0-9a-f]{64}$")
#: Limits of what a check or a restore unpacks: the database and each media file (the size in an archive may lie).
DATABASE_MAX = 64 * 1024**3
MEMBER_MAX = 64 * 1024**3
#: The first broken members a check names, as before the module.
DAMAGED_SHOWN = 20

#: The schedule as nextasks kept it before the module (``backup_schedule``, ``backup_keep``; their defaults in
#: ``settings_service.DEFAULTS``), with the time of day the module adds (``backup_time``): the night's hours nextasks
#: used before (3 to 6) begin at 03:00.
DEFAULT_EVERY = "daily"
DEFAULT_TIME = "03:00"
DEFAULT_KEEP = 7

#: What a damaged member raises while it unpacks (zlib's own error for a flipped byte in a deflated member among them).
DAMAGE = tools.DAMAGE


def media_root() -> Path:
    path = get_settings().media_dir
    assert path is not None
    return path


def media_files(root: Path) -> list[tuple[str, Path]]:
    """Every media file, by name; nothing else that may lie there (temporary files of an upload, links)."""
    if not root.is_dir():
        return []
    return sorted(
        (entry.name, entry) for entry in root.iterdir()
        if MEDIA_NAME.match(entry.name) and entry.is_file() and not entry.is_symlink()
    )


def _manifest(archive: zipfile.ZipFile) -> dict[str, Any]:
    try:
        raw = json.loads(tools.read_small(archive, MANIFEST, limit=64 * 1024 * 1024).decode("utf-8"))
    except (KeyError, ValueError, *DAMAGE) as exc:
        raise BackupError("backup_invalid", "the archive has no readable manifest") from exc
    if not isinstance(raw, dict) or not isinstance(raw.get("media", {}), dict):
        raise BackupError("backup_invalid", "the manifest has the wrong shape")
    return raw


def _count_tasks(database: Path) -> int:
    """How many reminders a database copy holds (not in the bin), as the manifest named them before."""
    connection = sqlite3.connect(database)
    try:
        row = connection.execute("SELECT count(*) FROM reminders WHERE deleted_at IS NULL").fetchone()
        return int(row[0])
    except sqlite3.DatabaseError:
        return 0
    finally:
        connection.close()


def write_archive(target: Path, manifest: dict[str, Any]) -> dict[str, Any]:
    """The archive as nextasks made it before the module and as ``pack`` makes it now: the database through the backup
    API, the key, every media file with its size and hash, the manifest last (an archive without it is recognisably
    incomplete). Returns the manifest written."""
    settings = get_settings()
    database = target.with_name(target.name + ".db")
    try:
        private.new_file(database)
        tools.copy_database(settings.database_path, database)
        manifest = {**manifest, "tasks": _count_tasks(database), "files": 0, "bytes": 0, "media": {}}
        with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            archive.write(database, DATABASE_ENTRY)
            key = settings.data_dir / "secret.key"
            if key.is_file():
                archive.write(key, SECRET_ENTRY)
            for rel, full in media_files(media_root()):
                try:
                    size = full.stat().st_size
                    # Photos and PDFs are packed already; deflating them again only costs time.
                    archive.write(full, MEDIA_PREFIX + rel, compress_type=zipfile.ZIP_STORED)
                    manifest["media"][rel] = [size, tools.sha256_file(full)]
                except OSError as exc:
                    logger.warning("A file could not be backed up and was left out: %s", exc.strerror)
                    continue
                manifest["files"] += 1
                manifest["bytes"] += size
            archive.writestr(MANIFEST, json.dumps(manifest, ensure_ascii=False))
    finally:
        database.unlink(missing_ok=True)
    logger.info("Backup made kind=%s tasks=%s files=%s bytes=%s", manifest.get("kind"), manifest["tasks"],
                manifest["files"], manifest["bytes"])
    return manifest


# --- After a restore ------------------------------------------------------------------------------------------------


def end_restored_sessions(database: Path) -> None:
    """Sign-ins stored in the backup would come back to life, even ones ended since: everybody signs in anew."""
    connection = sqlite3.connect(database)
    try:
        if connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='auth_sessions'").fetchone():
            connection.execute("DELETE FROM auth_sessions")
            connection.commit()
    finally:
        connection.close()


def counter_of(database: Path) -> int:
    """The newest cursor a database handed out (``sync_state.last``); 0 for none or an older layout."""
    if not database.is_file():
        return 0
    connection = sqlite3.connect(database)
    try:
        if not connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sync_state'").fetchone():
            return 0
        row = connection.execute("SELECT last FROM sync_state WHERE id = 1").fetchone()
        return int(row[0]) if row else 0
    finally:
        connection.close()


def continue_counter(database: Path, before: int) -> None:
    """After a restore the change counter goes on past everything handed out before it, and every older cursor is
    expired (410 ``cursor_expired``).

    Without this the restored counter would hand out again numbers devices already hold for changes the backup does
    not know: ``/changes`` would answer such a device with nothing, and what it had would stay with it for ever.
    Pages handed out with ``more: true`` belong to the old state and go too."""
    restored = counter_of(database)
    fresh = max(restored, before) + 1
    connection = sqlite3.connect(database)
    try:
        if not connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sync_state'").fetchone():
            return
        connection.execute(
            "INSERT INTO sync_state (id, last, oldest) VALUES (1, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET last = excluded.last, oldest = excluded.oldest",
            (fresh, fresh),
        )
        if connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='page_cursors'").fetchone():
            connection.execute("DELETE FROM page_cursors")
        connection.commit()
    finally:
        connection.close()


class NextasksHooks(nexsicherung.AppHooks):
    # --- What goes in

    def pack(self, target: Path, *, kind: str, note: str, created: str) -> None:
        from .. import __version__

        write_archive(target, {"version": __version__, "created": created, "kind": kind, "note": note})

    def describe(self, path: Path) -> Described:
        try:
            with zipfile.ZipFile(path) as archive:
                manifest = _manifest(archive)
                if DATABASE_ENTRY not in archive.namelist():
                    raise BackupError("backup_invalid", "the archive holds no database")
        except zipfile.BadZipFile as exc:
            raise BackupError("backup_invalid", "not a ZIP archive") from exc
        return Described(
            created=str(manifest.get("created") or "") or None, kind=str(manifest.get("kind") or "manual"),
            note=str(manifest.get("note") or ""), version=str(manifest.get("version") or ""),
            facts={"tasks": int(manifest.get("tasks") or 0), "files": int(manifest.get("files") or 0)},
        )

    def check(self, path: Path, *, viewer: Any = None, archive_password: str | None = None) -> Checked:
        """The trial run: is the archive whole, and what would a restore change in the media folder? It names no
        task: the operator sees counts, never what others wrote."""
        scratch = nexsicherung.archives.scratch("check")
        try:
            with zipfile.ZipFile(path) as archive:
                manifest = _manifest(archive)
                media: dict[str, list[Any]] = manifest.get("media", {})
                members = {info.filename: info for info in archive.infolist()}
                try:
                    database_ok = DATABASE_ENTRY in members and tools.read_database(
                        archive, DATABASE_ENTRY, scratch, limit=DATABASE_MAX)
                except (BackupError, *DAMAGE):
                    database_ok = False
                if not database_ok:
                    logger.warning("The database in the backup is damaged or could not be read name=%s", path.name)
                damaged: list[str] = []
                for rel, value in media.items():
                    member = members.get(MEDIA_PREFIX + rel)
                    if member is None or tools.safe_member(member.filename, MEDIA_PREFIX, MEDIA_NAME) != rel \
                            or member.file_size != value[0]:
                        damaged.append(rel)
                        continue
                    try:
                        if tools.sha256_member(archive, member, limit=MEMBER_MAX) != (value[0], value[1]):
                            damaged.append(rel)
                    except (BackupError, *DAMAGE):
                        damaged.append(rel)
                damaged += [name for name, info in members.items() if not info.is_dir()
                            and name not in (MANIFEST, DATABASE_ENTRY, SECRET_ENTRY)
                            and tools.safe_member(name, MEDIA_PREFIX, MEDIA_NAME) not in media]
        except zipfile.BadZipFile as exc:
            raise BackupError("backup_invalid", "not a ZIP archive") from exc
        finally:
            try:
                scratch.unlink(missing_ok=True)
            except OSError:
                # Still held for a moment: a hidden name the module tidies away later.
                pass
        current = dict(media_files(media_root()))
        details = {
            "would_add": sum(1 for rel in media if rel not in current),
            "would_remove": sum(1 for rel in current if rel not in media),
            "would_change": sum(1 for rel, full in current.items() if rel in media
                                and (full.stat().st_size != media[rel][0]
                                     or tools.sha256_file(full) != media[rel][1])),
        }
        return Checked(database_ok=database_ok, files_ok=not damaged, damaged=sorted(damaged)[:DAMAGED_SHOWN],
                       details=details)

    # --- How it comes back, at the next start

    def unpack(self, path: Path, pending: Path, *, archive_password: str | None = None) -> None:
        with zipfile.ZipFile(path) as archive:
            manifest = _manifest(archive)
            tools.extract(archive, DATABASE_ENTRY, pending / "nextasks.db", limit=DATABASE_MAX)
            if SECRET_ENTRY in archive.namelist():
                (pending / "secret.key").write_bytes(tools.read_small(archive, SECRET_ENTRY, limit=4096))
            (pending / "media").mkdir()
            for rel in manifest.get("media", {}):
                if not MEDIA_NAME.fullmatch(rel):
                    raise BackupError("backup_damaged", "a file name leaves its folder")
                tools.extract(archive, MEDIA_PREFIX + rel, pending / "media" / rel, limit=MEMBER_MAX)

    def tidy(self) -> None:
        """At every start: what an earlier restore set aside (the module itself clears what a stopped copy left)."""
        root = media_root()
        if not root.parent.is_dir():
            return
        for leftover in root.parent.glob(f"{root.name}.replaced-*"):
            if leftover.is_dir() and not leftover.is_symlink() and not tools.remove_tree(leftover):
                logger.warning("A folder set aside by a restore could not be removed yet name=%s", leftover.name)

    def apply(self, pending: Path) -> None:
        """The media folder belongs to nextasks alone: it is swapped as a whole, the old one set aside until the end;
        then the database (its WAL left behind would be read into the restored one) and the key. Sessions end and the
        change counter moves on. All or nothing: on a failure the media, the database and the key from before are put
        back."""
        settings = get_settings()
        root = media_root()
        target = settings.database_path
        key = settings.data_dir / "secret.key"
        stamp = time.time_ns()
        aside = root.with_name(f"{root.name}.replaced-{stamp}")
        database_aside = target.with_name(f"{target.name}.replaced-{stamp}")
        key_aside = key.with_name(f"{key.name}.replaced-{stamp}")
        moved = database_moved = key_moved = False
        try:
            if root.exists():
                os.rename(root, aside)
                moved = True
            incoming = pending / "media"
            if incoming.is_dir():
                shutil.move(str(incoming), str(root))
            else:
                root.mkdir(parents=True)
            # Read before the side files go: opening the old database folds its WAL in, so ``last`` is what it
            # handed out.
            before = counter_of(target)
            for suffix in ("-wal", "-shm", "-journal"):
                target.with_name(target.name + suffix).unlink(missing_ok=True)
            if target.exists():
                os.replace(target, database_aside)
                database_moved = True
            shutil.copyfile(pending / "nextasks.db", target)
            end_restored_sessions(target)
            continue_counter(target, before)
            if (pending / "secret.key").is_file():
                if key.exists():
                    os.replace(key, key_aside)
                    key_moved = True
                shutil.copyfile(pending / "secret.key", key)
                private.tighten(key)
        except Exception:
            logger.exception("Restoring the backup failed, the previous state is put back")
            if moved:
                if root.exists():
                    tools.remove_tree(root)
                os.rename(aside, root)
            if database_moved:
                os.replace(database_aside, target)
            if key_moved:
                os.replace(key_aside, key)
            raise
        if database_moved:
            database_aside.unlink(missing_ok=True)
        if key_moved:
            key_aside.unlink(missing_ok=True)
        if moved:
            tools.remove_tree(aside)
        logger.info("Backup restored")

    # --- The schedule, under nextasks' own keys

    def load_schedule(self) -> Schedule:
        from ..db import SessionLocal

        with SessionLocal() as db:
            every = settings_service.get(db, "backup_schedule")
            at = settings_service.get(db, "backup_time")
            keep = settings_service.get(db, "backup_keep")
        return Schedule(
            every=every if every in nexsicherung.EVERY else DEFAULT_EVERY,
            time=at if isinstance(at, str) and nexsicherung.model.TIME.match(at) else DEFAULT_TIME,
            keep=keep if isinstance(keep, int) and nexsicherung.model.KEEP_MIN <= keep <= nexsicherung.model.KEEP_MAX
            else DEFAULT_KEEP,
        )

    def save_schedule(self, schedule: Schedule) -> None:
        from ..db import SessionLocal

        with SessionLocal() as db:
            settings_service.save(db, {"backup_schedule": schedule.every, "backup_time": schedule.time,
                                       "backup_keep": schedule.keep})

    # --- The storage

    def places(self) -> dict[str, Path]:
        """The media folder may lie elsewhere (``NEXTASKS_MEDIA_DIR``): its disk is checked for a share too."""
        return {"media": media_root()}


def configure() -> NextasksHooks:
    """The module set up for nextasks: its folders, version and hooks. At the start, before ``apply_pending``; done on
    import too, so the tests find it configured."""
    from .. import __version__

    settings = get_settings()
    hooks = NextasksHooks()
    root = media_root()
    parts = {"media": (root.name,)} if root.parent == settings.data_dir else {}
    nexsicherung.configure(nexsicherung.AppConfig(
        app_name="nextasks", data_dir=settings.data_dir, version=__version__, hooks=hooks,
        database_path=settings.database_path, parts=parts,
    ))
    return hooks
