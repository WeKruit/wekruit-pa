# wekruit-shared-tags (Python)

Python port of `@wekruit/shared-tags` (TypeScript). Ships the canonical-tag
idempotent write contract used by the **scraping repo** to emit tag events
into the same Firestore collections that the PA orchestrator writes to.

> **Cross-repo contract:** the idempotency-key construction in this package
> is **byte-for-byte identical** to the TypeScript sibling. Any divergence
> would split events that should collide. See
> [§ Parity contract](#parity-contract) below.

## What it provides

- `record_tag_event(args, *, firestore, now=None)` — PA-shorthand entry
  point: caller passes `userId` xor `jobId`, package resolves the
  `EntityRef`.
- `record_tag_event_with_entity_ref(input, *, firestore, ...)` — explicit
  `EntityRef` for cross-repo callers (e.g. `scraping-github-repo:foo/bar`).
- `compute_event_id(...)` / `build_idempotency_input(...)` — re-exported
  for tests + diagnostics.
- Pydantic v2 models matching the TS Zod schemas: `TagEvent`,
  `CanonicalTag`, `EntityTagAssignment`, `EntityTagsRoot`, `EntityRef`,
  `RecordTagEventInput`, `CanonicalEvidence`.
- Constants: `TAG_TYPES`, `TAG_EVENT_SOURCES`, `ENTITY_KINDS`,
  `DECAY_HALF_LIFE_DAYS_BY_TYPE`, `SHARED_TAG_COLLECTIONS`,
  `TAG_EVENT_SCHEMA_VERSION`.

## Install (scraping repo, until GH Packages publish lands)

Pick **one** of these — Adam decides cross-repo timing.

### Option A — relative editable install (recommended for dev)

From the scraping repo root:

```bash
pip install -e ../wekruit-pa/packages/shared-tags-py
```

This pins to whatever is on disk; subsequent `git pull` in `wekruit-pa`
updates the Python package without re-installing.

### Option B — vendored copy

```bash
cp -R ../wekruit-pa/packages/shared-tags-py/wekruit_shared_tags \
      ./vendor/
# then add `from vendor.wekruit_shared_tags import record_tag_event`
```

Use only if the scraping repo can't reach `wekruit-pa` at install time
(e.g. CI without sibling checkout).

### Runtime dependencies

- `pydantic>=2.5,<3` — installed automatically.
- `google-cloud-firestore>=2.14` — **NOT** auto-installed. The package
  takes a duck-typed `firestore` argument so unit tests don't need it.
  Production callers must add it to their own `requirements.txt`:

  ```
  google-cloud-firestore>=2.14
  ```

  (As of 2026-05-03, the scraping repo's `requirements.txt` does NOT
  list this dep yet — the Phase-3 PR that wires `record_tag_event` into
  `github_categorizer.py` etc. needs to add it.)

## Quickstart (scraping caller)

```python
import asyncio
from google.cloud import firestore_async
from wekruit_shared_tags import record_tag_event_with_entity_ref

async def main():
    db = firestore_async.AsyncClient(project="wekruit-5f89b")
    result = await record_tag_event_with_entity_ref(
        {
            "source": "scraping-github",
            "sourceDocId": "openai/swarm",
            "sourceField": "topics[0]",
            "rawText": "agent-orchestration",
            "type": "topic",
            "entityRef": {
                "kind": "scraping-github-repo",
                "id": "openai/swarm",
            },
        },
        firestore=db,
    )
    print(result.eventId, result.created)

asyncio.run(main())
```

## Parity contract

The idempotency-key string is constructed via lowercase + trim + pipe-join,
in this exact field order:

```
{source}|{sourceDocId}|{rawText.lower().strip()}|{entityRef.kind}|{entityRef.id}
```

The eventId is `sha256(input).hexdigest()[:32]` — **same algorithm, same
encoding, same prefix length** as the TypeScript sibling
(`packages/shared-tags/src/record-tag-event.ts::computeEventId`).

Anchor (lifted from the TS test fixtures, file
`packages/shared-tags/src/__tests__/record-tag-event.test.ts:153`):

| Idempotency input                                     | eventId (32-hex)                     |
| ----------------------------------------------------- | ------------------------------------ |
| `pa-realtime-tagger\|msg-1\|ml\|pa-user\|usr-abc`     | `92296d40c3c400dba057052abdb0afdb`   |

If you ever see this anchor change in test output, **stop** — TS↔Py drift.

## Run tests

```bash
cd packages/shared-tags-py
python -m pytest -v
# or, if uv is available:
uv run pytest -v
```

The test suite covers:

- `tests/test_idempotency.py` — deterministic eventId, case+whitespace
  collapse, divergence on source/docId/entity changes, **explicit
  TS-fixture parity anchors**.
- `tests/test_validation.py` — missing/both userId+jobId rejected, empty
  rawTag rejected, rawText > 500 truncated (not rejected), Zod-strict
  parity for unknown source / empty entity id / extra fields.
- `tests/test_record_tag_event.py` — single-write idempotency, cross-repo
  path produces v1 pending doc, propagation of non-ALREADY_EXISTS errors.

## Lock-step with TypeScript

Any change to `TAG_EVENT_SOURCES`, `ENTITY_KINDS`, the idempotency-key
construction, or schema-version bumps **must** land in the same PR as the
TS-side change. The TS source of truth is:

- `packages/shared-tags/src/types.ts` — taxonomy + collections + decay.
- `packages/shared-tags/src/schemas.ts` — Zod schemas → pydantic here.
- `packages/shared-tags/src/record-tag-event.ts` — write contract.
- `packages/shared-tags/src/__tests__/record-tag-event.test.ts` — the
  shared acceptance fixture set.

When in doubt, run BOTH suites:

```bash
# TS side
pnpm --filter @wekruit/shared-tags test
# Py side
cd packages/shared-tags-py && python -m pytest -v
```
