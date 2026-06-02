import { test } from "node:test"
import assert from "node:assert/strict"
import { selectClaireMode } from "../claire-agent/mode-selector.js"

/**
 * Fake Firestore with Firestore-faithful DEEP merge. selectClaireMode is now a READ-ONLY seeder
 * (it only WRITES the one-time cold-start bootstrap doc); answer recording flows through the
 * record_onboarding_answer TOOL (covered end-to-end by apps/eval/thin-claire/eval-sim-onboarding.mjs).
 */
function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    const cur = out[k]
    if (v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object" && !Array.isArray(cur)) {
      out[k] = deepMerge(cur as Record<string, unknown>, v as Record<string, unknown>)
    } else out[k] = v
  }
  return out
}
function makeDb(seed: Record<string, Record<string, unknown>> = {}) {
  const store = new Map<string, Record<string, unknown>>(Object.entries(seed))
  const doc = (col: string, id: string) => ({
    id,
    async get() { return { exists: store.has(`${col}/${id}`), id, data: () => store.get(`${col}/${id}`) } },
    async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
      store.set(`${col}/${id}`, opts?.merge ? deepMerge(store.get(`${col}/${id}`) ?? {}, data) : { ...data })
    },
  })
  const collection = (col: string) => {
    const buildQuery = (preds: Array<[string, unknown]>) => ({
      where(field: string, _op: string, val: unknown) { return buildQuery([...preds, [field, val]]) },
      limit(_n: number) { return this },
      async get() {
        const docs = [...store.entries()]
          .filter(([k]) => k.startsWith(`${col}/`))
          .filter(([, v]) => preds.every(([f, val]) => (v as Record<string, unknown>)[f] === val))
          .map(([k, v]) => ({ id: k.split("/").slice(1).join("/"), data: () => v }))
        return { empty: docs.length === 0, docs }
      },
    })
    return { doc: (id: string) => doc(col, id), ...buildQuery([]) }
  }
  return { db: { collection } as never, store }
}

const UID = "u1"

test("active prescreen → defer to legacy (no thin handling)", async () => {
  const { db } = makeDb({
    [`pa-prescreen-sessions/ps1`]: { userId: UID, jobId: "JOB1", terminal: null },
    [`pa-users/${UID}`]: { onboardingState: "pending" },
  })
  const res = await selectClaireMode({ db, userId: UID, inboundText: "hi" })
  assert.equal(res.mode, "prescreen")
  assert.equal(res.deferToLegacy, true)
  assert.equal(res.jobId, "JOB1")
})

test("terminal prescreen is NOT active → does not defer", async () => {
  const { db } = makeDb({
    [`pa-prescreen-sessions/ps1`]: { userId: UID, jobId: "JOB1", terminal: "PASS" },
    [`pa-users/${UID}`]: { onboardingState: "complete", sharedOnboarding: { completed: true } },
  })
  const res = await selectClaireMode({ db, userId: UID, inboundText: "hi" })
  assert.equal(res.mode, "triage")
})

test("cold start → bootstrap + onboarding (ask main_goal, awaitingAnswer=false, kickoff NOT recorded)", async () => {
  const { db, store } = makeDb({ [`pa-users/${UID}`]: { onboardingState: "pending" } })
  const res = await selectClaireMode({ db, userId: UID, inboundText: "Hello, WeKruit! TOKEN123" })
  assert.equal(res.mode, "onboarding")
  assert.equal(res.awaitingAnswer, false, "kickoff turn does not record an answer")
  assert.equal(res.onboardingSlot, "main_goal")
  assert.ok(res.pendingStep && res.pendingStep.length > 0)
  assert.ok(res.processStore, "seeds the per-turn process store")
  assert.deepEqual(res.processStore!.onboarding.answers, {}, "no answers seeded on cold start")
  // bootstrap wrote the durable started-state, but recorded NO answer (the tool does that).
  const u = store.get(`pa-users/${UID}`) as { sharedOnboarding: Record<string, unknown> }
  assert.equal(u.sharedOnboarding.status, "active")
  assert.equal(u.sharedOnboarding.currentQuestionId, "main_goal")
  assert.deepEqual(u.sharedOnboarding.answers, {})
})

