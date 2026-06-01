#!/usr/bin/env node
/**
 * L5 simulated-user ONBOARDING eval — proves the UNIFIED agent-SDK + tools onboarding flow on the
 * PRODUCTION seam (real gpt-5.4-nano), mirroring the dev-phone path after reinitializeCandidate:
 * a fresh user (onboardingState:"pending", résumé tags, NO sharedOnboarding) texts a kickoff →
 * the thin agent runs the 7 canonical SHARED onboarding questions IN ORDER, and the AGENT calls the
 * record_onboarding_answer TOOL each answer turn — which WRITES THROUGH to the same canonical
 * interface (pa-users.tags via applyPartialUserTags + sharedOnboarding) the legacy path + triage use.
 *
 * Drives EXACTLY what the live cutover calls: selectClaireMode (read-only seeder → mode + seeded
 * processStore + onboardingSlot + pendingStep) → runClaireTurn (real LLM; the record tool persists).
 * It MEASURES reliability: after each answer turn the durable currentQuestionId MUST advance, which
 * only happens if the agent actually called the tool (no deterministic side-channel records here).
 *
 * Run: source ~/.zshrc && nvm use 24 && node apps/eval/thin-claire/eval-sim-onboarding.mjs
 */
import { loadClaireBundle, loadEnv } from "./_claire-bundle.mjs"

loadEnv()
const { runClaireTurn, createSendblueTransport, selectClaireMode } = await loadClaireBundle()

function deepMerge(base, patch) {
  const out = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    const cur = out[k]
    if (v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object" && !Array.isArray(cur)) out[k] = deepMerge(cur, v)
    else out[k] = v
  }
  return out
}
function makeFakeDb(seed = {}) {
  const store = new Map(Object.entries(seed))
  const docRef = (col, id) => {
    const key = `${col}/${id}`
    return {
      async get() { return { exists: store.has(key), id, data: () => store.get(key) } },
      async set(data, opts) { store.set(key, opts && opts.merge ? deepMerge(store.get(key) || {}, data) : { ...data }) },
      async update(data) { store.set(key, deepMerge(store.get(key) || {}, data)) },
    }
  }
  const emptyish = () => { const q = { where: () => q, orderBy: () => q, limit: () => q, async get() { return { docs: [], empty: true, size: 0, forEach() {} } } }; return q }
  const colRef = (col) => ({ doc: (id) => docRef(col, id), where: () => emptyish(), orderBy: () => emptyish(), limit: () => emptyish(), async add(d) { const id = `a${store.size}`; store.set(`${col}/${id}`, d); return { id } } })
  return { collection: colRef, _store: store }
}

const UID = "sim-onb-uid", SID = "sim-onb-session", PHONE = "+14243201960"
const SCRIPT = [
  "Hello, WeKruit! kickoffTOKEN123",                                   // kickoff → bootstrap, ask main_goal
  "honestly career growth and learning matter most to me",             // main_goal
  "early-stage startup, high ownership, small team",                   // culture_stage
  "software engineering, ideally backend / platform roles",            // target_role
  "fintech and AI infrastructure",                                     // industry_interest
  "NYC or fully remote, open to relocating for the right role",        // location_relocation
  "full-time mid/senior, 160k+ but flexible for the right team",        // seniority_comp
  "I need H1B visa sponsorship and I'm available to start in June",    // special_context
]
const EXPECT_SLOT = [null, "main_goal", "culture_stage", "target_role", "industry_interest", "location_relocation", "seniority_comp", "special_context"]
const curOf = (db) => (db._store.get(`pa-users/${UID}`)?.sharedOnboarding?.currentQuestionId) ?? null

