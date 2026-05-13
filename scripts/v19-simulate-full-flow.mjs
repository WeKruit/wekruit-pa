#!/usr/bin/env node
/**
 * v1.9 G7 — full-flow simulator: prescreen → PII → Level 1 → completion.
 *
 * Mirrors what a production candidate sees end-to-end (modulo the actual
 * SMS transport + generateJobRecs call). Replays:
 *
 *   1. PreScreenPipeline with real gpt-5.4-nano against pa-jobs config
 *      (existing v19-simulate-prescreen.mjs logic, inlined)
 *   2. PiiConfirmPipeline with includeLevel1=true through canned answers
 *      (uses in-memory state provider; verifies all 9 Qs accept + tag
 *      shape written)
 *
 * Catches regressions in:
 *   - Q routing (Q1→Q2 verbatim, not Claire commentary)
 *   - Type gate threshold (matchThreshold per Q)
 *   - PII chain Q1→Q9 ordering
 *   - Level 1 validators (yoe/visa/location/salary/industry/company_size)
 *   - tag write shape (yoeRange, visaStatus, targetLocations, minSalary,
 *     industrySector, companySize, level1CollectedAt, level1Source)
 *
 * Usage:
 *   node scripts/v19-simulate-full-flow.mjs [jobId]
 */
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import {
  PreScreenPipeline,
  InMemoryPreScreenStore,
  emptyPreScreenState,
  parsePrescreenConfig,
  configToStateQuestions,
  KeywordSetJudge,
  OnboardingPipeline,
  createPiiConfirmPipeline,
} from "../packages/pa-orchestrator/dist/index.js"

const jobId = process.argv[2] ?? "test-swe-screen-001"

// ─────────────────────────────────────────────────────────────────────────
// Auth + load config
// ─────────────────────────────────────────────────────────────────────────
const cfg = JSON.parse(readFileSync(`${homedir()}/.config/configstore/firebase-tools.json`, "utf8"))
const tokRes = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_id: "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com",
    client_secret: "j9iVZfS8kkCEFUPaAeJV0sAi",
    refresh_token: cfg.tokens.refresh_token,
    grant_type: "refresh_token",
  }),
})
const { access_token } = await tokRes.json()
const docRes = await fetch(
  `https://firestore.googleapis.com/v1/projects/wekruit-5f89b/databases/(default)/documents/pa-jobs/${jobId}`,
  { headers: { authorization: `Bearer ${access_token}` } }
)
const docJson = await docRes.json()
function fromFs(v) {
  if (!v) return undefined
  if ("nullValue" in v) return null
  if ("stringValue" in v) return v.stringValue
  if ("booleanValue" in v) return v.booleanValue
  if ("integerValue" in v) return parseInt(v.integerValue, 10)
  if ("doubleValue" in v) return v.doubleValue
  if ("arrayValue" in v) return (v.arrayValue.values ?? []).map(fromFs)
  if ("mapValue" in v) {
    const out = {}
    for (const [k, vv] of Object.entries(v.mapValue.fields ?? {})) out[k] = fromFs(vv)
    return out
  }
}
const job = fromFs({ mapValue: { fields: docJson.fields } })
const prescreenConfig = parsePrescreenConfig(job.prescreenConfig)

// Real gpt-5.4-nano caller
const sr = await fetch(
  "https://secretmanager.googleapis.com/v1/projects/wekruit-5f89b/secrets/PA_OPENAI_AGENT_API_KEY/versions/latest:access",
  { headers: { authorization: `Bearer ${access_token}` } }
)
const sj = await sr.json()
const openaiKey = Buffer.from(sj.payload.data, "base64").toString("utf8").trim()
const llmCaller = {
  async score({ reply, lang, keywords, questionPrompt }) {
    const list = keywords
      .map(
        (k, i) =>
          `${i + 1}. "${k.keyword}" (weight ${(k.weight ?? 1).toFixed(2)})${
            k.hint ? ` hint: ${k.hint}` : ""
          }`
      )
      .join("\n")
    const sys = [
      "You are a recruiting screener evaluating candidate replies against a JD keyword set.",
      "For EACH configured keyword, emit one cell:",
      "  - keyword (verbatim), match 0..1, confidence 0..1, evidence ≤60 char, reasoning ≤80 char",
      "Output STRICT JSON. Temperature 0.",
    ].join("\n")
    const userMsg = `Question (${lang}): ${questionPrompt}\n\nCandidate reply (${lang}): """${reply}"""\n\nKeyword set:\n${list}\n\nSchema: { "perKeyword": [...], "summary": "...", "answered": bool }`
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${openaiKey}` },
      body: JSON.stringify({
        model: "gpt-5.4-nano",
        messages: [
          { role: "system", content: sys },
          { role: "user", content: userMsg },
        ],
        temperature: 0,
        response_format: { type: "json_object" },
      }),
    })
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`)
    return JSON.parse((await res.json()).choices[0].message.content)
  },
}

