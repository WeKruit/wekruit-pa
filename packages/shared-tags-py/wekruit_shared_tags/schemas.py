"""
iter30 WS2 — Pydantic v2 schemas for the 3 canonical-tag collections.

Source-of-truth: `packages/shared-tags/src/schemas.ts` (Zod). This is a
mechanical port — same field names (camelCase), same constraints, same
literal enum sets. Changes here REQUIRE matching changes in TS in the
same PR or the cross-repo idempotency contract drifts.

Constraints (Adam-locked, see TS source):
  - English-only `displayName` (no zh/en split)
  - `mutexGroup` present on canonical + entity-tag for write-time mutex
  - sha256-derived idempotency key on every event
  - schemaVersion: "v1" so cross-repo bumps are explicit
"""
from __future__ import annotations

import re
from typing import Annotated, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
)

from .types import (
    TAG_EVENT_SCHEMA_VERSION,
    EntityKind,
    TagEventSource,
    TagType,
)

# ─────────────────────────────────────────────────────────────────
# Common building blocks
# ─────────────────────────────────────────────────────────────────

# canonicalKey: lowercase kebab-case, 2..64 chars
_CANONICAL_KEY_RE = re.compile(r"^[a-z0-9-]+$")
CanonicalKey = Annotated[
    str,
    StringConstraints(min_length=2, max_length=64, pattern=r"^[a-z0-9-]+$"),
]

# eventId: 32-char lowercase hex (prefix of sha256)
TagEventId = Annotated[
    str,
    StringConstraints(min_length=32, max_length=32, pattern=r"^[a-f0-9]{32}$"),
]


class _StrictModel(BaseModel):
    """Common base — extra=forbid gives us Zod `.strict()` parity."""

    model_config = ConfigDict(extra="forbid", strict=False)


class EntityRef(_StrictModel):
    kind: EntityKind
    id: Annotated[str, StringConstraints(min_length=1, max_length=200)]


# ─────────────────────────────────────────────────────────────────
# 1. pa-canonical-tags/{canonicalKey}
# ─────────────────────────────────────────────────────────────────

ApprovalStatus = Literal[
    "proposed",
    "auto-approved",
    "human-approved",
    "rejected",
]


class CanonicalEvidence(_StrictModel):
    source: TagEventSource
    sourceDocId: Annotated[str, StringConstraints(min_length=1, max_length=200)]
    sourceField: Annotated[str, StringConstraints(min_length=1, max_length=200)]
    rawText: Annotated[str, StringConstraints(min_length=1, max_length=500)]
    observedAt: str


class CanonicalTag(_StrictModel):
    """Stable doc in `pa-canonical-tags/{canonicalKey}`."""

    canonicalKey: CanonicalKey
    type: TagType
    displayName: Annotated[str, StringConstraints(min_length=1, max_length=80)]
    aliases: list[Annotated[str, StringConstraints(min_length=1, max_length=120)]] = (
        Field(default_factory=list)
    )
    embedding: list[float] | None = None
    confidence: Annotated[float, Field(ge=0, le=1)] = 0.5
    evidence: list[CanonicalEvidence] = Field(default_factory=list)
    approvalStatus: ApprovalStatus = "proposed"
    parentKey: CanonicalKey | None = None
    mutexGroup: CanonicalKey | None = None
    schemaVersion: Literal["v1"] = TAG_EVENT_SCHEMA_VERSION
    createdAt: str
    updatedAt: str

    @field_validator("aliases")
    @classmethod
    def _aliases_max(cls, v: list[str]) -> list[str]:
        if len(v) > 500:
            raise ValueError("aliases: max 500")
        return v

    @field_validator("embedding")
    @classmethod
    def _embedding_dim(cls, v: list[float] | None) -> list[float] | None:
        if v is not None and len(v) != 1024:
            raise ValueError("embedding: must be exactly 1024 dimensions")
        return v

    @field_validator("evidence")
    @classmethod
    def _evidence_cap(cls, v: list[CanonicalEvidence]) -> list[CanonicalEvidence]:
        if len(v) > 10:
            raise ValueError("evidence: max 10 entries")
        return v


