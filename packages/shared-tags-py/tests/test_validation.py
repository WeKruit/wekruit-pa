"""
iter30 WS2 — validation parity tests.

Ports the `recordTagEvent — validation` describe block from
`packages/shared-tags/src/__tests__/record-tag-event.test.ts`.
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from wekruit_shared_tags import (
    RecordTagEventInput,
    record_tag_event,
)

from ._fakes import make_fake_firestore

FIXED_NOW = "2026-05-03T12:00:00.000Z"


@pytest.mark.asyncio
async def test_throws_when_neither_user_nor_job():
    fs = make_fake_firestore()
    with pytest.raises(ValueError, match="exactly one"):
        await record_tag_event(
            {
                "rawTag": "ML",
                "source": "pa-realtime-tagger",
                "sourceDocId": "msg-1",
            },
            firestore=fs.fs,
            now=lambda: FIXED_NOW,
        )


@pytest.mark.asyncio
async def test_throws_when_both_user_and_job():
    fs = make_fake_firestore()
    with pytest.raises(ValueError, match="exactly one"):
        await record_tag_event(
            {
                "userId": "u1",
                "jobId": "j1",
                "rawTag": "ML",
                "source": "pa-realtime-tagger",
                "sourceDocId": "msg-1",
            },
            firestore=fs.fs,
            now=lambda: FIXED_NOW,
        )


@pytest.mark.asyncio
async def test_throws_when_raw_tag_empty():
    fs = make_fake_firestore()
    with pytest.raises(ValueError, match="rawTag"):
        await record_tag_event(
            {
                "userId": "u1",
                "rawTag": "   ",
                "source": "pa-realtime-tagger",
            },
            firestore=fs.fs,
            now=lambda: FIXED_NOW,
        )


@pytest.mark.asyncio
async def test_raw_tag_truncated_when_over_500():
    fs = make_fake_firestore()
    long = "x" * 900
    r = await record_tag_event(
        {
            "userId": "u1",
            "rawTag": long,
            "source": "pa-realtime-tagger",
            "sourceDocId": "msg-1",
            "type": "skill",
        },
        firestore=fs.fs,
        now=lambda: FIXED_NOW,
    )
    assert r.created is True
    assert r.truncated is True
    assert len(fs.writes) == 1
    stored = fs.writes[0]["data"]
    assert len(stored["rawText"]) == 500


def test_input_schema_rejects_unknown_source():
    with pytest.raises(ValidationError):
        RecordTagEventInput(
            source="unknown-source",  # type: ignore[arg-type]
            sourceDocId="msg-1",
            sourceField="rawTag",
            rawText="ML",
            type="skill",
            entityRef={"kind": "pa-user", "id": "usr-abc"},  # type: ignore[arg-type]
        )


def test_input_schema_rejects_empty_entity_id():
    with pytest.raises(ValidationError):
        RecordTagEventInput(
            source="pa-realtime-tagger",
            sourceDocId="msg-1",
            sourceField="rawTag",
            rawText="ML",
            type="skill",
            entityRef={"kind": "pa-user", "id": ""},  # type: ignore[arg-type]
        )


def test_input_schema_rejects_extra_fields():
    """Mirrors Zod `.strict()` — RecordTagEventInputSchema in TS is strict."""
    with pytest.raises(ValidationError):
        RecordTagEventInput(
            source="pa-realtime-tagger",
            sourceDocId="msg-1",
            sourceField="rawTag",
            rawText="ML",
            type="skill",
            entityRef={"kind": "pa-user", "id": "usr-abc"},  # type: ignore[arg-type]
            unexpected_extra="nope",  # type: ignore[call-arg]
        )
