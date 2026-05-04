"""
wekruit_shared_tags — Python port of @wekruit/shared-tags.

Public surface mirrors the TS package:
  - record_tag_event / record_tag_event_with_entity_ref
  - compute_event_id / build_idempotency_input
  - Pydantic models: TagEvent, CanonicalTag, EntityTagAssignment,
    EntityTagsRoot, EntityRef, RecordTagEventInput, CanonicalEvidence
  - Constants: TAG_TYPES, TAG_EVENT_SOURCES, ENTITY_KINDS,
    DECAY_HALF_LIFE_DAYS_BY_TYPE, SHARED_TAG_COLLECTIONS,
    TAG_EVENT_SCHEMA_VERSION

Idempotency-key BYTE-PARITY with TS is the cross-repo contract — do not
change `build_idempotency_input` without coordinating a TS-side bump.
"""
from __future__ import annotations

from .record_tag_event import (
    RecordTagEventArgs,
    RecordTagEventResult,
    build_idempotency_input,
    compute_event_id,
    record_tag_event,
    record_tag_event_with_entity_ref,
)
from .schemas import (
    ApprovalStatus,
    CanonicalEvidence,
    CanonicalTag,
    EntityRef,
    EntityTagAggregate,
    EntityTagAssignment,
    EntityTagSourceAttribution,
    EntityTagsRoot,
    RecordTagEventInput,
    TagEvent,
    TagEventDecision,
    TagEventStatus,
)
from .sha256 import sha256_hex
from .types import (
    DECAY_HALF_LIFE_DAYS_BY_TYPE,
    ENTITY_KINDS,
    SHARED_TAG_COLLECTIONS,
    TAG_EVENT_SCHEMA_VERSION,
    TAG_EVENT_SOURCES,
    TAG_TYPES,
    EntityKind,
    TagEventSource,
    TagType,
)

__version__ = "0.1.0"

__all__ = [
    # entry points
    "record_tag_event",
    "record_tag_event_with_entity_ref",
    "build_idempotency_input",
    "compute_event_id",
    "RecordTagEventArgs",
    "RecordTagEventResult",
    # schemas
    "ApprovalStatus",
    "CanonicalEvidence",
    "CanonicalTag",
    "EntityRef",
    "EntityTagAggregate",
    "EntityTagAssignment",
    "EntityTagSourceAttribution",
    "EntityTagsRoot",
    "RecordTagEventInput",
    "TagEvent",
    "TagEventDecision",
    "TagEventStatus",
    # types
    "DECAY_HALF_LIFE_DAYS_BY_TYPE",
    "ENTITY_KINDS",
    "SHARED_TAG_COLLECTIONS",
    "TAG_EVENT_SCHEMA_VERSION",
    "TAG_EVENT_SOURCES",
    "TAG_TYPES",
    "EntityKind",
    "TagEventSource",
    "TagType",
    "sha256_hex",
]
