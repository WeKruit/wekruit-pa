/**
 * VERIFY 1/3 — DUAL-COHORT SIM for the 7→2 onboarding trim (2026-06-02).
 *
 * Drives the REAL thin-path production units in-process against an in-memory
 * Firestore (same fake-db pattern as mode-selector-cv-parsed.test.ts +
 * process-tools.test.ts), and through the REAL OpenAI Agents SDK model
 * (runClaireTurn → run()), capturing the actual outbound bubbles + the durable
 * tag writes.
 *
 *   S1 FRESH cold-start: selectClaireMode bootstraps → asks EXACTLY target_role,
 *       then location_relocation; after 2 answers the FSM completes
 *       (recommend-eligible). NOT 7.
 *   S2 IN-FLIGHT: durable currentQuestionId = a DROPPED slot (culture_stage) +
 *       prior answers → selectClaireMode rescues to the first UNANSWERED asked
 *       slot. NO stall / crash / infinite re-ask.
 *   S3 EXTRACTION-NOT-LOST: a free-text target_role answer mentioning industry +
 *       seniority → the REAL model fills record_onboarding_answer canonical args
 *       → applyPartialUserTags writes industrySector/careerStage to the durable
 *       doc (soft signals captured even though those questions are no longer asked).
 *
 * Run from apps/functions:
 *   node --import tsx .tmp/onboarding-trim-dualcohort-sim.mts
 */
import { selectClaireMode } from "../apps/functions/src/claire-agent/mode-selector.js"
import { runClaireTurn } from "../apps/functions/src/claire-agent/agent.js"
import { buildProcessTools, emptyProcessStore } from "../apps/functions/src/claire-agent/tools/process-tools.js"
import { DEFAULT_ONBOARDING_SLOTS } from "../apps/functions/src/claire-agent/reducers/onboarding-fsm.js"
import {
  ALL_SHARED_ONBOARDING_QUESTIONS,
  SHARED_ONBOARDING_QUESTIONS,
} from "@pa/pa-orchestrator"

// ── In-memory Firestore (deep-merge set, faithful to the fields the units touch) ──
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
    async update(data: Record<string, unknown>) {
      store.set(`${col}/${id}`, deepMerge(store.get(`${col}/${id}`) ?? {}, data))
    },
  })
  const emptyChain = {
    where() { return emptyChain },
    orderBy() { return emptyChain },
    limit() { return emptyChain },
    async get() { return { empty: true, docs: [] as unknown[] } },
  }
  const collection = (col: string) => ({
    doc: (id: string) => doc(col, id),
    where() { return emptyChain },
    orderBy() { return emptyChain },
    limit() { return emptyChain },
    async get() { return { empty: true, docs: [] as unknown[] } },
  })
  return { db: { collection } as never, store }
}

// ── Recording transport (captures the real outbound bubbles) ──
function makeTransport() {
  const bubbles: string[] = []
  const transport = {
    async markRead() {},
    async typing() {},
    async sendStatus() {},
    async sendText(t: string) { bubbles.push(t) },
    async tapback() {},
    async noReply() {},
  }
  return { transport, bubbles }
}

const logs: Array<{ name: string; payload: Record<string, unknown> }> = []
const log = (name: string, payload?: Record<string, unknown>) => { logs.push({ name, payload: payload ?? {} }) }

const NOW = "2026-06-03T00:00:00.000Z"
const FRESH_UID = "sim_fresh_user_global"   // NON-canary on purpose: the trim is GLOBAL, not canary.
const INFLIGHT_UID = "sim_inflight_user_global"

function section(t: string) { console.log("\n" + "=".repeat(78) + "\n" + t + "\n" + "=".repeat(78)) }

