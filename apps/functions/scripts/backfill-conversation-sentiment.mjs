/**
 * Backfill — seed pa-conversation-sentiment from the existing 7-day sentiment
 * scan transcripts so the /admin/conversation-feedback dashboard has data
 * immediately, without waiting for the daily paConversationSentimentScan CF.
 *
 * Loads .ops/sentiment-scan-transcripts.json (array of {userId, phone,
 * messages:[{role,body,createdAt}]}), classifies each conversation with the SAME
 * classifier the CF uses (gpt-5.4-mini-first 3-tier router, strict JSON), and
 * upserts one doc per candidate (doc id = userId). Idempotent — re-running
 * overwrites the per-candidate doc.
 *
 * Env: FIREBASE_SERVICE_ACCOUNT_JSON + PA_OPENAI_AGENT_API_KEY (and optionally
 * ANTHROPIC_API_KEY for the middle tier). Run from apps/functions.
 *
 * Flags:
 *   --input=PATH       transcripts JSON (default ../../.ops/sentiment-scan-transcripts.json)
 *   --limit=N          classify at most N conversations (default: all)
 *   --concurrency=N    parallel LLM workers (default 6)
 *   --dry              classify + print, do NOT write
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { initializeApp, cert } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"

const __dirname = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const DRY = argv.includes("--dry")
const LIMIT = Number((argv.find((a) => a.startsWith("--limit=")) || "").split("=")[1]) || Infinity
const CONCURRENCY = Number((argv.find((a) => a.startsWith("--concurrency=")) || "").split("=")[1]) || 6
const INPUT =
  (argv.find((a) => a.startsWith("--input=")) || "").split("=")[1] ||
  resolve(__dirname, "../../../.ops/sentiment-scan-transcripts.json")

const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
initializeApp({ credential: cert(sa) })
const db = getFirestore()

const { callWithFallback } = await import("@pa/pa-resume-parser")
const {
  CONVERSATION_SENTIMENT_JSON_SCHEMA,
  CONVERSATION_SENTIMENT_SYSTEM_PROMPT,
  renderConversationForClassifier,
} = await import("@pa/core-types")
const { coerceClassification, classifyConversation, writeSentimentDocs } = await import(
  "../src/conversation-sentiment-scan.ts"
)

const OPENAI_KEY = (process.env.PA_OPENAI_AGENT_API_KEY ?? "").trim()
if (!OPENAI_KEY) {
  console.error("PA_OPENAI_AGENT_API_KEY is required to classify conversations.")
  process.exit(1)
}
const ANTHROPIC_KEY = (process.env.ANTHROPIC_API_KEY ?? "").trim() || undefined

const CHAIN = [
  { tier: "primary", provider: "openai", model: "gpt-5.4-mini", maxRetries: 2 },
  { tier: "secondary", provider: "anthropic", model: "claude-sonnet-4-6", maxRetries: 1 },
  { tier: "tertiary", provider: "openai", model: "gpt-4.1-mini", maxRetries: 1 },
]

const llm = async (args) => {
  const out = await callWithFallback({
    apiKey: OPENAI_KEY,
    baseURL: "https://api.openai.com/v1",
    anthropicApiKey: ANTHROPIC_KEY,
    chain: CHAIN,
    systemPrompt: args.systemPrompt,
    userText: args.userText,
    schemaName: args.schemaName,
    schema: args.schema,
  })
  return { rawJson: out.rawJson, usedModel: out.usedModel ?? "unknown" }
}

const raw = JSON.parse(readFileSync(INPUT, "utf8"))
const conversations = (Array.isArray(raw) ? raw : [])
  .map((c) => ({
    userId: String(c.userId ?? "").trim(),
    phone: typeof c.phone === "string" ? c.phone : undefined,
    messages: (Array.isArray(c.messages) ? c.messages : [])
      .map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        body: String(m.body ?? "").trim(),
        createdAt: typeof m.createdAt === "string" ? m.createdAt : undefined,
      }))
      .filter((m) => m.body),
    lastMessageAt: undefined,
  }))
  .filter((c) => c.userId && c.messages.length >= 2)
  .map((c) => ({
    ...c,
    lastMessageAt: c.messages[c.messages.length - 1]?.createdAt,
  }))
  .slice(0, LIMIT)

console.log(`Loaded ${conversations.length} conversations from ${INPUT}`)

const now = new Date().toISOString()
const docs = []
let done = 0
let failed = 0

async function worker(queue) {
  for (;;) {
    const convo = queue.pop()
    if (!convo) return
    const doc = await classifyConversation(convo, llm, now)
    done += 1
    if (!doc) {
      failed += 1
    } else {
      docs.push(doc)
      if (DRY) {
        console.log(
          `${doc.userId}  ${doc.sentiment.padEnd(13)} ${doc.category.padEnd(28)} ${
            doc.unhappy ? "UNHAPPY" : "ok"
          }  ${doc.evidenceQuote.slice(0, 60)}`,
        )
      }
    }
    if (done % 20 === 0) console.log(`...${done}/${conversations.length}`)
  }
}

const queue = [...conversations].reverse()
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () => worker(queue)))

const unhappy = docs.filter((d) => d.unhappy).length
console.log(`Classified ${docs.length} (failed ${failed}); ${unhappy} unhappy.`)

if (DRY) {
  console.log("--dry — no writes.")
  process.exit(0)
}

const written = await writeSentimentDocs(db, docs)
console.log(`Wrote ${written} docs to pa-conversation-sentiment.`)
// Silence unused-import lint noise; these are imported for parity with the CF.
void CONVERSATION_SENTIMENT_JSON_SCHEMA
void CONVERSATION_SENTIMENT_SYSTEM_PROMPT
void renderConversationForClassifier
void coerceClassification
process.exit(0)
