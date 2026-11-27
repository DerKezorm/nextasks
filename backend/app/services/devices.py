"""The iPhone app's devices: nextasks' side of the shared module ``vendor/nexgeraete`` (geraete 0.1.0).

The module manages pairing (QR code, code to type, sign-in in the browser, another own device over iCloud), knowing a
device again by its key, the list, renaming, disconnecting, the kinds of notification per device and the push through
the relay. The rows stay in nextasks' own tables (``app_devices``, ``app_pairings``, new ``app_codes``); the
``GeraeteStore`` below translates. Nothing moves and no key is hashed anew: a device paired before keeps working.

**The published iPhone app notices nothing.** It speaks the old form ``tasks`` (``X-Pairing-Secret``, ``{key,
account}``, ``404 app_pairing_unknown``, ``401 not_signed_in``, ``429 too_many``); the module answers it so as long as
the request carries no ``X-Nex-App``.

**A device has the rights of a browser session** of its account in every space it is a member of, unlike an API
token. It does not run out; it goes when its owner disconnects it, signs out everywhere, when its account is deleted
for good, or after 365 days without use (the daily ``sweep``). While its account is blocked or deleted and may still be
brought back, it rests (G26): refused, kept, and working again afterwards without pairing anew.

**Two switches of the operator, both on from the start** (Server › Connections): ``app_enabled`` off answers every
device with 403 ``app_disabled`` (they stay paired); ``app_pairing_allowed`` off refuses new devices with 403
``app_pairing_disabled``.

What stays nextasks' own: the rate of 600 requests a minute per device or session (``brake``), browser sessions on
``/api/app/1``, and ``make_device`` (a device written the way 0.8.0 wrote it, for the tests of what stands).
"""

from __future__ import annotations

import hashlib
import logging
import secrets
import threading
import time
from collections import defaultdict, deque
from collections.abc import Iterator
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.orm import Session

from ..models import OPERATOR, Account, AppCode, AppDevice, AppPairing, utcnow
from ..vendor import nexgeraete
from ..vendor.nexgeraete import ConnectCode, Device, DeviceChange, Holder, NewDevice, NewPairing, Pairing, PushState
from . import clock, settings_service, totp

logger = logging.getLogger("nextasks.app")

KEY_PREFIX = "ntd_"
SWITCH = "app_pairing_allowed"
ENABLED = "app_enabled"
NAME_CHARS = 80
#: Requests one device or browser session may make per minute on ``/api/app/1``.
PER_MINUTE = 600
#: Devices one account may bring in through a device it has, per hour (read at every request: the tests lower it).
SIBLINGS_PER_HOUR = 5
#: The link "Was ist neu" in the notice about a new version (G18).
WHATS_NEW_PAGE = "/settings/about"

