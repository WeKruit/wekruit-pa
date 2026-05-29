import assert from "node:assert/strict"
import test from "node:test"
import { isResetCommand, RESET_PATTERNS, summarizeClearResult } from "./admin.js"

test("isResetCommand matches all canonical patterns and ignores surrounding whitespace", () => {
  for (const p of RESET_PATTERNS) {
    assert.equal(isResetCommand(p), true, `should match canonical: ${p}`)
    assert.equal(isResetCommand(`  ${p}  `), true, `should match with whitespace: ${p}`)
  }
})

test("isResetCommand is case-insensitive for ASCII patterns only", () => {
  assert.equal(isResetCommand("__pa_reset__"), true)
  assert.equal(isResetCommand("__Pa_Reset__"), true)
  assert.equal(isResetCommand("/PA-RESET"), true)
  // Chinese pattern is exact-match only (no case folding for CJK)
  assert.equal(isResetCommand("重置我的记忆"), true)
})

test("isResetCommand rejects partial / surrounding text (must be full body)", () => {
  assert.equal(isResetCommand("hello __PA_RESET__"), false)
  assert.equal(isResetCommand("__PA_RESET__ now"), false)
  assert.equal(isResetCommand("请重置我的记忆吧"), false)
  assert.equal(isResetCommand("normal user message"), false)
  assert.equal(isResetCommand(""), false)
  assert.equal(isResetCommand("   "), false)
})

test("summarizeClearResult produces a tester-readable line for live runs", () => {
  const out = summarizeClearResult({
    userId: "u1",
    dryRun: false,
    qdrant: { collection: "pa-memory", matched: 7, deleted: true },
    firestore: { "pa-memory-facts": 2, "pa-messages": 18, "pa-memory-actions": 0 },
  })
  assert.match(out, /✓ Test memory cleared/)
  assert.match(out, /pa-memory=7/)
  assert.match(out, /pa-memory-facts=2/)
  assert.match(out, /pa-messages=18/)
  assert.doesNotMatch(out, /pa-memory-actions=0/)
})

test("summarizeClearResult flags dry-run results distinctly", () => {
  const out = summarizeClearResult({
    userId: "u1",
    dryRun: true,
    qdrant: { collection: "pa-memory", matched: 0, deleted: false },
    firestore: {},
  })
  assert.match(out, /\[DRY-RUN\]/)
  assert.match(out, /all empty/)
})

test("summarizeClearResult forCandidate is a short human confirm with NO internal counts (QA 2026-05-28 D)", () => {
  const out = summarizeClearResult(
    {
      userId: "u1",
      dryRun: false,
      qdrant: { collection: "pa-memory", matched: 13, deleted: true },
      firestore: { "pa-memory-facts": 13, "pa-messages": 126, "pa-rate-limits": 40 },
    },
    { forCandidate: true },
  )
  // The candidate-visible reply must NOT leak operator telemetry (the live bug:
  // "✓ Test memory cleared — qdrant pa_memory=0; firestore pa-memory-facts=13…").
  assert.doesNotMatch(out, /qdrant/i)
  assert.doesNotMatch(out, /firestore/i)
  assert.doesNotMatch(out, /pa-memory|pa-messages|pa-rate-limits/)
  assert.doesNotMatch(out, /=\d/)
  assert.ok(out.trim().length > 0 && out.length < 120, "should be a short human line")
})

// ----------------------------------------------------------------------------
// Phase 11.3 — clearUserMemory partition-key passthrough
// ----------------------------------------------------------------------------

import type { Firestore } from "firebase-admin/firestore"
import { clearUserMemory, type ClearUserMemoryDeps } from "./admin.js"

/**
 * Fakes a Firestore that returns empty snapshots for every where()-query.
 * `clearFirestoreCollection` only reads via `.where("userId", "==", id).get()`
 * and writes via `.batch()`, so we just have to satisfy the read shape; with
 * no docs there are no batched writes to model.
 */
function makeEmptyFirestoreFake(): Firestore {
  const empty = {
    empty: true,
    size: 0,
    docs: [],
  } as unknown
  const where = () => ({ get: async () => empty })
  // iter30 closure adds clearEntityTagsForUser() (subcollection delete) +
  // resetUserOnboardingState() (user-doc set/merge). Both go through
  // collection().doc() instead of where(). Stub with a noop ref.
  const docRef = {
    collection: () => ({ get: async () => empty }),
    delete: async () => undefined,
    set: async () => undefined,
  }
  const collection = () => ({
    where,
    get: async () => empty,
    doc: () => docRef,
  })
  return { collection } as unknown as Firestore
}

