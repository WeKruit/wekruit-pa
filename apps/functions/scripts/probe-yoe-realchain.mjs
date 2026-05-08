/**
 * Real-LLM smoke test for the q_yoe → GuidedOpenJudge chain.
 *
 * Calls the actual gpt-5.4-nano endpoint with the same prompt the orchestrator
 * uses, with the same payload of representative replies. Catches model
 * behavior regressions (e.g. malformed JSON, finish=length) before they
 * reach prod users.
 *
 * Run:  node apps/functions/scripts/probe-yoe-realchain.mjs
 * Env:  PA_OPENAI_AGENT_API_KEY (sk-...) — read from .env if present.
 */
import fs from "node:fs"

const envPath = ".env"
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (!m) continue
    if (!process.env[m[1]]) process.env[m[1]] = m[2]
  }
}

const KEY = process.env.PA_OPENAI_AGENT_API_KEY
if (!KEY || !KEY.startsWith("sk-")) {
  console.error("PA_OPENAI_AGENT_API_KEY missing or invalid")
  process.exit(1)
}

const SYSTEM = `You extract structured intent from a user's reply during onboarding.

Question topic: years of experience.

Canonical answer space (free-form OK, but normalize to these tokens when possible): "0", "1", "2", "3", "4", "5", "6", "7", "8", "10", "fresh".

Output JSON ONLY (no prose, no markdown). Three possible intents:
  • {"intent":"provided","value":<canonical token, array of tokens, or free-form>,"confidence":0.0-1.0}
  • {"intent":"unclear","clarifyingQuestion":"<friendly short follow-up>"}
  • {"intent":"declined"}

Rules:
- Confidence reflects how sure you are. Below 0.6 → "unclear" with clarifying question.
- Clarifying question must be SHORT (≤1 sentence), friend-tone, no marketing-speak.
- If the question warrants a clarifying question, ask in English.
- DO NOT invent specifics the user didn't say.
- Multi-value answers (e.g. "sf or nyc") → return value as array when natural.

Examples:
  "2years" → {"intent":"provided","value":2,"confidence":1}
  "5y" → {"intent":"provided","value":5,"confidence":0.95}
  "三年" → {"intent":"provided","value":3,"confidence":0.95}
  "fresh grad" → {"intent":"provided","value":"fresh","confidence":1}`

const REPLIES = [
  { reply: "2years", expectAccept: true, expectValueLike: 2 },
  { reply: "1-2years", expectAccept: true, expectValueLike: [1, 2] },
  { reply: "三年", expectAccept: true, expectValueLike: 3 },
  { reply: "5y", expectAccept: true, expectValueLike: 5 },
  { reply: "fresh grad", expectAccept: true, expectValueLike: "fresh" },
  { reply: "1.5 years", expectAccept: true, expectValueLike: 1 },
  { reply: "2", expectAccept: true, expectValueLike: 2 },
  { reply: "a few years", expectAccept: false /* unclear */ },
]

async function callModel(model, reply) {
  const t0 = Date.now()
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `User reply: "${reply}"\n\nOutput JSON:` },
      ],
      temperature: 0.1,
      max_completion_tokens: 200,
      response_format: { type: "json_object" },
    }),
  })
  const dt = Date.now() - t0
  if (!res.ok) return { ok: false, status: res.status, dt }
  const data = await res.json()
  const choice = data.choices?.[0]
  const raw = choice?.message?.content?.trim() ?? ""
  const finishReason = choice?.finish_reason
  let parsed = null
  let parseErr = null
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    parseErr = e.message
  }
  return { ok: true, raw, parsed, parseErr, finishReason, dt, usage: data.usage }
}

const MODELS = ["gpt-5.4-nano", "gpt-4.1-mini"]
let pass = 0
let fail = 0
for (const tc of REPLIES) {
  console.log(`\n========== reply="${tc.reply}" ==========`)
  for (const model of MODELS) {
    const r = await callModel(model, tc.reply)
    const tag = `-- ${model.padEnd(15)} ${r.dt}ms`
    if (!r.ok) {
      console.log(`${tag}  HTTP ${r.status}`)
      fail++
      continue
    }
    if (r.parseErr) {
      console.log(`${tag}  ❌ parse: ${r.parseErr}  raw=${r.raw.slice(0, 80)}`)
      fail++
      continue
    }
    if (r.finishReason !== "stop") {
      console.log(`${tag}  ❌ finish=${r.finishReason}`)
      fail++
      continue
    }
    console.log(
      `${tag}  finish=${r.finishReason}  ${JSON.stringify(r.parsed)}  tokens=${r.usage?.completion_tokens ?? "?"}`
    )
    pass++
  }
}
console.log(`\n>>> SUMMARY  pass=${pass} fail=${fail}`)
process.exit(fail > 0 ? 1 : 0)
