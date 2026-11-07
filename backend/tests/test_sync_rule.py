"""The rule per field (``datenmodell.md``, "Uhren und Abgleich"): a later clock wins, the same clock goes to the
canonically greater value, equal values change nothing, groups go whole, clocks from the future are capped, and the
server answers what it took and what it left."""

from __future__ import annotations

from app.services import clock

from .sync_helpers import batch, changes, make_reminder, now_ms, person, private_space, put, put_op, state


def _reminder() -> tuple[object, str, str]:
    _account, browser = person("anna")
    _space, list_id = private_space(browser)
    return browser, list_id, make_reminder(browser, list_id, "Milk")


def test_a_later_clock_wins_an_earlier_one_is_left_and_says_so() -> None:
    browser, _list, reminder = _reminder()
    base = now_ms()
    assert put(browser, "reminder", reminder, {"title": "B"}, base + 10)["applied"] == ["title"]
    stale = put(browser, "reminder", reminder, {"title": "A"}, base + 5)
    assert stale["ok"] and stale["applied"] == [] and stale["ignored"] == ["title"]
    assert stale["current"]["data"]["title"] == "B" and stale["current"]["clock"]["title"] == base + 10


def test_with_the_same_clock_the_canonically_greater_value_wins_on_both_orders() -> None:
    browser, _list, reminder = _reminder()
    moment = now_ms()
    put(browser, "reminder", reminder, {"title": "Apfel"}, moment)
    # "Äpfel" is greater than "Apfel" as UTF-8 bytes (0xC3 > 0x41), whichever arrives first.
    assert put(browser, "reminder", reminder, {"title": "Äpfel"}, moment)["applied"] == ["title"]
    assert put(browser, "reminder", reminder, {"title": "Apfel"}, moment)["ignored"] == ["title"]
    assert state(browser)[("reminder", reminder)]["data"]["title"] == "Äpfel"


def test_equal_values_with_equal_clocks_change_nothing_not_even_the_cursor() -> None:
    browser, _list, reminder = _reminder()
    moment = now_ms()
    first = put(browser, "reminder", reminder, {"title": "Same"}, moment)
    again = put(browser, "reminder", reminder, {"title": "Same"}, moment)
    assert again["applied"] == [] and again["ignored"] == ["title"]
    assert again["current"]["cursor"] == first["current"]["cursor"]


def test_a_later_clock_with_the_same_value_moves_the_clock_up() -> None:
    browser, _list, reminder = _reminder()
    moment = now_ms()
    put(browser, "reminder", reminder, {"title": "Same"}, moment)
    later = put(browser, "reminder", reminder, {"title": "Same"}, moment + 1)
    assert later["applied"] == ["title"] and later["current"]["clock"]["title"] == moment + 1


def test_different_fields_both_hold_whatever_the_order() -> None:
    browser, _list, reminder = _reminder()
    moment = now_ms()
    results = batch(browser, put_op("reminder", reminder, {"notes": "two litres"}, moment + 2),
                    put_op("reminder", reminder, {"flagged": True}, moment + 1))
    assert [r["applied"] for r in results] == [["notes"], ["flagged"]]
    data = state(browser)[("reminder", reminder)]["data"]
    assert data["notes"] == "two litres" and data["flagged"] is True


def test_a_group_goes_whole_and_is_compared_as_one_object() -> None:
    browser, _list, reminder = _reminder()
    half = put(browser, "reminder", reminder, {"due_date": "2026-11-07"})
    assert half["code"] == "invalid" and half["fields"] == ["due_time", "repeat", "repeat_from"]
    moment = now_ms()
    whole = {"due_date": "2026-11-07", "due_time": "09:00", "repeat": None, "repeat_from": "due"}
    taken = put(browser, "reminder", reminder, whole, {"due": moment})
    assert taken["applied"] == ["due"] and taken["current"]["clock"]["due"] == moment
    # Same clock: the object with the greater canonical form wins ("10:00" > "09:00").
    later = {**whole, "due_time": "10:00"}
    assert put(browser, "reminder", reminder, later, {"due": moment})["applied"] == ["due"]
    assert put(browser, "reminder", reminder, whole, {"due": moment})["ignored"] == ["due"]


def test_a_clock_far_in_the_future_is_set_to_the_servers_now() -> None:
    browser, _list, reminder = _reminder()
    future = now_ms() + 3_600_000
    taken = put(browser, "reminder", reminder, {"title": "From the future"}, future)
    assert taken["applied"] == ["title"]
    assert taken["current"]["clock"]["title"] < future - 3_000_000
    # Two seconds ahead are left as they are (a clock that runs a little fast).
    close = now_ms() + 1500
    assert put(browser, "reminder", reminder, {"notes": "x"}, close)["current"]["clock"]["notes"] == close


