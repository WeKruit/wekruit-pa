/**
 * Reproduce SiliconFlow Qwen2.5-7B behavior on the q_yoe prompt for
 * "2years", "1-2years", "三年", "5y", "fresh grad" — to confirm
 * whether the truncated JSON ('{"intent":"declined" , "confidence":"-1 "')
 * is reproducible, and whether max_tokens / response_format / model size
 * is the cause.
 */
import fs from "node:fs"

// Load .env so we get SILICONFLOW_API_KEY + PA_OPENAI_AGENT_API_KEY.
const envPath = ".env"
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (!m) continue
    if (!process.env[m[1]]) process.env[m[1]] = m[2]
  }
}

const SF_KEY = process.env.SILICONFLOW_API_KEY
const OA_KEY = process.env.PA_OPENAI_AGENT_API_KEY

if (!SF_KEY) {
  console.error("SILICONFLOW_API_KEY missing")
  process.exit(1)
}

const systemPrompt = `You extract structured intent from a user's reply during onboarding.

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
  "2 years" → {"intent":"provided","value":2,"confidence":1}
  "5y" → {"intent":"provided","value":5,"confidence":0.95}
  "三年" → {"intent":"provided","value":3,"confidence":0.95}
  "3-5 years" → {"intent":"provided","value":4,"confidence":0.9}
  "fresh grad" → {"intent":"provided","value":"fresh","confidence":1}
  "刚毕业" → {"intent":"provided","value":"fresh","confidence":1}`

const REPLIES = ["2years", "1-2years", "三年", "5y", "fresh grad", "1.5 years", "2"]

async function callProvider({ baseURL, model, apiKey, maxTokens, useJsonMode }) {
  const body = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: `User reply: "${reply}"\n\nOutput JSON:` },
    ],
    temperature: 0.1,
    max_tokens: maxTokens,
  }
  if (useJsonMode) body.response_format = { type: "json_object" }
  const t0 = Date.now()
  const res = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  })
  const dt = Date.now() - t0
  if (!res.ok) {
    const txt = await res.text()
    return { ok: false, status: res.status, raw: txt, dt }
  }
  const data = await res.json()
  const finishReason = data.choices?.[0]?.finish_reason
  const raw = data.choices?.[0]?.message?.content?.trim() ?? ""
  let parsed = null
  let parseErr = null
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    parseErr = e.message
  }
  return { ok: true, raw, finishReason, parsed, parseErr, dt, usage: data.usage }
}

let reply
const cases = [
  { label: "SF Qwen2.5-7B  json_mode  maxTok=200", baseURL: "https://api.siliconflow.cn/v1", model: "Qwen/Qwen2.5-7B-Instruct", apiKey: SF_KEY, maxTokens: 200, useJsonMode: true },
  { label: "SF Qwen2.5-7B  no-json     maxTok=200", baseURL: "https://api.siliconflow.cn/v1", model: "Qwen/Qwen2.5-7B-Instruct", apiKey: SF_KEY, maxTokens: 200, useJsonMode: false },
  { label: "SF Qwen2.5-7B  json_mode  maxTok=500", baseURL: "https://api.siliconflow.cn/v1", model: "Qwen/Qwen2.5-7B-Instruct", apiKey: SF_KEY, maxTokens: 500, useJsonMode: true },
]
if (OA_KEY && OA_KEY.startsWith("sk-")) {
  cases.push({
    label: "OpenAI gpt-4.1-mini  json_mode  maxTok=200",
    baseURL: "https://api.openai.com/v1",
    model: "gpt-4.1-mini",
    apiKey: OA_KEY,
    maxTokens: 200,
    useJsonMode: true,
  })
}

for (const r of REPLIES) {
  reply = r
  console.log(`\n========== reply="${reply}" ==========`)
  for (const c of cases) {
    const result = await callProvider(c)
    console.log(`-- ${c.label}  ${result.dt}ms  finish=${result.finishReason ?? "?"}`)
    if (!result.ok) {
      console.log(`   HTTP ${result.status}: ${result.raw.slice(0, 200)}`)
      continue
    }
    console.log(`   raw: ${result.raw}`)
    if (result.usage) console.log(`   usage: ${JSON.stringify(result.usage)}`)
    if (result.parseErr) console.log(`   ❌ parse: ${result.parseErr}`)
    else console.log(`   ✓ parsed: ${JSON.stringify(result.parsed)}`)
  }
}
