"""
iter30 WS2 — Python port of `recordTagEvent()` idempotent write contract.

Mirrors `packages/shared-tags/src/record-tag-event.ts`. Adam-locked
constraints:

  - Idempotency-key BYTE-PARITY with TS:
      sha256("{source}|{sourceDocId}|{rawText.lower().strip()}|{kind}|{id}")
      .hexdigest()[:32]
  - Validation: missing both userId+jobId → ValueError. Empty rawTag →
    ValueError. rawText > 500 chars → truncate + result.truncated=True.
  - Firestore `.create()` semantics: ALREADY_EXISTS → return
    {created: False, idempotent: True, reason: "duplicate"}; other
    errors propagate.
  - Async + sync Firestore clients both supported (see `_maybe_await`).

Caller surface:

    from wekruit_shared_tags import record_tag_event
    result = await record_tag_event(
        {"userId": "u1", "rawTag": "ML", "source": "scraping-github"},
        firestore=fs,
    )
"""
from __future__ import annotations

import asyncio
import inspect
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Mapping, TypedDict

from .schemas import EntityRef, RecordTagEventInput, TagEvent
from .sha256 import sha256_hex
from .types import (
    SHARED_TAG_COLLECTIONS,
    TAG_EVENT_SCHEMA_VERSION,
    EntityKind,
    TagEventSource,
    TagType,
)

# ─────────────────────────────────────────────────────────────────
# Public input/result shapes
# ─────────────────────────────────────────────────────────────────


class RecordTagEventArgs(TypedDict, total=False):
    """
    PA-shorthand input. Either `userId` or `jobId` must be set (xor).
    `type` defaults to "skill" (same as TS). `sourceField` defaults to
    "rawTag", `sourceDocId` defaults to userId/jobId.
    """

    userId: str
    jobId: str
    rawTag: str
    source: TagEventSource
    sourceField: str
    sourceDocId: str
    type: TagType
    evidence: str


@dataclass
class RecordTagEventResult:
    """
    Return shape — mirrors TS `RecordTagEventResult`. `idempotent` is the
    semantic-flip of `created` for caller convenience.
    """

    eventId: str
    created: bool
    idempotent: bool
    reason: str | None = None
    truncated: bool = False

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "eventId": self.eventId,
            "created": self.created,
            "idempotent": self.idempotent,
        }
        if self.reason is not None:
            out["reason"] = self.reason
        if self.truncated:
            out["truncated"] = True
        return out


# ─────────────────────────────────────────────────────────────────
# Idempotency key
# ─────────────────────────────────────────────────────────────────


def build_idempotency_input(
    *,
    source: str,
    sourceDocId: str,
    rawText: str,
    entityRef: EntityRef | Mapping[str, str],
) -> str:
    """
    Build the canonical pipe-joined idempotency string. BYTE-PARITY with
    TS `buildIdempotencyInput()` is mandatory — see the TS test fixture
    `pa-realtime-tagger|msg-1|ml|pa-user|usr-abc`.
    """
    if isinstance(entityRef, EntityRef):
        kind = entityRef.kind
        ref_id = entityRef.id
    else:
        kind = entityRef["kind"]
        ref_id = entityRef["id"]
    return "|".join(
        [
            source,
            sourceDocId,
            rawText.lower().strip(),
            kind,
            ref_id,
        ]
    )


def compute_event_id(
    *,
    source: str,
    sourceDocId: str,
    rawText: str,
    entityRef: EntityRef | Mapping[str, str],
) -> str:
    """sha256 prefix; 32 hex chars; matches TS `computeEventId`."""
    return sha256_hex(
        build_idempotency_input(
            source=source,
            sourceDocId=sourceDocId,
            rawText=rawText,
            entityRef=entityRef,
        )
    )[:32]


# ─────────────────────────────────────────────────────────────────
# Internal helpers
# ─────────────────────────────────────────────────────────────────

_RAW_TEXT_MAX = 500


def _truncate_raw_text(s: str) -> tuple[str, bool]:
    if len(s) <= _RAW_TEXT_MAX:
        return s, False
    return s[:_RAW_TEXT_MAX], True


def _resolve_entity_ref(*, userId: str | None, jobId: str | None) -> EntityRef:
    has_user = isinstance(userId, str) and len(userId) > 0
    has_job = isinstance(jobId, str) and len(jobId) > 0
    if has_user == has_job:
        raise ValueError(
            "[shared-tags] record_tag_event: exactly one of `userId` or `jobId` must be set"
        )
    if has_user:
        return EntityRef(kind="pa-user", id=userId)  # type: ignore[arg-type]
    return EntityRef(kind="pa-job", id=jobId)  # type: ignore[arg-type]


def _is_already_exists(err: BaseException) -> bool:
    """
    Detect Firestore ALREADY_EXISTS across SDK transports.

    google-cloud-firestore raises `google.api_core.exceptions.AlreadyExists`
    (gRPC code=6). Plain duck-typed fakes may raise anything with a
    matching attribute or message. Match all of them.
    """
    code = getattr(err, "code", None)
    # google.api_core ALREADY_EXISTS has grpc_status_code = 6
    if isinstance(code, int) and code == 6:
        return True
    if isinstance(code, str) and code.lower().replace("_", "-") in (
        "already-exists",
    ):
        return True
    # gRPC status object
    grpc_status = getattr(err, "grpc_status_code", None)
    if grpc_status is not None and getattr(grpc_status, "value", None) == 6:
        return True
    cls_name = type(err).__name__
    if cls_name in ("AlreadyExists", "AlreadyExistsError"):
        return True
    msg = str(err)
    if "ALREADY_EXISTS" in msg or "already exists" in msg.lower():
        return True
    return False