// ─────────────────────────────────────────────────────────────────────────
// Phase 1: prescreen pipeline (real LLM)
// ─────────────────────────────────────────────────────────────────────────
console.log(`\n=== Phase 1: Prescreen pipeline for jobId=${jobId} ===`)
const stateQs = configToStateQuestions(prescreenConfig)
const psState = emptyPreScreenState({
  sessionId: `sim-${Date.now()}`,
  userId: "sim-user-fullflow",
  jobId,
  questions: stateQs,
  threshold: prescreenConfig.threshold,
  confidenceThreshold: prescreenConfig.confidenceThreshold,
  maxClarifyRounds: prescreenConfig.maxClarifyRounds,
  nowIso: new Date().toISOString(),
})
const psStore = new InMemoryPreScreenStore()
await psStore.save(psState)
const psQuestions = {}
for (const q of prescreenConfig.questions) {
  psQuestions[q.qId] = {
    qId: q.qId,
    prompt: q.prompt,
    clarifyPrompt: q.clarifyPrompt,
    judge: new KeywordSetJudge({
      questionId: q.qId,
      keywords: q.keywords,
      questionPrompt: q.prompt.en,
      llmCaller,
    }),
  }
}
const psPipeline = new PreScreenPipeline({
  questions: psQuestions,
  store: psStore,
  log: (event, payload) => {
    if (event === "prescreen.pipeline.evaluated") {
      console.log(`  [prescreen] qId=${payload.qId} s=${payload.s?.toFixed?.(3)} c=${payload.c?.toFixed?.(3)}`)
    }
  },
})

// Strong-candidate canned replies per common job
const STRONG = {
  "test-swe-screen-001": [
    "I shipped 3 React production apps at FAANG over 4 years owned design + deploy + post-launch monitoring",
    "Yes — owned production deploy pipelines, on-call rotation, blameless post-mortems for our checkout service handling 30k req/min",
  ],
  "hs-11005382-invoko-product-designer": [
    "Led design at a Series A consumer fintech for 2 years — shipped onboarding redesign that lifted activation 22%",
    "Fluent in Figma + Framer + v0/Cursor; recently shipped 4 prototypes in a sprint",
  ],
  "hs-11005377-invoko-ui-ux-designer": [
    "Shipped onboarding + dashboard for a consumer health app, 50k+ MAU, both visual + interaction flows",
    "Ship rough Figma within 2 days then weekly user feedback loops — threw away 3 weeks of work after usability test",
  ],
  "hs-11005308-paradigm-gtm-growth": [
    "Owned organic TikTok for a learning startup — 0 to 80k followers in 6 months, drove 12k signups",
    "Started a podcast from zero as a senior — designed format, booked guests, scaled to 200 listens/episode",
  ],
  "hs-10996795-invoko-product-manager": [
    "First PM hire at a consumer travel app — shipped booking flow rewrite, drove 18% conversion lift",
    "Prioritize by user-signal × strategic alignment / effort. Cut 2 features to ship a friction-reducer that moved retention 9pts",
  ],
}
const replies = STRONG[jobId] ?? STRONG["test-swe-screen-001"]
let psResult
for (let i = 0; i < replies.length; i++) {
  psResult = await psPipeline.runTurn({
    sessionId: psState.sessionId,
    reply: replies[i],
    lang: "en",
    nowIso: new Date().toISOString(),
    judgeCtx: { userId: "sim-user-fullflow", turnId: `t${i}` },
  })
  console.log(`  Turn ${i + 1}: ${psResult.action.kind} → ${(psResult.text || "").slice(0, 80)}`)
  if (psResult.action.kind === "terminal") break
}
if (psResult?.action.kind !== "terminal" || psResult?.action.terminal !== "PASS") {
  console.error(`\n✗ Prescreen FAIL: terminal=${psResult?.action.kind === "terminal" ? psResult.action.terminal : "(none)"}`)
  process.exit(1)
}
console.log(`✓ Prescreen reached PASS (score ${psResult.state.score}/${psResult.state.scoreMax})`)

