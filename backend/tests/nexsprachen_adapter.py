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
            self._clients[role] = new_client(None if role == "anonymous" else self._accounts[role])
        return self._clients[role]
