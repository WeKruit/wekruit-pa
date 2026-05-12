#!/usr/bin/env node
/**
 * v1.9 — real-LLM end-to-end prescreen simulator.
 *
 * Mirrors what the deployed CF does:
 *   1. Loads pa-jobs/{jobId}.prescreenConfig from production Firestore
 *   2. Builds PreScreenPipeline w/ real gpt-5.4-nano caller (same as
 *      production)
 *   3. Replays a canned reply sequence
 *   4. Prints per-turn pipeline action + final state
 *
 * Catches "config + LLM combo silently HARD_STOP'd" bugs BEFORE we ask a
 * human tester to send real SMS.
 *
 * Usage:
 *   node scripts/v19-simulate-prescreen.mjs <jobId> <reply1>|<reply2>|...
 *
 * Default args run the canonical PASS path against test-swe-screen-001.
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
} from "../packages/pa-orchestrator/dist/index.js"

// ─────────────────────────────────────────────────────────────────────────
const jobId = process.argv[2] ?? "test-swe-screen-001"
const replies = (
  process.argv[3] ??
  [
    "I shipped 3 React production apps at FAANG over 4 years owned design + deploy + post-launch monitoring",
    "Yes — owned production deploy pipelines, on-call rotation, blameless post-mortems for our checkout service handling 30k req/min",
  ].join("|")
).split("|").map((s) => s.trim())

// ─────────────────────────────────────────────────────────────────────────
// Auth + load config
// ─────────────────────────────────────────────────────────────────────────
const cfg = JSON.parse(
  readFileSync(`${homedir()}/.config/configstore/firebase-tools.json`, "utf8")
)
const tokRes = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_id:
      "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com",
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
if (!docJson.fields) {
  console.error("no job doc:", JSON.stringify(docJson))
  process.exit(2)
}

// Firestore → plain JSON
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
  return undefined
}
const job = fromFs({ mapValue: { fields: docJson.fields } })
const prescreenConfig = parsePrescreenConfig(job.prescreenConfig)
console.log(
  `\n=== job ${jobId} — ${prescreenConfig.questions.length} Qs, T=${prescreenConfig.threshold} ===`
)
prescreenConfig.questions.forEach((q) => {
  console.log(
    `  ${q.qId} type=${q.type} weight=${q.weight} keywords=[${q.keywords
      .map((k) => k.keyword)
      .join(", ")}]`
  )
})

// ─────────────────────────────────────────────────────────────────────────
// Real gpt-5.4-nano caller (mirrors apps/functions/src/prescreen-turn-handler.ts)
// ─────────────────────────────────────────────────────────────────────────
async function getOpenAiKey() {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id:
        "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com",
      client_secret: "j9iVZfS8kkCEFUPaAeJV0sAi",
      refresh_token: cfg.tokens.refresh_token,
      grant_type: "refresh_token",
    }),
  })
  const { access_token: tok } = await r.json()
  // Hit Secret Manager directly
  const sr = await fetch(
    "https://secretmanager.googleapis.com/v1/projects/wekruit-5f89b/secrets/PA_OPENAI_AGENT_API_KEY/versions/latest:access",
    { headers: { authorization: `Bearer ${tok}` } }
  )
  const sj = await sr.json()
  return Buffer.from(sj.payload.data, "base64").toString("utf8").trim()
}
const openaiKey = await getOpenAiKey()

const llmCaller = {
  async score({ reply, lang, keywords, questionPrompt }) {
    const keywordList = keywords
      .map(
        (k, i) =>
          `${i + 1}. "${k.keyword}" (weight ${(k.weight ?? 1).toFixed(2)})${
            k.hint ? ` hint: ${k.hint}` : ""
          }`
      )
      .join("\n")
    const system = [
      "You are a recruiting screener evaluating candidate replies against a JD keyword set.",
      "For EACH configured keyword, emit one cell:",
      "  - keyword (verbatim)",
      "  - match 0..1 (how well the reply demonstrates this keyword)",
      "  - confidence 0..1 (how sure you are)",
      "  - evidence ≤60 char excerpt from reply",
      "  - reasoning ≤80 char explanation",
      "Also emit: summary ≤120 char, answered bool, abortHint?{kind:low_confidence|off_topic|decline|ambiguous, reason}",
      "Output STRICT JSON. No prose. Do NOT invent keywords. Temperature 0.",
    ].join("\n")
    const userMsg = [
      questionPrompt ? `Question (${lang}): ${questionPrompt}` : "",
      `Candidate reply (${lang}): """${reply}"""`,
      `Keyword set:\n${keywordList}`,
      'Schema: { "perKeyword": [...], "summary": "...", "answered": bool, "abortHint"?: {...} }',
    ]
      .filter(Boolean)
      .join("\n\n")
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-5.4-nano",
        messages: [
          { role: "system", content: system },
          { role: "user", content: userMsg },
        ],
        temperature: 0,
        response_format: { type: "json_object" },
      }),
    })
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`)
    const json = await res.json()
    return JSON.parse(json.choices[0].message.content)
  },
}

// ─────────────────────────────────────────────────────────────────────────
// Build pipeline + run
// ─────────────────────────────────────────────────────────────────────────
const stateQs = configToStateQuestions(prescreenConfig)
const state = emptyPreScreenState({
  sessionId: "sim-" + Date.now(),
  userId: "sim-user",
  jobId,
  questions: stateQs,
  threshold: prescreenConfig.threshold,
  confidenceThreshold: prescreenConfig.confidenceThreshold,
  maxClarifyRounds: prescreenConfig.maxClarifyRounds,
  nowIso: new Date().toISOString(),
})
const store = new InMemoryPreScreenStore()
await store.save(state)

const questionMap = {}
for (const q of prescreenConfig.questions) {
  questionMap[q.qId] = {
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

const pipeline = new PreScreenPipeline({
  questions: questionMap,
  store,
  log: (event, payload) => {
    if (event === "prescreen.pipeline.evaluated") {
      console.log(
        `   [eval] qId=${payload.qId} s=${(payload.s ?? 0).toFixed(3)} c=${(
          payload.c ?? 0
        ).toFixed(3)}`
      )
    }
  },
})

console.log(`\n--- first prompt ---`)
console.log(`   ${prescreenConfig.questions[0].prompt.en}`)

for (let i = 0; i < replies.length; i++) {
  const reply = replies[i]
  console.log(`\n--- turn ${i + 1} reply: "${reply.slice(0, 80)}…" ---`)
  const result = await pipeline.runTurn({
    sessionId: state.sessionId,
    reply,
    lang: "en",
    nowIso: new Date().toISOString(),
    judgeCtx: { userId: "sim-user", turnId: "t" + i },
  })
  console.log(`   action: ${result.action.kind}`, JSON.stringify(result.action))
  console.log(`   emit:   ${result.text.slice(0, 200)}`)
  if (result.action.kind === "terminal") {
    console.log(
      `\n=== TERMINAL ${result.action.terminal}  score=${result.state.score}/${result.state.scoreMax}`
    )
    console.log(`    reason: ${result.action.reason}`)
    process.exit(result.action.terminal === "PASS" ? 0 : 1)
  }
}

const final = await store.load(state.sessionId)
console.log(
  `\n=== END (no terminal)  score=${final.score}/${final.scoreMax}  currentQId=${final.currentQId}`
)
process.exit(final.terminal === "PASS" ? 0 : 1)
