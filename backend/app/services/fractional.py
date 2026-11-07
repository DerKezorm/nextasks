"""Order keys: a Python port of ``generateKeyBetween`` from the library ``fractional-indexing`` (rocicorp, version 3,
CC0), so that server, web (the library itself) and app (Swift) make the same keys. Base 62 ``0-9A-Za-z``, an integer
part with a head letter, then a fraction without a trailing zero. Keys compare byte by byte; equal keys are ordered
by ``id``. Checked against ``tests/pruefsaetze/position.json``. What the server takes in a ``put`` is decided by
``records.valid_key`` (the reference check of ``position.py``), not by ``validate`` here.
"""

from __future__ import annotations

import math

DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
_ZERO = DIGITS[0]
_SMALLEST_INTEGER = "A" + _ZERO * 26
#: Longer keys are refused: two people moving the same pair back and forth thousands of times would be needed.
MAX_LENGTH = 200


class KeyError_(ValueError):
    """Not an order key, or no key between the two."""


def _midpoint(a: str, b: str | None) -> str:
    if b is not None and a >= b:
        raise KeyError_(f"{a} >= {b}")
    if a[-1:] == _ZERO or (b and b[-1:] == _ZERO):
        raise KeyError_("trailing zero")
    if b:
        n = 0
        while (a[n] if n < len(a) else _ZERO) == b[n]:
            n += 1
        if n > 0:
            return b[:n] + _midpoint(a[n:], b[n:])
    digit_a = DIGITS.index(a[0]) if a else 0
    digit_b = DIGITS.index(b[0]) if b is not None else len(DIGITS)
    if digit_b - digit_a > 1:
        # JavaScript's Math.round: halves go up.
        return DIGITS[math.floor(0.5 * (digit_a + digit_b) + 0.5)]
    if b and len(b) > 1:
        return b[:1]
    return DIGITS[digit_a] + _midpoint(a[1:], None)


def _integer_length(head: str) -> int:
    if "a" <= head <= "z":
        return ord(head) - ord("a") + 2
    if "A" <= head <= "Z":
        return ord("Z") - ord(head) + 2
    raise KeyError_(f"invalid order key head: {head}")


def _validate_integer(integer: str) -> None:
    if len(integer) != _integer_length(integer[0]):
        raise KeyError_(f"invalid integer part of order key: {integer}")


def _integer_part(key: str) -> str:
    length = _integer_length(key[0])
    if length > len(key):
        raise KeyError_(f"invalid order key: {key}")
    return key[:length]


def validate(key: str) -> None:
    if not isinstance(key, str) or not key or len(key) > MAX_LENGTH:
        raise KeyError_("invalid order key")
    if any(char not in DIGITS for char in key):
        raise KeyError_(f"invalid order key: {key}")
    if key == _SMALLEST_INTEGER:
        raise KeyError_(f"invalid order key: {key}")
    integer = _integer_part(key)
    fraction = key[len(integer):]
    if fraction[-1:] == _ZERO:
        raise KeyError_(f"invalid order key: {key}")


def is_valid(key: object) -> bool:
    try:
        validate(key)  # type: ignore[arg-type]
    except KeyError_:
        return False
    return True


def _increment_integer(x: str) -> str | None:
    _validate_integer(x)
    head, digs = x[0], list(x[1:])
    carry = True
    i = len(digs) - 1
    while carry and i >= 0:
        d = DIGITS.index(digs[i]) + 1
        if d == len(DIGITS):
            digs[i] = _ZERO
        else:
            digs[i] = DIGITS[d]
            carry = False
        i -= 1
    if carry:
        if head == "Z":
            return "a" + _ZERO
        if head == "z":
            return None
        h = chr(ord(head) + 1)
        if h > "a":
            digs.append(_ZERO)
        else:
            digs.pop()
        return h + "".join(digs)
    return head + "".join(digs)


def _decrement_integer(x: str) -> str | None:
    _validate_integer(x)
    head, digs = x[0], list(x[1:])
    borrow = True
    i = len(digs) - 1
    while borrow and i >= 0:
        d = DIGITS.index(digs[i]) - 1
        if d == -1:
            digs[i] = DIGITS[-1]
        else:
            digs[i] = DIGITS[d]
            borrow = False
        i -= 1
    if borrow:
        if head == "a":
            return "Z" + DIGITS[-1]
        if head == "A":
            return None
        h = chr(ord(head) - 1)
        if h < "Z":
            digs.append(DIGITS[-1])
        else:
            digs.pop()
        return h + "".join(digs)
    return head + "".join(digs)


def key_between(a: str | None, b: str | None) -> str:
    """A key after ``a`` and before ``b``; None stands for the start or the end."""
    if a is not None:
        validate(a)
    if b is not None:
        validate(b)
    if a is not None and b is not None and a >= b:
        raise KeyError_(f"{a} >= {b}")
    if a is None:
        if b is None:
            return "a" + _ZERO
        ib = _integer_part(b)
        fb = b[len(ib):]
        if ib == _SMALLEST_INTEGER:
            return ib + _midpoint("", fb)
        if ib < b:
            return ib
        result = _decrement_integer(ib)
        if result is None:
            raise KeyError_("cannot decrement any more")
        return result
    if b is None:
        ia = _integer_part(a)
        fa = a[len(ia):]
        incremented = _increment_integer(ia)
        return ia + _midpoint(fa, None) if incremented is None else incremented
    ia = _integer_part(a)
    fa = a[len(ia):]
    ib = _integer_part(b)
    fb = b[len(ib):]
    if ia == ib:
        return ia + _midpoint(fa, fb)
    incremented = _increment_integer(ia)
    if incremented is None:
        raise KeyError_("cannot increment any more")
    if incremented < b:
        return incremented
    return ia + _midpoint(fa, None)


def keys_between(a: str | None, b: str | None, n: int) -> list[str]:
    """``n`` keys between ``a`` and ``b`` in order (``generateNKeysBetween``)."""
    if n == 0:
        return []
    if n == 1:
        return [key_between(a, b)]
    if b is None:
        c = key_between(a, b)
        result = [c]
        for _ in range(n - 1):
            c = key_between(c, b)
            result.append(c)
        return result
    if a is None:
        c = key_between(a, b)
        result = [c]
        for _ in range(n - 1):
            c = key_between(a, c)
            result.append(c)
        result.reverse()
        return result
    mid = n // 2
    c = key_between(a, b)
    return [*keys_between(a, c, mid), c, *keys_between(c, b, n - mid - 1)]
