"""The server's error codes (Prüfgang H3, H18): the scan finds them, the shared module has a sentence for each of its
own, and no API message is the code with its underscores gone. Whether the new web interface has a sentence for each
code is the web's test (its language files are rebuilt with it).

The codes are read from the source: ``error("code", ...)``, the typed errors (``TaskError("code")`` and the like), the
middleware's refusals and the sign-in redirects (``?error=code``). A code built at run time is named in ``BUILT``
with where it comes from.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.models import Account
from app.vendor.nexoidc import CODES, FORM_CODES

ROOT = Path(__file__).resolve().parents[2]
APP = ROOT / "backend" / "app"
FRONTEND = ROOT / "frontend" / "src"

#: Codes put together at run time, with their source.
BUILT = {
    # routers/oidc.py: the shared module's own codes, passed on (``error(exc.code, ...)``, ``?error=``)
    *CODES,
    *FORM_CODES,
    # services/sync.py: the codes of a ``Result`` (``Failed(...)``), named in the contract
    "forbidden", "invalid", "parent_missing", "gone", "already_done", "due_changed",
}
#: The shared module's codes have their sentences with the module (``oidc.error.<code>``, ``oidc.formError.<code>``,
#: frontend ``src/vendor/nexoidc``); the page finds them there when ``errors.<code>`` has none (``lib/errors.ts``).
MODULE_TEXTS = set(CODES) | set(FORM_CODES)

#: Typed errors that carry an error code to the page.
TYPED = "Account|Avatar|Backup|Locale|Mail|Media|Oidc|Pairing|Token"
RAISED = re.compile(
    rf"""(?:\berror|(?:{TYPED})Error|\brefuse\w*|_to_login|_to_account|_refuse\(\d+,)\(?\s*"([a-z][a-z0-9_]+)\""""
)


def _sources(folder: Path, suffixes: tuple[str, ...]) -> str:
    return "\n".join(
        path.read_text(encoding="utf-8")
        for path in sorted(folder.rglob("*"))
        if path.suffix in suffixes and ".test." not in path.name and "i18n" not in path.parts
        and "vendor" not in path.parts
    )


def server_codes() -> set[str]:
    """Also what ``tools``-side lists for the web are made from (``python -c`` on this function)."""
    return set(RAISED.findall(_sources(APP, (".py",)))) | BUILT


def texts(language: str) -> dict[str, str]:
    return json.loads((FRONTEND / "i18n" / f"{language}.json").read_text(encoding="utf-8"))["errors"]


def test_the_scan_finds_the_codes_it_should() -> None:
    codes = server_codes()
    # One of each way in: error(), a typed error, a refusal of the middleware, a sign-in redirect.
    assert {"not_found", "app_pairing_unknown", "too_large", "bad_client", "oidc_not_configured", "token_invalid"} <= codes


@pytest.mark.parametrize("language", ["de", "en"])
def test_the_shared_module_has_a_sentence_for_each_of_its_codes(language: str) -> None:
    shared = json.loads((FRONTEND / "vendor" / "nexoidc" / f"oidc.{language}.json").read_text(encoding="utf-8"))
    assert sorted(set(CODES) - set(shared["oidc"]["error"])) == []
    assert sorted(set(FORM_CODES) - set(shared["oidc"]["formError"])) == []


def test_no_api_message_is_the_code_spelt_out() -> None:
    source = _sources(APP, (".py",))
    assert ".code.replace(" not in source
    from app.services import avatars

    for code, text in avatars.MESSAGES.items():
        assert text.endswith(".") and text[0].isupper() and text.lower().rstrip(".") != code.replace("_", " ")
    raised = set(re.findall(r'AvatarError\(\s*"([a-z_]+)"', source))
    assert raised and sorted(raised - set(avatars.MESSAGES)) == []


def test_no_other_app_speaks_in_the_server() -> None:
    assert re.findall(r"notes\.example\.com|Give an address", _sources(APP, (".py",))) == []


def test_the_api_says_a_sentence_for_a_picture(client: TestClient, operator: Account) -> None:
    refused = client.put("/api/auth/avatar", content=b"not a picture").json()["detail"]
    assert refused["code"] == "avatar_not_a_picture"
    assert refused["message"] == "That is not a picture nextasks accepts (JPEG, PNG, WebP, GIF, HEIC or AVIF)."


def test_a_file_that_is_not_there_answers_like_every_not_found(client: TestClient) -> None:
    for path in ("/assets/index-gone.js", "/api/no/such/route"):
        answer = client.get(path)
        assert answer.status_code == 404, path
        assert answer.json() == {"detail": {"code": "not_found", "message": "Not found."}}, path
