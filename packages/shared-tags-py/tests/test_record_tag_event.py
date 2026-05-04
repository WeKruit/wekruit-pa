"""
iter30 WS2 — record_tag_event integration tests with the in-memory
firestore fake. Ports the `recordTagEvent — idempotency` and
`recordTagEventWithEntityRef — cross-repo path` describe blocks from
the TS test file.
"""
from __future__ import annotations

import pytest

from wekruit_shared_tags import (
    SHARED_TAG_COLLECTIONS,
    TAG_EVENT_SCHEMA_VERSION,
    record_tag_event,
    record_tag_event_with_entity_ref,
)

from ._fakes import make_fake_firestore

FIXED_NOW = "2026-05-03T12:00:00.000Z"


@pytest.mark.asyncio
async def test_same_input_same_event_id_one_write():
    state = make_fake_firestore()
    args = {
        "userId": "usr-abc",
        "rawTag": "Machine Learning",
        "source": "pa-realtime-tagger",
        "sourceDocId": "msg-1",
        "type": "skill",
    }
    r1 = await record_tag_event(args, firestore=state.fs, now=lambda: FIXED_NOW)
    r2 = await record_tag_event(args, firestore=state.fs, now=lambda: FIXED_NOW)

    assert r1.eventId == r2.eventId, "eventId must be stable"
    assert r1.created is True, "first write creates"
    assert r2.created is False, "second write is duplicate"
    assert r2.idempotent is True
    assert r2.reason == "duplicate"
    assert len(state.writes) == 1, "exactly one .create() landed"
    assert state.writes[0]["collection"] == SHARED_TAG_COLLECTIONS["tagEvents"]
    assert state.writes[0]["docId"] == r1.eventId


@pytest.mark.asyncio
async def test_case_only_difference_collapses_to_one_event():
    state = make_fake_firestore()
    base = {
        "userId": "usr-abc",
        "rawTag": "ML",
        "source": "pa-realtime-tagger",
        "sourceDocId": "msg-1",
        "type": "skill",
    }
    await record_tag_event(base, firestore=state.fs, now=lambda: FIXED_NOW)
    await record_tag_event(
        {**base, "rawTag": "  ml  "}, firestore=state.fs, now=lambda: FIXED_NOW
    )
    assert len(state.writes) == 1


@pytest.mark.asyncio
async def test_different_source_creates_two_events():
    state = make_fake_firestore()
    await record_tag_event(
        {
            "userId": "usr-abc",
            "rawTag": "ML",
            "source": "pa-realtime-tagger",
            "sourceDocId": "msg-1",
            "type": "skill",
        },
        firestore=state.fs,
        now=lambda: FIXED_NOW,
    )
    await record_tag_event(
        {
            "userId": "usr-abc",
            "rawTag": "ML",
            "source": "pa-cv-ingest",
            "sourceDocId": "cv-1",
            "type": "skill",
        },
        firestore=state.fs,
        now=lambda: FIXED_NOW,
    )
    assert len(state.writes) == 2


@pytest.mark.asyncio
async def test_cross_repo_path_writes_v1_pending_doc():
    state = make_fake_firestore()
    r = await record_tag_event_with_entity_ref(
        {
            "source": "scraping-github",
            "sourceDocId": "openai/swarm",
            "sourceField": "topics[0]",
            "rawText": "agent-orchestration",
            "type": "topic",
            "entityRef": {"kind": "scraping-github-repo", "id": "openai/swarm"},
        },
        firestore=state.fs,
        now=lambda: FIXED_NOW,
    )
    assert r.created is True
    stored = state.writes[0]["data"]
    assert stored["schemaVersion"] == TAG_EVENT_SCHEMA_VERSION
    assert stored["status"] == "pending"
    assert stored["normalizedTo"] is None
    assert stored["decision"] is None
    assert stored["id"] == r.eventId


@pytest.mark.asyncio
async def test_default_source_doc_id_falls_back_to_entity_id():
    """When sourceDocId is omitted, defaults to entity id (TS parity)."""
    state = make_fake_firestore()
    r = await record_tag_event(
        {
            "userId": "usr-abc",
            "rawTag": "ML",
            "source": "pa-realtime-tagger",
            "type": "skill",
        },
        firestore=state.fs,
        now=lambda: FIXED_NOW,
    )
    assert r.created is True
    stored = state.writes[0]["data"]
    assert stored["sourceDocId"] == "usr-abc"
    assert stored["sourceField"] == "rawTag"


@pytest.mark.asyncio
async def test_already_exists_propagates_other_errors():
    """Non-ALREADY_EXISTS errors propagate to caller."""
    state = make_fake_firestore()

    class _BoomDoc:
        async def create(self, data):
            raise RuntimeError("network blip")

    class _BoomCol:
        def document(self, _):
            return _BoomDoc()

        def doc(self, _):
            return _BoomDoc()

    class _BoomFS:
        def collection(self, _):
            return _BoomCol()

    with pytest.raises(RuntimeError, match="network blip"):
        await record_tag_event(
            {
                "userId": "u1",
                "rawTag": "ML",
                "source": "pa-realtime-tagger",
                "sourceDocId": "msg-1",
            },
            firestore=_BoomFS(),
            now=lambda: FIXED_NOW,
        )
