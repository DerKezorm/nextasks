# Herkunft: nextasks-ios/docs/pruefsaetze/referenz/gleichstand.py (Referenz der Prüfsätze, Stand 06.11.2026),
# unverändert übernommen; geändert wird nur dort. Prüfsatz: tests/pruefsaetze/gleichstand.json.
"""Reference for the per-field merge rule (datenmodell.md, "Uhren und Abgleich").

- ``canonical(value)``: the value written per RFC 8785 (JSON Canonicalization Scheme), as ``str``.
- ``canonical_bytes(value)``: the same as UTF-8 bytes.
- ``merge(stored_value, stored_clock, incoming_value, incoming_clock)``: ``take``, ``keep`` or ``same``.

Values are what ``json.loads`` gives: None, bool, int, float, str, list, dict. A group (``place``, ``due``,
``completion``) is compared as one object of its fields.
"""

from __future__ import annotations

import math
from decimal import Decimal

__all__ = ["canonical", "canonical_bytes", "merge"]

_ESCAPES = {'"': '\\"', "\\": "\\\\", "\b": "\\b", "\t": "\\t", "\n": "\\n", "\f": "\\f", "\r": "\\r"}


def _string(s: str) -> str:
    out = ['"']
    for ch in s:
        if ch in _ESCAPES:
            out.append(_ESCAPES[ch])
        elif ord(ch) < 0x20:
            out.append(f"\\u{ord(ch):04x}")
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def _number(x: int | float) -> str:
    """ECMAScript Number.prototype.toString for a double (RFC 8785, section 3.2.2.3)."""
    f = float(x)
    if not math.isfinite(f):
        raise ValueError("NaN and Infinity have no JSON form")
    if f == 0:
        return "0"
    sign = "-" if f < 0 else ""
    # repr gives the shortest digits that read back to the same double, like ECMAScript
    _, digits, exponent = Decimal(repr(abs(f))).as_tuple()
    digits = list(digits)
    while len(digits) > 1 and digits[-1] == 0:
        digits.pop()
        exponent += 1
    s = "".join(map(str, digits))
    k = len(s)
    n = k + exponent  # value = 0.s * 10^n
    if k <= n <= 21:
        body = s + "0" * (n - k)
    elif 0 < n <= 21:
        body = s[:n] + "." + s[n:]
    elif -6 < n <= 0:
        body = "0." + "0" * (-n) + s
    else:
        e = n - 1
        mantissa = s if k == 1 else s[0] + "." + s[1:]
        body = f"{mantissa}e{'+' if e >= 0 else '-'}{abs(e)}"
    return sign + body


def canonical(value) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, (int, float)):
        return _number(value)
    if isinstance(value, str):
        return _string(value)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonical(v) for v in value) + "]"
    if isinstance(value, dict):
        keys = sorted(value, key=lambda k: k.encode("utf-16-be"))  # UTF-16 code units
        return "{" + ",".join(_string(k) + ":" + canonical(value[k]) for k in keys) + "}"
    raise TypeError(f"no JSON value: {type(value).__name__}")


def canonical_bytes(value) -> bytes:
    return canonical(value).encode("utf-8")


def merge(stored_value, stored_clock: int, incoming_value, incoming_clock: int) -> str:
    """Does the incoming value replace the stored one?

    - ``take``: the incoming clock is larger, or the clocks are equal and the incoming value is canonically larger
      (UTF-8 bytes of the JCS form). With a larger clock and an equal value ``take`` too: the value stays, the
      clock moves up.
    - ``same``: equal clocks and canonically equal values: nothing changes.
    - ``keep``: everything else.
    """
    if incoming_clock > stored_clock:
        return "take"
    if incoming_clock < stored_clock:
        return "keep"
    a, b = canonical_bytes(stored_value), canonical_bytes(incoming_value)
    if b == a:
        return "same"
    return "take" if b > a else "keep"