#: nextasks' kinds of notification, the words of the list in the app and in the browser (G25). The published app knows
#: them all and gets them all (``legacy_kinds``).
KINDS = (
    nexgeraete.PushKind(
        id="due",
        title={"de": "Fällige Aufgaben", "en": "Due tasks", "fr": "Tâches à échéance"},
        hint={"de": "Wenn eine Aufgabe mit Uhrzeit fällig ist.", "en": "When a task with a time is due.",
              "fr": "Quand une tâche avec une heure arrive à échéance."},
    ),
    nexgeraete.PushKind(
        id="assigned",
        title={"de": "Mir zugewiesen", "en": "Assigned to me", "fr": "Attribuées à moi"},
        hint={"de": "Wenn dir jemand eine Aufgabe zuweist.", "en": "When someone assigns a task to you.",
              "fr": "Quand quelqu'un t'attribue une tâche."},
    ),
    nexgeraete.PushKind(
        id="changed",
        title={"de": "Änderungen in Listen", "en": "Changes in lists", "fr": "Modifications dans les listes"},
        hint={"de": "Wenn andere in Listen, die du verfolgst, etwas ändern.",
              "en": "When others change something in lists you follow.",
              "fr": "Quand d'autres modifient quelque chose dans les listes que tu suis."},
    ),
    nexgeraete.PushKind(
        id="comment",
        title={"de": "Kommentare", "en": "Comments", "fr": "Commentaires"},
        hint={"de": "Wenn jemand eine Aufgabe kommentiert, die du angelegt hast oder für die du zuständig bist.",
              "en": "When someone comments on a task you created or are assigned to.",
              "fr": "Quand quelqu'un commente une tâche que tu as créée ou qui t'est attribuée."},
    ),
    nexgeraete.PushKind(
        id="mention",
        title={"de": "Erwähnungen", "en": "Mentions", "fr": "Mentions"},
        hint={"de": "Wenn dich jemand in einem Kommentar erwähnt.", "en": "When someone mentions you in a comment.",
              "fr": "Quand quelqu'un te mentionne dans un commentaire."},
    ),
    nexgeraete.PushKind(
        id="daily",
        title={"de": "Mein Tag", "en": "My day", "fr": "Ma journée"},
        hint={"de": "Der tägliche Bericht, wenn du ihn aufs Gerät bestellt hast.",
              "en": "The daily report, if you asked for it on your devices.",
              "fr": "Le rapport du jour, si tu l'as demandé sur tes appareils."},
    ),
    nexgeraete.PushKind(
        id="weekly",
        title={"de": "Wochenbericht", "en": "Weekly report", "fr": "Rapport de la semaine"},
        hint={"de": "Der Bericht der Woche, wenn du ihn aufs Gerät bestellt hast.",
              "en": "The weekly report, if you asked for it on your devices.",
              "fr": "Le rapport de la semaine, si tu l'as demandé sur tes appareils."},
    ),
    nexgeraete.PushKind(
        id="mcp_waiting",
        title={"de": "KI-Programm wartet", "en": "AI program waiting", "fr": "Programme d'IA en attente"},
        hint={"de": "Wenn ein KI-Programm auf dein Ja wartet.", "en": "When an AI program waits for your yes.",
              "fr": "Quand un programme d'IA attend ton accord."},
    ),
)


def _relay() -> str:
    from . import push

    return push.relay_url()


#: The module's view of nextasks. ``siblings_per_hour`` follows ``SIBLINGS_PER_HOUR`` (``config()``).
CONFIG = nexgeraete.AppConfig(
    app="nextasks",
    scheme="nextasks",
    token_prefix=KEY_PREFIX,
    form=nexgeraete.FORM_TASKS,
    name_max=NAME_CHARS,
    relay_url=_relay,
    push_info="nextasks-push-v1",
    kinds=KINDS,
    legacy_kinds=tuple(kind.id for kind in KINDS),
)


class _LiveConfig:
    """``CONFIG`` with the values that may change while the server runs (the tests lower ``SIBLINGS_PER_HOUR``)."""

    def __getattr__(self, name: str) -> Any:
        return getattr(config(), name)


def config() -> nexgeraete.AppConfig:
    if CONFIG.siblings_per_hour == SIBLINGS_PER_HOUR:
        return CONFIG
    return replace(CONFIG, siblings_per_hour=SIBLINGS_PER_HOUR)


#: What the module's routers and calls get: always the current ``config()``.
LIVE: Any = _LiveConfig()


def now() -> datetime:
    """The server's clock (``services/clock``: the tests move it on)."""
    return clock.now().astimezone(UTC)


def digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def allowed(db: Session) -> bool:
    """New devices may come in."""
    return bool(settings_service.get(db, SWITCH))


def enabled(db: Session) -> bool:
    """Devices may use ``/api/app/1``."""
    return bool(settings_service.get(db, ENABLED))


def _aware(moment: datetime | None) -> datetime | None:
    if moment is None:
        return None
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=UTC)


