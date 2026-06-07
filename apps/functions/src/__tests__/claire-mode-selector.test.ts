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

test("cold start → bootstrap + onboarding (ask target_role, awaitingAnswer=false, kickoff NOT recorded)", async () => {
  const { db, store } = makeDb({ [`pa-users/${UID}`]: { onboardingState: "pending" } })
  const res = await selectClaireMode({ db, userId: UID, inboundText: "Hello, WeKruit! TOKEN123" })
  assert.equal(res.mode, "onboarding")
  assert.equal(res.awaitingAnswer, false, "kickoff turn does not record an answer")
  assert.equal(res.onboardingSlot, "target_role")
  assert.ok(res.pendingStep && res.pendingStep.length > 0)
  assert.ok(res.processStore, "seeds the per-turn process store")
  assert.deepEqual(res.processStore!.onboarding.answers, {}, "no answers seeded on cold start")
  // bootstrap wrote the durable started-state, but recorded NO answer (the tool does that).
  const u = store.get(`pa-users/${UID}`) as { sharedOnboarding: Record<string, unknown> }
  assert.equal(u.sharedOnboarding.status, "active")
  assert.equal(u.sharedOnboarding.currentQuestionId, "target_role")
  assert.deepEqual(u.sharedOnboarding.answers, {})
})

test("QR resume-less provisional user cold-starts onboarding (no resume gate) — bootstrap + target_role", async () => {
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
  assert.equal(res.onboardingSlot, "target_role")
  const u = store.get(`pa-users/${UID}`) as { sharedOnboarding: Record<string, unknown> }
  assert.equal(u.sharedOnboarding.status, "active")
  assert.equal(u.sharedOnboarding.currentQuestionId, "target_role")
})

test("QR dev re-onboard reset → existing user with a KEPT résumé is RECOGNIZED → pitch, NEVER the onboarding wall (Adam 2026-06-06)", async () => {
  // Post-reonboardExistingUserViaQr shape: onboardingState / sharedOnboarding / workSession CLEARED,
  // but tags + résumé KEPT (non-destructive reset). A kept résumé = ingested background, so under
  // Adam 2026-06-06 ("login on LinkedIn / known candidate → directly pitch, no more onboarding
  // questions") the selector must PITCH (triage + postParsePitch), not re-onboard with a question —
  // the pitch confirms/elicits any missing axis (e.g. location) inline. A TRUE cold re-onboard would
  // clear the résumé too (the cold reset path); a non-destructive reset that keeps the résumé keeps
  // the candidate recognized. SUPERSEDES the 2026-06-05 gap-aware "ask the missing location axis" for
  // this kept-background case. Self-heals onboarding complete so it never re-enters the wall.
  const { db, store } = makeDb({
    [`pa-users/${UID}`]: {
      // no onboardingState, no sharedOnboarding, no workSession (deleted by reset)
      source: "qr_imessage",
      firstTouchCampaign: "dev-card",
      senderNumber: "+15550000009",
      tags: { targetRoleFunction: ["software_engineering"] }, // KEPT
      latestResumeArtifactId: "resume-abc", // KEPT → recognized background
      displayName: "Adam Dev", // KEPT
    },
  })
  const res = await selectClaireMode({ db, userId: UID, inboundText: "Hello, WeKruit! 22222222-3333-4444-5555-666666666666" })
  assert.equal(res.mode, "triage", "recognized (kept résumé) → pitch in triage, not the onboarding wall")
  assert.equal(res.postParsePitch, true, "pitch the recognized candidate (pitch asks any missing axis inline)")
  assert.notEqual(res.mode, "onboarding", "must NEVER re-onboard a recognized candidate with a question")
  const u = store.get(`pa-users/${UID}`) as {
    sharedOnboarding?: Record<string, unknown>
    tags: Record<string, unknown>
    latestResumeArtifactId: string
  }
  // self-healed: onboarding marked complete (no active question wall seeded)
  assert.notEqual(u.sharedOnboarding?.status, "active", "must NOT seed an active onboarding question")
  // durable data still present (merge, non-destructive)
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
  assert.equal(
    res.onboardingSlot,
    "target_role",
    "dropped slot (culture_stage) rescues to the first UNANSWERED asked slot (target_role)",
  )
  assert.ok(res.pendingStep && res.pendingStep.length > 0)
  // seeded store reflects already-answered slots so the reducer enforces order.
  assert.ok("main_goal" in res.processStore!.onboarding.answers)
  assert.ok(!("culture_stage" in res.processStore!.onboarding.answers))
  // selector is READ-ONLY for answers: durable culture_stage answer is NOT written here (the tool writes it).
  const u = store.get(`pa-users/${UID}`) as { sharedOnboarding: { answers: Record<string, unknown> } }
  assert.ok(!("culture_stage" in u.sharedOnboarding.answers), "selector did not record the answer (tool does)")
})

test("in-flight STALL GUARD: paused at a dropped LATE slot with both asked slots answered → complete+triage (no re-ask loop)", async () => {
  // Pre-trim, special_context was position 7 (after location_relocation@5), so a user paused there
  // had ALREADY answered both surviving asked slots (target_role@3, location_relocation@5). Without
  // the guard, rescue falls back to target_role and re-asks forever (answer already recorded →
  // already_complete → durable `completed` never flips). The guard must complete + route to triage.
  const { db, store } = makeDb({
    [`pa-users/${UID}`]: {
      onboardingState: "pending",
      sharedOnboarding: {
        status: "active",
        currentQuestionId: "special_context",
        answers: {
          target_role: { answer: "swe", questionId: "target_role" },
          location_relocation: { answer: "nyc or remote", questionId: "location_relocation" },
        },
        completed: false,
      },
    },
  })
  const res = await selectClaireMode({ db, userId: UID, inboundText: "ok what's next" })
  assert.equal(res.mode, "triage", "all asked slots answered → triage, NOT a re-ask")
  // durable self-heal: onboarding is marked complete so the user exits the onboarding path for good.
  const u = store.get(`pa-users/${UID}`) as {
    onboardingState: string
    sharedOnboarding: { completed: boolean; status: string }
  }
  assert.equal(u.onboardingState, "complete")
  assert.equal(u.sharedOnboarding.completed, true)
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
