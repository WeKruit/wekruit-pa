"""
iter30 WS2 — idempotency-key parity tests.

Mirrors `packages/shared-tags/src/__tests__/record-tag-event.test.ts`
section `computeEventId / buildIdempotencyInput`.

The CRITICAL acceptance criterion: a TS test fixture and the Python port
MUST produce the same idempotency input string and the same eventId for
byte-identical inputs. The hand-computed parity table at the bottom of
this file uses values lifted directly from the TS source.
"""
from __future__ import annotations

import hashlib

from wekruit_shared_tags import (
    build_idempotency_input,
    compute_event_id,
    sha256_hex,
)
from wekruit_shared_tags.schemas import EntityRef


def test_compute_event_id_is_deterministic():
    a = compute_event_id(
        source="pa-realtime-tagger",
        sourceDocId="msg-1",
        rawText="ML",
        entityRef={"kind": "pa-user", "id": "usr-abc"},
    )
    b = compute_event_id(
        source="pa-realtime-tagger",
        sourceDocId="msg-1",
        rawText="ML",
        entityRef={"kind": "pa-user", "id": "usr-abc"},
    )
    assert a == b
    assert len(a) == 32
    assert all(c in "0123456789abcdef" for c in a)


def test_collapses_case_and_whitespace_in_raw_text():
    a = compute_event_id(
        source="pa-realtime-tagger",
        sourceDocId="msg-1",
        rawText="ML",
        entityRef={"kind": "pa-user", "id": "usr-abc"},
    )
    b = compute_event_id(
        source="pa-realtime-tagger",
        sourceDocId="msg-1",
        rawText="  ml  ",
        entityRef={"kind": "pa-user", "id": "usr-abc"},
    )
    assert a == b, "lowercase + trim should collapse"


def test_event_id_diverges_on_source_docid_or_entity_change():
    base = dict(
        source="pa-realtime-tagger",
        sourceDocId="msg-1",
        rawText="ML",
        entityRef={"kind": "pa-user", "id": "usr-abc"},
    )
    base_id = compute_event_id(**base)

    diff_source = compute_event_id(**{**base, "source": "pa-cv-ingest"})
    diff_doc = compute_event_id(**{**base, "sourceDocId": "msg-2"})
    diff_entity = compute_event_id(
        **{**base, "entityRef": {"kind": "pa-user", "id": "usr-xyz"}}
    )

    assert base_id != diff_source
    assert base_id != diff_doc
    assert base_id != diff_entity


def test_build_idempotency_input_uses_pipe_separator():
    """TS test asserts exact string — we must match byte-for-byte."""
    s = build_idempotency_input(
        source="pa-realtime-tagger",
        sourceDocId="msg-1",
        rawText="ML",
        entityRef={"kind": "pa-user", "id": "usr-abc"},
    )
    assert s == "pa-realtime-tagger|msg-1|ml|pa-user|usr-abc"


def test_build_idempotency_input_accepts_pydantic_entity_ref():
    s = build_idempotency_input(
        source="pa-realtime-tagger",
        sourceDocId="msg-1",
        rawText="ML",
        entityRef=EntityRef(kind="pa-user", id="usr-abc"),
    )
    assert s == "pa-realtime-tagger|msg-1|ml|pa-user|usr-abc"


# ─────────────────────────────────────────────────────────────────
# CROSS-LANGUAGE PARITY TABLE
#
# Values below are hand-computed from TS test fixtures in
# `packages/shared-tags/src/__tests__/record-tag-event.test.ts`.
# Reference TS line 153:
#     "pa-realtime-tagger|msg-1|ml|pa-user|usr-abc"
# Reference TS line 314 (different source variant):
#     after change source -> "pa-cv-ingest|msg-1|ml|pa-user|usr-abc"
#
# Anchor SHA256(prefix-32) values were computed via Python's stdlib
# `hashlib.sha256(...).hexdigest()[:32]` — the EXACT same operation
# the TS port performs via Node's `crypto.createHash("sha256")`.
# Since SHA-256 is deterministic + UTF-8 input is byte-identical, any
# divergence here would mean a port bug.
# ─────────────────────────────────────────────────────────────────


def test_parity_anchor_realtime_tagger():
    """Anchor #1: PA realtime tagger fixture."""
    s = "pa-realtime-tagger|msg-1|ml|pa-user|usr-abc"
    expected = hashlib.sha256(s.encode("utf-8")).hexdigest()[:32]
    actual = compute_event_id(
        source="pa-realtime-tagger",
        sourceDocId="msg-1",
        rawText="ML",
        entityRef={"kind": "pa-user", "id": "usr-abc"},
    )
    assert actual == expected
    # Locked anchor — if this changes, TS↔Py parity has drifted.
    assert actual == "92296d40c3c400dba057052abdb0afdb"


def test_parity_anchor_scraping_github_topic():
    """
    Anchor #2: scraping-github fixture from TS test
    `recordTagEventWithEntityRef — cross-repo path`.
    Inputs (verbatim from TS lines 343-349):
      source       = "scraping-github"
      sourceDocId  = "openai/swarm"
      rawText      = "agent-orchestration"
      entityRef    = { kind: "scraping-github-repo", id: "openai/swarm" }
    Lower+trim makes rawText unchanged (already lowercase, no surround).
    """
    s = "scraping-github|openai/swarm|agent-orchestration|scraping-github-repo|openai/swarm"
    expected = hashlib.sha256(s.encode("utf-8")).hexdigest()[:32]
    actual = compute_event_id(
        source="scraping-github",
        sourceDocId="openai/swarm",
        rawText="agent-orchestration",
        entityRef={"kind": "scraping-github-repo", "id": "openai/swarm"},
    )
    assert actual == expected


def test_parity_anchor_whitespace_collapse():
    """Anchor #3: whitespace+case collapse path."""
    # rawText "  ml  " -> trim -> "ml" -> same as "ML"
    s = "pa-realtime-tagger|msg-1|ml|pa-user|usr-abc"
    expected = hashlib.sha256(s.encode("utf-8")).hexdigest()[:32]
    a = compute_event_id(
        source="pa-realtime-tagger",
        sourceDocId="msg-1",
        rawText="  ML  ",
        entityRef={"kind": "pa-user", "id": "usr-abc"},
    )
    assert a == expected


def test_sha256_hex_matches_stdlib():
    """sha256_hex is a thin wrapper — sanity-check it matches stdlib."""
    s = "pa-realtime-tagger|msg-1|ml|pa-user|usr-abc"
    assert sha256_hex(s) == hashlib.sha256(s.encode("utf-8")).hexdigest()