/** Capture every Qdrant request bodies for assertions. */
function makeQdrantFakes() {
  const calls: { url: string; body: unknown }[] = []
  const fetchFn: typeof fetch = (async (input: unknown, init: RequestInit) => {
    const url = String(input)
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ url, body })
    if (url.endsWith("/points/count")) {
      return new Response(JSON.stringify({ result: { count: 3 } }), { status: 200 })
    }
    if (url.includes("/points/delete")) {
      return new Response(JSON.stringify({ result: { status: "ok" } }), { status: 200 })
    }
    return new Response(JSON.stringify({}), { status: 200 })
  }) as unknown as typeof fetch
  return { calls, fetchFn }
}

test("clearUserMemory: omitting mem0PartitionKey keeps legacy behavior (Qdrant filter user_id == userId)", async () => {
  const { calls, fetchFn } = makeQdrantFakes()
  const deps: ClearUserMemoryDeps = {
    db: makeEmptyFirestoreFake(),
    qdrantUrl: "https://qdrant.local",
    qdrantApiKey: "key",
    fetch: fetchFn,
  }
  await clearUserMemory("u1", deps, { keepMessages: true })
  const countCall = calls.find((c) => c.url.endsWith("/points/count"))
  assert.ok(countCall, "count call should fire")
  const filter = (countCall!.body as { filter: { must: { match: { value: string } }[] } }).filter
  assert.equal(filter.must[0]!.match.value, "u1")
})

test("clearUserMemory: explicit mem0PartitionKey scopes Qdrant filter to that key (NOT userId)", async () => {
  const { calls, fetchFn } = makeQdrantFakes()
  const deps: ClearUserMemoryDeps = {
    db: makeEmptyFirestoreFake(),
    qdrantUrl: "https://qdrant.local",
    qdrantApiKey: "key",
    fetch: fetchFn,
  }
  // userId="u1" is the Firestore canonical id; "alt_partition" is the Qdrant
  // partition. Per the contract Firestore deletes still scope by userId,
  // but Qdrant calls use the partition.
  await clearUserMemory("u1", deps, {
    keepMessages: true,
    mem0PartitionKey: "alt_partition",
  })
  const countCall = calls.find((c) => c.url.endsWith("/points/count"))!
  const delCall = calls.find((c) => c.url.includes("/points/delete"))!
  const cFilter = (countCall.body as { filter: { must: { match: { value: string } }[] } }).filter
  const dFilter = (delCall.body as { filter: { must: { match: { value: string } }[] } }).filter
  assert.equal(cFilter.must[0]!.match.value, "alt_partition")
  assert.equal(dFilter.must[0]!.match.value, "alt_partition")
})

test("clearUserMemory: empty/whitespace mem0PartitionKey falls back to userId (defensive)", async () => {
  const { calls, fetchFn } = makeQdrantFakes()
  const deps: ClearUserMemoryDeps = {
    db: makeEmptyFirestoreFake(),
    qdrantUrl: "https://qdrant.local",
    qdrantApiKey: "key",
    fetch: fetchFn,
  }
  await clearUserMemory("u1", deps, {
    keepMessages: true,
    mem0PartitionKey: "   ",
  })
  const countCall = calls.find((c) => c.url.endsWith("/points/count"))!
  const filter = (countCall.body as { filter: { must: { match: { value: string } }[] } }).filter
  assert.equal(filter.must[0]!.match.value, "u1")
})

// ----------------------------------------------------------------------------
// iter34 P0.6 closure (Adam directive 2026-05-05) — reset must clear
// onboardingProbeAttempts + systemFlags (else halt-at-5 sticks across reset).
// ----------------------------------------------------------------------------

function makeFirestoreCapturingUserSet(): {
  db: Firestore
  setCalls: { docPath: string; payload: Record<string, unknown>; opts: unknown }[]
} {
  const setCalls: { docPath: string; payload: Record<string, unknown>; opts: unknown }[] = []
  const empty = { empty: true, size: 0, docs: [] } as unknown
  const where = () => ({ get: async () => empty })
  const makeDocRef = (docPath: string) => ({
    collection: () => ({ get: async () => empty }),
    delete: async () => undefined,
    set: async (payload: Record<string, unknown>, opts: unknown) => {
      setCalls.push({ docPath, payload, opts })
    },
  })
  const collection = (collectionName: string) => ({
    where,
    get: async () => empty,
    doc: (docId: string) => makeDocRef(`${collectionName}/${docId}`),
  })
  return { db: { collection } as unknown as Firestore, setCalls }
}

