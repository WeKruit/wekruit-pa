/**
 * 2026-05-06 P9 — regression test for applyOnboarding wrapper dropping
 * `parsedAnswer` on the floor.
 *
 * Live bug repro (Adam iter23 testing 2026-05-06):
 *   - Legacy language preference capture produced a parsed preferredLang
 *     value before advancing to the next onboarding step.
 *     onAccepted fires → runtime-bridge calls
 *     `deps.applyOnboarding(userId, phone, "ask_q_tos", { parsedAnswer:
 *     { preferredLang: "en" } })`.
 *   - Production wrapper at `createFirestoreOrchestratorStore.applyOnboarding`
 *     enumerated each `opts.X` field manually (line 3653-3663) and
 *     **omitted `opts.parsedAnswer`**, silently dropping it.
 *   - Downstream `applyOnboardingStep` then fell into the regex-fallback
 *     branch, but with no priorAskedStep+priorUserReply either, so prefPatch
 *     stayed empty → `writeOnboardingTags` skipped → `pa-users.tags.
 *     preferredLang` never updated → next bot reply read the prior session's
 *     "zh" tag and replied in mixed bilingual.
 *   - Mirror impact: every probe-Q canonical-answer write (q_role,
 *     q_yoe, q_visa, q_startup_pref, q_location)
 *     was equally broken via the same wrapper hole.
 *
 * Fix: forward `parsedAnswer: opts?.parsedAnswer` in the wrapper.
 *
 * What we verify:
 *   - When applyOnboarding is called with opts.parsedAnswer, the resulting
 *     userRef.set payload contains a `statedPreferences` field with the
 *     same canonical content (proves the parsedAnswer reached
 *     applyOnboardingStep).
 *   - Without the fix this test would observe `statedPreferences` absent
 *     from the payload (regex fallback would also be empty without
 *     priorAskedStep+priorUserReply).
 */
import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"

import { createFirestoreOrchestratorStore } from "../index.js"

interface CapturedSet {
  docPath: string
  payload: Record<string, unknown>
}

/**
 * Minimal Firestore fake. Captures user-doc set() calls so the test can
 * assert `payload.statedPreferences` content. Read returns "no current
 * onboardingState" so applyOnboardingStep treats this as a fresh advance
 * (idempotency guard passes).
 */
function makeCapturingDb(
  initialDocs: Record<string, Record<string, unknown>> = {}
): { db: Firestore; sets: CapturedSet[] } {
  const sets: CapturedSet[] = []
  const docs = new Map<string, Record<string, unknown>>(Object.entries(initialDocs))
  const empty = { empty: true, size: 0, docs: [] } as unknown
  const where = () => ({ get: async () => empty, limit: () => ({ get: async () => empty }) })
  const makeDocRef = (docPath: string) => ({
    get: async () => {
      const data = docs.get(docPath)
      return { exists: Boolean(data), data: () => data }
    },
    set: async (payload: Record<string, unknown>) => {
      sets.push({ docPath, payload })
      docs.set(docPath, { ...(docs.get(docPath) ?? {}), ...payload })
    },
    update: async (payload: Record<string, unknown>) => {
      sets.push({ docPath, payload })
      docs.set(docPath, { ...(docs.get(docPath) ?? {}), ...payload })
    },
    delete: async () => undefined,
    collection: () => ({ get: async () => empty }),
  })
  const collection = (collectionName: string) => ({
    where,
    get: async () => empty,
    doc: (docId: string) => makeDocRef(`${collectionName}/${docId}`),
  })
  const db = {
    collection,
  } as unknown as Firestore
  return { db, sets }
}

