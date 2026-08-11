import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { runMarkCandidateQuality } from "../admin-mark-candidate-quality.js"

/**
 * In-memory Firestore double: enough for the handle → pa-users → tier write chain.
 * Docs are addressed by `${collection}/${id}`.
 */
function makeDb(seed: Record<string, Record<string, unknown>> = {}) {
  const store = new Map<string, Record<string, unknown>>(Object.entries(seed))
  const added: Array<{ collection: string; data: Record<string, unknown> }> = []
  const db = {
    collection(name: string) {
      return {
        doc(id: string) {
          const key = `${name}/${id}`
          return {
            get: async () => ({ exists: store.has(key), data: () => store.get(key) }),
            set: async (patch: Record<string, unknown>, opts?: { merge?: boolean }) => {
              store.set(key, opts?.merge ? { ...(store.get(key) ?? {}), ...patch } : patch)
            },
          }
        },
        add: async (data: Record<string, unknown>) => { added.push({ collection: name, data }); return { id: `${added.length}` } },
      }
    },
  }
  return { db: db as never, store, added }
}

const SUBMISSION = {
  jobId: "photon-be",
  status: "submitted",
  candidate: { name: "Sam Okonkwo", linkedinUrl: "https://linkedin.com/in/sam-okonkwo", email: "sam@example.com" },
}

const seedWith = (submission: Record<string, unknown> | null): Record<string, Record<string, unknown>> =>
  submission ? { "pa-recruiter-submissions/s1": submission } : {}

const globalTierOf = (store: Map<string, Record<string, unknown>>) => {
  for (const [k, v] of store) if (k.startsWith("pa-users/") && v.globalCandidateTier) return v.globalCandidateTier as Record<string, unknown>
  return undefined
}

describe("mark candidate quality", () => {
  it("stamps the GLOBAL tier so it outlives the role that surfaced them", async () => {
    const { db, store } = makeDb(seedWith(SUBMISSION))
    const res = await runMarkCandidateQuality({ db, now: () => "2026-07-26T00:00:00.000Z" }, {
      submissionId: "s1", tier: "tier_1", reason: "strong infra背景, wrong role", actor: "admin1@wekruit.com",
    })
    assert.equal(res.ok, true)
    const gt = globalTierOf(store)
    assert.equal(gt?.tier, "tier_1")
    assert.equal(gt?.source, "admin")
    assert.equal(gt?.reusable, true)
    assert.equal(gt?.humanConfirmed, true)
  })

  it("does NOT count an operator mark as a rejection", async () => {
    const { db, store } = makeDb(seedWith(SUBMISSION))
    await runMarkCandidateQuality({ db }, { submissionId: "s1", tier: "tier_1" })
    assert.equal(globalTierOf(store)?.rejectionCount, 0, "nobody rejected this candidate")
  })

  it("never touches the submission status", async () => {
    const { db, store } = makeDb(seedWith(SUBMISSION))
    await runMarkCandidateQuality({ db }, { submissionId: "s1", tier: "tier_1" })
    assert.equal((store.get("pa-recruiter-submissions/s1") as Record<string, unknown>).status, "submitted")
  })

  it("is best-wins — a later weaker mark cannot demote a tier_1", async () => {
    const { db, store } = makeDb(seedWith(SUBMISSION))
    await runMarkCandidateQuality({ db }, { submissionId: "s1", tier: "tier_1" })
    await runMarkCandidateQuality({ db }, { submissionId: "s1", tier: "tier_3" })
    assert.equal(globalTierOf(store)?.tier, "tier_1")
  })

  it("writes a per-mark ledger row for the browse drawer", async () => {
    const { db, added } = makeDb(seedWith(SUBMISSION))
    await runMarkCandidateQuality({ db }, { submissionId: "s1", tier: "tier_2", reason: "worth a look", actor: "admin1@wekruit.com" })
    const row = added.find((a) => a.collection.includes("tier"))
    assert.ok(row, "expected a candidate-tier event")
    assert.equal(row?.data.tier, "tier_2")
    assert.equal(row?.data.source, "admin")
    assert.equal(row?.data.actor, "admin1@wekruit.com")
    assert.equal(row?.data.humanConfirmed, true)
  })

  it("refuses a submission with no LinkedIn instead of inventing an identity", async () => {
    const { db } = makeDb({ "pa-recruiter-submissions/s1": { jobId: "photon-be", candidate: { name: "No Handle" } } })
    const res = await runMarkCandidateQuality({ db }, { submissionId: "s1", tier: "tier_1" })
    assert.deepEqual(res, { ok: false, reason: "no_candidate_identity_linkedin_required" })
  })

  it("reports a missing submission instead of throwing", async () => {
    const { db } = makeDb(seedWith(null))
    const res = await runMarkCandidateQuality({ db }, { submissionId: "s1", tier: "tier_1" })
    assert.deepEqual(res, { ok: false, reason: "submission_not_found" })
  })
})
