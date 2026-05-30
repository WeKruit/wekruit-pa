import { test } from "node:test"
import assert from "node:assert/strict"
import { buildProcessTools, emptyProcessStore } from "./process-tools.js"
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
      sharedOnboarding: { status: "active", currentQuestionId: "main_goal", completed: false, answers: {} },
    },
  }
}

test("record_onboarding_answer DURABLY advances sharedOnboarding.currentQuestionId on a tool-fired turn", async () => {
  const { db, store } = makeDb(seededUser())
  const [, recordOnboarding] = buildProcessTools(makeCtx(db))
  await recordOnboarding.invoke({} as never, JSON.stringify({ slot: "main_goal", answer: "career growth", ...NULLS }))
  const so = (store.get(`pa-users/${UID}`) as { sharedOnboarding: Record<string, unknown> }).sharedOnboarding
  // Before the fix this stayed "main_goal" → Claire re-asked main_goal every turn.
  assert.equal(so.currentQuestionId, "culture_stage", "durable slot must advance to the NEXT slot")
  assert.equal(so.completed, false)
  assert.equal((store.get(`pa-users/${UID}`) as { onboardingState: string }).onboardingState, "pending")
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
