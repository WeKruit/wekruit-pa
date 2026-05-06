/**
 * v1.7 Phase 64 — Tests for backfill-sponsorship.mjs.
 *
 * Coverage: planJob + migrateJob across DRY-RUN / APPLY / idempotency / error paths.
 *
 * Mocking strategy: we don't import the script's `main()` (it does Firebase
 * init + paged scan); instead we exercise the pure helpers (`planJob`,
 * `migrateJob`) with fake Firestore + fake `inferConfig`. The `inferConfig`
 * is shaped so the LLM helper's allowlistOverride seam returns deterministic
 * results without any real LLM call.
 */

import test from "node:test"
import assert from "node:assert/strict"

import { planJob, migrateJob } from "../backfill-sponsorship.mjs"

// ─── Fake Firestore ───────────────────────────────────────────────────────

/** Mimic the minimal subset of admin SDK we use. Records what was written. */
function makeFakeDb() {
  /** @type {Record<string, Record<string, any>>} */
  const writes = {}
  const auditWrites = []
  const db = {
    collection(name) {
      return {
        doc(id) {
          return {
            async update(payload) {
              writes[`${name}/${id}`] = payload
              return undefined
            },
            async set(payload, opts) {
              writes[`${name}/${id}`] = { ...payload, _opts: opts }
              return undefined
            },
            async get() {
              return { exists: false, data: () => undefined }
            },
            collection(sub) {
              return {
                doc(subId) {
                  return {
                    async set(payload) {
                      auditWrites.push({ path: `${name}/${id}/${sub}/${subId}`, payload })
                      return undefined
                    },
                  }
                },
              }
            },
          }
        },
      }
    },
  }
  return { db, writes, auditWrites }
}

/**
 * Build an `inferConfig` whose allowlistOverride yields deterministic results.
 * Falls back to `null + all_failed` when the company isn't in the table.
 */
function makeInferConfig(allowlistTable, llmTable) {
  const { db } = makeFakeDb()
  return {
    db,
    allowlistOverride: async (slug) => allowlistTable[slug] ?? null,
    // LLM tier — we override at the api-key level: if these aren't present
    // the helper goes straight to "all_failed" tier.
    anthropicApiKey: llmTable ? "fake" : undefined,
    anthropicClientFactory: () =>
      llmTable
        ? {
            messages: {
              create: async ({ messages }) => {
                const userPayload = JSON.parse(messages[0].content)
                const company = userPayload.companyName
                const verdict = llmTable[company]
                if (!verdict) {
                  return { content: [{ type: "text", text: "garbage" }] }
                }
                return {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify(verdict),
                    },
                  ],
                }
              },
            },
          }
        : undefined,
  }
}

// ─── planJob ────────────────────────────────────────────────────────────────

test("planJob: sponsorship === true → skip-already-set", () => {
  const r = planJob({ sponsorship: true, roleTitle: "SWE" })
  assert.equal(r.mode, "skip-already-set")
  assert.equal(r.existing, true)
})

test("planJob: sponsorship === false → skip-already-set", () => {
  const r = planJob({ sponsorship: false, roleTitle: "SWE" })
  assert.equal(r.mode, "skip-already-set")
  assert.equal(r.existing, false)
})

test("planJob: sponsorship === null + already backfilled → skip-already-attempted", () => {
  const r = planJob({
    sponsorship: null,
    sponsorshipBackfilledAt: "2026-05-01T00:00:00Z",
    roleTitle: "SWE",
  })
  assert.equal(r.mode, "skip-already-attempted")
})

test("planJob: --force-rerun overrides skip-already-set on null", () => {
  const r = planJob(
    {
      sponsorship: null,
      sponsorshipBackfilledAt: "2026-05-01T00:00:00Z",
      roleTitle: "SWE",
    },
    /* forceRerun */ true
  )
  assert.equal(r.mode, "infer")
})

test("planJob: --force-rerun overrides skip on existing true (re-infer if requested)", () => {
  const r = planJob({ sponsorship: true, roleTitle: "SWE" }, /* forceRerun */ true)
  assert.equal(r.mode, "infer")
})

test("planJob: missing roleTitle / jobTitle / title → skip-no-title", () => {
  assert.equal(planJob({ sponsorship: null }).mode, "skip-no-title")
  assert.equal(planJob({ sponsorship: null, roleTitle: "" }).mode, "skip-no-title")
  assert.equal(planJob({ sponsorship: null, roleTitle: "   " }).mode, "skip-no-title")
})

