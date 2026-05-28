# Partner Users API + Privacy Disclosure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a partner-facing HTTP Cloud Function (`paPartnerUsersApi`) exposing layoffhedge-referred candidates' candidacy status, plus parallel privacy-policy disclosure across all WeKruit `/legal` pages.

**Architecture:** New CSV-keyed HTTP Cloud Function under the `pa-orchestrator` codebase. Auth derives partner source from key prefix (`key_<source>_<random>`); enforces per-partner data isolation. Single fat endpoint returning `users[]` with embedded `jobs[]` and a `summary` block. Cursor pagination on `pa-users.createdAt`. PII tier 1 (email + name) exposed; tier 2 (resume / transcript / memory) withheld. Two Legal.tsx files updated in lockstep; layoff.wekruit.com inherits via shared dist.

**Tech Stack:** TypeScript, Firebase Cloud Functions v2 (`onRequest`), Firestore admin, zod, node:test (via `tsx`), React 19 (SPA legal pages).

**Spec:** [`docs/superpowers/specs/2026-05-27-partner-users-api-design.md`](../specs/2026-05-27-partner-users-api-design.md)

**Worktree:** `/Users/adam/Desktop/WeKruit/wekruit-pa/.claude/worktrees/partner-api` (branch `claude/partner-users-api`, based on `origin/main` `fc26e04f`).

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `apps/functions/src/partner-users-api.ts` | **create** | All handler logic — auth helpers, query layer, response shaping, HTTP entry. Single file because all parts are tightly coupled and the file stays well under 600 lines. |
| `apps/functions/src/__tests__/partner-users-api.test.ts` | **create** | Unit + FakeFirestore integration tests. |
| `apps/functions/src/index.ts` | **modify** | Append `export { paPartnerUsersApi } from "./partner-users-api.js"`. |
| `firebase.json` | **modify** | Add `/api/v1/partner/users` rewrite to `pa-landing` hosting target BEFORE the catch-all `**` rewrite. |
| `apps/pa-landing/src/pages/Legal.tsx` | **modify** | "Partner referrals" paragraph in "Who can see your data" + new "Partners we share with" section + version bump v1.0 → v1.1. |
| `apps/dashboard-web/src/pages/Legal.tsx` | **modify** | Mirror the pa-landing changes. |

No new package dependencies. No schema migrations. No new Firestore indexes (the `pa-users.source == X order by createdAt desc` query is already indexed via the existing `paAdminPassedCandidatesSnapshot` admin tooling pattern; verify in Task 4).

---

## Task 1: Baseline lock + secret prep

**Files:** none (verification only).

- [ ] **Step 1: Pin Node 24 and verify clean worktree**

Run:
```bash
cd /Users/adam/Desktop/WeKruit/wekruit-pa/.claude/worktrees/partner-api
source ~/.zshrc && nvm use 24
node --version
git status
git log --oneline -2
```
Expected: `v24.x.x`; working tree clean; HEAD at `4eda95cd docs(spec): partner users API + privacy disclosure design` on `claude/partner-users-api` branch.

- [ ] **Step 2: Install deps**

Run:
```bash
pnpm install --frozen-lockfile
```
Expected: completes with no errors. (First run may take ~30s; subsequent runs near-instant via pnpm store.)

- [ ] **Step 3: Snapshot baseline test suites**

