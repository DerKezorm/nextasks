"""nexsprachen contract tests: nextasks' adapter (from the module's ``tests-fuer-apps/adapter_template.py``).

The app as in production: files in ``NEXTASKS_LOCALES_DIR`` (the tests' data folder), German and English built in,
readable without signing in (the sign-in page speaks the chosen language), the routes under ``/api/locales``, refusals
in nextasks' form (``{"detail": {"code", "message", …}}``, the module's default), the template made by the page.
"""

from __future__ import annotations

import json
import secrets
import shutil
from pathlib import Path
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
    # nextasks publishes it under /api/openapi.json only with NEXTASKS_API_DOCS (off in the tests): description()
    # below hands over the app's own.
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

    def restart(self) -> None:
        # As main.lifespan does at the app's start: configure, then tidy_at_start (the data stay).
        from app.services import locales

        locales.start()

    def client(self, role: str) -> Any:
        from tests.conftest import new_client

        if role not in self._clients:
            self._clients[role] = new_client(None if role == "anonymous" else self._accounts[role])
        return self._clients[role]

    def offered_template(self) -> dict[str, Any]:
        """The template as the page offers it: ``ENGLISH`` of ``frontend/src/i18n/index.ts`` (nextasks' English, the
        sign-in words with invitations and several accounts, those of accounts and of system mail, merged at the top),
        through ``texts_only``, with ``_meta``."""
        from app.vendor import nexsprachen

        source = Path(__file__).resolve().parents[2] / "frontend" / "src"

        def read(part: str) -> dict[str, Any]:
            found: dict[str, Any] = json.loads((source / part).read_text(encoding="utf-8"))
            return found

        oidc = read("vendor/nexoidc/oidc.en.json")
        oidc["oidc"] = {key: value for key, value in oidc["oidc"].items() if key not in ("single", "noInvitations")}
        english = {**read("i18n/en.json"), **oidc, **read("vendor/nexkonten/konten.en.json"),
                   **read("vendor/nexpost/post.en.json")}
        return {"_meta": {"name": "Name of the language in itself, for example Nederlands"},
                **nexsprachen.texts_only(english)}

    def description(self) -> dict[str, Any]:
        # The app's own description, as /api/openapi.json shows it with NEXTASKS_API_DOCS; never published for tests.
        from app.main import app

        return app.openapi()