async function main() {
  const db = makeFakeDb({
    "pa-users/sim-onb-uid": {
      onboardingState: "pending",
      tags: { targetRoleFunction: ["software_engineering"], skills: ["python", "react"], careerStage: "junior" },
    },
  })
  const transport = createSendblueTransport({ db, toE164: PHONE, userId: UID, sessionId: SID, dryRun: true, log: () => {} })
  const turns = []
  for (let i = 0; i < SCRIPT.length; i++) {
    const decision = await selectClaireMode({ db, userId: UID, inboundText: SCRIPT[i], log: () => {} })
    const curBefore = curOf(db)
    transport.recordedEvents.length = 0
    if (!decision.deferToLegacy) {
      await runClaireTurn(
        { userId: UID, sessionId: SID, text: SCRIPT[i], toE164: PHONE, lang: "en" },
        {
          db, transport, findMatch: async () => ({ ok: true, recCount: 0, jobs: [], reason: null }), log: () => {},
          mode: decision.mode,
          ...(decision.pendingStep ? { pendingStep: decision.pendingStep } : {}),
          ...(decision.processStore ? { processStore: decision.processStore } : {}),
          ...(decision.onboardingSlot ? { onboardingSlot: decision.onboardingSlot } : {}),
          ...(decision.awaitingAnswer !== undefined ? { awaitingAnswer: decision.awaitingAnswer } : {}),
        },
      )
    }
    const curAfter = curOf(db)
    const reply = transport.recordedEvents.filter((e) => e.kind === "text" || e.kind === "status").map((e) => String(e.value ?? "")).join(" ").trim()
    // tool fired on an answer turn iff the durable currentQuestionId advanced (or completed → null/complete).
    const recorded = decision.awaitingAnswer ? curAfter !== curBefore : false
    turns.push({ i, mode: decision.mode, slot: decision.onboardingSlot ?? null, awaiting: !!decision.awaitingAnswer, curBefore, curAfter, recorded, reply })
    console.log(`T${i + 1} [${decision.mode}] slot=${decision.onboardingSlot ?? "-"} await=${decision.awaitingAnswer ?? "-"} rec=${recorded} cur:${curBefore}→${curAfter} «${SCRIPT[i].slice(0, 34)}» → ${reply.slice(0, 84).replace(/\n/g, " ")}`)
  }

  const user = db._store.get(`pa-users/${UID}`) ?? {}
  const so = user.sharedOnboarding ?? {}
  const answers = so.answers ?? {}
  const tags = user.tags ?? {}
  console.log(`\nFINAL onboardingState=${user.onboardingState} completed=${so.completed} answers=[${Object.keys(answers).join(",")}]`)
  console.log(`FINAL tags: ${JSON.stringify(tags)}`)

  const fails = []
  const ck = (name, cond, detail) => { if (cond) console.log(`PASS  ${name}`); else { console.log(`FAIL  ${name} → ${detail ?? ""}`); fails.push(name) } }

  ck("turn1: kickoff → onboarding, ask-only (awaitingAnswer=false)", turns[0].mode === "onboarding" && turns[0].awaiting === false)
  for (let i = 1; i <= 7; i++) ck(`turn${i + 1}: answers slot '${EXPECT_SLOT[i]}'`, turns[i].slot === EXPECT_SLOT[i], `got ${turns[i].slot}`)
  // RELIABILITY: every answer turn must actually advance durable state = the agent called the tool.
  const answerTurns = turns.slice(1, 8)
  const recordedCount = answerTurns.filter((t) => t.recorded).length
  ck("reliability: agent called record_onboarding_answer on ALL 7 answer turns (durable advanced)", recordedCount === 7, `${recordedCount}/7 advanced`)

  ck("final: onboardingState=complete", user.onboardingState === "complete")
  ck("final: sharedOnboarding.completed=true", so.completed === true)
  ck("final: all 7 slot answers recorded (write-through accumulation)", ["main_goal", "culture_stage", "target_role", "industry_interest", "location_relocation", "seniority_comp", "special_context"].every((s) => answers[s]), `[${Object.keys(answers).join(",")}]`)
  ck("enrich: targetLocations captured (location answer → canonical tag interface)", Array.isArray(tags.targetLocations) && tags.targetLocations.length > 0, JSON.stringify(tags.targetLocations))
  ck("enrich: industrySector captured (industry answer → canonical tag interface)", Array.isArray(tags.industrySector) && tags.industrySector.length > 0, JSON.stringify(tags.industrySector))
  const allReplies = turns.slice(0, 8).map((t) => t.reply.toLowerCase()).join("\n")
  ck("voice: no markdown in onboarding questions", !/[*_`]|^\s*[-•]/m.test(allReplies), "markdown found")
  ck("coverage: Claire asked a question on turns 1-7", turns.slice(0, 7).every((t) => t.reply.length > 0))

  console.log(`\n${fails.length === 0 ? "L5 ONBOARDING SIM: GREEN ✅ — kickoff→5 questions→complete, AGENT-TOOL write-through to canonical tags, real LLM" : `L5 ONBOARDING SIM: ${fails.length} FAILED`}`)
  process.exit(fails.length === 0 ? 0 : 1)
}
await main()
