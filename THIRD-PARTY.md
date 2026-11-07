# Third-party licences

nextasks itself is licensed under the **GNU Affero General Public License v3.0** (see [LICENSE](LICENSE)). This file
lists what it ships or depends on.

## Bundled with the app

These travel inside the container image.

| What | Copyright | Licence |
|---|---|---|
| Font Inter (via Fontsource) | The Inter Project Authors | OFL-1.1 |
| Lucide icons (partly from Feather) | Lucide Icons and Contributors; Cole Bemis | ISC, MIT |

nextasks loads no font, icon or script from another host.

## Backend

| Package | Licence |
|---|---|
| FastAPI, SQLAlchemy, pydantic, pydantic-settings, argon2-cffi, PyJWT, http-ece | MIT |
| uvicorn, httpx, segno | BSD-3-Clause |
| Pillow | MIT-CMU |
| python-multipart | Apache-2.0 |
| cryptography | Apache-2.0 **or** BSD-3-Clause |
| tzdata | Apache-2.0 |
| pillow-heif | BSD-3-Clause for its own code; the binary wheels are **GPLv2** as a whole, see below |

### HEIC photos: pillow-heif and the libraries it brings

To read profile pictures taken on an iPhone (HEIC), nextasks uses pillow-heif. Its binary wheels, and so the
container image, contain:

| Library | Licence |
|---|---|
| libheif | LGPL-3.0 |
| libde265 | LGPL-3.0 |
| x265 | GPL-2.0-or-later |

The wheel ships these notices in `pillow_heif-*.dist-info/licenses/`. GPL-2.0-or-later and LGPL-3.0 may be combined
with an AGPL-3.0 work, and the source of every part is public.

## Frontend

| Package | Licence |
|---|---|
| React, React DOM, React Router, i18next, react-i18next | MIT |
| lucide-react | ISC |
| Milkdown (`@milkdown/kit`) with ProseMirror, remark and micromark, for the note editor | MIT |
| fractional-indexing, for the order of lists and tasks | CC0-1.0 |
| Fontsource packages | MIT (the font itself OFL-1.1, see above) |

Build and test tools (Vite, TypeScript, Tailwind CSS, ESLint, Vitest, ruff, pytest) are not part of the image.

## Compatibility

All of the above may be combined into an AGPL-3.0 work. The obligation runs one way: nextasks as a whole is AGPL-3.0,
and anyone who runs a modified version as a network service must offer its source.
