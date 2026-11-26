"""nexsprachen contract tests: nextasks' adapter (from the module's ``tests-fuer-apps/adapter_template.py``).

The app as in production: files in ``NEXTASKS_LOCALES_DIR`` (the tests' data folder), German and English built in,
readable without signing in (the sign-in page speaks the chosen language), the routes under ``/api/locales``, refusals
in nextasks' form (``{"detail": {"code", "message", …}}``, the module's default), the template made by the page.
"""

from __future__ import annotations

import secrets
import shutil
from typing import Any, ClassVar

from sprachen_contract import StandardAdapter


class Adapter(StandardAdapter):
    package = "app.vendor.nexsprachen"
    prefix = "/api/locales"
    also: tuple[str, ...] = ()
    built_in: ClassVar[dict[str, str]] = {"de": "Deutsch", "en": "English"}
    public_read = True
    # The page makes the template from its English texts (as nexnotes); the server has none.
    has_template = False
    # The names the routes had in the description before the module (routers/locales.py gives them to the router).
    # nextasks serves it under /api/openapi.json only with NEXTASKS_API_DOCS (off in the tests); the clients below
    # answer that path with what the app would serve there, app.openapi().
    openapi_path = "/api/openapi.json"
    operation_ids: ClassVar[dict[str, str]] = {
        "list": "list_locales_api_locales_get",
        "read": "read_locale_api_locales__code__get",
        "upload": "upload_locale_api_locales__code__put",
        "remove": "delete_locale_api_locales__code__delete",
    }
    summaries: ClassVar[dict[str, str]] = {
        "list": "Languages the operator added",
        "read": "The texts of one added language",
        "upload": "Add or replace a language (operator)",
        "remove": "Remove an added language (operator)",
    }
    schema_names: ClassVar[dict[str, str]] = {"LanguageEntry": "LocaleEntry"}

    def start(self) -> None:
        from app.models import MEMBER, OPERATOR
        from app.services import locales
        from tests.conftest import make_account

        # An empty folder of own languages: what an earlier test left there does not count.
        folder = locales.locales_dir()
        shutil.rmtree(folder, ignore_errors=True)
        folder.mkdir(parents=True)
        locales.forget()
        self._accounts = {
            "operator": make_account("boss", OPERATOR, password=secrets.token_urlsafe(12)),
            "member": make_account("robin", MEMBER, password=secrets.token_urlsafe(12)),
        }
        self._clients: dict[str, Any] = {}

    def stop(self) -> None:
        from app.services import locales

        for client in self._clients.values():
            client.close()
        shutil.rmtree(locales.locales_dir(), ignore_errors=True)
        locales.forget()

    def client(self, role: str) -> Any:
        from tests.conftest import new_client

        if role not in self._clients:
            self._clients[role] = _Described(new_client(None if role == "anonymous" else self._accounts[role]),
                                             self.openapi_path)
        return self._clients[role]


class _Described:
    """A client of the app that also answers the description's path, as FastAPI's own route there would."""

    def __init__(self, client: Any, path: str) -> None:
        self._client = client
        self._path = path

    def get(self, url: str, *args: Any, **kwargs: Any) -> Any:
        if url == self._path:
            from fastapi.responses import JSONResponse
            from httpx import Response

            from app.main import app

            shown = JSONResponse(app.openapi())
            return Response(200, content=shown.body, headers={"content-type": "application/json"})
        return self._client.get(url, *args, **kwargs)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._client, name)