test("iter34 P0.6 — clearUserMemory wipes onboardingProbeAttempts + systemFlags on reset", async () => {
  const { db, setCalls } = makeFirestoreCapturingUserSet()
  const { fetchFn } = makeQdrantFakes()
  const deps: ClearUserMemoryDeps = {
    db,
    qdrantUrl: "https://qdrant.local",
    qdrantApiKey: "key",
    fetch: fetchFn,
  }
  // resetUserOnboardingState only fires on the FULL reset path
  // (keepMessages=false). The orchestrator's __PA_RESET__ handler always uses
  // keepMessages=false, so that's the path users hit.
  await clearUserMemory("u1", deps, { keepMessages: false })

  // Find the set() against pa-users/u1 — should be exactly one (resetUserOnboardingState).
  const userSet = setCalls.find((c) => c.docPath === "pa-users/u1")
  assert.ok(userSet, "expected resetUserOnboardingState to call pa-users/u1.set")
  assert.deepEqual(userSet!.opts, { merge: true })

  const payload = userSet!.payload
  // Pre-existing fields still present
  assert.equal(payload.onboardingState, "pending")
  assert.ok("onboardingStep" in payload, "onboardingStep delete-marker present")
  assert.ok("statedPreferences" in payload, "statedPreferences delete-marker present")
  // iter34 P0.6 additions
  assert.ok(
    "onboardingProbeAttempts" in payload,
    "onboardingProbeAttempts must be deleted on reset (else halt-at-5 sticks across reset)"
  )
  assert.ok(
    "systemFlags" in payload,
    "systemFlags must be deleted on reset (else onboardingHalted=true sticks across reset)"
  )
})

// ----------------------------------------------------------------------------
// 2026-05-06 P9 — full reset must wipe `tags`, `resumeParseCount`,
// `resumeParseLastAt`, top-level `preferredLang`, and the entire
// `parsedCandidateResumes` collection scoped to userId.
// Live bug: re-onboarding biz tester saw "我已经看过你两份简历了" / mixed
// bilingual reply because the prior session's parsedCandidateResumes
// (count >= 2) and tags.preferredLang stayed.
// ----------------------------------------------------------------------------

function makeFirestoreCapturingFullReset(): {
  db: Firestore
  setCalls: { docPath: string; payload: Record<string, unknown>; opts: unknown }[]
  whereQueries: { collection: string; field: string; value: unknown }[]
} {
  const setCalls: { docPath: string; payload: Record<string, unknown>; opts: unknown }[] = []
  const whereQueries: { collection: string; field: string; value: unknown }[] = []
  const empty = { empty: true, size: 0, docs: [] } as unknown
  const makeWhere = (collectionName: string) => (field: string, _op: string, value: unknown) => {
    whereQueries.push({ collection: collectionName, field, value })
    return { get: async () => empty }
  }
  const makeDocRef = (docPath: string) => ({
    collection: () => ({ get: async () => empty }),
    delete: async () => undefined,
    set: async (payload: Record<string, unknown>, opts: unknown) => {
      setCalls.push({ docPath, payload, opts })
    },
  })
  const collection = (collectionName: string) => ({
    where: makeWhere(collectionName),
    get: async () => empty,
    doc: (docId: string) => makeDocRef(`${collectionName}/${docId}`),
  })
  // Add runTransaction so autoEnableOnboardingPipelineFlag doesn't throw.
  const db = {
    collection,
    runTransaction: async (fn: (t: unknown) => Promise<unknown>) => {
      // Fake transaction: t.get returns empty doc, t.set/update no-op.
      const t = {
        get: async (_ref: unknown) => ({
          exists: false,
          data: () => undefined,
        }),
        set: () => undefined,
        update: () => undefined,
      }
      return await fn(t)
    },
  }
  return { db: db as unknown as Firestore, setCalls, whereQueries }
}

test("P9 — clearUserMemory wipes parsedCandidateResumes scoped to userId on full reset", async () => {
  const { db, whereQueries } = makeFirestoreCapturingFullReset()
  const { fetchFn } = makeQdrantFakes()
  const deps: ClearUserMemoryDeps = {
    db,
    qdrantUrl: "https://qdrant.local",
    qdrantApiKey: "key",
    fetch: fetchFn,
  }
  await clearUserMemory("u1", deps, { keepMessages: false })

  const cvQuery = whereQueries.find(
    (q) => q.collection === "parsedCandidateResumes" && q.field === "userId"
  )
  assert.ok(
    cvQuery,
    "parsedCandidateResumes must be queried with where(userId, ==, userId) on full reset"
  )
  assert.equal(cvQuery!.value, "u1", "scope must be exact userId, never global delete")
})