class GeraeteStore:
    """The module's ``Store`` over nextasks' tables, one session (one transaction) per request."""

    def __init__(self, db: Session) -> None:
        self.db = db

    # --- devices ---------------------------------------------------------------------------------------------------

    @staticmethod
    def _device(row: AppDevice) -> Device:
        state = None
        if row.push_ticket and row.push_key:
            understands = row.push_understands
            state = PushState(row.push_ticket, row.push_key,
                              tuple(str(kind) for kind in understands) if isinstance(understands, list) else None)
        return Device(
            id=row.id,
            account_id=row.account_id,
            name=row.name or "iPhone",
            kind=row.kind,
            model=row.model,
            system=row.system,
            app_version=row.app_version,
            via=row.via,
            created_at=_aware(row.created_at),
            last_seen_at=_aware(row.last_seen_at),
            push=state,
            kinds={str(key): bool(on) for key, on in (row.push_kinds or {}).items()},
        )

    def devices_of(self, account_id: Any) -> list[Device]:
        rows = self.db.scalars(select(AppDevice).where(AppDevice.account_id == int(account_id))
                               .order_by(AppDevice.created_at.desc(), AppDevice.id.desc()))
        return [self._device(row) for row in rows]

    def _row(self, device_id: Any) -> AppDevice | None:
        try:
            return self.db.get(AppDevice, int(device_id))
        except (TypeError, ValueError, OverflowError):
            return None

    def device(self, device_id: Any) -> Device | None:
        row = self._row(device_id)
        return self._device(row) if row is not None else None

    def device_by_hash(self, token_hash: str) -> Device | None:
        row = self.db.scalar(select(AppDevice).where(AppDevice.key_hash == token_hash))
        return self._device(row) if row is not None else None

    def add_device(self, new: NewDevice) -> Device:
        row = AppDevice(account_id=int(new.account_id), name=new.name[:NAME_CHARS] or "iPhone",
                        key_hash=new.token_hash, created_at=new.created_at, kind=new.kind, model=new.model,
                        system=new.system, app_version=new.app_version, via=new.via)
        self.db.add(row)
        self.db.flush()
        logger.info("Device paired device_id=%s via=%s", row.id, new.via)
        return self._device(row)

    def change_device(self, device_id: Any, change: DeviceChange) -> Device:
        row = self._row(device_id)
        if row is None:
            raise nexgeraete.DeviceRefused("not_found")
        for part in ("name", "model", "system", "app_version"):
            value = getattr(change, part)
            if value is not None:
                setattr(row, part, value[:80] if part == "name" else value[:64])
        self.db.flush()
        return self._device(row)

    def remove_device(self, device_id: Any) -> None:
        row = self._row(device_id)
        if row is not None:
            self.db.delete(row)
            self.db.flush()
            logger.info("Device disconnected device_id=%s", row.id)

    def touch(self, device_id: Any, when: datetime) -> None:
        self.db.execute(update(AppDevice).where(AppDevice.id == int(device_id)).values(last_seen_at=when))

    def idle_devices(self, before: datetime) -> list[Device]:
        rows = self.db.scalars(select(AppDevice).where(
            or_(AppDevice.last_seen_at < before, (AppDevice.last_seen_at.is_(None) & (AppDevice.created_at < before)))
        ))
        return [self._device(row) for row in rows]

    def set_push(self, device_id: Any, state: PushState | None) -> None:
        row = self._row(device_id)
        if row is None:
            return
        row.push_ticket = state.ticket if state else ""
        row.push_key = state.key if state else ""
        row.push_understands = list(state.understands) if state and state.understands is not None else None
        self.db.flush()

    def set_kinds(self, device_id: Any, kinds: dict[str, bool]) -> None:
        row = self._row(device_id)
        if row is not None:
            row.push_kinds = dict(kinds)
            self.db.flush()

    # --- accounts --------------------------------------------------------------------------------------------------

    def holder(self, account_id: Any) -> Holder | None:
        from . import spaces

        try:
            account = self.db.get(Account, int(account_id))
        except (TypeError, ValueError, OverflowError):
            return None
        if account is None:
            return None
        return Holder(
            id=account.id,
            name=account.display_name or account.name,
            login=account.name,
            email=account.email or "",
            avatar=account.avatar_hash or "",
            operator=account.role == OPERATOR,
            out=account.shut,
            language=spaces.language_of(account),
            factor_owed=totp.setup_required(self.db, account),
        )

    def operators(self) -> list[Any]:
        return list(self.db.scalars(select(Account.id).where(Account.role == OPERATOR).order_by(Account.id)))

    # --- pairings and one-time codes -------------------------------------------------------------------------------

    @staticmethod
    def _pairing(row: AppPairing | None) -> Pairing | None:
        if row is None:
            return None
        return Pairing(id=row.id, account_id=row.account_id, secret_hash=row.secret_hash, code_hash=row.code_hash,
                       created_at=_aware(row.created_at) or utcnow(), expires_at=_aware(row.expires_at) or utcnow(),
                       used_at=_aware(row.used_at), device_id=row.device_id)

    def add_pairing(self, new: NewPairing) -> Pairing:
        # Pairings that ran out a day ago are of no use to anybody.
        self.db.execute(delete(AppPairing).where(AppPairing.expires_at < new.created_at - timedelta(days=1)))
        row = AppPairing(id=new.id, account_id=int(new.account_id), secret_hash=new.secret_hash,
                         code_hash=new.code_hash, created_at=new.created_at, expires_at=new.expires_at)
        self.db.add(row)
        self.db.flush()
        found = self._pairing(row)
        assert found is not None
        return found

    def pairing(self, pairing_id: str) -> Pairing | None:
        return self._pairing(self.db.get(AppPairing, pairing_id[:32]))

    def pairing_by_code(self, code_hash: str) -> Pairing | None:
        return self._pairing(self.db.scalar(select(AppPairing).where(AppPairing.code_hash == code_hash)
                                            .order_by(AppPairing.created_at.desc()).limit(1)))

    def open_pairings(self, account_id: Any, now: datetime) -> list[Pairing]:
        rows = self.db.scalars(select(AppPairing).where(
            AppPairing.account_id == int(account_id), AppPairing.used_at.is_(None), AppPairing.expires_at > now))
        return [found for found in (self._pairing(row) for row in rows) if found is not None]

    def use_pairing(self, pairing_id: str, device_id: Any, when: datetime) -> bool:
        """One conditional UPDATE: of two pickups at the same moment exactly one hits. The device's name goes along
        for the old answer of ``GET /api/app-pairing/{id}``."""
        device = self._row(device_id) if device_id is not None else None
        hit = self.db.execute(
            update(AppPairing)
            .where(AppPairing.id == pairing_id, AppPairing.used_at.is_(None), AppPairing.expires_at > when)
            .values(used_at=when, device_id=device.id if device else None, device_name=device.name if device else "")
        ).rowcount
        return int(hit or 0) == 1

    def remove_pairing(self, pairing_id: str) -> None:
        self.db.execute(delete(AppPairing).where(AppPairing.id == pairing_id))

    def add_connect_code(self, new: ConnectCode) -> None:
        self.db.execute(delete(AppCode).where(AppCode.expires_at < new.created_at - timedelta(days=1)))
        self.db.add(AppCode(code_hash=new.code_hash, account_id=int(new.account_id), state=new.state,
                            challenge=new.challenge, created_at=new.created_at, expires_at=new.expires_at))
        self.db.flush()

    def take_connect_code(self, code_hash: str, when: datetime) -> ConnectCode | None:
        hit = self.db.execute(
            update(AppCode).where(AppCode.code_hash == code_hash, AppCode.used_at.is_(None), AppCode.expires_at > when)
            .values(used_at=when)
        ).rowcount
        if int(hit or 0) != 1:
            return None
        row = self.db.get(AppCode, code_hash)
        assert row is not None
        return ConnectCode(code_hash=row.code_hash, account_id=row.account_id, state=row.state,
                           challenge=row.challenge, created_at=_aware(row.created_at) or when,
                           expires_at=_aware(row.expires_at) or when)

    # --- the operator's switches -----------------------------------------------------------------------------------

    def switch(self, name: str) -> bool:
        return bool(settings_service.get(self.db, ENABLED if name == nexgeraete.SWITCH_APP else SWITCH))

    def commit(self) -> None:
        self.db.commit()

    def rollback(self) -> None:
        self.db.rollback()