test("QR resume-less provisional user cold-starts onboarding (no resume gate) — bootstrap + main_goal", async () => {
  // Mirror the iMessage-first QR path: a freshly created provisional user with
  // source='qr_imessage', NO resume, NO tags. bootstrapOnboarding must still cold-
  // start (résumé is OPTIONAL FOREVER — Adam) with the same main_goal kickoff.
  const { db, store } = makeDb({
    [`pa-users/${UID}`]: {
      onboardingState: "pending",
      source: "qr_imessage",
      firstTouchCampaign: "dev-card",
      // intentionally NO tags / latestResumeArtifactId
    },
  })
  const res = await selectClaireMode({ db, userId: UID, inboundText: "Hello, WeKruit! 11111111-2222-3333-4444-555555555555" })
  assert.equal(res.mode, "onboarding")
  assert.equal(res.awaitingAnswer, false, "kickoff turn does not record an answer")
  assert.equal(res.onboardingSlot, "main_goal")
  const u = store.get(`pa-users/${UID}`) as { sharedOnboarding: Record<string, unknown> }
  assert.equal(u.sharedOnboarding.status, "active")
  assert.equal(u.sharedOnboarding.currentQuestionId, "main_goal")
})

test("QR dev re-onboard reset → existing user with tags/resume cold-starts onboarding fresh (non-destructive)", async () => {
  // Post-reonboardExistingUserViaQr shape: onboardingState / sharedOnboarding /
  // workSession CLEARED, but tags + resume KEPT. The mode-selector must treat this
  // as a cold start (NOT complete, NOT active) and bootstrap onboarding fresh.
  const { db, store } = makeDb({
    [`pa-users/${UID}`]: {
      // no onboardingState, no sharedOnboarding, no workSession (deleted by reset)
      source: "qr_imessage",
      firstTouchCampaign: "dev-card",
      senderNumber: "+15550000009",
      tags: { targetRoleFunction: ["software_engineering"] }, // KEPT
      latestResumeArtifactId: "resume-abc", // KEPT
      displayName: "Adam Dev", // KEPT
    },
  })
  const res = await selectClaireMode({ db, userId: UID, inboundText: "Hello, WeKruit! 22222222-3333-4444-5555-666666666666" })
  assert.equal(res.mode, "onboarding")
  assert.equal(res.awaitingAnswer, false, "re-onboard kickoff does not record an answer")
  assert.equal(res.onboardingSlot, "main_goal")
  const u = store.get(`pa-users/${UID}`) as {
    sharedOnboarding: Record<string, unknown>
    tags: Record<string, unknown>
    latestResumeArtifactId: string
  }
  assert.equal(u.sharedOnboarding.status, "active")
  assert.equal(u.sharedOnboarding.currentQuestionId, "main_goal")
  // durable data still present after the bootstrap write (merge, non-destructive)
  assert.deepEqual(u.tags, { targetRoleFunction: ["software_engineering"] })
  assert.equal(u.latestResumeArtifactId, "resume-abc")
})

test("active onboarding → awaitingAnswer + current slot + seeded answers; selector writes NO answer", async () => {
  const { db, store } = makeDb({
    [`pa-users/${UID}`]: {
      onboardingState: "pending",
      sharedOnboarding: {
        status: "active",
        currentQuestionId: "culture_stage",
        answers: { main_goal: { answer: "growth", questionId: "main_goal" } },
        completed: false,
      },
    },
  })
  const res = await selectClaireMode({ db, userId: UID, inboundText: "early-stage startup" })
  assert.equal(res.mode, "onboarding")
  assert.equal(res.awaitingAnswer, true)
  assert.equal(res.onboardingSlot, "culture_stage", "the inbound answers the CURRENT slot")
  assert.ok(res.pendingStep && res.pendingStep.length > 0)
  // seeded store reflects already-answered slots so the reducer enforces order.
  assert.ok("main_goal" in res.processStore!.onboarding.answers)
  assert.ok(!("culture_stage" in res.processStore!.onboarding.answers))
  // selector is READ-ONLY for answers: durable culture_stage answer is NOT written here (the tool writes it).
  const u = store.get(`pa-users/${UID}`) as { sharedOnboarding: { answers: Record<string, unknown> } }
  assert.ok(!("culture_stage" in u.sharedOnboarding.answers), "selector did not record the answer (tool does)")
})

test("onboarding already complete → triage", async () => {
  const { db } = makeDb({ [`pa-users/${UID}`]: { onboardingState: "complete", sharedOnboarding: { completed: true } } })
  const res = await selectClaireMode({ db, userId: UID, inboundText: "what's new?" })
  assert.equal(res.mode, "triage")
})

test("fail-safe: db read error → triage (never throws)", async () => {
  const db = {
    collection() {
      return {
        where() { return this },
        limit() { return this },
        async get() { throw new Error("boom") },
        doc() { return { async get() { throw new Error("boom") }, async set() {} } },
      }
    },
  } as never
  const res = await selectClaireMode({ db, userId: UID, inboundText: "hi" })
  assert.equal(res.mode, "triage")
})