# ─────────────────────────────────────────────────────────────────
# 2. pa-tag-events/{eventId} (append-only)
# ─────────────────────────────────────────────────────────────────

TagEventStatus = Literal["pending", "normalized", "rejected", "skipped", "needs-review"]
TagEventDecision = Literal[
    "hot-alias",
    "llm-match",
    "cosine-match",
    "new-canonical",
    "needs-review",
    "skipped-mutex",
]


class TagEvent(_StrictModel):
    """Append-only event row in `pa-tag-events/{eventId}`."""

    id: TagEventId
    source: TagEventSource
    sourceDocId: Annotated[str, StringConstraints(min_length=1, max_length=200)]
    sourceField: Annotated[str, StringConstraints(min_length=1, max_length=200)]
    rawText: Annotated[str, StringConstraints(min_length=1, max_length=500)]
    type: TagType
    entityRef: EntityRef
    context: Annotated[str, StringConstraints(max_length=500)] | None = None
    status: TagEventStatus = "pending"
    normalizedTo: CanonicalKey | None = None
    decision: TagEventDecision | None = None
    workerConfidence: Annotated[float, Field(ge=0, le=1)] | None = None
    schemaVersion: Literal["v1"] = TAG_EVENT_SCHEMA_VERSION
    createdAt: str
    processedAt: str | None = None
    processingDurationMs: Annotated[int, Field(ge=0)] | None = None


class RecordTagEventInput(_StrictModel):
    """Caller-facing input shape for `record_tag_event_with_entity_ref()`."""

    source: TagEventSource
    sourceDocId: Annotated[str, StringConstraints(min_length=1, max_length=200)]
    sourceField: Annotated[str, StringConstraints(min_length=1, max_length=200)]
    rawText: Annotated[str, StringConstraints(min_length=1, max_length=500)]
    type: TagType
    entityRef: EntityRef
    context: Annotated[str, StringConstraints(max_length=500)] | None = None


# ─────────────────────────────────────────────────────────────────
# 3. pa-entity-tags/{entityKey} + items/{canonicalKey}
# ─────────────────────────────────────────────────────────────────


class EntityTagsRoot(_StrictModel):
    entityKey: Annotated[str, StringConstraints(min_length=3, max_length=220)]
    tagCount: Annotated[int, Field(ge=0)] = 0
    schemaVersion: Literal["v1"] = TAG_EVENT_SCHEMA_VERSION
    updatedAt: str


class EntityTagSourceAttribution(_StrictModel):
    source: TagEventSource
    weight: Annotated[float, Field(ge=0, le=1)] = 1.0
    firstAt: str
    lastAt: str
    count: Annotated[int, Field(gt=0)] = 1


class EntityTagAssignment(_StrictModel):
    canonicalKey: CanonicalKey
    type: TagType
    mutexGroup: CanonicalKey
    confidence: Annotated[float, Field(ge=0, le=1)] = 0.5
    firstSeen: str
    lastReinforced: str
    count: Annotated[int, Field(ge=0)] = 1
    sources: list[EntityTagSourceAttribution] = Field(default_factory=list)
    decayHalfLifeDays: Annotated[int, Field(ge=0)] = 0
    schemaVersion: Literal["v1"] = TAG_EVENT_SCHEMA_VERSION

    @field_validator("sources")
    @classmethod
    def _sources_cap(
        cls, v: list[EntityTagSourceAttribution]
    ) -> list[EntityTagSourceAttribution]:
        if len(v) > 20:
            raise ValueError("sources: max 20 entries")
        return v


# Backward-friendly aliases echoing the TS naming
EntityTagAggregate = EntityTagAssignment


__all__ = [
    "CanonicalKey",
    "TagEventId",
    "EntityRef",
    "ApprovalStatus",
    "CanonicalEvidence",
    "CanonicalTag",
    "TagEventStatus",
    "TagEventDecision",
    "TagEvent",
    "RecordTagEventInput",
    "EntityTagsRoot",
    "EntityTagSourceAttribution",
    "EntityTagAssignment",
    "EntityTagAggregate",
]
