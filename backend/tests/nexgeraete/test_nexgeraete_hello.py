"""The first question of every app (since 0.1.6, I30): ``GET /api/app/1/hello`` without a key names the app, its
interface, how one signs in, what it offers and the ways a device comes in, in the same shape in every app. Red here
means an iPhone app cannot tell whether the address is this app, or waits in vain while iOS asks for the network."""

from __future__ import annotations

from typing import Any

from geraete_contract import auth


def test_hello_names_the_app_and_its_interface_without_a_key(app: Any, config: Any) -> None:
    answer = app.device_client().get(f"{app.app_prefix}/hello")
    assert answer.status_code == 200, answer.text
    assert answer.headers["cache-control"] == "no-store"
    body = answer.json()
    assert body["app"] == config.app
    assert isinstance(body["api"], int) and isinstance(body["min_api"], int) and 1 <= body["min_api"] <= body["api"]
    assert isinstance(body["version"], str) and body["version"]
    assert isinstance(body["sign_in"], list) and all(isinstance(way, str) for way in body["sign_in"])
    assert isinstance(body["features"], list) and all(isinstance(word, str) for word in body["features"])
    assert body["pairing"] == ["qr", "code", "browser", "icloud"]


def test_hello_answers_a_wrong_key_the_same(app: Any) -> None:
    """A key that is none changes nothing: ``hello`` asks for none (the app asks it before it has one)."""
    plain = app.device_client().get(f"{app.app_prefix}/hello").json()
    with_key = app.device_client().get(f"{app.app_prefix}/hello", headers=auth("ntd_nothing")).json()
    assert with_key == plain
