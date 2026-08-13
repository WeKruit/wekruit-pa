/**
 * DIAGNOSTIC (throwaway): is the caller's explicit `query` actually steering the semantic stage?
 *
 * `runYcPeopleMatch` embeds `synthesizePeopleMatchText({...asker profile, intent: queryText})`, so
 * the query is ONE line inside the asker's full experience prose. This prints, for the same query,
 * the top-4 under (a) that composed vector and (b) the query text alone.
 */
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { cosineSimilarity } from "@pa/job-rec"
import { loadCohortPool, synthesizePeopleMatchText, YC_COHORT_2026 } from "../src/yc-people-match.js"

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
const embed = async (t: string) => {
  const r = await client.embeddings.create({ model: "text-embedding-3-small", input: t })
  return r.data[0].embedding as number[]
}

const USER = process.env.PROBE_USER ?? "3d1TYXwutJuPZ8wlZEwE"
const QUERIES = [
  "investors, VCs, angel investors",
  "founders building in edtech",
  "people building robotics",
  "students, undergrads still in school",
]

async function main() {
  const u = (await db.collection("pa-users").doc(USER).get()).data() ?? {}
  const highlights = (Array.isArray(u.experienceHighlights) ? u.experienceHighlights : []) as any[]
  const pool = (await loadCohortPool(db, YC_COHORT_2026)).filter((m) => m.embedding?.length)
  console.log(`pool=${pool.length} askerHighlights=${highlights.length}`)

  const top = async (text: string) => {
    const q = await embed(text)
    return pool
      .map((m) => {
        let s = cosineSimilarity(q, m.embedding!)
        if (m.descriptorEmbedding?.length) s = Math.max(s, cosineSimilarity(q, m.descriptorEmbedding))
        return { m, s }
      })
      .sort((a, b) => b.s - a.s)
      .slice(0, 4)
  }

  for (const query of QUERIES) {
    const askerText = synthesizePeopleMatchText({
      currentTitle: typeof u.recentRoleTitle === "string" ? u.recentRoleTitle : null,
      currentCompany: typeof u.recentCompany === "string" ? u.recentCompany : null,
      experience: highlights.map((h) => ({ title: h.title, company: h.company, description: h.description })),
      intent: query,
    })
    console.log(`\n### "${query}"   (composed vector is ${askerText.length} chars, query is ${query.length})`)
    console.log("  A) CURRENT — asker profile + query:")
    for (const { m, s } of await top(askerText)) console.log(`     ${s.toFixed(3)} ${m.name} — ${m.currentTitle} @ ${m.currentCompany}`)
    console.log("  B) QUERY TEXT ALONE:")
    for (const { m, s } of await top(query)) console.log(`     ${s.toFixed(3)} ${m.name} — ${m.currentTitle} @ ${m.currentCompany}`)
  }
}
void main().then(() => process.exit(0))
