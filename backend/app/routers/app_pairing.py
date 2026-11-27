"""The browser's addresses of before for the iPhone app (``vertrag-block1.md``, "Koppeln"), kept with their answers.

Since geraete 0.1.0 the pages use the module's routes under ``/api/devices`` (``routers/geraete.py``). These stay for
a page still open from before an update and for whatever else called them: the same paths, the same answers, the work
done by the module (``pairing.start``, ``pairing.state``, ``pairing.withdraw``, ``devices.disconnect``) over the same
tables. Only with a session.
"""

from __future__ import annotations

import logging
from typing import Annotated, Any
from urllib.parse import quote, urlsplit

from fastapi import APIRouter, Path, Request
from pydantic import BaseModel, Field

from ..deps import Account, DbSession
from ..errors import error
from ..services import devices, settings_service
from ..services.records import StampOut
from ..vendor import nexgeraete
from ..vendor.nexgeraete import qr

logger = logging.getLogger("nextasks.app")

router = APIRouter(prefix="/api", tags=["app"])

PairingId = Annotated[str, Path(min_length=1, max_length=32)]

def _fail(refused: nexgeraete.DeviceRefused) -> Exception:
    """The module's refusals as the page of before knew them."""
    if refused.code == "not_found":
        return error("app_pairing_unknown", "No such pairing.", 404)
    if refused.code == "too_many_pairings":
        return error("app_too_many_pairings", "At most 5 pairings may wait at once.", 409, **refused.values)
    return error(refused.code, refused.message, refused.status, **refused.values)


class PairingIn(BaseModel):
    #: Where the browser sees nextasks now. Counts only when the operator has set no public address; that one wins.
    address: str = Field(default="", max_length=600)


class PairingOut(BaseModel):
    id: str
    #: ``ABCD-EFGH``. Only in this answer: the page shows it and forgets it.
    code: str
    expires_at: StampOut
    #: The address the app keeps; typed in beside the short code.
    address: str
    link: str
    qr_svg: str


class PairingState(BaseModel):
    #: ``waiting``, ``connected`` or ``expired``.
    state: str
    device: str = ""


class DeviceOut(BaseModel):
    id: int
    name: str
    created_at: StampOut
    last_seen: StampOut | None = None


class ConnectIn(BaseModel):
    #: The device's name as the app named it in the address ``/app-connect?device=<name>``.
    device: str = Field(default="", max_length=200)


class ConnectOut(BaseModel):
    #: ``nextasks://connect?...``: the page leads the browser there, the app picks the key up with it.
    link: str
    #: The same, as the module's page reads it.
    redirect: str


def _address(db: DbSession, from_browser: str) -> str:
    """The public address from the settings wins: whoever opens nextasks at home by its IP address still wants the app
    to know the one that works on the way."""
    for candidate in (settings_service.public_url(db), from_browser.strip().rstrip("/")):
        parts = urlsplit(candidate)
        if parts.scheme in ("http", "https") and parts.netloc:
            return candidate
    raise error("app_address_missing", "nextasks does not know its address. The operator sets it.", 422)


def _link(started: nexgeraete.Started) -> str:
    """The QR code's link as before: ``nextasks://connect?address=…&pairing=…&secret=…`` (the module's adds
    ``server=`` in front for the apps built on NexKonto)."""
    return (f"{devices.CONFIG.scheme}://connect?address={quote(started.address, safe='')}"
            f"&pairing={quote(started.pairing.id, safe='')}&secret={quote(started.secret, safe='')}")


def _started(db: DbSession, account: Account, from_browser: str) -> nexgeraete.Started:
    # The address first: without it the code would lead nowhere.
    address = _address(db, from_browser)
    try:
        started = nexgeraete.pairing.start(devices.GeraeteStore(db), devices.CONFIG, account.id, address=address,
                                           now=devices.now())
    except nexgeraete.DeviceRefused as refused:
        db.rollback()
        raise _fail(refused) from refused
    logger.info("Pairing made for the iPhone app")
    return started


@router.post("/app-pairing", response_model=PairingOut, status_code=201, summary="A pairing for the iPhone app")
def pair(account: Account, db: DbSession, body: PairingIn | None = None) -> PairingOut:
    started = _started(db, account, body.address if body else "")
    return PairingOut(id=started.pairing.id, code=started.code, expires_at=started.pairing.expires_at,
                      address=started.address, link=_link(started), qr_svg=qr.svg(_link(started)))


@router.post("/app-connect", response_model=ConnectOut, summary="Pairing for the sign-in page: the link for the app")
def connect(request: Request, account: Account, db: DbSession, body: ConnectIn | None = None) -> ConnectOut:
    """The page ``/app-connect?device=<name>`` of before called this after "Connect iPhone" and led the browser to the
    link."""
    link = _link(_started(db, account, str(request.base_url).rstrip("/")))
    return ConnectOut(link=link, redirect=link)


@router.get("/app-pairing/{pairing_id}", response_model=PairingState, summary="Whether the app picked the key up")
def pairing_state(pairing_id: PairingId, account: Account, db: DbSession) -> PairingState:
    try:
        state, device = nexgeraete.pairing.state(devices.GeraeteStore(db), devices.CONFIG, account.id, pairing_id,
                                                 devices.now())
    except nexgeraete.DeviceRefused as refused:
        raise _fail(refused) from refused
    if state != "used":
        return PairingState(state=state)
    return PairingState(state="connected", device=device.name if device is not None else _used_name(db, pairing_id))


def _used_name(db: DbSession, pairing_id: str) -> str:
    """The name the device had when it used the code (kept at the pairing; the device may be gone since)."""
    from ..models import AppPairing

    row = db.get(AppPairing, pairing_id)
    return row.device_name if row is not None else ""


@router.delete("/app-pairing/{pairing_id}", status_code=204, summary="Withdraw a pairing")
def withdraw(pairing_id: PairingId, account: Account, db: DbSession) -> None:
    try:
        nexgeraete.pairing.withdraw(devices.GeraeteStore(db), devices.CONFIG, account.id, pairing_id)
    except nexgeraete.DeviceRefused as refused:
        raise _fail(refused) from refused


@router.get("/app-devices", response_model=list[DeviceOut], summary="The own paired iPhones")
def own_devices(account: Account, db: DbSession) -> list[Any]:
    return [DeviceOut(id=int(row.id), name=row.name, created_at=row.created_at, last_seen=row.last_seen_at)
            for row in devices.of_account(db, account.id)]


@router.delete("/app-devices/{device_id}", status_code=204, summary="Disconnect a paired iPhone")
def disconnect(device_id: int, account: Account, db: DbSession) -> None:
    try:
        nexgeraete.devices.disconnect(devices.GeraeteStore(db), devices.CONFIG, account.id, device_id)
    except nexgeraete.DeviceRefused as refused:
        raise error("not_found", "Not found.", 404) from refused
