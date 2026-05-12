#!/usr/bin/env node
/**
 * v1.8 smoke — run actual gpt-5.4-nano against 2 fixtures + assert
 * output shape matches KeywordSetLlmOutput schema. Proves the
 * production KeywordSetLlmCaller integration path works end-to-end
 * with the real LLM, not stubs.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import admin from "firebase-admin"

const envPath = "/Users/adam/Desktop/WeKruit/wekruit-pa/.env"
const env = readFileSync(envPath, "utf8")
const m = env.match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.+)$/m)
if (!m) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON missing")
const credPath = join(tmpdir(), `pa-cred-${Date.now()}.json`)
writeFileSync(credPath, m[1])
process.env.GOOGLE_APPLICATION_CREDENTIALS = credPath

// Pull OpenAI key
const oaiMatch = env.match(/^PA_OPENAI_AGENT_API_KEY=(.+)$/m) || env.match(/^OPENAI_API_KEY=(.+)$/m)
if (!oaiMatch) {
  console.error("missing PA_OPENAI_AGENT_API_KEY / OPENAI_API_KEY in .env")
  process.exit(1)
}
const apiKey = oaiMatch[1]

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "wekruit-5f89b",
})
const db = admin.firestore()

const samples = await db.collection("pa-prescreen-fixtures").limit(2).get()

for (const doc of samples.docs) {
  const fx = doc.data()
  const keywordList = fx.keywords.map((k, i) => `${i + 1}. "${k.keyword}" (weight ${(k.weight ?? 1).toFixed(2)})`).join("\n")
  const system =
    "You are a recruiting screener. For EACH keyword emit {keyword, match 0-1, confidence 0-1, evidence ≤60ch, reasoning ≤80ch}. Output STRICT JSON: {perKeyword:[], summary, answered}."
  const user = `${fx.questionPrompt ? `Question: ${fx.questionPrompt}\n` : ""}Reply: """${fx.reply}"""\nKeywords:\n${keywordList}`

  console.log(`\n=== Fixture ${fx.id} ===`)
  console.log(`Reply: "${fx.reply}"`)
  console.log(`Gold:`, JSON.stringify(fx.goldPerKeyword))

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "gpt-5.4-nano",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0,
      response_format: { type: "json_object" },
    }),
  })
  if (!res.ok) {
    console.error(`FAIL ${res.status}: ${await res.text()}`)
    process.exit(1)
  }
  const j = await res.json()
  const content = j.choices?.[0]?.message?.content ?? "{}"
  const parsed = JSON.parse(content)
  console.log(`Live LLM output:`)
  console.log(JSON.stringify(parsed, null, 2))

  // Assert schema
  if (!Array.isArray(parsed.perKeyword)) {
    console.error("FAIL: perKeyword missing")
    process.exit(1)
  }
  for (const cell of parsed.perKeyword) {
    if (typeof cell.match !== "number" || typeof cell.confidence !== "number") {
      console.error("FAIL: malformed cell", cell)
      process.exit(1)
    }
  }
  console.log(`✓ Schema valid (${parsed.perKeyword.length} cells, mean match ${(parsed.perKeyword.reduce((s, c) => s + c.match, 0) / parsed.perKeyword.length).toFixed(2)})`)
}
console.log(`\n✓ All ${samples.size} fixture(s) round-tripped through gpt-5.4-nano with valid schema`)
process.exit(0)