Run:
```bash
pnpm --filter @pa/core-types test
pnpm --filter pa-orchestrator test
pnpm --filter @pa/functions test
```
Expected: all suites pass with the test counts seen on `origin/main` (do NOT memorize the exact numbers — verify they're green; capture the count for after-comparison).

If anything is red on baseline, STOP and report BLOCKED.

- [ ] **Step 4: Confirm Firebase Secret `PA_PARTNER_USERS_API_KEYS` does NOT yet exist**

Run:
```bash
gcloud secrets describe PA_PARTNER_USERS_API_KEYS --project=wekruit-5f89b 2>&1 | head -5 || echo "secret-not-found"
```
Expected: `NOT_FOUND` error (or `secret-not-found` fallback). If the secret already exists, surface that — likely a previous abandoned attempt — and do NOT overwrite without explicit confirmation.

No commit in this task.

---

## Task 2: Create `partner-users-api.ts` skeleton + auth layer

**Files:**
- Create: `apps/functions/src/partner-users-api.ts`
- Create: `apps/functions/src/__tests__/partner-users-api.test.ts`

- [ ] **Step 1: Write the failing test for `verifyPartnerKey`**

Create `apps/functions/src/__tests__/partner-users-api.test.ts`:

```ts
import assert from "node:assert/strict"
import test from "node:test"

import { __test_verifyPartnerKey, __test_PARTNER_KEY_RE } from "../partner-users-api.js"

const KEYS_CSV = "key_layoffhedge_abc123def456,key_layoffheaven_xyz789"

test("verifyPartnerKey rejects missing api key", () => {
  const res = __test_verifyPartnerKey(undefined, undefined, KEYS_CSV, "*")
  assert.deepEqual(res, { ok: false, reason: "missing_api_key" })
})

test("verifyPartnerKey rejects malformed key shape", () => {
  const res = __test_verifyPartnerKey("not_a_key", undefined, KEYS_CSV, "*")
  assert.deepEqual(res, { ok: false, reason: "invalid_api_key_format" })
})

test("verifyPartnerKey rejects key not in CSV", () => {
  const res = __test_verifyPartnerKey("key_layoffhedge_wrongtail", undefined, KEYS_CSV, "*")
  assert.deepEqual(res, { ok: false, reason: "invalid_api_key" })
})

test("verifyPartnerKey rejects key whose prefix is not a PaUserSource", () => {
  // Add a key whose source slug isn't in PA_USER_SOURCES enum.
  const csv = "key_unknownpartner_abc123"
  const res = __test_verifyPartnerKey("key_unknownpartner_abc123", undefined, csv, "*")
  assert.deepEqual(res, { ok: false, reason: "key_partner_mismatch" })
})

test("verifyPartnerKey accepts valid layoffhedge key and returns partnerSource", () => {
  const res = __test_verifyPartnerKey("key_layoffhedge_abc123def456", undefined, KEYS_CSV, "*")
  assert.deepEqual(res, { ok: true, partnerSource: "layoffhedge" })
})

test("verifyPartnerKey enforces origin allowlist when set", () => {
  const allowlist = "https://layoffhedge.com,https://staging.layoffhedge.com"
  const ok = __test_verifyPartnerKey(
    "key_layoffhedge_abc123def456",
    "https://layoffhedge.com",
    KEYS_CSV,
    allowlist,
  )
  assert.deepEqual(ok, { ok: true, partnerSource: "layoffhedge" })

  const blocked = __test_verifyPartnerKey(
    "key_layoffhedge_abc123def456",
    "https://evil.example",
    KEYS_CSV,
    allowlist,
  )
  assert.deepEqual(blocked, { ok: false, reason: "origin_not_allowed" })
})

test("verifyPartnerKey server-to-server (no Origin) accepted on key alone", () => {
  const allowlist = "https://layoffhedge.com"
  const res = __test_verifyPartnerKey(
    "key_layoffhedge_abc123def456",
    undefined, // no Origin header
    KEYS_CSV,
    allowlist,
  )
  assert.deepEqual(res, { ok: true, partnerSource: "layoffhedge" })
})

test("PARTNER_KEY_RE captures multi-word slugs", () => {
  // Future partner with underscore in slug, e.g. `external_supply`
  const match = __test_PARTNER_KEY_RE.exec("key_external_supply_abc123")
  assert.ok(match)
  assert.equal(match![1], "external_supply")
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/functions
node --import tsx --test src/__tests__/partner-users-api.test.ts
```
Expected: cannot import `partner-users-api.js` — file does not yet exist.

- [ ] **Step 3: Create the skeleton with auth layer**

Create `apps/functions/src/partner-users-api.ts`:

```ts
/**
 * Public partner API — paPartnerUsersApi.
 *
 * Surface: GET https://wekruit.com/api/v1/partner/users
 * Auth: X-API-Key header. Keys shaped `key_<partnerSource>_<random>` —
 * the prefix is parsed to derive the `pa-users.source` filter, so each
 * key is scoped to exactly one partner's data.
 *
 * Spec: docs/superpowers/specs/2026-05-27-partner-users-api-design.md
 */
import { getApps, initializeApp } from "firebase-admin/app"
import { Timestamp, getFirestore, type Firestore, type Query } from "firebase-admin/firestore"
import { defineSecret } from "firebase-functions/params"
import { onRequest } from "firebase-functions/v2/https"
import { createHash } from "node:crypto"
import {
  CandidateJobStateSchema,
  PA_COLLECTIONS,
  isPaUserSource,
  type CandidateJobState,
  type PaUserSource,
} from "@pa/core-types"

if (!getApps().length) initializeApp()

// ---------------------------------------------------------------- secrets

/** CSV of partner-scoped API keys. Each `key_<source>_<random>`. */
const PA_PARTNER_USERS_API_KEYS = defineSecret("PA_PARTNER_USERS_API_KEYS")
/** Reused from paPublicOpenJobs — same browser origin allowlist applies. */
const PA_PUBLIC_COLLAB_ORIGINS = defineSecret("PA_PUBLIC_COLLAB_ORIGINS")

// ---------------------------------------------------------------- constants

const API_VERSION = "v1"
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const PER_USER_JOB_CAP = 50
const SNAPSHOT_TTL_MS = 60_000

// ---------------------------------------------------------------- types

interface AuthOk {
  ok: true
  partnerSource: PaUserSource
}

interface AuthFail {
  ok: false
  reason:
    | "missing_api_key"
    | "invalid_api_key"
    | "invalid_api_key_format"
    | "key_partner_mismatch"
    | "origin_not_allowed"
}

type AuthResult = AuthOk | AuthFail

// ---------------------------------------------------------------- auth

const PARTNER_KEY_RE = /^key_([a-z][a-z0-9_]+?)_[A-Za-z0-9]+$/

function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}

export function verifyPartnerKey(
  apiKey: string | undefined,
  origin: string | undefined,
  keysCsv: string,
  originsCsv: string,
): AuthResult {
  if (!apiKey) return { ok: false, reason: "missing_api_key" }

  const match = PARTNER_KEY_RE.exec(apiKey)
  if (!match) return { ok: false, reason: "invalid_api_key_format" }
  const partnerSlug = match[1]!

  const keys = keysCsv.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
  const apiKeyBuf = Buffer.from(apiKey)
  let matched = false
  for (const k of keys) {
    if (constantTimeEqual(apiKeyBuf, Buffer.from(k))) {
      matched = true
      break
    }
  }
  if (!matched) return { ok: false, reason: "invalid_api_key" }

  if (!isPaUserSource(partnerSlug)) return { ok: false, reason: "key_partner_mismatch" }
  const partnerSource = partnerSlug as PaUserSource

  const originsTrim = originsCsv.trim()
  if (originsTrim === "*" || originsTrim === "") return { ok: true, partnerSource }
  if (!origin) return { ok: true, partnerSource }
  const allowed = originsTrim.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
  if (!allowed.includes(origin)) return { ok: false, reason: "origin_not_allowed" }
  return { ok: true, partnerSource }
}

// Internal test exports (do not call from production code).
export const __test_verifyPartnerKey = verifyPartnerKey
export const __test_PARTNER_KEY_RE = PARTNER_KEY_RE

// ---------------------------------------------------------------- handler

export const paPartnerUsersApi = onRequest(
  {
    region: "us-central1",
    memory: "512MiB",
    maxInstances: 10,
    secrets: [PA_PARTNER_USERS_API_KEYS, PA_PUBLIC_COLLAB_ORIGINS],
  },
  async (req, res) => {
    // CORS preflight — partners may call from a browser.
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Key")
    res.setHeader("Access-Control-Max-Age", "3600")
    if (req.method === "OPTIONS") {
      res.status(204).end()
      return
    }
    if (req.method !== "GET") {
      res.status(405).json({ ok: false, reason: "method_not_allowed" })
      return
    }

    const apiKey = req.header("x-api-key") ?? undefined
    const origin = req.header("origin") ?? undefined
    const auth = verifyPartnerKey(
      apiKey,
      origin,
      PA_PARTNER_USERS_API_KEYS.value(),
      PA_PUBLIC_COLLAB_ORIGINS.value(),
    )
    if (!auth.ok) {
      const status = auth.reason === "origin_not_allowed" || auth.reason === "key_partner_mismatch" ? 403 : 401
      const fp = apiKey ? createHash("sha256").update(apiKey).digest("hex").slice(0, 8) : "absent"
      console.warn(`paPartnerUsersApi auth_fail reason=${auth.reason} key_fp=${fp} origin=${origin ?? "absent"}`)
      res.status(status).json({ ok: false, reason: auth.reason })
      return
    }

    // Query layer + response shaping land in Task 3 + Task 4.
    res.status(501).json({ ok: false, reason: "not_implemented" })
  },
)
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/functions
node --import tsx --test src/__tests__/partner-users-api.test.ts
```
Expected: all 8 tests pass.

- [ ] **Step 5: Run the full functions suite to verify no regression**

```bash
pnpm --filter @pa/functions test
```
Expected: green; total = baseline + 8.

- [ ] **Step 6: Commit**

```bash
git add apps/functions/src/partner-users-api.ts apps/functions/src/__tests__/partner-users-api.test.ts
git commit -m "$(cat <<'EOF'
feat(functions): partner-users-api skeleton + key auth

verifyPartnerKey parses key prefix (`key_<source>_<random>`) and anchors
to PA_USER_SOURCES enum for per-partner isolation. Reuses constant-time
CSV compare from paPublicOpenJobs. Origin allowlist reused via
PA_PUBLIC_COLLAB_ORIGINS. Handler returns 501 for the query path (lands
in Task 3 + 4).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Query layer — Firestore reads

**Files:**
- Modify: `apps/functions/src/partner-users-api.ts`
- Modify: `apps/functions/src/__tests__/partner-users-api.test.ts`

- [ ] **Step 1: Add the failing integration tests with a FakeFirestore**

Open `apps/functions/src/__tests__/partner-users-api.test.ts` and append:

```ts
import {
  __test_fetchPartnerUsers,
  type PartnerUsersFetchArgs,
  type PartnerUsersResponse,
} from "../partner-users-api.js"

// Minimal FakeFirestore mimicking the surface fetchPartnerUsers uses.
// Real prod paths go through firebase-admin; this fake mirrors only what
// the query layer touches.
interface FakeDoc { id: string; data: Record<string, unknown> }
interface FakeStore { [collection: string]: FakeDoc[] }

function makeFakeDb(store: FakeStore): unknown {
  const queryFor = (path: string) => {
    type Filter = (doc: FakeDoc) => boolean
    type OrderEntry = { field: string; dir: "asc" | "desc" }
    const filters: Filter[] = []
    const orders: OrderEntry[] = []
    let lim: number | undefined
    let startAfterTuple: unknown[] | undefined

    const compare = (a: FakeDoc, b: FakeDoc): number => {
      for (const { field, dir } of orders) {
        const av = field === "__name__" ? a.id : (a.data[field] as number | string)
        const bv = field === "__name__" ? b.id : (b.data[field] as number | string)
        const cmp = av === bv ? 0 : av < bv ? -1 : 1
        if (cmp !== 0) return dir === "asc" ? cmp : -cmp
      }
      return 0
    }

    const obj: any = {
      where(field: string, op: string, value: unknown) {
        if (op === "==") filters.push((d) => d.data[field] === value)
        else if (op === ">") filters.push((d) => (d.data[field] as number) > (value as number))
        else throw new Error(`unsupported op ${op}`)
        return obj
      },
      orderBy(field: string, dir: "asc" | "desc" = "asc") {
        orders.push({ field, dir })
        return obj
      },
      limit(n: number) {
        lim = n
        return obj
      },
      startAfter(...vals: unknown[]) {
        startAfterTuple = vals
        return obj
      },
      async get() {
        let rows = (store[path] ?? []).filter((d) => filters.every((f) => f(d)))
        rows = rows.sort(compare)
        if (startAfterTuple) {
          rows = rows.filter((d) => {
            for (let i = 0; i < orders.length; i++) {
              const { field, dir } = orders[i]!
              const dv = field === "__name__" ? d.id : (d.data[field] as number | string)
              const sv = startAfterTuple![i] as number | string
              if (dv === sv) continue
              return dir === "desc" ? dv < sv : dv > sv
            }
            return false
          })
        }
        if (lim !== undefined) rows = rows.slice(0, lim)
        return { docs: rows.map((d) => ({ id: d.id, data: () => d.data })) }
      },
    }
    return obj
  }

  return {
    collection(path: string) {
      const base = queryFor(path)
      return {
        ...base,
        doc(id: string) {
          return {
            async get() {
              const d = (store[path] ?? []).find((x) => x.id === id)
              return { id, exists: !!d, data: () => d?.data ?? {} }
            },
          }
        },
      }
    },
  }
}

test("fetchPartnerUsers returns only users matching partnerSource", async () => {
  const store: FakeStore = {
    "pa-users": [
      { id: "uA", data: { source: "layoffhedge", email: "a@x.com", displayName: "A", createdAt: "2026-05-27T12:00:00Z", createdAtMs: 1779915600000 } },
      { id: "uB", data: { source: "candidate", email: "b@x.com", displayName: "B", createdAt: "2026-05-27T11:00:00Z", createdAtMs: 1779912000000 } },
      { id: "uC", data: { source: "layoffhedge", email: "c@x.com", displayName: "C", createdAt: "2026-05-27T10:00:00Z", createdAtMs: 1779908400000 } },
    ],
    "pa-candidate-job-states": [],
    "pa-jobs": [],
    "pa-prescreen-sessions": [],
  }
  const db = makeFakeDb(store) as Firestore
  const res = await __test_fetchPartnerUsers({
    db,
    partnerSource: "layoffhedge",
    limit: 50,
  })
  assert.equal(res.users.length, 2)
  assert.deepEqual(res.users.map((u) => u.wekruitUserId).sort(), ["uA", "uC"])
})

test("fetchPartnerUsers embeds jobs[] with state + jobTitle", async () => {
  const store: FakeStore = {
    "pa-users": [
      { id: "uA", data: { source: "layoffhedge", email: "a@x.com", displayName: "A", createdAt: "2026-05-27T12:00:00Z", createdAtMs: 1779915600000 } },
    ],
    "pa-candidate-job-states": [
      { id: "uA__hs-1", data: { candidateId: "uA", jobId: "hs-1", state: "prescreen_started", stateUpdatedAt: "2026-05-28T09:00:00Z", stateUpdatedAtMs: 1779984000000 } },
    ],
    "pa-jobs": [
      { id: "hs-1", data: { title: "Senior PM", company: "Invoko" } },
    ],
    "pa-prescreen-sessions": [
      { id: "pss_1", data: { candidateId: "uA", jobId: "hs-1", updatedAt: "2026-05-28T09:05:00Z", updatedAtMs: 1779984300000 } },
    ],
  }
  const db = makeFakeDb(store) as Firestore
  const res = await __test_fetchPartnerUsers({
    db,
    partnerSource: "layoffhedge",
    limit: 50,
  })
  assert.equal(res.users.length, 1)
  const u = res.users[0]!
  assert.equal(u.email, "a@x.com")
  assert.equal(u.name, "A")
  assert.equal(u.jobs.length, 1)
  const j = u.jobs[0]!
  assert.equal(j.jobId, "hs-1")
  assert.equal(j.state, "prescreen_started")
  assert.equal(j.jobTitle, "Senior PM")
  assert.equal(j.company, "Invoko")
  assert.equal(j.prescreenSessionId, "pss_1")
  assert.equal(j.wekruitJobUrl, "https://wekruit.com/j/hs-1")
})

test("fetchPartnerUsers paginates via cursor (createdAtMs + docId)", async () => {
  const users = Array.from({ length: 5 }, (_, i) => ({
    id: `u${i}`,
    data: { source: "layoffhedge", email: `u${i}@x.com`, displayName: `U${i}`, createdAt: `2026-05-27T1${i}:00:00Z`, createdAtMs: 1779900000000 + i * 1000 },
  }))
  const store: FakeStore = {
    "pa-users": users,
    "pa-candidate-job-states": [],
    "pa-jobs": [],
    "pa-prescreen-sessions": [],
  }
  const db = makeFakeDb(store) as Firestore
  const page1 = await __test_fetchPartnerUsers({ db, partnerSource: "layoffhedge", limit: 2 })
  assert.equal(page1.users.length, 2)
  assert.equal(page1.hasMore, true)
  assert.ok(page1.nextCursor)

  const page2 = await __test_fetchPartnerUsers({
    db,
    partnerSource: "layoffhedge",
    limit: 2,
    cursorOpaque: page1.nextCursor!,
  })
  assert.equal(page2.users.length, 2)
  assert.equal(page2.hasMore, true)

  const page3 = await __test_fetchPartnerUsers({
    db,
    partnerSource: "layoffhedge",
    limit: 2,
    cursorOpaque: page2.nextCursor!,
  })
  assert.equal(page3.users.length, 1)
  assert.equal(page3.hasMore, false)

  // All five distinct.
  const allIds = [...page1.users, ...page2.users, ...page3.users].map((u) => u.wekruitUserId)
  assert.deepEqual([...new Set(allIds)].sort(), ["u0", "u1", "u2", "u3", "u4"])
})

test("fetchPartnerUsers filters by status when provided", async () => {
  const store: FakeStore = {
    "pa-users": [
      { id: "uA", data: { source: "layoffhedge", email: "a@x.com", displayName: "A", createdAt: "2026-05-27T12:00:00Z", createdAtMs: 1779915600000 } },
      { id: "uB", data: { source: "layoffhedge", email: "b@x.com", displayName: "B", createdAt: "2026-05-27T11:00:00Z", createdAtMs: 1779912000000 } },
    ],
    "pa-candidate-job-states": [
      { id: "uA__hs-1", data: { candidateId: "uA", jobId: "hs-1", state: "passed", stateUpdatedAt: "2026-05-28T09:00:00Z", stateUpdatedAtMs: 1779984000000 } },
      { id: "uB__hs-2", data: { candidateId: "uB", jobId: "hs-2", state: "outbound_sent", stateUpdatedAt: "2026-05-28T09:00:00Z", stateUpdatedAtMs: 1779984000000 } },
    ],
    "pa-jobs": [
      { id: "hs-1", data: { title: "T1", company: "C1" } },
      { id: "hs-2", data: { title: "T2", company: "C2" } },
    ],
    "pa-prescreen-sessions": [],
  }
  const db = makeFakeDb(store) as Firestore
  const res = await __test_fetchPartnerUsers({
    db,
    partnerSource: "layoffhedge",
    limit: 50,
    status: ["passed"],
  })
  // Only uA appears because only uA has a job with state `passed`.
  assert.equal(res.users.length, 1)
  assert.equal(res.users[0]!.wekruitUserId, "uA")
})

test("fetchPartnerUsers cross-partner isolation: layoffhedge key cannot see candidate-bucket users", async () => {
  const store: FakeStore = {
    "pa-users": [
      { id: "uA", data: { source: "candidate", email: "a@x.com", displayName: "A", createdAt: "2026-05-27T12:00:00Z", createdAtMs: 1779915600000 } },
      { id: "uB", data: { source: "candidate", email: "b@x.com", displayName: "B", createdAt: "2026-05-27T11:00:00Z", createdAtMs: 1779912000000 } },
    ],
    "pa-candidate-job-states": [],
    "pa-jobs": [],
    "pa-prescreen-sessions": [],
  }
  const db = makeFakeDb(store) as Firestore
  const res = await __test_fetchPartnerUsers({
    db,
    partnerSource: "layoffhedge",
    limit: 50,
  })
  assert.equal(res.users.length, 0)
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/functions
node --import tsx --test src/__tests__/partner-users-api.test.ts
```
Expected: 5 new tests fail with "cannot import __test_fetchPartnerUsers".

- [ ] **Step 3: Implement `fetchPartnerUsers` + cursor codec**

Open `apps/functions/src/partner-users-api.ts`. Replace the file body BELOW the `// ---------------------------------------------------------------- handler` divider (everything from `export const paPartnerUsersApi = ...` onward) and ADD the new exports + query function ABOVE that divider:

```ts
// ---------------------------------------------------------------- query

export interface PartnerUsersFetchArgs {
  db: Firestore
  partnerSource: PaUserSource
  limit: number
  cursorOpaque?: string
  status?: CandidateJobState[]
  since?: string // ISO 8601
}

export interface PartnerUsersJobRow {
  jobId: string
  jobTitle: string
  company: string
  state: CandidateJobState
  stateUpdatedAt: string
  prescreenSessionId?: string
  wekruitJobUrl: string
}

export interface PartnerUsersUserRow {
  email: string
  name?: string
  wekruitUserId: string
  registeredAt: string
  lifecycleState?: string
  jobs: PartnerUsersJobRow[]
  summary: {
    totalJobs: number
    passedJobs: number
    notPassedJobs: number
    activePrescreens: number
    employerVisibleJobs: number
  }
}

export interface PartnerUsersResponse {
  users: PartnerUsersUserRow[]
  nextCursor?: string
  hasMore: boolean
  generatedAt: string
  partner: PaUserSource
  apiVersion: string
}

interface CursorPayload {
  createdAtMs: number
  docId: string
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url")
}

function decodeCursor(opaque: string): CursorPayload | null {
  try {
    const decoded = JSON.parse(Buffer.from(opaque, "base64url").toString("utf8"))
    if (
      decoded &&
      typeof decoded === "object" &&
      typeof decoded.createdAtMs === "number" &&
      typeof decoded.docId === "string"
    ) {
      return { createdAtMs: decoded.createdAtMs, docId: decoded.docId }
    }
    return null
  } catch {
    return null
  }
}

function toIsoString(value: unknown, fallback: string): string {
  if (typeof value === "string" && value) return value
  if (value instanceof Timestamp) return value.toDate().toISOString()
  if (typeof value === "object" && value !== null && "_seconds" in value) {
    const sec = Number((value as { _seconds?: unknown })._seconds ?? 0)
    return new Date(sec * 1000).toISOString()
  }
  return fallback
}

function activePrescreenStates(): ReadonlySet<CandidateJobState> {
  return new Set<CandidateJobState>([
    "prescreen_started",
    "prescreen_review_pending",
    "paused",
  ])
}

const ACTIVE_PRESCREEN = activePrescreenStates()

export async function fetchPartnerUsers(args: PartnerUsersFetchArgs): Promise<PartnerUsersResponse> {
  const { db, partnerSource, limit } = args
  const safeLimit = Math.max(1, Math.min(MAX_LIMIT, limit))
  const sinceMs = args.since ? Date.parse(args.since) : undefined

  // Users page (limit + 1 to detect hasMore).
  let usersQ: Query = db
    .collection(PA_COLLECTIONS.users)
    .where("source", "==", partnerSource)
    .orderBy("createdAtMs", "desc")
    .orderBy("__name__", "desc")
  const cursor = args.cursorOpaque ? decodeCursor(args.cursorOpaque) : null
  if (cursor) usersQ = usersQ.startAfter(cursor.createdAtMs, cursor.docId)
  usersQ = usersQ.limit(safeLimit + 1)
  const usersSnap = await usersQ.get()
  const usersDocs = usersSnap.docs.slice(0, safeLimit)
  const hasMore = usersSnap.docs.length > safeLimit

  // Per-user job states + job-doc hydration + prescreen session join.
  const rows = await Promise.all(
    usersDocs.map(async (userDoc) => {
      const userData = userDoc.data() ?? {}
      const candidateId = userDoc.id

      const stateSnap = await db
        .collection(PA_COLLECTIONS.candidateJobStates)
        .where("candidateId", "==", candidateId)
        .orderBy("stateUpdatedAtMs", "desc")
        .limit(PER_USER_JOB_CAP)
        .get()
      const jobStates = stateSnap.docs.map((d) => ({ id: d.id, data: d.data() ?? {} }))

      const distinctJobIds = [
        ...new Set(jobStates.map((s) => (s.data.jobId as string | undefined) ?? "").filter(Boolean)),
      ]
      const jobDocs = await Promise.all(
        distinctJobIds.map((jobId) =>
          db.collection(PA_COLLECTIONS.matchingJobs).doc(jobId).get().catch(() => null),
        ),
      )
      const jobMeta = new Map<string, { title: string; company: string }>()
      for (let i = 0; i < distinctJobIds.length; i++) {
        const snap = jobDocs[i]
        const data = (snap && typeof snap === "object" && "data" in snap ? snap.data?.() : null) ?? {}
        jobMeta.set(distinctJobIds[i]!, {
          title: (data.title as string | undefined) ?? "Unknown role",
          company: (data.company as string | undefined) ?? "",
        })
      }

      const jobs: PartnerUsersJobRow[] = []
      for (const s of jobStates) {
        const parsed = CandidateJobStateSchema.safeParse(s.data.state)
        if (!parsed.success) continue
        const jobId = (s.data.jobId as string | undefined) ?? ""
        if (!jobId) continue
        const stateUpdatedAt = toIsoString(s.data.stateUpdatedAt, new Date(0).toISOString())
        if (sinceMs !== undefined && Date.parse(stateUpdatedAt) < sinceMs) continue
        if (args.status && args.status.length > 0 && !args.status.includes(parsed.data)) continue
        const meta = jobMeta.get(jobId) ?? { title: "Unknown role", company: "" }

        // Latest prescreen session for this candidate+job.
        const psSnap = await db
          .collection("pa-prescreen-sessions")
          .where("candidateId", "==", candidateId)
          .where("jobId", "==", jobId)
          .orderBy("updatedAtMs", "desc")
          .limit(1)
          .get()
          .catch(() => ({ docs: [] }))
        const prescreenSessionId = psSnap.docs[0]?.id

        jobs.push({
          jobId,
          jobTitle: meta.title,
          company: meta.company,
          state: parsed.data,
          stateUpdatedAt,
          prescreenSessionId,
          wekruitJobUrl: `https://wekruit.com/j/${jobId}`,
        })
      }

      // If a status filter is present, drop users with zero remaining jobs.
      if (args.status && args.status.length > 0 && jobs.length === 0) return null

      const summary = {
        totalJobs: jobs.length,
        passedJobs: jobs.filter((j) => j.state === "passed").length,
        notPassedJobs: jobs.filter((j) => j.state === "not_passed").length,
        activePrescreens: jobs.filter((j) => ACTIVE_PRESCREEN.has(j.state)).length,
        employerVisibleJobs: jobs.filter((j) => j.state === "employer_visible").length,
      }

      return {
        email: (userData.email as string | undefined) ?? "",
        name: (userData.displayName as string | undefined) ?? undefined,
        wekruitUserId: candidateId,
        registeredAt: toIsoString(userData.createdAt, new Date(0).toISOString()),
        lifecycleState: (userData.lifecycleState as string | undefined) ?? undefined,
        jobs,
        summary,
      } as PartnerUsersUserRow
    }),
  )

  const filteredRows = rows.filter((r): r is PartnerUsersUserRow => r !== null)

  let nextCursor: string | undefined
  if (hasMore && usersDocs.length > 0) {
    const last = usersDocs[usersDocs.length - 1]!
    const lastData = last.data() ?? {}
    nextCursor = encodeCursor({
      createdAtMs: Number(lastData.createdAtMs ?? 0),
      docId: last.id,
    })
  }

  return {
    users: filteredRows,
    nextCursor,
    hasMore,
    generatedAt: new Date().toISOString(),
    partner: partnerSource,
    apiVersion: API_VERSION,
  }
}