test("P9 — applyOnboarding wrapper FORWARDS opts.parsedAnswer (q_lang preferredLang)", async () => {
  const { db, sets } = makeCapturingDb()
  const store = createFirestoreOrchestratorStore(db)

  // Mirror runtime-bridge.q_lang.onAccepted call shape:
  //   applyOnboarding(userId, phone, "ask_q_tos", { parsedAnswer: { preferredLang: "en" } })
  await store.applyOnboarding("u_p9_test", "+15551234", "ask_q_tos", {
    parsedAnswer: { preferredLang: "en" },
  })

  // The wrapper should have called applyOnboardingStep, which writes a
  // userRef.set with `statedPreferences: { preferredLang: 'en', updatedAt: ... }`.
  // Find the pa-users/u_p9_test set call.
  const userSet = sets.find((s) => s.docPath === "pa-users/u_p9_test")
  assert.ok(userSet, "applyOnboarding must trigger a pa-users write")
  const payload = userSet!.payload
  // The state advance should have fired.
  assert.equal(
    payload.onboardingState,
    "q_tos_asked",
    "ask_q_tos step must transition state to q_tos_asked"
  )
  // Critical assertion — without the wrapper fix this would be undefined.
  const sp = payload.statedPreferences as { preferredLang?: string } | undefined
  assert.ok(
    sp,
    "statedPreferences must be in the payload (proves parsedAnswer flowed through)"
  )
  assert.equal(
    sp.preferredLang,
    "en",
    "parsedAnswer.preferredLang must reach statedPreferences (this regression caused mixed-lang leak)"
  )
})

test("P9 — applyOnboarding wrapper forwards parsedAnswer for visa probe (q_visa)", async () => {
  const { db, sets } = makeCapturingDb()
  const store = createFirestoreOrchestratorStore(db)

  // Mirror runtime-bridge.q_visa.onAccepted — VisaJudge canonical "h1b".
  await store.applyOnboarding("u_p9_visa", "+15551235", "ask_q_startup_pref", {
    parsedAnswer: { visaStatus: "h1b" },
  })

  const userSet = sets.find((s) => s.docPath === "pa-users/u_p9_visa")
  assert.ok(userSet)
  const sp = userSet!.payload.statedPreferences as { visaStatus?: string } | undefined
  assert.ok(sp, "visa parsedAnswer must reach statedPreferences via wrapper")
  assert.equal(sp.visaStatus, "h1b", "h1b passes through verbatim")
})

test("P9 — applyOnboarding wrapper forwards q_country targetCountry", async () => {
  const { db, sets } = makeCapturingDb()
  const store = createFirestoreOrchestratorStore(db)

  await store.applyOnboarding("u_p9_country", "+15551237", "ask_q_location", {
    parsedAnswer: { targetCountry: ["usa"] },
  })

  const userSet = sets.find((s) => s.docPath === "pa-users/u_p9_country")
  assert.ok(userSet)
  assert.equal(userSet!.payload.onboardingState, "q_location_asked")
  const sp = userSet!.payload.statedPreferences as { targetCountry?: string[] } | undefined
  assert.ok(sp, "country parsedAnswer must reach statedPreferences via wrapper")
  assert.deepEqual(sp.targetCountry, ["usa"])
  const tagSet = sets.find(
    (s) => s.docPath === "pa-users/u_p9_country" && s.payload.tags
  )
  const tags = tagSet?.payload.tags as { targetCountry?: string[] } | undefined
  assert.ok(tags, "country parsedAnswer must be projected into user tags")
  assert.deepEqual(tags.targetCountry, ["usa"])
})

test("returning completed users still persist fresh parsedAnswer and tags", async () => {
  const { db, sets } = makeCapturingDb({
    "pa-users/u_returning_visa": {
      onboardingState: "complete",
      statedPreferences: { visaStatus: "citizen" },
      tags: { visaStatus: "citizen" },
    },
  })
  const store = createFirestoreOrchestratorStore(db)

  await store.applyOnboarding("u_returning_visa", "+15551242", "ask_q_startup_pref", {
    now: "2026-05-17T20:50:00.000Z",
    parsedAnswer: { visaStatus: "sponsorship_needed" },
  })

  const prefSet = sets.find(
    (s) => s.docPath === "pa-users/u_returning_visa" && s.payload.statedPreferences
  )
  assert.ok(prefSet, "fresh parsedAnswer must write even when onboardingState is complete")
  assert.equal(
    prefSet!.payload.onboardingState,
    undefined,
    "completed returning user must not regress legacy onboardingState"
  )
  const sp = prefSet!.payload.statedPreferences as { visaStatus?: string } | undefined
  assert.equal(sp?.visaStatus, "sponsorship_needed")

  const tagSet = sets.find(
    (s) => s.docPath === "pa-users/u_returning_visa" && s.payload.tags
  )
  const tags = tagSet?.payload.tags as { visaStatus?: string } | undefined
  assert.equal(tags?.visaStatus, "sponsor_needed")
})

