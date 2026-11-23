"""Own colours (contract 0.8, word ``own_colors``): a space, a list and a filter take ``#rrggbb`` in lower case
besides the fixed names, as nexnotes' folders do. Anything else stays refused."""

from __future__ import annotations

from app.db import SessionLocal
from app.routers.app1 import features

from .sync_helpers import make_list, new_id, person, private_space, put, state


def test_space_list_and_filter_take_an_own_colour_and_keep_it() -> None:
    _anna, anna = person("anna")
    space_id, _first = private_space(anna)
    list_id = make_list(anna, space_id)
    filter_id = new_id()
    assert put(anna, "space", space_id, {"color": "#1e3a8a"})["ok"]
    assert put(anna, "list", list_id, {"color": "#ff5a5f"})["ok"]
    assert put(anna, "filter", filter_id, {"name": "Mine", "position": "a0", "color": "#00aa00"})["ok"]
    held = state(anna)
    assert held[("space", space_id)]["data"]["color"] == "#1e3a8a"
    assert held[("list", list_id)]["data"]["color"] == "#ff5a5f"
    assert held[("filter", filter_id)]["data"]["color"] == "#00aa00"
    # Back to a fixed one works as before.
    assert put(anna, "list", list_id, {"color": "teal"})["ok"]
    assert state(anna)[("list", list_id)]["data"]["color"] == "teal"


def test_only_six_lower_case_hex_digits_count_as_an_own_colour() -> None:
    _anna, anna = person("anna")
    space_id, _first = private_space(anna)
    list_id = make_list(anna, space_id)
    for bad in ("#1E3A8A", "1e3a8a", "#123", "#1e3a8a0", "#gggggg", "beige", "", None, 5):
        wrong = put(anna, "list", list_id, {"color": bad})
        assert wrong["code"] == "invalid" and wrong["fields"] == ["color"], bad


def test_the_server_names_own_colors_among_its_features() -> None:
    with SessionLocal() as db:
        assert "own_colors" in features(db)
