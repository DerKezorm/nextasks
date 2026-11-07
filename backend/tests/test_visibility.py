"""Who sees what (``vertrag-block1.md``, "Abgleich: holen"): members see their spaces, joining brings the whole space
through ``granted_cursor``, leaving and moves into other spaces tell ``deleted: true`` per account, assignees follow
the members, ``people`` names whom one sees."""

from __future__ import annotations

from .sync_helpers import (
    all_changes,
    changes,
    make_list,
    make_reminder,
    new_id,
    person,
    private_space,
    put,
    shared_space,
    state,
)


def test_a_stranger_sees_nothing_and_a_change_of_it_is_not_found() -> None:
    _anna, anna = person("anna")
    _ben, ben = person("ben")
    _space, list_id = private_space(anna)
    reminder = make_reminder(anna, list_id, "Diary")
    assert ("reminder", reminder) not in state(ben)
    result = put(ben, "reminder", reminder, {"title": "Mine now"})
    assert result["code"] == "not_found" and result["current"] is None
    made_there = put(ben, "reminder", new_id(), {"list_id": list_id, "title": "x", "position": "a0"})
    assert made_there["code"] == "not_found"


def test_joining_brings_the_whole_space_even_across_pages() -> None:
    _anna, anna = person("anna")
    ben_account, ben = person("ben")
    space = new_id()
    put(anna, "space", space, {"name": "Family"})
    list_id = make_list(anna, space)
    made = [make_reminder(anna, list_id, f"Thing {number}") for number in range(7)]
    before = changes(ben)["cursor"]
    link = anna.post(f"/api/app/1/spaces/{space}/invites").json()["link"]
    assert ben.post(f"/api/invites/{link.rsplit('/', 1)[-1]}/accept").json() == {"space_id": space}
    # Small pages: the whole space has the cursor of the joining, and no page may end inside it.
    items, _cursor = all_changes(ben, since=before, limit=3)
    got = {item["id"] for item in items if item["kind"] == "reminder"}
    assert got == set(made)
    assert ("space", space) in {(item["kind"], item["id"]) for item in items}
    page = changes(ben, since=before)
    assert space in page["space_ids"] and ben_account.id in {p["id"] for p in page["people"]}


def test_a_member_who_leaves_hears_that_everything_went_and_falls_out_of_assignees() -> None:
    anna_account, anna = person("anna")
    ben_account, ben = person("ben")
    space = shared_space(anna, ben)
    list_id = make_list(anna, space)
    reminder = make_reminder(anna, list_id, "Cut the grass", assignees=[ben_account.id, anna_account.id])
    since = changes(ben)["cursor"]
    assert ben.delete(f"/api/app/1/spaces/{space}/members/{ben_account.id}").status_code == 204
    page = changes(ben, since)
    gone = {(item["kind"], item["id"]) for item in page["items"] if item["deleted"]}
    assert {("space", space), ("list", list_id), ("reminder", reminder),
            ("member", f"{space}:{ben_account.id}")} <= gone
    assert space not in page["space_ids"]
    assert ("reminder", reminder) not in state(ben)
    held = state(anna)[("reminder", reminder)]
    assert held["data"]["assignees"] == [anna_account.id], "the one who left falls out"
    assert ("member", f"{space}:{ben_account.id}") not in state(anna)


def test_a_list_moved_into_another_space_goes_with_its_children_and_tells_who_lost_it() -> None:
    _anna, anna = person("anna")
    ben_account, ben = person("ben")
    family = shared_space(anna, ben, name="Family")
    _private, _first = private_space(anna)
    list_id = make_list(anna, family, "Gifts")
    section = new_id()
    assert put(anna, "section", section, {"list_id": list_id, "name": "Mum", "position": "a0"})["ok"]
    reminder = make_reminder(anna, list_id, "Scarf", assignees=[ben_account.id])
    sub = make_reminder(anna, list_id, "Wrap it", parent_id=reminder)
    since = changes(ben)["cursor"]
    since_anna = changes(anna)["cursor"]
    private_id, _ = private_space(anna)
    moved = put(anna, "list", list_id, {"space_id": private_id})
    assert moved["ok"] and moved["current"]["data"]["space_id"] == private_id
    lost = {(item["kind"], item["id"]) for item in changes(ben, since)["items"] if item["deleted"]}
    assert {("list", list_id), ("section", section), ("reminder", reminder), ("reminder", sub)} <= lost
    came = {item["id"]: item for item in changes(anna, since_anna)["items"]}
    assert {list_id, section, reminder, sub} <= set(came), "everything moved has a new cursor"
    assert came[reminder]["data"]["assignees"] == [], "nobody is assigned in a private space"


def test_moving_into_a_space_one_is_not_in_is_not_found_and_nothing_moves() -> None:
    _anna, anna = person("anna")
    _ben, ben = person("ben")
    ben_private, _ = private_space(ben)
    _private, list_id = private_space(anna)
    result = put(anna, "list", list_id, {"space_id": ben_private})
    assert result["code"] == "not_found" and result["current"]["data"]["space_id"] != ben_private


