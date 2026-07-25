import { test } from "node:test"
import assert from "node:assert/strict"
import { buildProcessTools, emptyProcessStore, isContentlessYcIntakeAnswer } from "./process-tools.js"
import { DEFAULT_ONBOARDING_SLOTS } from "../reducers/onboarding-fsm.js"
import type { ProcessToolContext } from "./process-tools.js"

/**
 * REGRESSION (live stall 2026-05-30): the no-regex record_onboarding_answer tool advanced only the
 * IN-MEMORY process store + wrote canonical tags — it dropped the durable sharedOnboarding write the
 * old tool did. The mode-selector re-reads sharedOnboarding.currentQuestionId from Firestore on the
 * NEXT inbound, so on every tool-fired turn the durable slot never moved → Claire re-asked the same
 * question forever. These tests drive the REAL tool against a Firestore-faithful mock and assert the
 * DURABLE currentQuestionId advances (the in-memory FSM reducer tests never caught this — they don't
 * round-trip Firestore).
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
    async get() {
      return { exists: store.has(`${col}/${id}`), id, data: () => store.get(`${col}/${id}`) }
    },
    async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
      store.set(`${col}/${id}`, opts?.merge ? deepMerge(store.get(`${col}/${id}`) ?? {}, data) : { ...data })
    },
  })
  const collection = (col: string) => ({ doc: (id: string) => doc(col, id) })
  return { db: { collection } as never, store }
}

const UID = "u1"
const NULLS = {
  targetRoleFunction: null,
  negativeRoleFunction: null,
  industrySector: null,
  negativeIndustrySector: null,
  companySize: null,
  targetJobType: null,
  targetLocations: null,
  careerStage: null,
  visaStatus: null,
  minSalary: null,
  preferenceHardness: null,
}

function makeCtx(db: never): ProcessToolContext {
  return {
    db,
    userId: UID,
    sessionId: "s1",
    lang: "en",
    transport: {
      markRead: async () => {},
      typing: async () => {},
      sendStatus: async () => {},
      sendText: async () => {},
      tapback: async () => {},
      noReply: async () => {},
    },
    judgeModel: "gpt-4.1-mini",
    log: () => {},
    nowIso: () => "2026-05-30T00:00:00.000Z",
    processStore: emptyProcessStore(),
  } as ProcessToolContext
}

function seededUser() {
  return {
    [`pa-users/${UID}`]: {
      onboardingState: "pending",
      // 2026-06-02 trim: the first ASKED slot is target_role (was main_goal).
      sharedOnboarding: { status: "active", currentQuestionId: "target_role", completed: false, answers: {} },
    },
  }
}

test("record_onboarding_answer DURABLY advances sharedOnboarding.currentQuestionId on a tool-fired turn", async () => {
  const { db, store } = makeDb(seededUser())
  const [, recordOnboarding] = buildProcessTools(makeCtx(db))
  // 2026-06-02 trim: walk the FIRST asked slot (target_role) → it advances to location_relocation.
  await recordOnboarding.invoke({} as never, JSON.stringify({ slot: "target_role", answer: "product management", ...NULLS }))
  const so = (store.get(`pa-users/${UID}`) as { sharedOnboarding: Record<string, unknown> }).sharedOnboarding
  // Before the fix this stayed on the current slot → Claire re-asked it every turn.
  assert.equal(so.currentQuestionId, "location_relocation", "durable slot must advance to the NEXT asked slot")
  assert.equal(so.completed, false)
  assert.equal((store.get(`pa-users/${UID}`) as { onboardingState: string }).onboardingState, "pending")
})

test("score_prescreen_answer: one-score-per-turn latch rejects a 2nd score in the same turn (no judge call, no record)", async () => {
  // Latch ON simulates "a question was already scored THIS turn" — the guard short-circuits BEFORE the
  // LLM judge runs, so this is fully offline + deterministic. Proves the agent can't score q2/q3 with a
  // fabricated answer the candidate never gave (the live FAIL cause: premature terminal on bogus scores).
  const { db } = makeDb()
  const ctx = makeCtx(db)
  ctx.processStore!.prescreen = { questions: ["q1", "q2"], scores: {}, threshold: 0.6, terminal: null, terminalCommits: 0 }
  ctx.prescreenScoredThisTurn = true
  const scorePrescreen = buildProcessTools(ctx)[3]!
  const raw = await scorePrescreen.invoke({} as never, JSON.stringify({ question: "q1", answer: "anything" }))
  const out = (typeof raw === "string" ? JSON.parse(raw) : raw) as { ok: boolean; reason: string; pending: string }
  assert.equal(out.ok, false, "2nd score in a turn must be rejected")
  assert.match(out.reason, /already_scored_this_turn/, "rejection names the per-turn latch")
  assert.equal(out.pending, "q1", "still-pending question is surfaced so the agent asks it next")
  assert.deepEqual(ctx.processStore!.prescreen.scores, {}, "no score recorded on the rejected call")
})

test("record_onboarding_answer walks all slots and completes onboarding durably", async () => {
  const { db, store } = makeDb(seededUser())
  const [, recordOnboarding] = buildProcessTools(makeCtx(db))
  for (const slot of DEFAULT_ONBOARDING_SLOTS) {
    await recordOnboarding.invoke({} as never, JSON.stringify({ slot, answer: `ans-${slot}`, ...NULLS }))
  }
  const doc = store.get(`pa-users/${UID}`) as {
    onboardingState: string
    sharedOnboarding: Record<string, unknown>
  }
  assert.equal(doc.sharedOnboarding.currentQuestionId, null, "last slot → no next question")
  assert.equal(doc.sharedOnboarding.completed, true)
  assert.equal(doc.onboardingState, "complete")
})

/**
 * REGRESSION (live 2026-07-24): user zO7RW9ECC7HlWQZxwgwL has ycIntake.building = "right now" —
 * an echo of Claire's own question ("what are you building right now?") recorded as the answer.
 * Their match query became "right now. everyone". The matcher ranks 988 real attendees off these
 * two strings, so the guard is load-bearing. Vague-but-real answers must still get through.
 */