def test_the_server_moves_its_own_clock_and_the_rule_follows() -> None:
    browser, _list, reminder = _reminder()
    clock.shift(10_000)
    ahead = now_ms()
    assert put(browser, "reminder", reminder, {"title": "Later"}, ahead)["current"]["clock"]["title"] == ahead


def test_what_only_the_server_sets_is_named_as_ignored() -> None:
    browser, list_id, _reminder_id = _reminder()
    result = put(browser, "reminder", make_reminder(browser, list_id, "x"), {
        "title": "y", "created_by": 99, "private": True, "role": "manager"})
    assert result["applied"] == ["title"] and result["ignored"] == ["created_by", "private", "role"]


def test_wrong_values_are_named_and_nothing_of_the_op_is_taken() -> None:
    browser, _list, reminder = _reminder()
    result = put(browser, "reminder", reminder, {"title": "  ", "priority": 4, "url": "javascript:alert(1)",
                                                 "tags": ["a b"], "flagged": True})
    assert result["code"] == "invalid" and result["fields"] == ["priority", "tags", "title", "url"]
    assert result["current"]["data"]["flagged"] is False
    bad_clock = put(browser, "reminder", reminder, {"notes": "x"}, {"notes": -1})
    assert bad_clock["code"] == "invalid" and bad_clock["fields"] == ["clock.notes"]
    unknown = put(browser, "reminder", reminder, {"colour": "red"})
    assert unknown["code"] == "invalid" and unknown["fields"] == ["colour"]


def test_texts_are_nfc_without_blanks_at_the_ends_and_counted_in_code_points() -> None:
    browser, _list, reminder = _reminder()
    decomposed = "Café "
    assert put(browser, "reminder", reminder, {"title": decomposed})["current"]["data"]["title"] == "Café"
    assert put(browser, "reminder", reminder, {"title": "🛒" * 500})["ok"]
    assert put(browser, "reminder", reminder, {"title": "🛒" * 501})["code"] == "invalid"


def test_completed_at_comes_only_through_complete_and_a_put_may_reopen() -> None:
    browser, list_id, reminder = _reminder()
    done = put(browser, "reminder", reminder, {"completed_at": "2026-11-06T09:00:00.000Z", "completed_by": 1},
               {"completion": now_ms()})
    assert done["code"] == "invalid" and done["fields"] == ["completed_at"]
    # Made already done (moved over from the phone): taken, and the server names who brought it.
    moved = put(browser, "reminder", "00000000-0000-4000-8000-0000000000aa", {
        "list_id": list_id, "title": "Old", "position": "a5", "completed_at": "2026-11-01T08:00:00.000Z",
        "completed_by": None})
    assert moved["ok"] and moved["current"]["data"]["completed_at"] == "2026-11-01T08:00:00.000Z"
    assert moved["current"]["data"]["completed_by"] is not None
    reopened = put(browser, "reminder", moved["current"]["id"], {"completed_at": None, "completed_by": None},
                   {"completion": now_ms()})
    assert reopened["applied"] == ["completion"] and reopened["current"]["data"]["completed_by"] is None


def test_making_needs_the_required_fields_and_takes_a_created_at_not_in_the_future() -> None:
    browser, list_id, _reminder_id = _reminder()
    missing = put(browser, "reminder", "00000000-0000-4000-8000-0000000000bb", {"title": "x"})
    assert missing["code"] == "invalid" and missing["fields"] == ["list_id", "position"]
    early = put(browser, "reminder", "00000000-0000-4000-8000-0000000000cc", {
        "list_id": list_id, "title": "x", "position": "a3", "created_at": "2026-01-02T03:04:05.678Z"})
    assert early["current"]["data"]["created_at"] == "2026-01-02T03:04:05.678Z"
    late = put(browser, "reminder", "00000000-0000-4000-8000-0000000000dd", {
        "list_id": list_id, "title": "x", "position": "a4", "created_at": "2999-01-01T00:00:00.000Z"})
    assert late["current"]["data"]["created_at"] < "2999"


def test_ids_with_capitals_are_refused() -> None:
    browser, list_id, _reminder_id = _reminder()
    result = put(browser, "reminder", "6F1C2A9E-4B7D-4C1E-9A3F-2D5E8B7C1A40", {
        "list_id": list_id, "title": "x", "position": "a0"})
    assert result["code"] == "invalid" and result["fields"] == ["id"]


def test_every_change_gets_a_cursor_of_its_own() -> None:
    browser, list_id, reminder = _reminder()
    other = make_reminder(browser, list_id, "Bread")
    cursors = []
    for title in ("one", "two"):
        for item in (reminder, other):
            cursors.append(put(browser, "reminder", item, {"title": title})["current"]["cursor"])
    assert cursors == sorted(set(cursors)) and len(cursors) == 4
    page = changes(browser, since=cursors[1])
    assert [item["cursor"] for item in page["items"]] == cursors[2:]
