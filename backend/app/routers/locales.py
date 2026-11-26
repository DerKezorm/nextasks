"""The operator's own languages, for the language menu: the routes of the shared module ``nexsprachen`` under
``/api/locales``, the same ways as before.

Readable without signing in: the sign-in page is shown in the chosen language too, and the texts are the same for
everybody. Adding and removing is the operator's.
"""

from __future__ import annotations

from ..deps import require_operator
from ..services import locales  # noqa: F401  (configures the module before its routes answer)
from ..vendor.nexsprachen import api

#: The names the routes had in /openapi.json before the module (nextasks 0.8.0), so that a snapshot or a generated
#: client keeps working; the list and the upload's answer stay one schema ``LocaleEntry``. The template is new.
OPERATION_IDS = {
    "list": "list_locales_api_locales_get",
    "read": "read_locale_api_locales__code__get",
    "upload": "upload_locale_api_locales__code__put",
    "remove": "delete_locale_api_locales__code__delete",
}
SUMMARIES = {
    "list": "Languages the operator added",
    "read": "The texts of one added language",
    "upload": "Add or replace a language (operator)",
    "remove": "Remove an added language (operator)",
}
SCHEMA_NAMES = {"LanguageEntry": "LocaleEntry"}

router = api.router(operator=require_operator, operation_ids=OPERATION_IDS, summaries=SUMMARIES,
                    schema_names=SCHEMA_NAMES)
