/**
 * READ-ONLY verification of the ask-gating fix on the live cohort.
 *
 *   short contentful ask  -> embedded ALONE  -> domain-matched people
 *   contentless ask       -> profile path    -> DIFFERENT people per asker
 *   long ask              -> unchanged
 *
 * Writes nothing: `runYcPeopleMatch` never writes (the ledger write lives in the tool), and
 * `loadAlreadySent` is stubbed empty so no real user's `ycPeopleMatchSent` is read or touched.
 *
 *   node --import tsx <this> <askerA> <askerB>
 */
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { cosineSimilarity } from "@pa/job-rec"
import { runYcPeopleMatch } from "../src/yc-people-match.js"

const require = createRequire(`${process.cwd()}/apps/functions/`)
const admin = require("firebase-admin")
const OpenAI = require("openai")

admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS!, "utf8")),
  ),
})
const db = admin.firestore()
const client = new OpenAI({ apiKey: process.env.PA_OPENAI_AGENT_API_KEY ?? process.env.OPENAI_API_KEY })

const SHORT_CONTENTFUL = ["fintech", "robotics", "devtools", "biotech", "investors", "healthcare"]
const CONTENTLESS = ["anyone", "no preference", "anyone really"]
const LONG_CONTROL = ["developer tools and CI/CD"]

async function embed(text: string): Promise<number[] | null> {
  const r = await client.embeddings.create({ model: "text-embedding-3-small", input: text.slice(0, 8000) })
  return (r.data?.[0]?.embedding as number[]) ?? null
}

async function top(userId: string, query: string | undefined): Promise<string> {
  const out = await runYcPeopleMatch(
    { userId, limit: 3, filters: query ? { query } : {} },
    { db, embed, cosine: cosineSimilarity, loadAlreadySent: async () => new Set<string>() },
  )
  const head = out.results[0]
  return `[top=${head?.score ?? "—"}] ${out.results.map((r) => `${r.name} (${r.company ?? "—"})`).join(", ") || `<none: ${out.reason ?? ""}>`}`
}

async function main() {
  const [a, b] = [process.argv[2]!, process.argv[3]!]
  for (const [label, asks] of [
    ["SHORT CONTENTFUL — must differ per ask", SHORT_CONTENTFUL],
    ["CONTENTLESS — must differ per ASKER, not per ask", CONTENTLESS],
    ["LONG CONTROL", LONG_CONTROL],
  ] as const) {
    console.log(`\n=== ${label} ===`)
    for (const ask of asks) {
      console.log(`  "${ask}"`)
      console.log(`     askerA: ${await top(a, ask)}`)
      console.log(`     askerB: ${await top(b, ask)}`)
    }
  }
}
void main().then(() => process.exit(0))
