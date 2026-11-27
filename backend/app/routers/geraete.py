"""The routes of the shared device module (``vendor/nexgeraete``, geraete 0.1.0), mounted in nextasks.

App (``/api/app/1``, in ``PROMISED`` of ``routers/app1.py``): ``pairing/{id}/key``, ``pairing/code``, ``devices``
(another own device; the list), ``devices/{id}``, ``device`` (rename), ``push``, ``push/kinds``. They answer the
published iPhone app in its old form ``tasks``, and an app that sends ``X-Nex-App`` in the module's. ``DELETE device``
stays nextasks' own (a browser session hears 404 there, as before).

The module's routes answer with plain JSON. So that ``/api/app/1`` stays described as before (``tests/
app1_contract.json`` keeps the fields of every answer, ``tests/test_openapi_names.py`` the names of 0.8.0), each is
mounted here again: the ways of before under their old operation names, summaries and schema names (``KeyIn``,
``CodeIn``, ``KeyOut``, ``Done`` in ``routers/app1.py``), the new ones with the shape they answer. The behaviour is the
module's. ``DELETE devices/{id}`` answers 204 without a body and is left out of the description.

Browser (``/api/devices`` + the module's paths: ``/app-pairing``, ``/app-connect``, ``/app-devices`` …, and the
operator's ``/server/accounts/{id}/devices``): the cards of the module on the pages. The addresses of before
(``/api/app-pairing``, ``/api/app-devices``, ``/api/app-connect``) keep their old answers in ``routers/app_pairing.py``,
so the module's sit under a prefix of their own, and out of the description (their schema names would push nextasks'
own ``NameIn``, ``AddressIn``, ``ConnectIn`` to longer names).
"""

from __future__ import annotations

import inspect
from collections.abc import Callable
from dataclasses import dataclass
from typing import Annotated, Any

from fastapi import APIRouter, Body, Request
from fastapi.routing import APIRoute
from pydantic import BaseModel

from ..deps import client_ip, require_account, require_operator
from ..services import devices
from ..vendor.nexgeraete import api as nexgeraete_api
from ..vendor.nexkonten.brake import BRAKE
from .app1 import CodeIn, Done, KeyIn, KeyOut, MeDevice

#: Where the module's browser routes are mounted (the cards take it as ``base``).
BROWSER_PREFIX = "/api/devices"


class DeviceNameIn(nexgeraete_api.NameIn):
    """A new name for this device (the module's ``NameIn``, named so beside nextasks' own ``NameIn``)."""


class KindOut(BaseModel):
    id: str
    title: str
    hint: str
    on: bool
    operator_only: bool


class KindsOut(BaseModel):
    kinds: list[KindOut]


@dataclass(frozen=True)
class Way:
    """How one of the module's app routes is described."""

    #: The status and the model of the answer; ``None``: left out of the description.
    answer: tuple[int, Any] | None
    #: The ways of before keep their names (``test_openapi_names``).
    name: str | None = None
    summary: str | None = None
    #: The body under its name of before.
    body: Any = None


_WAYS: dict[tuple[str, str], Way] = {
    ("POST", "/api/app/1/pairing/{pairing_id}/key"): Way(
        answer=(200, KeyOut), name="pickup_by_secret", summary="Pick the device key up with the QR code",
        body=Annotated[KeyIn | None, Body()]),
    ("POST", "/api/app/1/pairing/code"): Way(
        answer=(200, KeyOut), name="pickup_by_code", summary="Pick the device key up with the short code", body=CodeIn),
    ("POST", "/api/app/1/devices"): Way(
        answer=(200, KeyOut), name="bring_in_device", summary="A key of its own for another device of this account",
        body=Annotated[KeyIn | None, Body()]),
    ("GET", "/api/app/1/devices"): Way(answer=(200, list[MeDevice])),
    ("DELETE", "/api/app/1/devices/{device_id}"): Way(answer=None),
    ("PATCH", "/api/app/1/device"): Way(answer=(200, MeDevice), body=DeviceNameIn),
    ("PUT", "/api/app/1/push"): Way(
        answer=(200, Done), name="set_push", summary="Where notifications for this device go (device key only)"),
    ("DELETE", "/api/app/1/push"): Way(
        answer=(200, Done), name="stop_push", summary="Stop notifications for this device; it stays paired"),
    ("GET", "/api/app/1/push/kinds"): Way(answer=(200, KindsOut)),
    ("PUT", "/api/app/1/push/kinds"): Way(answer=(200, KindsOut)),
}
#: nextasks keeps its own ``DELETE /api/app/1/device`` (``routers/app1.py``).
_OWN = {("DELETE", "/api/app/1/device")}


def _sender(request: Request) -> str:
    return client_ip(request)


def _with_body(endpoint: Callable[..., Any], body: Any) -> Callable[..., Any]:
    """The module's endpoint with its body described under nextasks' name of before (the classes extend the module's
    ``PairIn``, so the module reads them unchanged)."""
    signature = inspect.signature(endpoint)

    def described(**values: Any) -> Any:
        return endpoint(**values)

    described.__signature__ = signature.replace(  # type: ignore[attr-defined]
        parameters=[part.replace(annotation=body) if part.name == "body" else part
                    for part in signature.parameters.values()])
    described.__name__ = endpoint.__name__
    described.__doc__ = endpoint.__doc__
    return described


def _described(module_router: APIRouter) -> APIRouter:
    """The module's app routes again, each with its answer's shape (and the names of before) in OpenAPI."""
    out = APIRouter(tags=["app"])
    for route in module_router.routes:
        assert isinstance(route, APIRoute)
        for method in sorted(route.methods):
            key = (method, route.path)
            if key in _OWN:
                continue
            assert key in _WAYS, f"geraete: no description for {key}"
            way = _WAYS[key]
            out.add_api_route(
                route.path,
                _with_body(route.endpoint, way.body) if way.body is not None else route.endpoint,
                methods=[method],
                status_code=route.status_code,
                name=way.name or route.name,
                summary=way.summary or route.summary,
                response_model=None,
                responses={way.answer[0]: {"model": way.answer[1]}} if way.answer is not None else None,
                include_in_schema=way.answer is not None,
            )
    return out


router = _described(
    nexgeraete_api.app_router(
        config=devices.LIVE,
        store=devices.store,
        # The sign-in brake of the shared account module (pot ``app-pairing:<sender>``; ``security.brake.forget``
        # empties it too).
        brake=BRAKE,
        on_paired=lambda holder, device: devices.on_paired(holder, device),
        send=devices.send,
        sender=_sender,
        clock=devices.now,
    )
)

browser = nexgeraete_api.browser_router(
    config=devices.LIVE,
    store=devices.store,
    account=require_account,
    operator=require_operator,
    address=lambda request: devices.public_address(),
    send=devices.send,
    clock=devices.now,
    prefix=BROWSER_PREFIX,
    tags=["devices"],
)
router.include_router(browser, include_in_schema=False)
