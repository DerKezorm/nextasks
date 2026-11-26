"""The AI tools of nextasks (MCP, shared module ``nexmcp``, mcp 1.1.0): what is nextasks' own beside the contract tests
in ``tests/nexmcp``. Its eleven tools, a key that sees only the spaces it was given, a reading key without changing
tools, changes through the same services as ``/api/v1`` (the bin, not deleting), MCP keys and API keys never open each
other's way, programs need no tab header (they are no page), and an account blocked or disconnected: programs end,
keys made by hand rest (E41, E42), "Disconnect all" ends both."""

from __future__ import annotations

import base64
import hashlib
import secrets
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.main import app
from app.models import Account, Reminder
from app.models_mcp import McpKey
from app.services import settings_service
from app.vendor.nexmcp import brake

from .conftest import PASSWORD
from .sync_helpers import make_list, person, private_space, shared_space
from .test_api_v1 import token

TOOLS = {"list_spaces", "list_lists", "list_tasks", "read_task", "list_comments", "list_members", "create_task",
         "update_task", "complete_task", "add_comment", "delete_task", "request_status"}
REDIRECT = "http://127.0.0.1:33418/callback"


@pytest.fixture(autouse=True)
def mcp_on() -> None:
    with SessionLocal() as db:
        settings_service.save(db, {"mcp_enabled": True, "api_tokens_allowed": True})
    brake.BRAKE.forget()


def program() -> TestClient:
    """A program: no cookie, no tab header."""
    return TestClient(app, base_url="http://testserver")


def mcp_key(owner: TestClient, **body: Any) -> str:
    made = owner.post("/api/connections/keys", json={"kind": "mcp", "name": "Assistant", **body})
    assert made.status_code == 201, made.text
    secret = made.json()["secret"]
    assert secret.startswith("ntm_")
    return str(secret)


def rpc(secret: str, method: str, params: dict[str, Any] | None = None) -> Any:
    return program().post("/api/mcp", headers={"Authorization": f"Bearer {secret}"},
                          json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}})


def call(secret: str, name: str, **args: Any) -> dict[str, Any]:
    answer = rpc(secret, "tools/call", {"name": name, "arguments": args})
    assert answer.status_code == 200, answer.text
    return answer.json()["result"]


def data(result: dict[str, Any]) -> Any:
    assert not result.get("isError"), result
    return result["structuredContent"]


def names(secret: str) -> set[str]:
    return {tool["name"] for tool in rpc(secret, "tools/list").json()["result"]["tools"]}


def test_the_tools_of_nextasks() -> None:
    _account, owner = person("anna")
    private_space(owner)
    assert names(mcp_key(owner, right="write")) == TOOLS
    # A reading key: no tool that changes.
    assert names(mcp_key(owner, right="read")) == {"list_spaces", "list_lists", "list_tasks", "read_task",
                                                   "list_comments", "list_members", "request_status"}


def test_a_key_sees_only_the_spaces_it_was_given() -> None:
    anna_account, anna = person("anna")
    _ben_account, ben = person("ben")
    family = shared_space(anna, ben)
    family_list = make_list(anna, family)
    private, private_list = private_space(anna)
    secret = mcp_key(anna, right="write", areas=[private])
    spaces = {space["id"] for space in data(call(secret, "list_spaces"))["spaces"]}
    assert spaces == {private}
    seen = data(call(secret, "list_lists"))["lists"]
    assert {row["id"] for row in seen} == {private_list}
    # A task in the space the key was not given answers as if it were not there, in every tool.
    made = data(call(secret, "create_task", title="Private one"))
    assert made["list_id"] == private_list
    other = task_from_v1(anna_account, family_list, "Family one")
    for tool in ("read_task", "list_comments", "complete_task", "delete_task"):
        result = call(secret, tool, task_id=other)
        assert result["isError"] and "Not found." in result["content"][0]["text"], (tool, result)
    refused = call(secret, "create_task", title="Into the family", list_id=family_list)
    assert refused["isError"] and "Not found." in refused["content"][0]["text"]
    assert call(secret, "list_members", space_id=family)["isError"]


def task_from_v1(account: Account, list_id: str, title: str) -> str:
    made = token(account).post("/api/v1/tasks", json={"title": title, "list_id": list_id})
    assert made.status_code == 201, made.text
    return str(made.json()["id"])