async function driveTurn(opts: {
  db: never
  store: Map<string, Record<string, unknown>>
  userId: string
  text: string
  realModel: boolean
}): Promise<{ bubbles: string[]; mode: string; onboardingSlot?: string; deferToLegacy?: boolean; awaitingAnswer?: boolean }> {
  const decision = await selectClaireMode({ db: opts.db, userId: opts.userId, inboundText: opts.text, nowIso: () => NOW, log })
  const { transport, bubbles } = makeTransport()
  if (opts.realModel && !decision.deferToLegacy) {
    await runClaireTurn(
      { userId: opts.userId, sessionId: `s-${opts.userId}`, text: opts.text, lang: "en" },
      {
        db: opts.db,
        transport,
        mode: decision.mode,
        pendingStep: decision.pendingStep,
        currentStep: decision.currentStep,
        onboardingSlot: decision.onboardingSlot,
        awaitingAnswer: decision.awaitingAnswer,
        processStore: decision.processStore,
        nowIso: () => NOW,
        log,
      },
    )
  }
  return {
    bubbles,
    mode: decision.mode,
    onboardingSlot: decision.onboardingSlot,
    deferToLegacy: decision.deferToLegacy,
    awaitingAnswer: decision.awaitingAnswer,
  }
}

async function main() {
  const realModel = !!(process.env.PA_OPENAI_AGENT_API_KEY || process.env.OPENAI_API_KEY)
  if (realModel && !process.env.OPENAI_API_KEY && process.env.PA_OPENAI_AGENT_API_KEY) {
    process.env.OPENAI_API_KEY = process.env.PA_OPENAI_AGENT_API_KEY
  }
  console.log(`# real model available: ${realModel}  (asked-slot order: ${JSON.stringify(SHARED_ONBOARDING_QUESTIONS.map((q) => q.id))})`)
  console.log(`# DEFAULT_ONBOARDING_SLOTS = ${JSON.stringify([...DEFAULT_ONBOARDING_SLOTS])}  (len ${DEFAULT_ONBOARDING_SLOTS.length})`)
  console.log(`# FULL definition set still covers all ${ALL_SHARED_ONBOARDING_QUESTIONS.length} ids (in-flight slots stay resolvable)`)

  const summary: Record<string, unknown> = {}

  // ───────────────────────────── S1: FRESH COLD-START ─────────────────────────────
  section("S1 — FRESH user (cold start, no durable onboarding state)")
  {
    const { db, store } = makeDb({})            // NO pa-users doc → cold start
    // Turn 1: greeting/kickoff. mode-selector bootstraps + asks the FIRST asked slot.
    const t1 = await driveTurn({ db, store, userId: FRESH_UID, text: "hey", realModel })
    console.log("\n[turn 1] inbound: 'hey'")
    console.log("  mode:", t1.mode, "| onboardingSlot:", t1.onboardingSlot, "| awaitingAnswer:", t1.awaitingAnswer)
    console.log("  OUTBOUND BUBBLES:")
    t1.bubbles.forEach((b, i) => console.log(`    [${i}] ${b}`))
    const seeded = store.get(`pa-users/${FRESH_UID}`) as { sharedOnboarding?: Record<string, unknown> } | undefined
    console.log("  durable sharedOnboarding after bootstrap:", JSON.stringify(seeded?.sharedOnboarding))

    // Turn 2: candidate answers target_role. Agent records via tool → durable advances to location_relocation.
    const t2 = await driveTurn({ db, store, userId: FRESH_UID, text: "I'm a backend software engineer, staying in that lane", realModel })
    console.log("\n[turn 2] inbound: \"I'm a backend software engineer, staying in that lane\"")
    console.log("  mode:", t2.mode, "| onboardingSlot:", t2.onboardingSlot)
    console.log("  OUTBOUND BUBBLES:")
    t2.bubbles.forEach((b, i) => console.log(`    [${i}] ${b}`))
    const afterT2 = store.get(`pa-users/${FRESH_UID}`) as { sharedOnboarding?: Record<string, unknown> } | undefined
    console.log("  durable sharedOnboarding:", JSON.stringify(afterT2?.sharedOnboarding))

    // Turn 3: candidate answers location_relocation → completion.
    const t3 = await driveTurn({ db, store, userId: FRESH_UID, text: "NYC or remote in the US, not relocating", realModel })
    console.log("\n[turn 3] inbound: 'NYC or remote in the US, not relocating'")
    console.log("  mode:", t3.mode, "| onboardingSlot:", t3.onboardingSlot)
    console.log("  OUTBOUND BUBBLES:")
    t3.bubbles.forEach((b, i) => console.log(`    [${i}] ${b}`))
    const afterT3 = store.get(`pa-users/${FRESH_UID}`) as { sharedOnboarding?: Record<string, unknown>; onboardingState?: string; tags?: Record<string, unknown> } | undefined
    console.log("  durable sharedOnboarding:", JSON.stringify(afterT3?.sharedOnboarding))
    console.log("  onboardingState:", afterT3?.onboardingState)
    console.log("  durable tags written:", JSON.stringify(afterT3?.tags))

    // Turn 4 (probe): a now-COMPLETE user → mode resolves to triage (recommend-eligible, NOT a 3rd onboarding question).
    const t4 = await driveTurn({ db, store, userId: FRESH_UID, text: "ok what do you have for me", realModel: false })
    console.log("\n[turn 4 probe — recommend-eligibility] inbound: 'ok what do you have for me'")
    console.log("  mode:", t4.mode, "(triage = onboarding done, recommend-eligible)")

    const completed = (afterT3?.sharedOnboarding as { completed?: boolean })?.completed === true
    const askedSlots = [t1.onboardingSlot, t2.onboardingSlot].filter(Boolean)
    summary.s1 = {
      firstAskedSlot: t1.onboardingSlot,
      secondAskedSlot: t2.onboardingSlot,
      askedExactlyTwo: askedSlots.length === 2 && t1.onboardingSlot === "target_role" && t2.onboardingSlot === "location_relocation",
      completedAfterTwo: completed,
      modeAfterComplete: t4.mode,
      recommendEligible: completed && t4.mode === "triage",
      bubblesT1: t1.bubbles,
      bubblesT2: t2.bubbles,
      bubblesT3: t3.bubbles,
    }
    console.log("\n  S1 RESULT:", JSON.stringify({ askedExactlyTwo: summary.s1["askedExactlyTwo"], completedAfterTwo: completed, recommendEligible: summary.s1["recommendEligible"] }))
  }

  // ───────────────────────────── S2: IN-FLIGHT (dropped slot) ─────────────────────────────
  section("S2 — IN-FLIGHT user: durable currentQuestionId = DROPPED slot 'culture_stage' + prior answers")
  {
    // Mid-onboarding user from BEFORE the trim: they were on culture_stage with main_goal already answered.
    const { db, store } = makeDb({
      [`pa-users/${INFLIGHT_UID}`]: {
        onboardingState: "pending",
        onboardingStatus: "invited",
        sharedOnboarding: {
          status: "active",
          completed: false,
          currentQuestionId: "culture_stage", // a DROPPED slot — must NOT be re-asked / must NOT strand
          answers: { main_goal: { answer: "career growth", answeredAt: NOW, questionId: "main_goal" } },
        },
      },
    })
    const before = store.get(`pa-users/${INFLIGHT_UID}`) as { sharedOnboarding: Record<string, unknown> }
    console.log("  durable BEFORE:", JSON.stringify(before.sharedOnboarding))

    let crashed = false
    let t: Awaited<ReturnType<typeof driveTurn>> | null = null
    try {
      t = await driveTurn({ db, store, userId: INFLIGHT_UID, text: "ok what's next", realModel })
    } catch (err) {
      crashed = true
      console.log("  !! CRASH:", err instanceof Error ? err.message : String(err))
    }
    if (t) {
      console.log("\n[turn] inbound: \"ok what's next\"")
      console.log("  mode:", t.mode, "| deferToLegacy:", t.deferToLegacy, "| onboardingSlot (rescued):", t.onboardingSlot)
      console.log("  OUTBOUND BUBBLES:")
      t.bubbles.forEach((b, i) => console.log(`    [${i}] ${b}`))
    }

    // Loop guard: drive ANOTHER turn — the rescued slot must ANSWER + ADVANCE, never re-ask culture_stage forever.
    let t2: Awaited<ReturnType<typeof driveTurn>> | null = null
    if (t && !crashed) {
      t2 = await driveTurn({ db, store, userId: INFLIGHT_UID, text: "I want product roles at a fintech, mid-level", realModel })
      console.log("\n[turn 2 — loop guard] inbound: 'I want product roles at a fintech, mid-level'")
      console.log("  mode:", t2.mode, "| onboardingSlot:", t2.onboardingSlot)
      console.log("  OUTBOUND BUBBLES:")
      t2.bubbles.forEach((b, i) => console.log(`    [${i}] ${b}`))
    }
    const after = store.get(`pa-users/${INFLIGHT_UID}`) as { sharedOnboarding?: Record<string, unknown>; tags?: Record<string, unknown> }
    console.log("\n  durable AFTER:", JSON.stringify(after?.sharedOnboarding))
    console.log("  durable tags:", JSON.stringify(after?.tags))

    const rescuedSlot = t?.onboardingSlot
    const rescuedToAsked = rescuedSlot ? DEFAULT_ONBOARDING_SLOTS.includes(rescuedSlot) : false
    const notStaleDropped = rescuedSlot !== "culture_stage"
    // No infinite loop: the rescued slot must be the first UNANSWERED asked slot (target_role here),
    // and the 2nd turn must MOVE (advance the durable slot or complete) — not re-ask the same thing.
    const slotMovedOrAdvanced =
      !!t2 && (t2.onboardingSlot !== rescuedSlot || (after?.sharedOnboarding as { currentQuestionId?: unknown })?.currentQuestionId !== rescuedSlot)
    summary.s2 = {
      crashed,
      stalled: !t || (t.bubbles.length === 0 && !t.deferToLegacy && realModel),
      rescuedSlot,
      rescuedToAskedSet: rescuedToAsked,
      notReaskedStaleDropped: notStaleDropped,
      slotMovedOrAdvanced,
      bubbles: t?.bubbles ?? [],
      bubbles2: t2?.bubbles ?? [],
    }
    console.log("\n  S2 RESULT:", JSON.stringify({ crashed, rescuedSlot, rescuedToAskedSet: rescuedToAsked, notReaskedStaleDropped: notStaleDropped, slotMovedOrAdvanced }))
  }

  // ───────────────────────────── S3: EXTRACTION NOT LOST (real model) ─────────────────────────────
  section("S3 — free-text target_role answer mentioning industry + seniority → soft signals extracted")
  {
    // Drive the REAL record_onboarding_answer tool the way the production AGENT reaches it. The agent
    // FILLS the canonical enum args from the free text (LLM-picks-enum, no regex), and the tool writes
    // them durably via applyPartialUserTags. We run a real agent turn so the MODEL does the extraction.
    const { db, store } = makeDb({
      [`pa-users/${FRESH_UID}_s3`]: {
        onboardingState: "pending",
        onboardingStatus: "invited",
        sharedOnboarding: { status: "active", completed: false, currentQuestionId: "target_role", answers: {} },
      },
    })
    const uid = `${FRESH_UID}_s3`
    const freeText = "I want to move into product management at AI/ML infra startups, targeting a senior level"
    console.log(`  inbound (answering target_role): "${freeText}"`)

    if (realModel) {
      const t = await driveTurn({ db, store, userId: uid, text: freeText, realModel: true })
      console.log("  mode:", t.mode, "| onboardingSlot:", t.onboardingSlot)
      console.log("  OUTBOUND BUBBLES:")
      t.bubbles.forEach((b, i) => console.log(`    [${i}] ${b}`))
    }
    const after = store.get(`pa-users/${uid}`) as { tags?: Record<string, unknown>; sharedOnboarding?: Record<string, unknown> } | undefined
    const tags = after?.tags ?? {}
    console.log("\n  durable tags after real-model extraction:", JSON.stringify(tags, null, 2))
    console.log("  durable sharedOnboarding:", JSON.stringify(after?.sharedOnboarding))

    const hasRole = Array.isArray((tags as { targetRoleFunction?: unknown }).targetRoleFunction) && ((tags as { targetRoleFunction: unknown[] }).targetRoleFunction.length > 0)
    const hasIndustry = Array.isArray((tags as { industrySector?: unknown }).industrySector) && ((tags as { industrySector: unknown[] }).industrySector.length > 0)
    const hasSeniority = !!(tags as { careerStage?: unknown }).careerStage
    summary.s3 = {
      realModel,
      targetRoleFunction: (tags as { targetRoleFunction?: unknown }).targetRoleFunction,
      industrySector: (tags as { industrySector?: unknown }).industrySector,
      careerStage: (tags as { careerStage?: unknown }).careerStage,
      softSignalsCaptured: hasIndustry || hasSeniority,
      hardRoleCaptured: hasRole,
    }
    console.log("\n  S3 RESULT:", JSON.stringify(summary.s3))
  }

  section("DUAL-COHORT SIM SUMMARY")
  console.log(JSON.stringify(summary, null, 2))
}

main().then(() => process.exit(0)).catch((err) => { console.error("FATAL:", err); process.exit(1) })