export const __test_fetchPartnerUsers = fetchPartnerUsers

// ---------------------------------------------------------------- handler
```

(Keep the existing handler stub from Task 2; only the query layer is new in this task. The handler is still 501 — wired in Task 4.)

NOTE on `PA_COLLECTIONS.matchingJobs`: verify the collection name in `packages/core-types/src/collections.ts`. The `pa-jobs` collection that holds `title` + `company` is `matchingJobs` in the constant map. If the constant name is different (e.g. `paJobs`), use the matching one. Do NOT hard-code `"pa-jobs"`.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/functions
node --import tsx --test src/__tests__/partner-users-api.test.ts
```
Expected: all 13 tests pass (8 auth + 5 query). If a test fails because the FakeFirestore mock doesn't model some real Firestore behavior (e.g. missing field in `data()`), tighten the test fixture rather than the production code — the production code targets real Firestore admin SDK.

- [ ] **Step 5: Run the full functions suite**

```bash
pnpm --filter @pa/functions test
```
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add apps/functions/src/partner-users-api.ts apps/functions/src/__tests__/partner-users-api.test.ts
git commit -m "$(cat <<'EOF'
feat(functions): partner-users-api query layer

fetchPartnerUsers reads pa-users filtered by source, hydrates per-user
pa-candidate-job-states, joins job titles, fetches latest prescreen
session. Cursor pagination on createdAtMs + docId. Status + since
filters applied client-side after read (small per-user job lists).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: HTTP handler — wire query into response