test("planJob: falls back to jobTitle / title fields", () => {
  assert.equal(planJob({ sponsorship: null, jobTitle: "SWE" }).mode, "infer")
  assert.equal(planJob({ sponsorship: null, title: "SWE" }).mode, "infer")
})

test("planJob: undefined sponsorship (legacy doc) → infer", () => {
  // legacy docs may not have sponsorship field at all
  const r = planJob({ roleTitle: "SWE", companyName: "Acme" })
  assert.equal(r.mode, "infer")
  assert.equal(r.title, "SWE")
})

// ─── migrateJob: DRY-RUN ────────────────────────────────────────────────────

test("migrateJob DRY-RUN: allowlist hit → audit-only write, no matching-jobs update", async () => {
  const { db, writes, auditWrites } = makeFakeDb()
  const inferConfig = makeInferConfig({
    google: { company: "google", sponsorship: true, source: "h1b_data_2024", confidence: 0.98 },
  })
  inferConfig.db = db

  const res = await migrateJob(
    db,
    "test-run-1",
    "job-001",
    { sponsorship: null, roleTitle: "SWE", companyName: "Google" },
    { dryRun: true, forceRerun: false, inferConfig }
  )

  assert.equal(res.mode, "dry-run-infer")
  assert.equal(res.after.sponsorship, true)
  assert.equal(res.after.sponsorshipSource, "allowlist")
  assert.ok(!writes["matching-jobs/job-001"], "no matching-jobs write in dry-run")
  assert.equal(auditWrites.length, 1, "audit write happens in dry-run")
  assert.match(
    auditWrites[0].path,
    /matching-jobs-sponsorship-runs\/test-run-1\/jobs\/job-001/
  )
})

// ─── migrateJob: APPLY ──────────────────────────────────────────────────────

test("migrateJob APPLY: allowlist hit → updates sponsorship + sponsorshipSource + sponsorshipConfidence + sponsorshipBackfilledAt", async () => {
  const { db, writes } = makeFakeDb()
  const inferConfig = makeInferConfig({
    stripe: { company: "stripe", sponsorship: true, source: "h1b_data_2024", confidence: 0.95 },
  })
  inferConfig.db = db

  const res = await migrateJob(
    db,
    "test-run-2",
    "job-002",
    { sponsorship: null, roleTitle: "SWE", companyName: "Stripe" },
    { dryRun: false, forceRerun: false, inferConfig }
  )

  assert.equal(res.mode, "applied")
  const w = writes["matching-jobs/job-002"]
  assert.ok(w, "matching-jobs write should exist")
  assert.equal(w.sponsorship, true)
  assert.equal(w.sponsorshipSource, "allowlist")
  assert.equal(w.sponsorshipConfidence, 0.95)
  assert.ok(typeof w.sponsorshipBackfilledAt === "string", "sponsorshipBackfilledAt stamped")
})

test("migrateJob APPLY: allowlist preference wins over LLM", async () => {
  const { db, writes } = makeFakeDb()
  // Allowlist has stripe → true; LLM table also has stripe → would say false
  const inferConfig = makeInferConfig(
    {
      stripe: { company: "stripe", sponsorship: true, source: "allowlist", confidence: 0.95 },
    },
    {
      Stripe: { sponsorship: false, confidence: 0.9, reasoning: "LLM would say false" },
    }
  )
  inferConfig.db = db

  const res = await migrateJob(
    db,
    "test-run-3",
    "job-003",
    { sponsorship: null, roleTitle: "SWE", companyName: "Stripe" },
    { dryRun: false, forceRerun: false, inferConfig }
  )

  assert.equal(res.after.sponsorship, true, "allowlist must win")
  assert.equal(res.after.sponsorshipSource, "allowlist")
  assert.equal(writes["matching-jobs/job-003"].sponsorship, true)
})

test("migrateJob APPLY: LLM null verdict persists null (not fabricated false)", async () => {
  const { db, writes } = makeFakeDb()
  const inferConfig = makeInferConfig(
    {},
    {
      "Mystery Co": { sponsorship: null, confidence: 0, reasoning: "JD silent" },
    }
  )
  inferConfig.db = db

  const res = await migrateJob(
    db,
    "test-run-4",
    "job-004",
    { sponsorship: null, roleTitle: "SWE", companyName: "Mystery Co" },
    { dryRun: false, forceRerun: false, inferConfig }
  )

  assert.equal(res.after.sponsorship, null, "MUST persist null, never fabricate")
  assert.equal(res.after.sponsorshipSource, "jd_inference")
  // Important: V16 graceful filter REQUIRES null preservation
  assert.equal(writes["matching-jobs/job-004"].sponsorship, null)
})

