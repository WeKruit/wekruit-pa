/**
 * claire-find-match-ledger.test.ts — Rec tracking (req #4/#5) for the
 * claire_agent find_match path (apps/functions/src/claire-agent/tools/matching-tools.ts).
 *
 * Locks the integration seam THIS domain owns:
 *   1. recordAgentPresentation writes the per-(user,job) recommendation ledger
 *      (drives V16's previousRecommendationPenalty → automatic dedup) AND one
 *      append-only `job_presented` FeedbackEvent per offered job (flywheel).
 *   2. The ledger row carries reason="claire_agent" for a normal mix and
 *      reason="general_market_fallback" when V16 relaxed all hard filters (req #5).
 *   3. FAIL-OPEN: when the Firestore writes throw, recordAgentPresentation still
 *      RESOLVES (void) — the find_match tool's never-throws contract (RC2) holds.
 *   4. makeV16FindMatch never throws even against a degenerate db — returns a
 *      grounded ok:false.
 *
 * No locked claire-agent file is modified; we import the two exported seams
 * (recordAgentPresentation, makeV16FindMatch) only.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { Firestore } from "firebase-admin/firestore"

import { recordAgentPresentation, makeV16FindMatch } from "../claire-agent/tools/matching-tools.js"

// ── Minimal fake Firestore (mirrors pa-persistence/marketplace.test.ts) ──────
// Supports: top-level collections, nested subcollections (recordRecommendedJobs
// uses pa-user-job-recommendations/{uid}/jobs/{jobId}), get/set/merge. Stores
// docs in a flat `${collectionName}` keyspace keyed by encoded path.
type Store = Map<string, Map<string, Record<string, unknown>>>

function makeFakeFirestore(): { db: Firestore; store: Store } {
  const store: Store = new Map()
  function col(name: string): Map<string, Record<string, unknown>> {
    if (!store.has(name)) store.set(name, new Map())
    return store.get(name)!
  }
  function docRef(collectionName: string, id: string) {
    return {
      id,
      collection(sub: string) {
        return collection(`${collectionName}/${id}/${sub}`)
      },
      async get() {
        const data = col(collectionName).get(id)
        return { exists: data !== undefined, id, data: () => data }
      },
      async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
        const current = col(collectionName).get(id)
        col(collectionName).set(id, opts?.merge && current ? { ...current, ...data } : { ...data })
      },
    }
  }
  function collection(collectionName: string) {
    return { doc(id: string) { return docRef(collectionName, id) } }
  }
  return { db: { collection } as unknown as Firestore, store }
}

// A db whose every read/write throws — exercises the fail-open guard.
function makeThrowingFirestore(): Firestore {
  const thrower = () => {
    throw new Error("firestore_down")
  }
  const doc = () => ({
    collection: () => ({ doc }),
    get: thrower,
    set: thrower,
  })
  return { collection: () => ({ doc }) } as unknown as Firestore
}

const NOW = "2026-05-29T12:00:00.000Z"

describe("recordAgentPresentation (claire_agent rec tracking req #4/#5)", () => {
  it("writes the recommendation ledger + a job_presented FeedbackEvent per job", async () => {
    const { db, store } = makeFakeFirestore()
    await recordAgentPresentation(db, {
      userId: "u1",
      jobs: [{ id: "job-a" }, { id: "job-b" }, { id: "" }, { id: 42 }],
      fallbackApplied: false,
      log: () => {},
      nowIso: NOW,
    })

    // Ledger: one doc per valid job under pa-user-job-recommendations/u1/jobs.
    const ledgerCol = store.get("pa-user-job-recommendations/u1/jobs")
    assert.ok(ledgerCol, "ledger subcollection exists")
    const ledgerA = ledgerCol!.get("job-a")
    assert.ok(ledgerA, "ledger row for job-a written")
    assert.equal(ledgerA!.lastRecommendedSource, "claire_agent")
    assert.equal(ledgerA!.recommendationCount, 1)
    const sources = ledgerA!.recommendationSources as Array<{ source: string }>
    assert.equal(sources.at(-1)!.source, "claire_agent", "ledger reason label is claire_agent")
    assert.ok(ledgerCol!.get("job-b"), "ledger row for job-b written")
    assert.equal(ledgerCol!.size, 2, "blank + non-string ids are dropped")

    // Flywheel: one append-only job_presented event per job in pa-feedback-events.
    const fbCol = store.get("pa-feedback-events")
    assert.ok(fbCol, "feedback-events collection exists")
    assert.equal(fbCol!.size, 2, "one job_presented event per offered job")
    const fbA = fbCol!.get(`job-presented-u1-job-a-${NOW}`)
    assert.ok(fbA, "deterministic eventId for job-a")
    assert.equal(fbA!.kind, "job_presented")
    assert.equal(fbA!.actor, "orchestrator", "claire agent maps to canonical orchestrator actor")
    assert.equal(fbA!.candidateId, "u1")
    assert.equal(fbA!.jobId, "job-a")
    assert.equal(fbA!.outcome, "claire_agent")
  })

  it("tags the ledger reason 'general_market_fallback' when V16 relaxed all hard filters (req #5)", async () => {
    const { db, store } = makeFakeFirestore()
    await recordAgentPresentation(db, {
      userId: "u2",
      jobs: [{ id: "job-x" }],
      fallbackApplied: true,
      log: () => {},
      nowIso: NOW,
    })
    const row = store.get("pa-user-job-recommendations/u2/jobs")!.get("job-x")!
    const sources = row.recommendationSources as Array<{ source: string }>
    assert.equal(sources.at(-1)!.source, "general_market_fallback")
  })

  it("FAIL-OPEN: resolves (does not throw) when the Firestore writes throw", async () => {
    const calls: string[] = []
    // Must not reject — the find_match tool never throws (RC2).
    await assert.doesNotReject(
      recordAgentPresentation(makeThrowingFirestore(), {
        userId: "u3",
        jobs: [{ id: "job-z" }],
        log: (event) => calls.push(event),
        nowIso: NOW,
      }),
    )
    // Both the ledger and the feedback write errors are logged, not thrown.
    assert.ok(
      calls.includes("pa.claire.find_match_ledger_error") ||
        calls.includes("pa.claire.find_match_feedback_error"),
      "a write error was logged (swallowed, not thrown)",
    )
  })

  it("no-ops when there are no valid job ids", async () => {
    const { db, store } = makeFakeFirestore()
    await recordAgentPresentation(db, { userId: "u4", jobs: [{ id: "" }], log: () => {}, nowIso: NOW })
    assert.equal(store.size, 0, "nothing written for an empty job set")
  })
})

describe("makeV16FindMatch never-throws contract", () => {
  it("returns a grounded result (never throws) against a degenerate db", async () => {
    // V16 itself fails-soft (no tags / read error → empty result), so the tool
    // returns ok with 0 recs and a grounded reason — and importantly skips the
    // ledger/feedback writes entirely when there are no offered jobs. The
    // contract THIS test pins: makeV16FindMatch never throws to the agent loop.
    const findMatch = makeV16FindMatch(makeThrowingFirestore())
    assert.ok(findMatch, "makeV16FindMatch returns a callable")
    const res = await findMatch!({ userId: "u5", requestedCount: 3 })
    assert.equal(res.recCount, 0)
    assert.deepEqual(res.jobs, [])
    assert.equal(typeof res.reason, "string", "a grounded reason is always present on 0 recs")
  })
})
