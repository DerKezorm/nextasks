"""What every call outside shares: one TLS context, read once.

Making an ``httpx`` client reads the whole set of trusted certificates anew, 0.5 to 0.8 s on a small machine. Every
step of an OIDC sign-in once made one inside the event loop, which stood still for that long for everybody. Now the
context is read once, outside the event loop; the sign-in providers, the push relay and web push use it.
"""

from __future__ import annotations

import ssl
import threading

import httpx

_lock = threading.Lock()
_context: ssl.SSLContext | None = None


def ssl_context() -> ssl.SSLContext:
    """The TLS context with the trusted certificates, read on first use. Blocking: from ``async`` code call it
    through the thread pool (``warm`` does so at the start)."""
    global _context
    with _lock:
        if _context is None:
            _context = httpx.create_ssl_context()
        return _context


def warm() -> None:
    """Reads the context ahead, so that the first sign-in does not wait for it."""
    ssl_context()


def close() -> None:
    """At the end of the server; nothing is kept open between calls."""