def store() -> Iterator[GeraeteStore]:
    """The dependency of the module's routes: one session per request."""
    from ..db import SessionLocal

    with SessionLocal() as db:
        yield GeraeteStore(db)


def public_address() -> str:
    """The public address the operator set; empty: the module takes the one the browser sees."""
    from ..db import SessionLocal

    with SessionLocal() as db:
        return settings_service.public_url(db)


# --- What the module hands back to nextasks ---------------------------------------------------------------------------


def send(url: str, body: dict[str, Any]) -> int:
    """Posts to the relay the way nextasks always has (``push.POST``: httpx with the server's certificates; the tests
    put a recorder in its place). A network failure reaches the module as ``OSError``."""
    from . import push

    try:
        return int(push.POST(url, body))
    except httpx.HTTPError as exc:
        raise OSError(type(exc).__name__) from exc


def on_paired(holder: Holder, device: Device) -> None:
    """After every new device (G29): the mail "New sign-in" as after a sign-in in a new browser, unless the person
    turned it off; it names the device."""
    from ..db import SessionLocal
    from ..vendor.nexkonten import sessions as konten_sessions
    from . import kontenpost
    from .konten_store import KontenStore

    with SessionLocal() as db:
        account = db.get(Account, int(holder.id))
        konto = KontenStore(db).get_account(int(holder.id))
        if account is None or konto is None:
            return
        mail = konten_sessions.new_sign_in(konto, known=False, wanted=bool(account.new_sign_in_mail))
        if kontenpost.queue(db, mail, where=nexgeraete.describe(device)):
            logger.info("Mail about a new device queued account_id=%s", holder.id)