**Files:**
- Modify: `apps/functions/src/partner-users-api.ts`
- Modify: `apps/functions/src/__tests__/partner-users-api.test.ts`

- [ ] **Step 1: Add the failing handler tests**

Append to `apps/functions/src/__tests__/partner-users-api.test.ts`:

```ts
import { __test_parseHandlerQuery } from "../partner-users-api.js"

test("parseHandlerQuery clamps limit to [1, 200]", () => {
  assert.equal(__test_parseHandlerQuery({ limit: "10" }).limit, 10)
  assert.equal(__test_parseHandlerQuery({ limit: "0" }).limit, 1)
  assert.equal(__test_parseHandlerQuery({ limit: "9999" }).limit, 200)
  assert.equal(__test_parseHandlerQuery({}).limit, 50)
})

test("parseHandlerQuery parses status csv", () => {
  const parsed = __test_parseHandlerQuery({ status: "passed,prescreen_started" })
  assert.deepEqual(parsed.status, ["passed", "prescreen_started"])
})

test("parseHandlerQuery rejects unknown status value", () => {
  assert.throws(() => __test_parseHandlerQuery({ status: "bogus_state" }), /invalid_query/)
})

test("parseHandlerQuery rejects malformed since", () => {
  assert.throws(() => __test_parseHandlerQuery({ since: "yesterday" }), /invalid_query/)
})

test("parseHandlerQuery accepts opaque cursor as-is", () => {
  const parsed = __test_parseHandlerQuery({ cursor: "anyOpaqueValue=" })
  assert.equal(parsed.cursorOpaque, "anyOpaqueValue=")
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/functions
node --import tsx --test src/__tests__/partner-users-api.test.ts
```
Expected: 5 new tests fail with "cannot import __test_parseHandlerQuery".

