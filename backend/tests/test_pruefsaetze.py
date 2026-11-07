"""The shared test sets of ``nextasks-ios/docs/pruefsaetze`` (copied to ``tests/pruefsaetze``): the server computes
what web and app compute. Repeats, the tie rule and the order key check are the references themselves
(``services/wiederholung.py``, ``gleichstand.py``, ``position.py``); the order keys come from the server's own port
(``services/fractional.py``), the push from the server's own way to the relay (``services/push.py``), and the server
puts them to use where it takes data in (``records.take_apart``) and answers ``complete``.
"""

from __future__ import annotations

import base64
import json
from pathlib import Path
from typing import Any

import pytest

from app.services import fractional, gleichstand, notetext, push, push_crypto, records, wiederholung

SETS = Path(__file__).with_name("pruefsaetze")


def _load(name: str) -> dict[str, Any]:
    return json.loads((SETS / f"{name}.json").read_text(encoding="utf-8"))


REPEAT = _load("wiederholung")
TIE = _load("gleichstand")
POSITION = _load("position")
PUSH = _load("push")
NOTES = _load("notiz-klartext")


# --- Wiederholung -------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("case", REPEAT["next_due"], ids=lambda c: f"{c['rule']}|{c['due_date']}")
def test_next_due(case: dict[str, Any]) -> None:
    got = wiederholung.next_due(case["rule"], case["repeat_from"], case["due_date"], case["on"])
    assert (got.isoformat() if got else None) == case["expect"]


@pytest.mark.parametrize("case", REPEAT["copy_id"], ids=lambda c: c["occurrence"])
def test_copy_id(case: dict[str, Any]) -> None:
    assert wiederholung.copy_id(case["original_id"], case["occurrence"]) == case["expect"]


@pytest.mark.parametrize("case", REPEAT["count"], ids=lambda c: c["rule"])
def test_what_stands_at_the_original_after_completing(case: dict[str, Any]) -> None:
    following = wiederholung.next_due(case["rule"], case["repeat_from"], case["due_date"], case["on"])
    if case["expect"] is None:
        assert following is None
    else:
        assert {"repeat": wiederholung.next_rule(case["rule"]), "due_date": following.isoformat()} == case["expect"]


@pytest.mark.parametrize("case", REPEAT["invalid"], ids=lambda c: f"{c['rule']}|{c['repeat_from']}")
def test_a_rule_outside_the_subset_is_refused_by_a_put(case: dict[str, Any]) -> None:
    assert not wiederholung.validate(case["rule"], case["repeat_from"])
    fields = {"due_date": "2026-11-06", "due_time": None, "repeat": case["rule"], "repeat_from": case["repeat_from"]}
    if case["repeat_from"] not in ("due", "completion"):
        fields["repeat_from"] = case["repeat_from"]
    with pytest.raises(records.Invalid):
        records.take_apart("reminder", fields, {"due": 1})


@pytest.mark.parametrize("case", REPEAT["valid"], ids=lambda c: f"{c['rule']}|{c['repeat_from']}")
def test_a_rule_inside_the_subset_is_taken_by_a_put(case: dict[str, Any]) -> None:
    assert wiederholung.validate(case["rule"], case["repeat_from"])
    fields = {"due_date": "2026-11-06", "due_time": None, "repeat": case["rule"], "repeat_from": case["repeat_from"]}
    assert records.take_apart("reminder", fields, {"due": 1}).values["repeat"] == case["rule"]


# --- Gleichstand --------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("case", TIE["canonical"], ids=lambda c: c["expect"][:40])
def test_canonical(case: dict[str, Any]) -> None:
    assert gleichstand.canonical(case["value"]) == case["expect"]


@pytest.mark.parametrize("case", TIE["merge"],
                         ids=lambda c: f"{c['field']}|{c['stored_clock']}|{c['incoming_clock']}|{c['expect']}")
