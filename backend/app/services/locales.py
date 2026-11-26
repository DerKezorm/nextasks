"""The operator's own languages: JSON files in ``<data_dir>/locales`` (``NEXTASKS_LOCALES_DIR``), now the shared
module ``nexsprachen`` (sprachen 1.0.0, E51). English and German ship inside the frontend; every further language is
one file named after its code (``es.json``, ``pt-BR.json``), and a file for ``en`` or ``de`` lays its texts over the
shipped ones. The folder stayed where it was, so files of before count as they did.

Configured here, once, when anything first imports this module; the names of before (``available``, ``load``,
``valid_code``, ``save``, ``remove``, ``forget``, ``MAX_BYTES`` …) come from the module unchanged.
"""

from __future__ import annotations

from pathlib import Path

from ..config import get_settings
from ..vendor import nexsprachen
from ..vendor.nexsprachen import *  # the names of before, from the module


def _folder() -> Path:
    folder = get_settings().locales_dir
    assert folder is not None  # the settings fill it in: <data_dir>/locales
    return folder


CONFIG = nexsprachen.configure(nexsprachen.AppConfig(
    app_name="nextasks",
    folder=_folder,
    built_in={"de": "Deutsch", "en": "English"},
    # The template comes from the page, which knows the English texts (as nexnotes).
))