async def _maybe_await(value: Any) -> Any:
    """Accept both sync and async Firestore clients."""
    if inspect.isawaitable(value):
        return await value
    return value


def _default_now() -> str:
    # ISO-8601 UTC with 'Z' suffix (matches TS `new Date().toISOString()`)
    now = datetime.now(timezone.utc)
    # millisecond precision, drop microseconds to avoid drift in fixtures
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


# ─────────────────────────────────────────────────────────────────
# Public entry — PA-shorthand
# ─────────────────────────────────────────────────────────────────


async def record_tag_event(
    args: RecordTagEventArgs | Mapping[str, Any],
    *,
    firestore: Any,
    now: Callable[[], str] | None = None,
) -> RecordTagEventResult:
    """
    Idempotent append to `pa-tag-events`. Two calls with byte-identical
    input produce the same eventId and at most one Firestore document.

    Validation errors raise `ValueError` — caller is expected to wrap in
    fire-and-forget try/except on hot paths (matches TS contract §3.3).
    """
    raw_tag = args.get("rawTag")
    if not isinstance(raw_tag, str) or len(raw_tag.strip()) == 0:
        raise ValueError(
            "[shared-tags] record_tag_event: rawTag must be a non-empty string"
        )

    entity_ref = _resolve_entity_ref(
        userId=args.get("userId"),
        jobId=args.get("jobId"),
    )

    raw_text, truncated = _truncate_raw_text(raw_tag)
    source = args.get("source")
    if source is None:
        raise ValueError("[shared-tags] record_tag_event: `source` is required")

    source_doc_id = args.get("sourceDocId") or entity_ref.id
    source_field = args.get("sourceField") or "rawTag"
    tag_type: TagType = args.get("type") or "skill"  # type: ignore[assignment]
    context = args.get("evidence")

    # Validate via pydantic (Zod-strict parity)
    parsed = RecordTagEventInput(
        source=source,
        sourceDocId=source_doc_id,
        sourceField=source_field,
        rawText=raw_text,
        type=tag_type,
        entityRef=entity_ref,
        context=context,
    )

    return await record_tag_event_with_entity_ref(
        parsed,
        firestore=firestore,
        now=now,
        truncated=truncated,
    )


# ─────────────────────────────────────────────────────────────────
# Public entry — explicit EntityRef (cross-repo)
# ─────────────────────────────────────────────────────────────────


async def record_tag_event_with_entity_ref(
    input: RecordTagEventInput | Mapping[str, Any],
    *,
    firestore: Any,
    now: Callable[[], str] | None = None,
    truncated: bool = False,
) -> RecordTagEventResult:
    """
    Lower-level entry used by scraping pipelines that emit tags for
    non-PA entities (e.g. `scraping-github-repo:foo/bar`).
    """
    if not isinstance(input, RecordTagEventInput):
        input = RecordTagEventInput.model_validate(dict(input))

    event_id = compute_event_id(
        source=input.source,
        sourceDocId=input.sourceDocId,
        rawText=input.rawText,
        entityRef=input.entityRef,
    )

    now_str = (now or _default_now)()

    event = TagEvent(
        id=event_id,
        source=input.source,
        sourceDocId=input.sourceDocId,
        sourceField=input.sourceField,
        rawText=input.rawText,
        type=input.type,
        entityRef=input.entityRef,
        context=input.context,
        status="pending",
        normalizedTo=None,
        decision=None,
        workerConfidence=None,
        schemaVersion=TAG_EVENT_SCHEMA_VERSION,
        createdAt=now_str,
        processedAt=None,
        processingDurationMs=None,
    )

    payload = event.model_dump(mode="json")

    collection = firestore.collection(SHARED_TAG_COLLECTIONS["tagEvents"])
    # google-cloud-firestore Python SDK uses `.document(id)`. Some test
    # fakes mirror TS `.doc(id)` — accept both.
    if hasattr(collection, "document"):
        doc_ref = collection.document(event_id)
    else:
        doc_ref = collection.doc(event_id)  # type: ignore[attr-defined]

    try:
        await _maybe_await(doc_ref.create(payload))
        return RecordTagEventResult(
            eventId=event_id,
            created=True,
            idempotent=False,
            reason="truncated" if truncated else None,
            truncated=truncated,
        )
    except Exception as err:  # noqa: BLE001 — we re-raise non-AlreadyExists
        if _is_already_exists(err):
            return RecordTagEventResult(
                eventId=event_id,
                created=False,
                idempotent=True,
                reason="duplicate",
                truncated=truncated,
            )
        raise


__all__ = [
    "RecordTagEventArgs",
    "RecordTagEventResult",
    "build_idempotency_input",
    "compute_event_id",
    "record_tag_event",
    "record_tag_event_with_entity_ref",
]