test("P9 — clearUserMemory does NOT wipe parsedCandidateResumes on keepMessages=true", async () => {
  const { db, whereQueries } = makeFirestoreCapturingFullReset()
  const { fetchFn } = makeQdrantFakes()
  const deps: ClearUserMemoryDeps = {
    db,
    qdrantUrl: "https://qdrant.local",
    qdrantApiKey: "key",
    fetch: fetchFn,
  }
  // keepMessages=true is the legacy "memory plane only" path. Don't touch
  // parsedCandidateResumes so the dashboard "view CV" feature still works.
  await clearUserMemory("u1", deps, { keepMessages: true })

  const cvQuery = whereQueries.find((q) => q.collection === "parsedCandidateResumes")
  assert.equal(
    cvQuery,
    undefined,
    "parsedCandidateResumes must NOT be touched when keepMessages=true"
  )
})

test("P9 — clearUserMemory user-doc reset wipes tags, resumeParseCount, preferredLang on full reset", async () => {
  const { db, setCalls } = makeFirestoreCapturingFullReset()
  const { fetchFn } = makeQdrantFakes()
  const deps: ClearUserMemoryDeps = {
    db,
    qdrantUrl: "https://qdrant.local",
    qdrantApiKey: "key",
    fetch: fetchFn,
  }
  await clearUserMemory("u1", deps, { keepMessages: false })

  const userSet = setCalls.find((c) => c.docPath === "pa-users/u1")
  assert.ok(userSet, "expected resetUserOnboardingState to call pa-users/u1.set")
  const payload = userSet!.payload
  // Existing fields still present (regression guard).
  assert.equal(payload.onboardingState, "pending")
  assert.ok("statedPreferences" in payload, "statedPreferences delete-marker present")
  // P9 additions — these MUST be delete-markers (not actual values),
  // else legacy data leaks across reset.
  assert.ok(
    "tags" in payload,
    "tags delete-marker required (else preferredLang/skills/industrySector leak)"
  )
  assert.ok(
    "resumeParseCount" in payload,
    "resumeParseCount delete-marker required (else CV quota_exhausted on next upload)"
  )
  assert.ok(
    "resumeParseLastAt" in payload,
    "resumeParseLastAt delete-marker required (paired with quota count)"
  )
  assert.ok(
    "preferredLang" in payload,
    "top-level preferredLang delete-marker required (legacy field path)"
  )
  assert.ok(
    "pipelineState" in payload,
    "pipelineState delete-marker required (else Q-as-class pipeline resumes old currentQId after reset)"
  )
})

test("P9 — summarizeClearResult surfaces user-doc resets (tags=cleared, quota=cleared)", async () => {
  const { db } = makeFirestoreCapturingFullReset()
  const { fetchFn } = makeQdrantFakes()
  const deps: ClearUserMemoryDeps = {
    db,
    qdrantUrl: "https://qdrant.local",
    qdrantApiKey: "key",
    fetch: fetchFn,
  }
  const r = await clearUserMemory("u1", deps, { keepMessages: false })
  assert.ok(r.userDocReset, "userDocReset markers must be populated on full reset")
  assert.equal(r.userDocReset!.tags, true)
  assert.equal(r.userDocReset!.resumeParseCount, true)
  assert.equal(r.userDocReset!.onboardingState, true)
  assert.equal(r.userDocReset!.pipelineState, true)
  const summary = summarizeClearResult(r)
  assert.match(summary, /tags=cleared/, "summary should announce tags wipe")
  assert.match(summary, /quota=cleared/, "summary should announce CV-quota wipe")
  assert.match(summary, /onboarding=reset/, "summary should announce onboarding-state reset")
  assert.match(summary, /pipeline=reset/, "summary should announce pipeline-state reset")
})

test("clearUserMemory: dry-run with mem0PartitionKey still scopes count by partition (no delete)", async () => {
  const { calls, fetchFn } = makeQdrantFakes()
  const deps: ClearUserMemoryDeps = {
    db: makeEmptyFirestoreFake(),
    qdrantUrl: "https://qdrant.local",
    qdrantApiKey: "key",
    fetch: fetchFn,
  }
  const r = await clearUserMemory("u1", deps, {
    keepMessages: true,
    dryRun: true,
    mem0PartitionKey: "alt_partition",
  })
  assert.equal(r.dryRun, true)
  assert.equal(r.qdrant.deleted, false)
  assert.equal(r.qdrant.matched, 3)
  // Count call MUST use the partition.
  const countCall = calls.find((c) => c.url.endsWith("/points/count"))!
  assert.equal(
    (countCall.body as { filter: { must: { match: { value: string } }[] } }).filter.must[0]!.match
      .value,
    "alt_partition"
  )
  // Delete call MUST NOT have been made.
  assert.equal(calls.filter((c) => c.url.includes("/points/delete")).length, 0)
})