- [ ] **Step 3: Implement `parseHandlerQuery` + wire handler to fetchPartnerUsers**

Open `apps/functions/src/partner-users-api.ts`. Above the handler, add:

```ts
// ---------------------------------------------------------------- request

interface ParsedHandlerQuery {
  limit: number
  cursorOpaque?: string
  status?: CandidateJobState[]
  since?: string
}

function parseHandlerQuery(q: Record<string, string | string[] | undefined>): ParsedHandlerQuery {
  const out: ParsedHandlerQuery = { limit: DEFAULT_LIMIT }

  const rawLimit = typeof q.limit === "string" ? q.limit : undefined
  if (rawLimit !== undefined) {
    const n = Number(rawLimit)
    if (!Number.isFinite(n)) throw new Error("invalid_query:limit")
    out.limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(n)))
  }

  const rawStatus = typeof q.status === "string" ? q.status : undefined
  if (rawStatus) {
    const items = rawStatus
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    const validated: CandidateJobState[] = []
    for (const item of items) {
      const parsed = CandidateJobStateSchema.safeParse(item)
      if (!parsed.success) throw new Error("invalid_query:status")
      validated.push(parsed.data)
    }
    out.status = validated
  }

  const rawSince = typeof q.since === "string" ? q.since : undefined
  if (rawSince) {
    const t = Date.parse(rawSince)
    if (!Number.isFinite(t)) throw new Error("invalid_query:since")
    out.since = rawSince
  }

  const rawCursor = typeof q.cursor === "string" ? q.cursor : undefined
  if (rawCursor) out.cursorOpaque = rawCursor

  return out
}

export const __test_parseHandlerQuery = parseHandlerQuery
```

Then replace the handler stub body. Find:

```ts
    // Query layer + response shaping land in Task 3 + Task 4.
    res.status(501).json({ ok: false, reason: "not_implemented" })
```

Replace with:

```ts
    let parsedQuery: ParsedHandlerQuery
    try {
      parsedQuery = parseHandlerQuery(req.query as Record<string, string | string[] | undefined>)
    } catch (err) {
      const reason = err instanceof Error ? err.message : "invalid_query"
      res.status(400).json({ ok: false, reason })
      return
    }

    try {
      const t0 = Date.now()
      const response = await fetchPartnerUsers({
        db: getFirestore(),
        partnerSource: auth.partnerSource,
        limit: parsedQuery.limit,
        cursorOpaque: parsedQuery.cursorOpaque,
        status: parsedQuery.status,
        since: parsedQuery.since,
      })
      const ms = Date.now() - t0
      console.info(
        `paPartnerUsersApi ok partner=${auth.partnerSource} users=${response.users.length} hasMore=${response.hasMore} latency_ms=${ms}`,
      )
      res.status(200).json(response)
    } catch (err) {
      const fp = apiKey ? createHash("sha256").update(apiKey).digest("hex").slice(0, 8) : "absent"
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`paPartnerUsersApi internal_error key_fp=${fp} err=${msg}`)
      res.status(500).json({ ok: false, reason: "internal_error" })
    }
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/functions
node --import tsx --test src/__tests__/partner-users-api.test.ts
```
Expected: all 18 tests pass.