def announce(version: str, current: str | None = None) -> None:
    """The operators' devices hear of a new version (G18; ``current`` is the running one, ``__version__``). Not
    wired to ``updates`` yet: nextasks has no bell, and the module updates gives ``on_newer`` only to an app with one
    (U19, its contract ``test_the_bell_is_given_exactly_where_the_app_has_one``); the contract of the device module
    calls it."""
    from .. import __version__
    from ..db import SessionLocal

    with SessionLocal() as db:
        base = settings_service.public_url(db)
        nexgeraete.notices.newer(GeraeteStore(db), LIVE, version, current or __version__,
                                 f"{base}{WHATS_NEW_PAGE}" if base else "", send=send)


def sweep() -> int:
    """The daily run (G27): devices unused for 365 days are disconnected."""
    from ..db import SessionLocal

    with SessionLocal() as db:
        gone = nexgeraete.devices.sweep(GeraeteStore(db), LIVE, now())
    if gone:
        logger.info("Unused devices disconnected count=%s", gone)
    return gone


def tell(db: Session, account_id: int, kind: str, message: bytes, *, collapse: str = "") -> nexgeraete.push.Told:
    """A message of nextasks' own ``kind`` to every device of the account that may get it (``push.send_all``)."""
    return nexgeraete.push.tell(GeraeteStore(db), LIVE, account_id, kind, message, collapse=collapse, send=send)


def of_account(db: Session, account_id: int) -> list[Device]:
    """The account's devices, oldest first (the order of the page of before)."""
    return sorted(GeraeteStore(db).devices_of(account_id), key=lambda device: int(device.id))


def make_device(db: Session, account: Account, name: str) -> tuple[str, AppDevice]:
    """A device written exactly the way 0.8.0 wrote one (no kind, model or way): for the tests of what stands."""
    key = KEY_PREFIX + secrets.token_urlsafe(32)
    clean = "".join(char for char in name if char.isprintable()).strip()[:NAME_CHARS] or "iPhone"
    row = AppDevice(account_id=account.id, name=clean, key_hash=digest(key), created_at=utcnow())
    db.add(row)
    db.commit()
    db.refresh(row)
    return key, row


def count(db: Session, account_id: int, *, with_push: bool = False) -> int:
    statement = select(func.count()).select_from(AppDevice).where(AppDevice.account_id == account_id)
    if with_push:
        statement = statement.where(AppDevice.push_ticket != "")
    return int(db.scalar(statement) or 0)


# --- The rate on /api/app/1 (nextasks' own) ---------------------------------------------------------------------

_calls_lock = threading.Lock()
_calls: dict[str, deque[float]] = defaultdict(deque)


def brake(caller: str, now: float | None = None) -> bool:
    """True while the device or session stays under ``PER_MINUTE`` requests in the last minute; counts this one."""
    now = time.monotonic() if now is None else now
    with _calls_lock:
        seen = _calls[caller]
        while seen and now - seen[0] > 60:
            seen.popleft()
        if len(seen) >= PER_MINUTE:
            return False
        seen.append(now)
        return True


def forget() -> None:
    with _calls_lock:
        _calls.clear()
