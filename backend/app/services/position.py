# Herkunft: nextasks-ios/docs/pruefsaetze/referenz/position.py (Referenz der Prüfsätze, Stand 06.11.2026),
# unverändert übernommen; geändert wird nur dort. Prüfsatz: tests/pruefsaetze/position.json.
"""Key check for positions (datenmodell.md, "Reihenfolge (Schlüssel)").

The keys come from ``fractional-indexing`` (rocicorp); ``position.json`` is made with that library. This module only
holds the check a server applies to keys it receives: the library's own check (head letter, length of the integer
part, no trailing ``0`` in the fraction, not the smallest integer) plus Base62 for every character, which the library
itself leaves out for the fraction.
"""

from __future__ import annotations

__all__ = ["BASE62", "is_valid_key"]

BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
_DIGITS = frozenset(BASE62)
_SMALLEST = "A" + "0" * 26


def _integer_length(head: str) -> int | None:
    if "a" <= head <= "z":
        return ord(head) - ord("a") + 2
    if "A" <= head <= "Z":
        return ord("Z") - ord(head) + 2
    return None


def is_valid_key(key: str) -> bool:
    if not isinstance(key, str) or key == "" or any(ch not in _DIGITS for ch in key):
        return False
    length = _integer_length(key[0])
    if length is None or len(key) < length:
        return False
    if key[:length] == _SMALLEST:
        return False
    return not key[length:].endswith("0")