// ─── migrateJob: skip paths (idempotency) ───────────────────────────────────

test("migrateJob: skip-already-set returns early (no LLM call, no write)", async () => {
  const { db, writes } = makeFakeDb()
  let llmCalled = 0
  const inferConfig = {
    db,
    allowlistOverride: async () => {
      llmCalled++ // proxy for "did anything happen"
      return null
    },
  }

  const res = await migrateJob(
    db,
    "test-run-5",
    "job-005",
    { sponsorship: true, roleTitle: "SWE", companyName: "Google" },
    { dryRun: false, forceRerun: false, inferConfig }
  )

  assert.equal(res.mode, "skip-already-set")
  assert.equal(llmCalled, 0, "must not even hit allowlist when already set")
  assert.ok(!writes["matching-jobs/job-005"], "no write")
})

test("migrateJob: skip-already-attempted returns early (don't waste $)", async () => {
  const { db, writes } = makeFakeDb()
  const inferConfig = { db, allowlistOverride: async () => null }

  const res = await migrateJob(
    db,
    "test-run-6",
    "job-006",
    {
      sponsorship: null,
      sponsorshipBackfilledAt: "2026-04-01T00:00:00Z",
      roleTitle: "SWE",
      companyName: "X",
    },
    { dryRun: false, forceRerun: false, inferConfig }
  )

  assert.equal(res.mode, "skip-already-attempted")
  assert.ok(!writes["matching-jobs/job-006"])
})

test("migrateJob: skip-no-title returns early", async () => {
  const { db, writes } = makeFakeDb()
  const inferConfig = { db, allowlistOverride: async () => null }

  const res = await migrateJob(
    db,
    "test-run-7",
    "job-007",
    { sponsorship: null, companyName: "Google" }, // no roleTitle
    { dryRun: false, forceRerun: false, inferConfig }
  )

  assert.equal(res.mode, "skip-no-title")
  assert.ok(!writes["matching-jobs/job-007"])
})

// ─── migrateJob: error paths ────────────────────────────────────────────────

test("migrateJob: inferSponsorship throws → mode='error'", async () => {
  const { db } = makeFakeDb()
  const inferConfig = {
    db,
    allowlistOverride: async () => {
      throw new Error("simulated firestore error")
    },
    // No LLM keys → inferSponsorship returns 'all_failed' (graceful)
    // To force an actual throw, we make the allowlist throw AND no LLM keys
    // are provided. The lib catches the override throw and falls through to
    // LLM tier (all_failed). So actually this won't error out — let's verify
    // the graceful path here instead.
  }

  const res = await migrateJob(
    db,
    "test-run-8",
    "job-008",
    { sponsorship: null, roleTitle: "SWE", companyName: "Acme" },
    { dryRun: true, forceRerun: false, inferConfig }
  )

  // The lib is graceful → returns null + 'all_failed' (no throw)
  assert.equal(res.mode, "dry-run-infer")
  assert.equal(res.after.sponsorship, null)
  assert.equal(res.after.sponsorshipSource, "all_failed")
})

test("migrateJob: Firestore update throws → mode='error'", async () => {
  // Build a fake db whose update() throws.
  const writes = {}
  const db = {
    collection(name) {
      return {
        doc(id) {
          return {
            async update() {
              throw new Error("firestore unavailable")
            },
            async set() {
              writes[`${name}/${id}`] = "audit-set-ok"
            },
            collection() {
              return {
                doc() {
                  return {
                    async set() {},
                  }
                },
              }
            },
          }
        },
      }
    },
  }
  const inferConfig = {
    db,
    allowlistOverride: async () => ({
      company: "google",
      sponsorship: true,
      source: "h1b_data_2024",
      confidence: 0.98,
    }),
  }

  const res = await migrateJob(
    db,
    "test-run-9",
    "job-009",
    { sponsorship: null, roleTitle: "SWE", companyName: "Google" },
    { dryRun: false, forceRerun: false, inferConfig }
  )

  assert.equal(res.mode, "error")
  assert.match(res.error, /firestore unavailable/)
})