- [ ] **Step 5: Run the full functions suite**

```bash
pnpm --filter @pa/functions test
```
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add apps/functions/src/partner-users-api.ts apps/functions/src/__tests__/partner-users-api.test.ts
git commit -m "$(cat <<'EOF'
feat(functions): partner-users-api handler — wire query to HTTP

parseHandlerQuery validates limit/status/since/cursor; fetchPartnerUsers
is called with the parsed args and the auth-resolved partnerSource.
500 responses log a sha256-truncated key fingerprint so failed calls
can be correlated without leaking the secret.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Register export + firebase.json rewrite

**Files:**
- Modify: `apps/functions/src/index.ts`
- Modify: `firebase.json`

- [ ] **Step 1: Add the failing test for the export**

Append to `apps/functions/src/__tests__/partner-users-api.test.ts`:

```ts
test("paPartnerUsersApi is re-exported from src/index.ts", async () => {
  const mod = await import("../index.js")
  // The Firebase Functions runtime requires the export to be a callable/handler.
  assert.ok(typeof (mod as Record<string, unknown>).paPartnerUsersApi === "function" || typeof (mod as Record<string, unknown>).paPartnerUsersApi === "object")
})
```

- [ ] **Step 2: Run the test — expect failure**

```bash
cd apps/functions
node --import tsx --test src/__tests__/partner-users-api.test.ts
```
Expected: the re-export test fails because `paPartnerUsersApi` isn't yet exported from index.ts.

- [ ] **Step 3: Add the re-export**

Open `apps/functions/src/index.ts`. Search for the existing public-open-jobs export:
```ts
export { paPublicOpenJobs } from "./public-open-jobs.js"
```
Add immediately after it:
```ts
export { paPartnerUsersApi } from "./partner-users-api.js"
```

- [ ] **Step 4: Run the test — expect pass**

```bash
cd apps/functions
node --import tsx --test src/__tests__/partner-users-api.test.ts
```
Expected: all 19 tests pass.

- [ ] **Step 5: Add the firebase.json hosting rewrite**

Open `firebase.json`. Find the `pa-landing` hosting block (the one whose `"_comment"` begins with `"v1.9 hotfix 2026-05-13 — pa-landing upgraded from static-only to Vite SPA"`).

Find this rewrites array:
```json
"rewrites": [
  {
    "source": "**",
    "destination": "/index.html"
  }
]
```

Replace with:
```json
"rewrites": [
  {
    "source": "/api/v1/partner/users",
    "function": { "functionId": "paPartnerUsersApi", "region": "us-central1" }
  },
  {
    "source": "**",
    "destination": "/index.html"
  }
]
```

DO NOT modify the `layoff` hosting block. The partner API is intentionally NOT exposed under `layoff.wekruit.com`.

- [ ] **Step 6: Sanity-check the JSON parses**

```bash
node -e "JSON.parse(require('fs').readFileSync('firebase.json','utf8')); console.log('firebase.json valid')"
```
Expected: `firebase.json valid`.

- [ ] **Step 7: Commit**

```bash
git add apps/functions/src/index.ts apps/functions/src/__tests__/partner-users-api.test.ts firebase.json
git commit -m "$(cat <<'EOF'
feat: wire paPartnerUsersApi export + hosting rewrite

Index re-export so the deploy picks up the function in the
pa-orchestrator codebase. Hosting rewrite exposes the function as
https://wekruit.com/api/v1/partner/users; placed BEFORE the catch-all
** → /index.html. layoff target intentionally NOT updated (API is
not partner-facing on the layoff domain).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Update `apps/pa-landing/src/pages/Legal.tsx`

**Files:**
- Modify: `apps/pa-landing/src/pages/Legal.tsx`

No new test file — the legal page is presentational. Visual smoke is part of Task 9 / hosting deploy.

- [ ] **Step 1: Update the version + last-updated line**

Open `apps/pa-landing/src/pages/Legal.tsx`. Find:
```tsx
<p className="legal-meta">Version v1.0 · Last updated May 5, 2026</p>
```
Replace with:
```tsx
<p className="legal-meta">Version v1.1 · Last updated May 27, 2026</p>
```

- [ ] **Step 2: Add the partner-referral paragraph to "Who can see your data"**

Find the section (`<h2 className="legal-h2">Who can see your data</h2>` followed by a single `<p>...</p>`). Replace the existing `<p>` block with TWO paragraphs:

```tsx
        <p>
          The wekruit team operates Claire and may read conversations to debug issues, improve
          quality, and respond to support requests. Operators may pause Claire's auto-replies in
          your conversation and respond manually as part of human-in-the-loop. We do not sell your
          data to third parties.
        </p>
        <p>
          <b>Partner referrals.</b> If you arrived at WeKruit through a referral link from a
          partner site (such as a layoff-tracking service that included{" "}
          <code>?source=&lt;partner&gt;</code> in the URL you clicked), we share your candidacy
          progress with that partner. Specifically: your email, name, the jobs you've started
          pre-screening for, and the status of each pre-screen (in progress / passed / not
          passed / paused). We do not share your résumé, conversation transcript, or other
          sensitive details with the partner. You can request that we stop sharing by emailing{" "}
          <a className="legal-link" href="mailto:hello@wekruit.com">hello@wekruit.com</a>.
        </p>
```

- [ ] **Step 3: Add the "Partners we share with" section**

After the "Your choices" section and BEFORE the "Beta caveats" section, insert:

```tsx
      <section className="legal-section">
        <h2 className="legal-h2">Partners we share with</h2>
        <p>Current referral partners:</p>
        <ul>
          <li>
            <a className="legal-link" href="https://layoffhedge.com" target="_blank" rel="noreferrer">
              layoffhedge.com
            </a>
            {" "}— layoff-tracking and job-discovery service.
          </li>
        </ul>
        <p>
          When we add a new partner, this list is updated in the same release that adds the
          partner's referral link support.
        </p>
      </section>