def test_merge(case: dict[str, Any]) -> None:
    got = gleichstand.merge(case["stored_value"], case["stored_clock"], case["incoming_value"], case["incoming_clock"])
    assert got == case["expect"]


# --- Position -----------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("case", POSITION["between"], ids=lambda c: f"{c['a']}|{c['b']}")
def test_key_between(case: dict[str, Any]) -> None:
    assert fractional.key_between(case["a"], case["b"]) == case["key"]


def test_thirty_appended_and_prepended() -> None:
    key, appended = None, []
    for _ in range(30):
        key = fractional.key_between(key, None)
        appended.append(key)
    assert appended == POSITION["append_30"]
    key, prepended = None, []
    for _ in range(30):
        key = fractional.key_between(None, key)
        prepended.append(key)
    assert prepended == POSITION["prepend_30"]


def test_bisecting_towards_the_lower_neighbour() -> None:
    case = POSITION["bisect_lower_20_from"]
    upper, made = case["b"], []
    for _ in range(20):
        upper = fractional.key_between(case["a"], upper)
        made.append(upper)
    assert made == case["keys"]


def test_n_keys_between() -> None:
    case = POSITION["n_keys_between"]
    assert fractional.keys_between(case["a"], case["b"], case["n"]) == case["keys"]


@pytest.mark.parametrize("case", POSITION["must_fail"], ids=lambda c: f"{c['a']}|{c['b']}")
def test_what_must_fail_fails(case: dict[str, Any]) -> None:
    with pytest.raises(fractional.KeyError_):
        fractional.key_between(case["a"], case["b"])


@pytest.mark.parametrize("case", POSITION["invalid_keys"], ids=lambda c: repr(c["key"]))
def test_the_server_refuses_every_invalid_key(case: dict[str, Any]) -> None:
    assert not records.valid_key(case["key"])
    with pytest.raises(records.Invalid) as refused:
        records.take_apart("section", {"position": case["key"]}, {"position": 1})
    assert refused.value.fields == ["position"]


def test_every_key_the_library_made_is_taken() -> None:
    made = [case["key"] for case in POSITION["between"]] + POSITION["append_30"] + POSITION["prepend_30"]
    assert all(records.valid_key(key) for key in made)


# --- Push ---------------------------------------------------------------------------------------------------------


def test_the_push_test_value_comes_out_with_the_fixed_ephemeral_key_and_nonce() -> None:
    assert PUSH["info"] == push_crypto.INFO.decode()
    enc = push_crypto.encrypt(PUSH["plaintext"].encode("utf-8"), PUSH["device_public_key"],
                              ephemeral_private=base64.b64decode(PUSH["ephemeral_private_key"]),
                              nonce=base64.b64decode(PUSH["nonce"]))
    assert enc == PUSH["enc"]
    assert push_crypto.decrypt(PUSH["enc"], PUSH["device_private_key"]).decode("utf-8") == PUSH["plaintext"]


def test_the_server_writes_the_plain_text_as_the_test_set_does() -> None:
    plain = json.loads(PUSH["plaintext"])
    message = push.Message(title=plain["title"], text=plain["text"], reminder_id=plain["reminder_id"],
                           list_id=plain["list_id"], type=plain["type"])
    assert push.plaintext(message).decode("utf-8") == PUSH["plaintext"]
    sealed = push.seal(message, PUSH["device_public_key"])
    assert push_crypto.decrypt(sealed, PUSH["device_private_key"]).decode("utf-8") == PUSH["plaintext"]
    assert sealed != push.seal(message, PUSH["device_public_key"]), "a fresh key and nonce every time"


# --- Notiz als Klartext -------------------------------------------------------------------------------------------


@pytest.mark.parametrize("case", NOTES["cases"], ids=lambda c: c["name"])
def test_note_as_plain_text(case: dict[str, Any]) -> None:
    assert notetext.plain(case["input"], case.get("lang", "de")) == case["expect"]


def test_the_note_set_is_big_enough() -> None:
    assert len(NOTES["cases"]) >= 40