test("returning completed users still open the resume gate when q_resume is reached", async () => {
  const { db, sets } = makeCapturingDb({
    "pa-users/u_returning_resume": {
      onboardingState: "complete",
    },
  })
  const store = createFirestoreOrchestratorStore(db)

  await store.applyOnboarding("u_returning_resume", "+15551243", "ask_q_resume", {
    now: "2026-05-17T20:51:00.000Z",
    parsedAnswer: { targetLocations: ["nyc", "remote"] },
  })

  const prefSet = sets.find(
    (s) => s.docPath === "pa-users/u_returning_resume" && s.payload.statedPreferences
  )
  assert.ok(prefSet)
  assert.equal(prefSet!.payload.onboardingState, undefined)
  assert.deepEqual(
    (prefSet!.payload.statedPreferences as { targetLocations?: string[] }).targetLocations,
    ["nyc", "remote"]
  )
  assert.deepEqual(prefSet!.payload.resumeAccepted, {
    at: "2026-05-17T20:51:00.000Z",
    expiresAt: "2026-05-18T20:51:00.000Z",
    triggerHash: "onboarding_ask_q_resume",
  })
  assert.equal(prefSet!.payload.lastAssistantTurnAskedResume, true)
})

test("P9 — applyOnboarding wrapper still works WITHOUT parsedAnswer (regression guard)", async () => {
  const { db, sets } = makeCapturingDb()
  const store = createFirestoreOrchestratorStore(db)

  // Legacy path: no parsedAnswer, no priorAskedStep — wrapper should still
  // advance state (this is the "send_first_mes" no-prefs case).
  await store.applyOnboarding("u_p9_legacy", "+15551236", "send_first_mes")

  const userSet = sets.find((s) => s.docPath === "pa-users/u_p9_legacy")
  assert.ok(userSet, "wrapper must still write user doc even with no opts")
  // No statedPreferences expected when nothing was passed.
  assert.equal(
    userSet!.payload.statedPreferences,
    undefined,
    "no parsedAnswer + no priorAskedStep = no statedPreferences write"
  )
})

test("onboarding writes a normal_onboarding workSession while advancing", async () => {
  const { db, sets } = makeCapturingDb({
    "pa-users/u_normal_session": {
      onboardingState: "q_location_asked",
      workSession: {
        kind: "job_prescreen",
        status: "ended",
        startedAt: "2026-05-16T18:00:00.000Z",
        endedAt: "2026-05-16T18:10:00.000Z",
        boundary: "user_exit",
        sessionId: "ps_old",
        jobId: "job_old",
        terminal: "PAUSE",
      },
    },
  })
  const store = createFirestoreOrchestratorStore(db)

  await store.applyOnboarding("u_normal_session", "+15551238", "ask_q_resume", {
    now: "2026-05-16T19:00:00.000Z",
  })

  const userSet = sets.find((s) => s.docPath === "pa-users/u_normal_session")
  assert.ok(userSet)
  assert.equal(userSet!.payload.onboardingState, "q_resume_asked")
  assert.deepEqual(userSet!.payload.workSession, {
    kind: "normal_onboarding",
    status: "active",
    startedAt: "2026-05-16T19:00:00.000Z",
    boundary: "onboarding",
    currentState: "q_resume_asked",
  })
})

