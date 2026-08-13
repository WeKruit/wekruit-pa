/**
 * READ-ONLY verification: does an "investors" ask now return people whose PRIMARY personType is
 * investor? Runs the SHIPPED runYcPeopleMatch against the live cohort pool. Writes nothing.
 *
 *   node --import tsx apps/functions/scripts/zz-verify-investor.ts
 */
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { cosineSimilarity } from "@pa/job-rec"
import { runYcPeopleMatch, type YcPeopleMatchFilters } from "../src/yc-people-match.js"

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
const embed = async (text: string) => {
  const r = await client.embeddings.create({ model: "text-embedding-3-small", input: text })
  return r.data[0].embedding as number[]
}

const PHONE = process.env.PROBE_PHONE ?? "+19257918082"
const us = await db.collection("pa-users").where("phoneE164", "==", PHONE).get()
if (us.empty) {
  console.log(`no pa-users doc for ${PHONE}`)
  process.exit(1)
}
const userId = us.docs[0]!.id
console.log(`asker ${PHONE} uid=${userId} intake=${JSON.stringify(us.docs[0]!.data().ycIntake ?? {}).slice(0, 200)}\n`)

// personType for each returned record, read straight from the pool row.
const typeOf = async (recordId: string) => {
  const d = await db.collection("pa-external-candidate-records").doc(recordId).get()
  const pt = (d.data()?.businessDescriptor?.personType ?? []) as string[]
  return pt
}

const cases: Array<{ label: string; filters: YcPeopleMatchFilters }> = [
  { label: "personType facet ['investor'] (the shape the agent emits for an investor ask)", filters: { personType: ["investor"], query: "investors" } },
  { label: "personType facet ['investor'] + richer query", filters: { personType: ["investor"], query: "investors, VCs, angel investors" } },
  { label: "no facet, semantic only: 'investors, VCs, angel investors'", filters: { query: "investors, VCs, angel investors" } },
]

for (const c of cases) {
  const out = await runYcPeopleMatch(
    { userId, limit: 5, filters: c.filters },
    { db, embed, cosine: cosineSimilarity },
  )
  console.log(`\n=== ${c.label}`)
  console.log(`    pool=${out.poolSize} facetMatched=${out.facetMatched}${out.didRelax ? " RELAXED" : ""}${out.reason ? ` reason=${out.reason}` : ""}`)
  let primary = 0
  for (const r of out.results) {
    const pt = await typeOf(r.recordId)
    const isPrimary = pt[0] === "investor"
    if (isPrimary) primary++
    console.log(`   ${r.score.toFixed(3)} ${isPrimary ? "PRIMARY-INVESTOR " : "                 "} ${r.name ?? "?"} — ${r.title ?? "?"} @ ${r.company ?? "?"}   personType=[${pt.join(",")}]`)
  }
  console.log(`    => ${primary}/${out.results.length} have PRIMARY personType = investor`)
}
process.exit(0)