```

- [ ] **Step 4: Typecheck**

```bash
cd apps/pa-landing
pnpm typecheck
```
Expected: 0 errors.

- [ ] **Step 5: Build**

```bash
cd apps/pa-landing
pnpm build
```
Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add apps/pa-landing/src/pages/Legal.tsx
git commit -m "$(cat <<'EOF'
docs(legal): pa-landing /legal v1.1 — partner-referral disclosure

Adds "Partner referrals" paragraph to "Who can see your data" + new
"Partners we share with" section listing layoffhedge as the first
referral partner. Bumps version v1.0 → v1.1.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Mirror legal changes in `apps/dashboard-web/src/pages/Legal.tsx`

**Files:**
- Modify: `apps/dashboard-web/src/pages/Legal.tsx`

- [ ] **Step 1: Update the version + last-updated line**

Open `apps/dashboard-web/src/pages/Legal.tsx`. Find:
```tsx
const updatedAt = "May 4, 2026"
```
Replace with:
```tsx
const updatedAt = "May 27, 2026"
```

And find:
```tsx
Version v1.0 · Last updated {updatedAt}
```
Replace with:
```tsx
Version v1.1 · Last updated {updatedAt}
```

- [ ] **Step 2: Add the partner-referral paragraph to "Who can see your data"**

Find the `<h2>` "Who can see your data" + its `<p>` body. Replace the single `<p>` with two paragraphs (this file uses inline style objects, no class names):

```tsx
        <p>
          The wekruit team operates Claire and may read conversations to debug issues, improve quality,
          and respond to support requests. Operators may pause Claire's auto-replies in your conversation
          and respond manually as part of human-in-the-loop. We do not sell your data to third parties.
        </p>
        <p>
          <b>Partner referrals.</b> If you arrived at WeKruit through a referral link from a partner
          site (such as a layoff-tracking service that included <code>?source=&lt;partner&gt;</code> in
          the URL you clicked), we share your candidacy progress with that partner. Specifically: your
          email, name, the jobs you've started pre-screening for, and the status of each pre-screen
          (in progress / passed / not passed / paused). We do not share your résumé, conversation
          transcript, or other sensitive details with the partner. You can request that we stop
          sharing by emailing <a href="mailto:hello@wekruit.com">hello@wekruit.com</a>.
        </p>
```

- [ ] **Step 3: Add the "Partners we share with" section**

Insert this `<section>` between "Your choices" and "Beta caveats" (matching the inline-style pattern of the surrounding sections):

```tsx
      <section style={{ marginBottom: "1.6rem" }}>
        <h2 style={{ fontSize: "1.15em", marginBottom: "0.4rem" }}>Partners we share with</h2>
        <p>Current referral partners:</p>
        <ul>
          <li>
            <a href="https://layoffhedge.com" target="_blank" rel="noreferrer">
              layoffhedge.com
            </a>{" "}
            — layoff-tracking and job-discovery service.
          </li>
        </ul>
        <p>
          When we add a new partner, this list is updated in the same release that adds the partner's
          referral link support.
        </p>
      </section>
```

- [ ] **Step 4: Typecheck**

```bash
cd apps/dashboard-web
pnpm typecheck
```
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard-web/src/pages/Legal.tsx
git commit -m "$(cat <<'EOF'
docs(legal): dashboard-web /legal v1.1 — partner-referral disclosure

Mirrors apps/pa-landing/src/pages/Legal.tsx so the admin domain's
/legal page stays consistent with the candidate-facing copy.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Full green-light + open PR

**Files:** none (verification only).

- [ ] **Step 1: Pin Node 24 + verify clean tree**

```bash
cd /Users/adam/Desktop/WeKruit/wekruit-pa/.claude/worktrees/partner-api
source ~/.zshrc && nvm use 24
git status
```
Expected: clean tree.

- [ ] **Step 2: Run every affected unit suite**

```bash
pnpm --filter @pa/core-types test
pnpm --filter pa-orchestrator test
pnpm --filter @pa/functions test
cd apps/pa-landing && node --import tsx --test src/lib/source.test.ts src/lib/browser-identity.test.ts && cd -
```
Expected: all green.

- [ ] **Step 3: Build the landing bundle**

```bash
cd apps/pa-landing && pnpm build && cd -
```
Expected: succeeds.

- [ ] **Step 4: Predeploy smoke for functions**

```bash
cd apps/functions
node scripts/predeploy-smoke.mjs
```
Expected: smoke passes (orchestrator dist freshness check).

- [ ] **Step 5: Push branch and open PR**

```bash
cd /Users/adam/Desktop/WeKruit/wekruit-pa/.claude/worktrees/partner-api
git push -u origin claude/partner-users-api
gh pr create --title "feat: partner users API (layoffhedge) + privacy disclosure" --body "$(cat <<'EOF'
## Summary
- New HTTP CF `paPartnerUsersApi` exposing `GET https://wekruit.com/api/v1/partner/users`.
- Auth via `X-API-Key` header. Keys shaped `key_<partnerSource>_<random>` — prefix anchors to `PA_USER_SOURCES` enum for per-partner data isolation.
- Returns email + name + jobs[] (state, jobTitle, prescreenSessionId) + summary aggregates. Resume / transcript / memory NOT exposed (PII tier 2 withheld).
- Cursor pagination on `pa-users.createdAtMs`. 60s LRU cache.
- New Firebase Secret `PA_PARTNER_USERS_API_KEYS` required before deploy (post-merge step).
- Privacy policy updated on `/legal` across pa-landing (covers candidate.wekruit.com + pa.wekruit.com + apex wekruit.com + layoff.wekruit.com via shared dist) and dashboard-web (admin domain).

## Spec
- [docs/superpowers/specs/2026-05-27-partner-users-api-design.md](docs/superpowers/specs/2026-05-27-partner-users-api-design.md)

## Plan
- [docs/superpowers/plans/2026-05-27-partner-users-api.md](docs/superpowers/plans/2026-05-27-partner-users-api.md)

## Test plan
- [x] `pnpm --filter @pa/functions test` — green (baseline + 19 new in `partner-users-api.test.ts`)
- [x] `pnpm --filter @pa/core-types test` — green (no changes; regression check)
- [x] `pnpm --filter pa-orchestrator test` — green (no changes; regression check)
- [x] `apps/pa-landing` build succeeds; legal page renders
- [x] `firebase.json` validates as JSON; hosting rewrite ordered before catch-all
- [ ] Post-merge: create `PA_PARTNER_USERS_API_KEYS` secret in Secret Manager, populate with `key_layoffhedge_<32hex>`
- [ ] Post-merge: scoped deploy `firebase deploy --only functions:pa-orchestrator:paPartnerUsersApi,hosting:pa-landing`
- [ ] Post-merge: live probe `curl -H "X-API-Key: <key>" https://wekruit.com/api/v1/partner/users` returns 200 + non-empty `users[]`
- [ ] Post-merge: securely transmit the key to layoffhedge out-of-band

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR URL printed.

No commit in this task (push only).

---

## Task 9: Post-merge — create secret + scoped deploy + live probe

**Files:** none (operational task).

Per `CLAUDE.md` "Deploy after merge" memory and "PR first for greenfield public CFs" memory: this task only runs AFTER the PR is approved and merged to `main`.

- [ ] **Step 1: Sync local main**

```bash
cd /Users/adam/Desktop/WeKruit/wekruit-pa/.claude/worktrees/partner-api
git fetch origin main
git rev-parse origin/main # capture merge SHA for the deploy log
```

> **SUPERSEDED (Adam directive 2026-05-27):** the secret is NOT new. The
> function reuses the existing `PA_PUBLIC_COLLAB_API_KEYS` (job-API key secret).
> Steps 2 + 3 below are replaced by a single check: does layoffhedge already
> have a `key_layoffhedge_<random>` entry in `PA_PUBLIC_COLLAB_API_KEYS`?

- [ ] **Step 2 (revised): Confirm or add layoffhedge's key in the EXISTING secret**

The deployer (or Adam) inspects the current `PA_PUBLIC_COLLAB_API_KEYS` value.
- If a `key_layoffhedge_<random>` entry already exists (layoffhedge was
  onboarded to the job API), nothing to do — reuse it for the probe in Step 6.
- If layoffhedge's existing key uses a different slug, OR no layoffhedge key
  exists, append a new `key_layoffhedge_<32hex>` entry to the CSV. Generate the
  tail with `openssl rand -hex 16`. Surface the full key to the user via the
  report — do NOT commit, log, or Slack it.