test("onboarding restores layoff_onboarding session from layoff source without prescreen fields", async () => {
  const { db, sets } = makeCapturingDb({
    "pa-users/u_layoff_session": {
      source: "WeKruit_Laid_Off",
      onboardingState: "q_location_asked",
      workSession: {
        kind: "job_prescreen",
        status: "ended",
        startedAt: "2026-05-16T18:00:00.000Z",
        endedAt: "2026-05-16T18:10:00.000Z",
        boundary: "user_exit",
        sessionId: "ps_old",
        jobId: "job_old",
        terminal: "PAUSE",
      },
    },
  })
  const store = createFirestoreOrchestratorStore(db)

  await store.applyOnboarding("u_layoff_session", "+15551239", "ask_q_resume", {
    now: "2026-05-16T19:01:00.000Z",
  })

  const userSet = sets.find((s) => s.docPath === "pa-users/u_layoff_session")
  assert.ok(userSet)
  const workSession = userSet!.payload.workSession as Record<string, unknown>
  assert.deepEqual(workSession, {
    kind: "layoff_onboarding",
    status: "active",
    startedAt: "2026-05-16T19:01:00.000Z",
    boundary: "onboarding",
    currentState: "q_resume_asked",
  })
  assert.equal("sessionId" in workSession, false)
  assert.equal("jobId" in workSession, false)
  assert.equal("terminal" in workSession, false)
})

test("onboarding marks workSession ended when the onboarding chain completes", async () => {
  const { db, sets } = makeCapturingDb({
    "pa-users/u_complete_session": {
      onboardingState: "q_resume_asked",
      workSession: {
        kind: "normal_onboarding",
        status: "active",
        startedAt: "2026-05-16T18:59:00.000Z",
        boundary: "onboarding",
        currentState: "q_resume_asked",
      },
    },
  })
  const store = createFirestoreOrchestratorStore(db)

  await store.applyOnboarding("u_complete_session", "+15551240", "complete", {
    now: "2026-05-16T19:02:00.000Z",
  })

  const userSet = sets.find((s) => s.docPath === "pa-users/u_complete_session")
  assert.ok(userSet)
  assert.equal(userSet!.payload.onboardingState, "complete")
  assert.equal(userSet!.payload.onboardingStatus, "active")
  assert.deepEqual(userSet!.payload.workSession, {
    kind: "normal_onboarding",
    status: "ended",
    startedAt: "2026-05-16T18:59:00.000Z",
    endedAt: "2026-05-16T19:02:00.000Z",
    boundary: "complete",
    currentState: "complete",
  })
})

test("onboarding completion replaces Firestore workSession map so stale prescreen keys are removed", async () => {
  const { db, sets } = makeCapturingDb({
    "pa-users/u_complete_stale_session": {
      source: "WeKruit_Laid_Off",
      onboardingState: "q_resume_asked",
      workSession: {
        kind: "job_prescreen",
        status: "ended",
        startedAt: "2026-05-16T18:59:00.000Z",
        boundary: "user_exit",
        sessionId: "ps_old",
        jobId: "job_old",
        terminal: "PAUSE",
      },
    },
  })
  const store = createFirestoreOrchestratorStore(db)

  await store.applyOnboarding("u_complete_stale_session", "+15551241", "complete", {
    now: "2026-05-16T19:03:00.000Z",
  })

  const replacement = sets.find(
    (s) =>
      s.docPath === "pa-users/u_complete_stale_session" &&
      Object.keys(s.payload).length === 1 &&
      Boolean(s.payload.workSession)
  )
  assert.ok(replacement, "applyOnboarding must replace the whole workSession map after merge")
  const workSession = replacement!.payload.workSession as Record<string, unknown>
  assert.deepEqual(workSession, {
    kind: "layoff_onboarding",
    status: "ended",
    startedAt: "2026-05-16T19:03:00.000Z",
    endedAt: "2026-05-16T19:03:00.000Z",
    boundary: "complete",
    currentState: "complete",
  })
  assert.equal("sessionId" in workSession, false)
  assert.equal("jobId" in workSession, false)
  assert.equal("terminal" in workSession, false)
})
