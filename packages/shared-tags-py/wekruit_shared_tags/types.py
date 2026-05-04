"""
iter30 WS2 — Python port of TS taxonomy + collection constants.

Source of truth: `packages/shared-tags/src/types.ts`. Any addition here
MUST land in TS in the same PR — the idempotency-key surface depends on
both repos agreeing on enum values byte-for-byte.

Adam-locked constraints (see TS source comments):
  - English-only canonical (no zh/en split)
  - Mutex enforcement at write time
  - 3 collections: pa-canonical-tags, pa-tag-events, pa-entity-tags
"""
from __future__ import annotations

from typing import Final, Literal, get_args

# ─────────────────────────────────────────────────────────────────
# Tag taxonomy
# ─────────────────────────────────────────────────────────────────

TagType = Literal[
    "skill",
    "preference",
    "trait",
    "experience",
    "location",
    "role",
    "industry",
    "company",
    "venue",
    "topic",
]

TAG_TYPES: Final[tuple[str, ...]] = get_args(TagType)

# ─────────────────────────────────────────────────────────────────
# Sources — lock-step with TS
# ─────────────────────────────────────────────────────────────────

TagEventSource = Literal[
    "pa-realtime-tagger",
    "pa-cv-ingest",
    "pa-onboarding",
    "scraping-github",
    "scraping-devpost",
    "scraping-researcher",
    "scraping-job",
    "manual-operator",
    "manual-backfill",
]

TAG_EVENT_SOURCES: Final[tuple[str, ...]] = get_args(TagEventSource)

# ─────────────────────────────────────────────────────────────────
# Decay half-life (days) — 0 = never decay
# ─────────────────────────────────────────────────────────────────

DECAY_HALF_LIFE_DAYS_BY_TYPE: Final[dict[str, int]] = {
    "skill": 0,
    "preference": 180,
    "trait": 180,
    "experience": 0,
    "location": 365,
    "role": 0,
    "industry": 0,
    "company": 0,
    "venue": 0,
    "topic": 365,
}

# ─────────────────────────────────────────────────────────────────
# Entity kinds — flattened "{kind}:{id}" namespace
# ─────────────────────────────────────────────────────────────────

EntityKind = Literal[
    "pa-user",
    "pa-job",
    "scraping-job",
    "scraping-researcher",
    "scraping-github-repo",
    "scraping-devpost-project",
]

ENTITY_KINDS: Final[tuple[str, ...]] = get_args(EntityKind)

# ─────────────────────────────────────────────────────────────────
# Schema versioning + collection names
# ─────────────────────────────────────────────────────────────────

TAG_EVENT_SCHEMA_VERSION: Final[Literal["v1"]] = "v1"

SHARED_TAG_COLLECTIONS: Final[dict[str, str]] = {
    "canonicalTags": "pa-canonical-tags",
    "tagEvents": "pa-tag-events",
    "entityTags": "pa-entity-tags",
    "entityTagItems": "items",
}


__all__ = [
    "TagType",
    "TAG_TYPES",
    "TagEventSource",
    "TAG_EVENT_SOURCES",
    "DECAY_HALF_LIFE_DAYS_BY_TYPE",
    "EntityKind",
    "ENTITY_KINDS",
    "TAG_EVENT_SCHEMA_VERSION",
    "SHARED_TAG_COLLECTIONS",
]
