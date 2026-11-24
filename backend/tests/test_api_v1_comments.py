"""Comments through ``/api/v1`` (``docs/api.md``, "Comments"; word ``comments``): read and write the comments of a
task the token sees, in shared spaces only; a reading token reads, a token limited to some spaces sees no others."""

from __future__ import annotations

from .sync_helpers import make_reminder, new_id, now_ms, person, private_space, put
from .test_api_v1 import V1, api_on, family, ok, refused, token  # noqa: F401


def test_me_names_comments() -> None:
    anna_account, _anna = person("anna")
    assert "comments" in ok(token(anna_account).get(f"{V1}/me"))["features"]


def test_a_program_writes_a_comment_and_reads_them_with_the_interface_ones() -> None:
    anna_account, anna, ben_account, _ben, _space, list_id = family()
    task = make_reminder(anna, list_id, title="Bins")
    earlier = new_id()
    assert put(anna, "comment", earlier, {"reminder_id": task, "text": "Who?", "mentions": []},
               {"text": now_ms()})["ok"]
    made = ok(token(ben_account).post(f"{V1}/tasks/{task}/comments",
                                      json={"text": "  Me, @anna  ", "mentions": [anna_account.id, 777]}), 201)
    assert made["text"] == "Me, @anna" and made["task_id"] == task and made["removed"] is False
    assert made["author"] == {"id": ben_account.id, "name": "ben", "display_name": "ben"}
    assert [person["id"] for person in made["mentions"]] == [anna_account.id]
    found = ok(token(anna_account, "read").get(f"{V1}/tasks/{task}/comments"))["comments"]
    assert [comment["text"] for comment in found] == ["Who?", "Me, @anna"]
    assert found[0]["id"] == earlier and found[0]["edited_at"] is None


def test_what_a_program_may_not_do_with_comments() -> None:
    anna_account, anna, _ben_account, _ben, space, list_id = family()
    task = make_reminder(anna, list_id)
    refused(token(anna_account, "read").post(f"{V1}/tasks/{task}/comments", json={"text": "x"}), 403,
            "token_reads_only")
    body = refused(token(anna_account).post(f"{V1}/tasks/{task}/comments", json={"text": "   "}), 422,
                   "invalid_input")
    assert body["fields"] == ["text"]
    refused(token(anna_account).post(f"{V1}/tasks/{task}/comments", json={"text": "x", "mentions": "all"}), 422,
            "invalid_input")
    private, first = private_space(anna)
    own = make_reminder(anna, first)
    refused(token(anna_account).post(f"{V1}/tasks/{own}/comments", json={"text": "x"}), 403, "private_space")
    narrow = token(anna_account, "write", [private])
    refused(narrow.get(f"{V1}/tasks/{task}/comments"), 404, "not_found")
    refused(narrow.post(f"{V1}/tasks/{task}/comments", json={"text": "x"}), 404, "not_found")
    _cleo_account, _cleo = person("cleo")
    refused(token(_cleo_account).get(f"{V1}/tasks/{task}/comments"), 404, "not_found")
    refused(token(anna_account).get(f"{V1}/tasks/{new_id()}/comments"), 404, "not_found")
    assert space