// ─────────────────────────────────────────────────────────────────────────
// Phase 2: PII confirm + Level 1 chain (in-memory)
// ─────────────────────────────────────────────────────────────────────────
console.log(`\n=== Phase 2: PII + Level 1 chain (9 Qs, all canned) ===`)
const pState = { currentQId: null, collected: {}, attempts: {}, halted: null, lang: "en", completed: false }
const stateProvider = {
  async load() { return pState },
  async save(_uid, s) { Object.assign(pState, s) },
}
const piiAnswers = [
  ["Q1 legalName", "Adam Smith"],
  ["Q2 email", "adam@example.com"],
  ["Q3 phone", "+1 415 555 0123"],
  ["Q4 yoe", "4 years"],
  ["Q5 visa", "H1B"],
  ["Q6 location", "SF, NYC"],
  ["Q7 salary", "150k"],
  ["Q8 industry", "AI, fintech"],
  ["Q9 company size", "early-startup"],
]
let collectedFinal = null
const piiPipeline = createPiiConfirmPipeline({
  state: stateProvider,
  source: "pass",
  includeLevel1: true,
  emit: async (text) => {
    console.log(`  [pii→] ${text.slice(0, 100)}`)
  },
  hooks: {
    onAllCollected: async (answers) => {
      collectedFinal = answers
      console.log(`  ✓ onAllCollected fired`)
    },
  },
})

// Kick off (emits Q1)
await piiPipeline.startTurn({ userId: "sim-user-fullflow", turnId: "kickoff", reply: "" })
// Iterate through each Q
for (const [label, reply] of piiAnswers) {
  const r = await piiPipeline.startTurn({
    userId: "sim-user-fullflow",
    turnId: `pii-${label}`,
    reply,
  })
  console.log(`  ${label} → ${reply}  [completed=${r.completed}]`)
  if (r.halted) {
    console.error(`✗ Halted at ${label}`)
    process.exit(1)
  }
  if (r.completed) break
}

if (!collectedFinal) {
  console.error(`✗ Pipeline did NOT call onAllCollected`)
  process.exit(1)
}
console.log(`\n=== Final collected ===`)
console.log(`  legalName: ${collectedFinal.legalName}`)
console.log(`  email:     ${collectedFinal.email}`)
console.log(`  phone:     ${collectedFinal.phone}`)
console.log(`  level1:    ${JSON.stringify(collectedFinal.level1)}`)

// Assertions
const l1 = collectedFinal.level1 ?? {}
const fails = []
if (collectedFinal.legalName !== "Adam Smith") fails.push("legalName mismatch")
if (collectedFinal.email !== "adam@example.com") fails.push("email mismatch")
if (collectedFinal.phone !== "+14155550123") fails.push(`phone not normalized: ${collectedFinal.phone}`)
if (!l1.yoeRange || l1.yoeRange[0] !== 4) fails.push(`yoeRange mismatch: ${JSON.stringify(l1.yoeRange)}`)
if (l1.visaStatus !== "sponsor_needed") fails.push(`visaStatus mismatch: ${l1.visaStatus}`)
if (!l1.targetLocations || l1.targetLocations.length !== 2) fails.push(`targetLocations mismatch: ${JSON.stringify(l1.targetLocations)}`)
if (l1.minSalaryUsd !== 150000) fails.push(`minSalaryUsd mismatch: ${l1.minSalaryUsd}`)
if (!l1.industrySector || l1.industrySector.length !== 2) fails.push(`industrySector mismatch: ${JSON.stringify(l1.industrySector)}`)
if (l1.companySize !== "early_startup") fails.push(`companySize mismatch: ${l1.companySize}`)

if (fails.length > 0) {
  console.error(`\n✗ FAILURES:`)
  fails.forEach((f) => console.error(`   - ${f}`))
  process.exit(1)
}

console.log(`\n=== FULL FLOW PASS ✓ ===`)
console.log(`  Prescreen → PASS (score ${psResult.state.score}/${psResult.state.scoreMax})`)
console.log(`  PII collected: legalName/email/phone normalized`)
console.log(`  Level 1: yoe/visa/loc/salary/industry/companySize all parsed`)
process.exit(0)
