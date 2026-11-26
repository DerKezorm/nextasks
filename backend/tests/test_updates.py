"""The about page and the update check in nextasks (shared module ``nexupdates``, updates 0.1.1).

What every app shares is held by the contract tests in ``tests/nexupdates``; here what is nextasks' own: its
repository and no project page (U18), a member's answer in the old form with nothing in it (U15, U21), the setup box
and the old setup page (U1), the operator's switch under Settings › Server through the old ``PUT /api/settings``, no
look in the background (U19: nextasks has no bell), and the one address asked. No test here reaches GitHub; the
conftest points the address at a port that refuses.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from app import __version__
from app.db import SessionLocal
from app.models import Account, Setting
from app.services import updates
from app.vendor.nexupdates import check

from .conftest import SETUP_CODE, TAB
from .test_profile import person

#: The real client, before any test puts a stand-in in its place.
REAL_CLIENT = httpx.Client


def answers(monkeypatch: pytest.MonkeyPatch, tag: str | None) -> list[int]:
    asked: list[int] = []

    def ask() -> str | None:
        asked.append(1)
        return tag

    monkeypatch.setattr(check, "ask", ask)
    return asked


def stored() -> Any:
    with SessionLocal() as db:
        row = db.get(Setting, "update_check")
        return None if row is None else row.value


def test_the_about_page_names_version_licence_and_where_it_comes_from(client: TestClient, account: Account) -> None:
    about = client.get("/api/about").json()
    assert about["version"] == __version__
    assert about["license"] == "AGPL-3.0"
    assert about["repo_url"] == "https://github.com/DerKezorm/nextasks"
    assert about["releases_url"] == "https://github.com/DerKezorm/nextasks/releases"
    # U18: no project page while the project pages are switched off (the page shows no row).
    assert about["project_url"] == ""


def test_the_operator_sees_the_state_with_the_release_of_nextasks(
    client: TestClient, account: Account, monkeypatch: pytest.MonkeyPatch
) -> None:
    answers(monkeypatch, "v99.0.0")
    seen = client.get("/api/about/updates").json()
    assert (seen["update_check"], seen["checked"], seen["latest"], seen["newer"], seen["hidden"]) == (
        True, True, "v99.0.0", True, False)
    assert seen["release_url"] == "https://github.com/DerKezorm/nextasks/releases/tag/v99.0.0"


def test_a_member_gets_the_old_form_with_nothing_in_it_and_never_makes_the_server_ask(
    client: TestClient, account: Account, monkeypatch: pytest.MonkeyPatch
) -> None:
    asked = answers(monkeypatch, "v99.0.0")
    client.post("/api/about/updates/check")
    asked.clear()
    anna = person("anna")
    seen = anna.get("/api/about/updates")
    assert seen.status_code == 200
    assert seen.json() == {"update_check": False, "checked": False, "latest": None, "newer": False,
                           "checked_at": None, "release_url": None, "hidden": True}
    assert anna.post("/api/about/updates/check").status_code == 403
    assert anna.put("/api/about/updates", json={"update_check": False}).status_code == 403
    assert asked == []
    # Without an account: nothing.
    assert TestClient(client.app).get("/api/about/updates").status_code == 401


def test_the_old_settings_switch_is_the_modules(client: TestClient, account: Account,
                                                 monkeypatch: pytest.MonkeyPatch) -> None:
    """Server › General (``PUT /api/settings``) and About (``PUT /api/about/updates``) switch the same thing."""
    asked = answers(monkeypatch, "v99.0.0")
    assert client.put("/api/settings", json={"update_check": False}).status_code == 200
    assert client.get("/api/about/updates").json()["update_check"] is False
    assert asked == []
    assert client.put("/api/about/updates", json={"update_check": True}).json()["update_check"] is True
    assert client.get("/api/settings").json()["update_check"] is True


def test_no_look_in_the_background_without_a_bell(client: TestClient, account: Account,
                                                  monkeypatch: pytest.MonkeyPatch) -> None:
    """U19: the daily look serves a bell; nextasks has none, so only an operator opening "About" asks."""
    asked = answers(monkeypatch, "v99.0.0")
    assert updates.configure().on_newer is None
    assert check.look_once() is None
    assert asked == []


def _setup(body: dict[str, Any]) -> None:
    from sqlalchemy import delete

    with SessionLocal() as db:
        db.execute(delete(Account))
        db.commit()
    password = "correct horse battery staple"
    from app.main import app

    with TestClient(app, base_url="http://testserver", headers=TAB) as browser:
        answer = browser.post("/api/setup", json={"display_name": "Olga", "name": "olga", "password": password,
                                                  "password_confirm": password, "code": SETUP_CODE, **body})
    assert answer.status_code == 200, answer.text


@pytest.mark.parametrize(("body", "expected"), [({}, None), ({"update_check": False}, False),
                                                 ({"update_check": True}, True)])
def test_the_setup_stores_the_box_and_a_page_of_before_stores_nothing(body: dict[str, Any], expected: Any) -> None:
    """U1: the answer of the setup is stored; a page of 0.8.0 sends no box, then nothing is stored and the check
    stays on by default."""
    _setup(body)
    assert stored() is expected
    assert check.switch_on() is (expected is not False)


def test_the_question_goes_to_the_releases_of_nextasks_and_carries_nothing_else(
    client: TestClient, account: Account, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen: list[httpx.Request] = []

    def make(*args: object, **kwargs: Any) -> httpx.Client:
        def handle(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(200, json={"tag_name": "v0.0.1"})

        return REAL_CLIENT(transport=httpx.MockTransport(handle), headers=kwargs.get("headers"))

    monkeypatch.setattr(check.httpx, "Client", make)
    monkeypatch.setattr(updates, "get_settings", lambda: type("S", (), {"update_url": ""})())
    updates.configure()
    client.post("/api/about/updates/check")
    assert [str(request.url) for request in seen] == ["https://api.github.com/repos/DerKezorm/nextasks/releases/latest"]
    assert seen[0].method == "GET" and seen[0].content == b""
    assert "cookie" not in seen[0].headers and "authorization" not in seen[0].headers
    assert seen[0].headers["user-agent"] == "nex-update-check"
