# @wekruit/shared-tags

Canonical tag vocabularies + Firestore overlay + zod validation. Single source of truth for tag axes used by wekruit-pa matching pipeline.

## Two Tag Systems Inside (Both Active)

1. **Event system** (iter30 WS2) — `pa-canonical-tags`, `pa-tag-events`, `pa-entity-tags` collections. 10 TAG_TYPES (skill/preference/trait/etc). For real-time tag-event ingestion + decay.

2. **v1.6 Per-Axis Vocab** (Phase 52) — `canonical/` subdir. 9 spelled-out axes for matching pipeline. Used by:
   - `cv-ingest` (Phase 53)
   - `mergeUserTags` (Phase 54)
   - `queryMatchingJobsV16` (Phase 56)
   - dashboards (Phase 59)

## v1.6 Vocab Axes

| Axis | Type | Source File |
|---|---|---|
| roleFunction | closed enum (17) | `src/canonical/role-function.ts` |
| industrySector | closed enum (42) + sandbox-promote | `src/canonical/industry-sector.ts` |
| major | closed enum (69) | `src/canonical/major.ts` |
| visa | closed enum (4) | `src/canonical/visa.ts` |
| jobType | closed enum (10) | `src/canonical/job-type.ts` |
| careerStage | closed enum (13) + adjacency helper | `src/canonical/career-stage.ts` |
| location | closed enum (175) | `src/canonical/location.ts` |
| relevantTags | open vocab + 12-cap | `src/canonical/relevant-tags.ts` |
| skills | bucketed (10 buckets) | `src/canonical/skills.ts` |

All values **lowercase + underscore**, **no abbreviations**. Validated at write-time via `validateCanonicalToken(value, vocab)`.

## Sandbox-Promotion Pattern (industrySector only)

D2: industry vocab is **add-able by admin** without code change.

1. CV parse emits `proposedTags: ['some_emerging_industry']` (Phase 53)
2. Token written to `pa-canonical-tags/industry-sector/tokens/{token}` with `status: 'sandbox'`
3. Admin reviews via `/admin/canonical-tags` page (Phase 59)
4. Admin clicks Promote → `paPromoteSandboxTag` CF updates `status: 'promoted'`
5. Runtime resolver `resolveCanonicalVocab('industry-sector', INDUSTRY_SECTOR_VOCAB, db)` merges static enum + promoted overlay tokens

## Browser-Safe Export

Phase 59 surfaced that the package was used in dashboard-web (Vite browser bundle). Added `browser` conditional export pointing at sha256-free barrel for browser consumers. Cloud Functions API surface preserved.

## Cross-Repo Notes

- `wekruit-scraping` Python repo has parallel `INDUSTRY_VOCAB` (38) + `REPO_TO_CATEGORY` (17) pre-existing. Phase 55 deterministic mappers in `apps/functions/src/lib/matching-jobs-mappers.ts` port both.
- v2.0 plan: port `packages/shared-tags/canonical/` to `wekruit_shared_tags` Python package; both repos consume from single source.

## Quick Use

```ts
import { ROLE_FUNCTION_VOCAB, RoleFunctionSchema } from '@wekruit/shared-tags'
import { validateCanonicalToken } from '@wekruit/shared-tags'

// Validate
const v = validateCanonicalToken('software_engineering', 'role-function')
// { ok: true }

// Use enum
const targetRoles: RoleFunction[] = ['software_engineering', 'data_analysis']
```

## Event System (iter30 WS2)

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

Same byte-identical input → same `eventId` → at most one Firestore document. The second call returns `{ created: false, idempotent: true, reason: "duplicate" }`.

### Cross-repo (scraping)

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

1. Tags are **English-only canonical** — `displayName: string` only, no `{zh, en}` split.
2. **Mutex enforcement at write time** — the worker (Phase 2) collapses two semantically equivalent canonicals to ONE entity-tag.
3. Cross-repo idempotency key is **sha256 of pipe-joined fields** so the Python port (`wekruit_shared_tags`) produces byte-identical eventIds.
4. `schemaVersion: "v1"` on every event. Bump on breaking change; both repos must update before PA merges.

## Test commands

```bash
npm --workspace=@wekruit/shared-tags run typecheck
npm --workspace=@wekruit/shared-tags run test
```

## Day-2+ roadmap

- Wave 2: emit JSON-Schema artifact via `zod-to-json-schema` + GH Packages publish + Python port (`wekruit_shared_tags`).
- Phase 2 (separate workstream): worker (`apps/functions/src/tag-worker/`) consumes `pa-tag-events` via `onDocumentCreated`.