test("record_yc_intake echo guard: contentless in, real intent through", () => {
  for (const junk of ["right now", "Right now", "yes", "ok", "sure", "idk", "nothing", "hi", "", "  ", "want to meet"]) {
    assert.equal(isContentlessYcIntakeAnswer(junk), true, `must REJECT contentless: ${JSON.stringify(junk)}`)
  }
  for (const real of [
    "AI vet scribe",
    "Anyone", // vague but a real scope answer to "who do you want to meet"
    "Founders",
    "everyone",
    "consumer founders and investors",
    "a dev tool for LLM evals",
  ]) {
    assert.equal(isContentlessYcIntakeAnswer(real), false, `must ACCEPT real answer: ${JSON.stringify(real)}`)
  }
})

test("record_yc_intake rejects an echo answer instead of writing it to pa-users", async () => {
  const { db, store } = makeDb({ [`pa-users/${UID}`]: {} })
  const recordYcIntake = buildProcessTools(makeCtx(db)).at(-1)!
  const raw = await recordYcIntake.invoke({} as never, JSON.stringify({ field: "building", answer: "right now" }))
  const out = (typeof raw === "string" ? JSON.parse(raw) : raw) as { ok: boolean; error: string; nextAction?: string }
  assert.equal(out.ok, false)
  assert.equal(out.error, "contentless_answer")
  assert.match(out.nextAction ?? "", /ask the question again/i, "tells the model to re-ask")
  assert.equal((store.get(`pa-users/${UID}`) as { ycIntake?: unknown }).ycIntake, undefined, "nothing written")

  // ...and a real answer still lands.
  await recordYcIntake.invoke({} as never, JSON.stringify({ field: "building", answer: "AI vet scribe" }))
  const intake = (store.get(`pa-users/${UID}`) as { ycIntake: { building: string } }).ycIntake
  assert.equal(intake.building, "AI vet scribe")
})
