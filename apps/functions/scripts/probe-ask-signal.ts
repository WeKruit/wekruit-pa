/**
 * READ-ONLY: what does each ask SCORE against the live pool? Decides whether the semantic gate
 * (`MIN_ASK_SIGNAL`) already covers the cases the string tests were covering, or whether it doesn't.
 *
 *   node --import tsx apps/functions/scripts/probe-ask-signal.ts
 */
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { cosineSimilarity } from "@pa/job-rec"
import { loadCohortPool, YC_COHORT_2026 } from "../src/yc-people-match.js"

const require = createRequire(`${process.cwd()}/apps/functions/`)
const admin = require("firebase-admin")
const OpenAI = require("openai")

admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS!, "utf8")),
  ),
})
const client = new OpenAI({ apiKey: process.env.PA_OPENAI_AGENT_API_KEY ?? process.env.OPENAI_API_KEY })

const GROUPS: Array<[string, string[]]> = [
  ["REAL ask — must clear the gate", [
    "fintech", "robotics", "devtools", "biotech", "investors", "healthcare", "ML", "SWE", "YC",
    "AI agents", "developer tools and CI/CD", "climate", "design",
  ]],
  ["CONTENTLESS — must fail the gate", [
    "anyone", "anyone really", "no preference", "all of the above", "idk", "whoever honestly",
    "not picky", "open to anything", "doesn't matter",
  ]],
  ["SELF-REFERENTIAL — the regex case; does the gate catch it?", [
    "people building something like mine", "someone similar to me", "founders like me",
    "anyone doing what i'm doing", "people with a similar background",
  ]],
  ["SHORT INTAKE ANSWERS — the length-floor case; does the gate catch it?", [
    "founders", "engineers", "students", "hi", "ok", "?", "yes",
  ]],
]

async function main() {
  const pool = (await loadCohortPool(admin.firestore(), YC_COHORT_2026)).filter(
    (m) => m.embedding && m.embedding.length > 0,
  )
  console.log(`pool=${pool.length}  gate=0.40\n`)
  for (const [label, asks] of GROUPS) {
    console.log(`=== ${label} ===`)
    const res = await client.embeddings.create({ model: "text-embedding-3-small", input: asks })
    asks.forEach((ask, i) => {
      const q = res.data[i].embedding as number[]
      const scores: number[] = []
      let best = -1
      let who = ""
      for (const m of pool) {
        let s = cosineSimilarity(q, m.embedding!)
        if (m.descriptorEmbedding?.length) s = Math.max(s, cosineSimilarity(q, m.descriptorEmbedding))
        scores.push(s)
        if (s > best) { best = s; who = `${m.name} (${m.currentCompany ?? "—"})` }
      }
      // DISCRIMINATION, not magnitude. A one-word ask ("design") scores low against everyone simply
      // because pool text is long prose — but it still pulls designers clear of the pack. A
      // contentless ask sits equidistant from all 988. The z-score of the best hit measures exactly
      // that and is scale-free, so it does not punish short asks.
      const mean = scores.reduce((a, b) => a + b, 0) / scores.length
      const sd = Math.sqrt(scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length)
      const z = sd > 0 ? (best - mean) / sd : 0
      console.log(`  cos=${best.toFixed(3)}  z=${z.toFixed(2)}  "${ask}"  → ${who}`)
    })
    console.log("")
  }
}
void main().then(() => process.exit(0))
