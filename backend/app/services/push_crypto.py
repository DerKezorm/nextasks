# Herkunft: nextasks-ios/docs/pruefsaetze/referenz/push.py (Referenz der Prüfsätze, Stand 06.11.2026),
# unverändert übernommen; geändert wird nur dort. Prüfsatz: tests/pruefsaetze/push.json.
"""Reference for the encrypted app push (vertrag-block1.md, "Mitteilungen"; form as in nexmail's push contract).

X25519 with a fresh key pair per message and device against the device's public key, HKDF-SHA256 over the shared
secret with an empty salt and info ``nextasks-push-v1`` to 32 bytes, ChaCha20-Poly1305 with a 12-byte nonce and no
associated data. ``enc`` = standard base64 with padding of ephemeral public key (32) + nonce (12) + ciphertext and tag.

Needs the package ``cryptography``.
"""

from __future__ import annotations

import base64
import os

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

__all__ = ["INFO", "MAX_ENC", "public_key", "encrypt", "decrypt"]

INFO = b"nextasks-push-v1"
MAX_ENC = 3000

_RAW = serialization.Encoding.Raw
_RAW_PUB = serialization.PublicFormat.Raw
_RAW_PRIV = serialization.PrivateFormat.Raw


def _key(shared: bytes, info: bytes) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=info).derive(shared)


def public_key(private_b64: str) -> str:
    """Public key (base64) of a raw 32-byte X25519 private key (base64)."""
    priv = X25519PrivateKey.from_private_bytes(base64.b64decode(private_b64))
    return base64.b64encode(priv.public_key().public_bytes(_RAW, _RAW_PUB)).decode()


def encrypt(
    plaintext: bytes | str,
    device_public_b64: str,
    ephemeral_private: bytes | None = None,
    nonce: bytes | None = None,
    info: bytes = INFO,
) -> str:
    """``enc`` for one device. Ephemeral key and nonce are random unless given (only tests give them)."""
    if isinstance(plaintext, str):
        plaintext = plaintext.encode("utf-8")
    eph = X25519PrivateKey.from_private_bytes(ephemeral_private) if ephemeral_private else X25519PrivateKey.generate()
    nonce = nonce if nonce is not None else os.urandom(12)
    if len(nonce) != 12:
        raise ValueError("nonce must be 12 bytes")
    device = X25519PublicKey.from_public_bytes(base64.b64decode(device_public_b64))
    key = _key(eph.exchange(device), info)
    sealed = ChaCha20Poly1305(key).encrypt(nonce, plaintext, None)
    enc = base64.b64encode(eph.public_key().public_bytes(_RAW, _RAW_PUB) + nonce + sealed).decode()
    if len(enc) > MAX_ENC:
        raise ValueError("enc longer than 3000 characters")
    return enc


def decrypt(enc: str, device_private_b64: str, info: bytes = INFO) -> bytes:
    """Plain text bytes. Raises ``cryptography.exceptions.InvalidTag`` for a wrong key or info."""
    raw = base64.b64decode(enc, validate=True)
    if len(raw) < 32 + 12 + 16:
        raise ValueError("enc too short")
    eph = X25519PublicKey.from_public_bytes(raw[:32])
    device = X25519PrivateKey.from_private_bytes(base64.b64decode(device_private_b64))
    key = _key(device.exchange(eph), info)
    return ChaCha20Poly1305(key).decrypt(raw[32:44], raw[44:], None)
