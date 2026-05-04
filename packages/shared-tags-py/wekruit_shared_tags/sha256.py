"""
Deterministic sha256 hex via stdlib `hashlib`. Mirrors the TS sibling
(`packages/shared-tags/src/sha256.ts`) byte-for-byte: UTF-8 encoding +
lowercase hex output.

Kept in its own module so the Python port reads exactly like the TS
source — any divergence surface is one-line and easy to audit.
"""
from __future__ import annotations

import hashlib


def sha256_hex(s: str) -> str:
    """Return lowercase hex sha256 of `s` encoded as UTF-8."""
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


__all__ = ["sha256_hex"]