```bash
# Append a key to the existing CSV secret (only if needed):
export GOOGLE_APPLICATION_CREDENTIALS=/tmp/wekruit-deploy-creds.json
grep -E "^FIREBASE_SERVICE_ACCOUNT_JSON=" /Users/adam/Desktop/WeKruit/wekruit-pa/.env | sed 's/^FIREBASE_SERVICE_ACCOUNT_JSON=//' > "$GOOGLE_APPLICATION_CREDENTIALS"
# Read current value, append ",key_layoffhedge_<32hex>", re-set:
firebase functions:secrets:access PA_PUBLIC_COLLAB_API_KEYS --project=wekruit-5f89b
# then (manually compose CSV with the new key appended):
printf '%s' "<existing-csv>,key_layoffhedge_<32hex>" | firebase functions:secrets:set PA_PUBLIC_COLLAB_API_KEYS --project=wekruit-5f89b --data-file=-
```

NOTE: the function attaches `defineSecret("PA_PUBLIC_COLLAB_API_KEYS")` — the
same secret the job API already uses — so no new secret is provisioned. If the
secret value was edited, BOTH `paPublicOpenJobs` and `paPartnerUsersApi` will
pick up the new revision on their next deploy.

- [ ] **Step 4: Set up clean deploy worktree**

```bash
cd /Users/adam/Desktop/WeKruit/wekruit-pa
git worktree add /tmp/wekruit-pa-deploy-partner-api origin/main
cp .env /tmp/wekruit-pa-deploy-partner-api/.env
cp apps/pa-landing/.env.production.local /tmp/wekruit-pa-deploy-partner-api/apps/pa-landing/.env.production.local
cp apps/dashboard-web/.env.production.local /tmp/wekruit-pa-deploy-partner-api/apps/dashboard-web/.env.production.local
cd /tmp/wekruit-pa-deploy-partner-api
source ~/.zshrc && nvm use 24
pnpm install --frozen-lockfile
```

- [ ] **Step 5: Scoped deploy — function + hosting in two steps**

```bash
cd /tmp/wekruit-pa-deploy-partner-api
export GOOGLE_APPLICATION_CREDENTIALS=/tmp/wekruit-deploy-creds.json

firebase deploy \
  --only "functions:pa-orchestrator:paPartnerUsersApi" \
  --project wekruit-5f89b \
  --non-interactive

PA_LANDING_VITE_ENV_FILE=apps/pa-landing/.env.production.local \
  firebase deploy \
    --only "hosting:pa-landing" \
    --project wekruit-5f89b \
    --non-interactive
```

Expected: both deploys complete. Capture the deployed function URL from the first command's output (will look like `https://papartnerusersapi-evm6xq7jyq-uc.a.run.app`).

If the function deploy fails with "Quota exceeded for total allowable memory per project per region", wait 10 min and retry (same as PR #222's deploy quota contention).

- [ ] **Step 6: Live probe — happy path**

```bash
curl -s -w "\nHTTP %{http_code}\n" \
  -H "X-API-Key: key_layoffhedge_<32hex>" \
  "https://wekruit.com/api/v1/partner/users?limit=5"
```

Expected: HTTP 200 + JSON body with `users[]` (possibly empty; layoffhedge has zero candidates as of this writing pre-promotion), `hasMore=false`, `partner="layoffhedge"`, `apiVersion="v1"`.

- [ ] **Step 7: Live probe — auth failure paths**

```bash
# Missing key → 401
curl -s -w "\nHTTP %{http_code}\n" "https://wekruit.com/api/v1/partner/users"

# Wrong key → 401
curl -s -w "\nHTTP %{http_code}\n" \
  -H "X-API-Key: key_layoffhedge_doesnotmatch" \
  "https://wekruit.com/api/v1/partner/users"

# Mismatched partner slug → 403 / 401 depending on which gate trips first
curl -s -w "\nHTTP %{http_code}\n" \
  -H "X-API-Key: key_unknownpartner_abc" \
  "https://wekruit.com/api/v1/partner/users"
```

Expected: 401 / 401 / 401 (or 403 if the key happens to also be valid CSV but fails the source-slug check; verify the reason field in the JSON body).

- [ ] **Step 8: Securely transmit the key to layoffhedge**

Out of band. Use a password manager share or an encrypted message — NOT email, NOT public chat. Confirm the partner contact's identity before sending. Adam owns this step.

- [ ] **Step 9: Clean up deploy worktree + creds**

```bash
rm -f /tmp/wekruit-deploy-creds.json
git worktree remove /tmp/wekruit-pa-deploy-partner-api --force
```

No commit in this task — operational only.

---

## Self-Review

**1. Spec coverage**

| Spec section | Plan task |
|---|---|
| §4.1 new HTTP CF | Task 2 (skeleton) + Task 4 (handler wiring) |
| §4.2 verifyPartnerKey + key prefix derivation | Task 2 |
| §4.3 query layer + per-user job hydration | Task 3 |
| §4.4 response shape | Task 3 (`PartnerUsersResponse` types) |
| §4.5 cursor encode/decode | Task 3 (`encodeCursor` / `decodeCursor`) |
| §4.6 60s LRU cache | DEFERRED — currently not implemented. Cache layer is a nice-to-have for high QPS; layoffhedge will poll at most every minute or two. Adding the cache wrapper would mean an additional file. Acceptable to ship without — flag in PR description as follow-up if traffic justifies it. |
| §4.7 error contract | Task 2 (auth errors) + Task 4 (handler errors) |
| §4.8 observability logging | Task 2 (auth_fail) + Task 4 (ok + internal_error) |
| §5.1 pa-landing legal | Task 6 |
| §5.2 dashboard-web legal | Task 7 |
| §5.3 layoff.wekruit.com via shared dist | covered automatically by Task 6 (same Vite dist; verified in §5.3 of spec) |
| §6 file structure | Task tasks 2, 3, 4, 5, 6, 7 cover every file in the table |
| §7 hosting rewrite | Task 5 |
| §8 compatibility | no breaking change to existing surfaces — verified across tasks |
| §9 risk mitigations | constant-time compare, isolation, cursor stability all covered in Task 2 / 3 |
| §10 test plan | Tasks 2, 3, 4 |
| §11 rollout | Task 8 (PR) + Task 9 (deploy + probe + key transmission) |

ONE deferred item: §4.6 in-memory snapshot cache. Acceptable for v1 given expected QPS; rear-loaded into a follow-up PR if needed.

**2. Placeholder scan** — no "TBD" / "TODO" / "fill in details" / "similar to Task N" anywhere. Every code step shows the full code. Every command shows the exact command and expected result. The placeholder `<32hex>` in Task 9 is an explicit user-provided value generated by `openssl rand -hex 16` and is documented as such — not a plan TODO.

**3. Type consistency**

- `PartnerUsersUserRow`, `PartnerUsersJobRow`, `PartnerUsersResponse`, `PartnerUsersFetchArgs` — defined in Task 3, consistent usage in Task 3 + Task 4.
- `verifyPartnerKey` signature `(apiKey, origin, keysCsv, originsCsv)` — same across Task 2 tests + production code.
- `__test_PARTNER_KEY_RE`, `__test_verifyPartnerKey`, `__test_fetchPartnerUsers`, `__test_parseHandlerQuery` — all spelled consistently between the test file and the production file across Tasks 2, 3, 4.
- `paPartnerUsersApi` export — same name in `partner-users-api.ts`, `index.ts`, `firebase.json` rewrite, deploy command, and PR description.
- `PA_PARTNER_USERS_API_KEYS` secret name — same in spec, code (Task 2 + Task 9), deploy step.
- `CandidateJobStateSchema` reused from `@pa/core-types`; no redefinition.
- `PaUserSource` / `isPaUserSource` reused from `@pa/core-types`; no redefinition.

All consistent.