def test_a_reminder_moved_to_a_list_of_another_space_takes_its_subtasks_along() -> None:
    _anna, anna = person("anna")
    _ben, ben = person("ben")
    family = shared_space(anna, ben)
    shared_list = make_list(anna, family)
    _private, own_list = private_space(anna)
    reminder = make_reminder(anna, shared_list, "Book flights")
    sub = make_reminder(anna, shared_list, "Compare prices", parent_id=reminder)
    since = changes(ben)["cursor"]
    result = put(anna, "reminder", reminder, {"list_id": own_list, "section_id": None, "parent_id": None,
                                              "position": "a5"})
    assert result["ok"]
    held = state(anna)
    assert held[("reminder", sub)]["data"]["list_id"] == own_list, "the server took the subtask along"
    lost = {(item["kind"], item["id"]) for item in changes(ben, since)["items"] if item["deleted"]}
    assert {("reminder", reminder), ("reminder", sub)} <= lost


def test_assignees_who_are_not_members_are_struck_and_named() -> None:
    anna_account, anna = person("anna")
    ben_account, ben = person("ben")
    carl_account, _carl = person("carl")
    space = shared_space(anna, ben)
    list_id = make_list(anna, space)
    reminder = make_reminder(anna, list_id, "x")
    result = put(anna, "reminder", reminder, {"assignees": [ben_account.id, carl_account.id, 999]})
    assert result["applied"] == ["assignees"] and result["dropped_assignees"] == [carl_account.id, 999]
    assert result["current"]["data"]["assignees"] == [ben_account.id]
    _private, own = private_space(anna)
    alone = make_reminder(anna, own, "y")
    private_result = put(anna, "reminder", alone, {"assignees": [anna_account.id]})
    assert private_result["current"]["data"]["assignees"] == [] and private_result["dropped_assignees"] == [
        anna_account.id]


def test_people_are_oneself_those_one_shares_with_and_those_named_in_what_one_sees() -> None:
    anna_account, anna = person("anna")
    ben_account, ben = person("ben")
    carl_account, carl = person("carl")
    space = shared_space(anna, ben, carl)
    list_id = make_list(anna, space)
    reminder = make_reminder(carl, list_id, "Carl's")
    assert carl.delete(f"/api/app/1/spaces/{space}/members/{carl_account.id}").status_code == 204
    people = {p["id"]: p for p in changes(ben)["people"]}
    assert set(people) == {anna_account.id, ben_account.id, carl_account.id}, "Carl made something Ben sees"
    assert state(ben)[("reminder", reminder)]["data"]["created_by"] == carl_account.id
    _dora, dora = person("dora")
    assert {p["id"] for p in changes(dora)["people"]} == {p["id"] for p in changes(dora)["people"]} and len(
        changes(dora)["people"]) == 1


def test_list_settings_are_ones_own_and_nobody_elses() -> None:
    _anna, anna = person("anna")
    _ben, ben = person("ben")
    space = shared_space(anna, ben)
    list_id = make_list(anna, space)
    assert put(anna, "list_pref", list_id, {"notify_changes": True})["ok"]
    assert put(ben, "list_pref", list_id, {"show_completed": True})["ok"]
    assert state(anna)[("list_pref", list_id)]["data"] == {"id": list_id, "show_completed": False,
                                                           "notify_changes": True}
    assert state(ben)[("list_pref", list_id)]["data"]["notify_changes"] is False
    unknown = put(anna, "list_pref", new_id(), {"show_completed": True})
    assert unknown["code"] == "parent_missing"


def test_a_section_id_the_server_never_had_is_kept_and_a_parent_it_never_had_is_missing() -> None:
    _anna, anna = person("anna")
    _private, list_id = private_space(anna)
    unknown_section = new_id()
    reminder = make_reminder(anna, list_id, "x", section_id=unknown_section)
    assert state(anna)[("reminder", reminder)]["data"]["section_id"] == unknown_section
    orphan = put(anna, "reminder", new_id(), {"list_id": list_id, "title": "y", "position": "a0",
                                              "parent_id": new_id(), "section_id": None})
    assert orphan["code"] == "parent_missing"
    nowhere = put(anna, "reminder", new_id(), {"list_id": new_id(), "title": "y", "position": "a0"})
    assert nowhere["code"] == "parent_missing"


def test_the_sidebar_order_is_ones_own() -> None:
    anna_account, anna = person("anna")
    ben_account, ben = person("ben")
    space = shared_space(anna, ben)
    from .sync_helpers import batch

    [result] = batch(anna, {"type": "position", "space_id": space, "position": "a3"})
    assert result["ok"] and result["current"]["data"]["position"] == "a3"
    assert state(anna)[("member", f"{space}:{anna_account.id}")]["data"]["position"] == "a3"
    assert state(ben)[("member", f"{space}:{anna_account.id}")]["data"]["position"] is None
    [bad] = batch(anna, {"type": "position", "space_id": space, "position": "a0 "})
    assert bad["code"] == "invalid"
    [stranger] = batch(anna, {"type": "position", "space_id": new_id(), "position": "a0"})
    assert stranger["code"] == "not_found"
    _ = ben_account