def test_changes_go_through_the_services_of_the_api_and_deleting_moves_to_the_bin() -> None:
    account, anna = person("anna")
    private_space(anna)
    secret = mcp_key(anna, right="write")
    made = data(call(secret, "create_task", title="Call the plumber", due_date="2026-12-01", priority=3))
    seen = token(account).get(f"/api/v1/tasks/{made['id']}").json()
    assert (seen["title"], seen["due_date"], seen["priority"]) == ("Call the plumber", "2026-12-01", 3)
    changed = data(call(secret, "update_task", task_id=made["id"], title="Call the plumber today", due_date=None))
    assert changed["title"] == "Call the plumber today" and changed["due_date"] is None
    assert data(call(secret, "complete_task", task_id=made["id"]))["completed"] is True
    assert data(call(secret, "list_tasks", state="completed"))["tasks"][0]["id"] == made["id"]
    assert data(call(secret, "delete_task", task_id=made["id"])) == {"id": made["id"], "trashed": True}
    with SessionLocal() as db:
        row = db.get(Reminder, made["id"])
        assert row is not None, "moved to the bin, not deleted"
    assert token(account).get(f"/api/v1/tasks/{made['id']}").json()["trashed"] is True
    # A wrong value is the tool's answer, not a failure of the server.
    wrong = call(secret, "create_task", title="Wrong", due_date="tomorrow")
    assert wrong["isError"] and "due_date" in wrong["content"][0]["text"]


def test_an_mcp_key_never_opens_the_api_and_an_api_key_never_opens_mcp() -> None:
    account, anna = person("anna")
    private_space(anna)
    secret = mcp_key(anna)
    assert program().get("/api/v1/me", headers={"Authorization": f"Bearer {secret}"}).status_code == 401
    made = anna.post("/api/connections/keys", json={"kind": "api", "name": "Script", "areas": "all"})
    assert made.status_code == 201, made.text
    assert rpc(made.json()["secret"], "ping").status_code == 401
    assert token(account).get("/api/v1/me").status_code == 200


def _pkce() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge


def connect(owner: TestClient) -> dict[str, Any]:
    """A program registers and trades its code without a tab header (it is no page); the account agrees in its
    browser."""
    registered = program().post("/api/oauth/register", json={"client_name": "Probe program", "redirect_uris": [REDIRECT]})
    assert registered.status_code == 201, registered.text
    client_id = registered.json()["client_id"]
    verifier, challenge = _pkce()
    params = {"client_id": client_id, "redirect_uri": REDIRECT, "response_type": "code", "code_challenge": challenge,
              "code_challenge_method": "S256", "state": "s1"}
    assert owner.get("/api/oauth/authorize", params=params).status_code == 200
    agreed = owner.post("/api/oauth/authorize", json={**params, "allow": True, "level": "write"})
    assert agreed.status_code == 200, agreed.text
    code = parse_qs(urlsplit(agreed.json()["redirect"]).query)["code"][0]
    traded = program().post("/api/oauth/token", data={"grant_type": "authorization_code", "code": code,
                                                      "redirect_uri": REDIRECT, "client_id": client_id,
                                                      "code_verifier": verifier})
    assert traded.status_code == 200, traded.text
    return {"client_id": client_id, **traded.json()}


def test_programs_speak_oauth_without_the_header_of_a_page() -> None:
    _account, anna = person("anna")
    private_space(anna)
    tokens = connect(anna)
    assert tokens["access_token"].startswith("ntm_") and tokens["refresh_token"].startswith("ntmr_")
    assert rpc(tokens["access_token"], "ping").status_code == 200
    renewed = program().post("/api/oauth/token", data={"grant_type": "refresh_token", "client_id": tokens["client_id"],
                                                       "refresh_token": tokens["refresh_token"]})
    assert renewed.status_code == 200, renewed.text
    # The metadata name nextasks' ways.
    found = program().get("/.well-known/oauth-authorization-server").json()
    assert found["token_endpoint"].endswith("/api/oauth/token")


def _block(operator: TestClient, account: Account, on: bool) -> None:
    answer = operator.post(f"/api/accounts/{account.id}/{'block' if on else 'unblock'}",
                           json={"current_password": PASSWORD})
    assert answer.status_code == 204, answer.text


def test_blocking_ends_the_programs_and_rests_the_keys_made_by_hand(client: TestClient, operator: Account) -> None:
    account, anna = person("anna")
    private_space(anna)
    secret = mcp_key(anna)
    tokens = connect(anna)
    _block(client, account, True)
    assert rpc(secret, "ping").status_code == 401
    assert rpc(tokens["access_token"], "ping").status_code == 401
    _block(client, account, False)
    # E41: the key made by hand works again; E42: the program was disconnected and connects anew.
    assert rpc(secret, "ping").status_code == 200
    assert rpc(tokens["access_token"], "ping").status_code == 401
    with SessionLocal() as db:
        left = db.query(McpKey).filter_by(account_id=account.id).all()
        assert [row.client_id for row in left] == [None]


def test_disconnect_all_ends_mcp_keys_and_programs_too() -> None:
    account, anna = person("anna")
    private_space(anna)
    secret = mcp_key(anna)
    tokens = connect(anna)
    listed = anna.get("/api/auth/access").json()
    assert sum(1 for entry in listed["access"] if str(entry["id"]).startswith("mcp-")) == 2
    answer = anna.post("/api/auth/access/disconnect")
    assert answer.status_code == 200, answer.text
    assert rpc(secret, "ping").status_code == 401
    assert rpc(tokens["access_token"], "ping").status_code == 401
    with SessionLocal() as db:
        assert db.query(McpKey).filter_by(account_id=account.id).count() == 0
