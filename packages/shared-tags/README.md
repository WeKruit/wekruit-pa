# @wekruit/shared-tags

Shared canonical-tag schema + idempotent event-write contract for the
WeKruit PA + scraping repos.

iter30 WS2 Wave-1 surface — workspace-internal in this iteration; GH
Packages publish lands in Wave 2.

## Package contents

```
src/
  index.ts              barrel re-export
  types.ts              TagType, TagEventSource, EntityKind, schemaVersion
  schemas.ts            Zod for pa-canonical-tags / pa-tag-events / pa-entity-tags
  record-tag-event.ts   recordTagEvent() — sha256 idempotency + Firestore .create()
  sha256.ts             deterministic Node-crypto hex (Python-port parity)
  __tests__/            unit tests (idempotency, validation, schema round-trip)
```

See `.planning/iter30/ws-2-7-detail.md` §2-3 for the authoritative spec.

## Usage (TS, PA path)

```ts
import { recordTagEvent } from "@wekruit/shared-tags"
import { getFirestore } from "firebase-admin/firestore"

const fs = getFirestore()

await recordTagEvent(
  {
    userId: "usr-abc",
    rawTag: "Machine Learning",
    source: "pa-realtime-tagger",
    sourceDocId: "msg-42",      // pa-messages doc id
    sourceField: "body",
    type: "skill",
    evidence: "I love ML projects",
  },
  { firestore: fs },
)
```

Same byte-identical input → same `eventId` → at most one Firestore
document. The second call returns `{ created: false, idempotent: true,
reason: "duplicate" }`.

## Cross-repo (scraping)

```ts
import { recordTagEventWithEntityRef } from "@wekruit/shared-tags"

await recordTagEventWithEntityRef(
  {
    source: "scraping-github",
    sourceDocId: "openai/swarm",
    sourceField: "topics[0]",
    rawText: "agent-orchestration",
    type: "topic",
    entityRef: { kind: "scraping-github-repo", id: "openai/swarm" },
  },
  { firestore: fs },
)
```

## Constraints (Adam-locked)

1. Tags are **English-only canonical** — `displayName: string` only, no
   `{zh, en}` split.
2. **Mutex enforcement at write time** — the worker (Phase 2) collapses
   two semantically equivalent canonicals to ONE entity-tag.
3. Cross-repo idempotency key is **sha256 of pipe-joined fields** so the
   Python port (`wekruit_shared_tags`) produces byte-identical eventIds.
4. `schemaVersion: "v1"` on every event. Bump on breaking change; both
   repos must update before PA merges.

## Test commands

```bash
npm --workspace=@wekruit/shared-tags run typecheck
npm --workspace=@wekruit/shared-tags run test
```

## Day-2+ roadmap

- Wave 2: emit JSON-Schema artifact via `zod-to-json-schema` + GH Packages
  publish + Python port (`wekruit_shared_tags`).
- Phase 2 (separate workstream): worker (`apps/functions/src/tag-worker/`)
  consumes `pa-tag-events` via `onDocumentCreated`.
