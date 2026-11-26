"""The operator's own languages, for the language menu: the routes of the shared module ``nexsprachen`` under
``/api/locales``, the same ways as before.

Readable without signing in: the sign-in page is shown in the chosen language too, and the texts are the same for
everybody. Adding and removing is the operator's.
"""

from __future__ import annotations

from ..deps import require_operator
from ..services import locales  # noqa: F401  (configures the module before its routes answer)
from ..vendor.nexsprachen import api

router = api.router(operator=require_operator)
