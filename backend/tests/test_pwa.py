"""The installable web app: the manifest and the symbols the web ships (``frontend/public``), the head of ``index.html``,
and how the server hands them out (``main._mount_frontend``): the manifest with its type, the service worker always
fetched anew, both allowed by the Content Security Policy from the own origin only."""

from __future__ import annotations

import json
import shutil
import struct
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.main import _mount_frontend, app

WEB = Path(__file__).resolve().parents[2] / "frontend"
PUBLIC = WEB / "public"


def png(path: Path) -> tuple[int, int, int]:
    """Width, height and colour type (2 RGB, 6 RGBA) from the PNG's header."""
    head = path.read_bytes()[:26]
    assert head[:8] == b"\x89PNG\r\n\x1a\n" and head[12:16] == b"IHDR", path
    width, height = struct.unpack(">II", head[16:24])
    return width, height, head[25]


def test_the_manifest_makes_an_installable_app_that_starts_on_today() -> None:
    manifest = json.loads((PUBLIC / "manifest.webmanifest").read_text(encoding="utf-8"))
    assert manifest["name"] == "nextasks" and manifest["short_name"] == "nextasks"
    assert (manifest["start_url"], manifest["scope"], manifest["display"]) == ("/today", "/", "standalone")
    assert manifest["lang"] and manifest["id"]
    # The calm ground of "Aussehen" (principle 9), light: the splash and the frame are the page's own.
    assert manifest["background_color"] == "#f4f6f7" and manifest["theme_color"] == "#f4f6f7"
    icons = {(icon["sizes"], icon["purpose"]): icon["src"] for icon in manifest["icons"]}
    assert set(icons) == {("192x192", "any"), ("512x512", "any"), ("192x192", "maskable"), ("512x512", "maskable")}
    for (sizes, purpose), src in icons.items():
        width, height, colour = png(PUBLIC / src.lstrip("/"))
        assert f"{width}x{height}" == sizes, src
        # A maskable symbol is cut to any shape: white to every edge, nothing clear.
        assert colour == (2 if purpose == "maskable" else 6), src
    shortcuts = {shortcut["name"]: shortcut["url"] for shortcut in manifest["shortcuts"]}
    assert shortcuts == {"New task": "/today?reminder=new", "Today": "/today"}


def test_the_apple_symbol_is_white_to_the_edges_and_180_wide() -> None:
    assert png(PUBLIC / "icons" / "apple-touch-icon.png") == (180, 180, 2)


def test_the_start_page_names_the_manifest_and_the_frame_light_and_dark() -> None:
    page = (WEB / "index.html").read_text(encoding="utf-8")
    for part in ('<link rel="manifest" href="/manifest.webmanifest" />',
                 '<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />',
                 '<meta name="apple-mobile-web-app-capable" content="yes" />',
                 '<meta name="theme-color" media="(prefers-color-scheme: light)" content="#f4f6f7" />',
                 '<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0f1417" />',
                 "viewport-fit=cover"):
        assert part in page, part


def _served(tmp_path: Path) -> TestClient:
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_bytes(b"<!doctype html><title>nextasks</title>")
    for name in ("manifest.webmanifest", "sw.js"):
        shutil.copy(PUBLIC / name, dist / name)
    shutil.copytree(PUBLIC / "icons", dist / "icons")
    served = FastAPI()
    _mount_frontend(served, dist)
    return TestClient(served)


def test_the_server_hands_out_manifest_worker_and_symbols_with_fitting_headers(tmp_path: Path) -> None:
    client = _served(tmp_path)
    manifest = client.get("/manifest.webmanifest")
    assert manifest.status_code == 200 and manifest.headers["content-type"].startswith("application/manifest+json")
    assert manifest.json()["start_url"] == "/today"
    worker = client.get("/sw.js")
    assert worker.headers["content-type"].startswith("text/javascript")
    assert worker.headers["cache-control"] == "no-cache", "an old worker would keep an old app"
    assert "addEventListener('fetch'" in worker.text
    symbol = client.get("/icons/maskable-512.png")
    assert symbol.status_code == 200 and symbol.headers["content-type"] == "image/png"


def test_the_policy_lets_manifest_and_worker_come_from_the_own_origin_only() -> None:
    csp = TestClient(app).get("/api/health").headers["content-security-policy"]
    directives = dict(part.strip().split(" ", 1) for part in csp.split(";"))
    assert directives["manifest-src"] == "'self'" and directives["worker-src"] == "'self'"
    assert directives["default-src"] == "'self'" and "script-src" not in directives
