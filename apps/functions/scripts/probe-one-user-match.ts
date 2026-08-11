/** READ-ONLY: run the matcher for ONE real user with explicit filters. Sends nothing. */
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { cosineSimilarity } from "@pa/job-rec"
import { runYcPeopleMatch, type YcPeopleMatchFilters } from "../src/yc-people-match.js"
const require = createRequire(`${process.cwd()}/apps/functions/`)
const admin = require("firebase-admin")
const OpenAI = require("openai")
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS!, "utf8"))) })
const db = admin.firestore()
const client = new OpenAI({ apiKey: process.env.PA_OPENAI_AGENT_API_KEY })
const embed = async (t: string) => (await client.embeddings.create({ model: "text-embedding-3-small", input: t.slice(0,8000) })).data?.[0]?.embedding ?? null
async function main() {
  const phone = process.argv[2]!
  const r = await db.collection("pa-users").where("phoneE164","==",phone).get()
  const uid = r.docs[0]!.id
  const variants: Array<[string, YcPeopleMatchFilters]> = [
    ["现状(只有自由文本)", { query: "cofounders who've built in insurance/ai, policy and trust folks" }],
    ["+ personType=founder", { query: "cofounders who've built in insurance/ai, policy and trust folks", personType: ["founder"] }],
    ["+ founder|executive|investor", { query: "cofounders who've built in insurance/ai, policy and trust folks", personType: ["founder","executive","investor"] }],
  ]
  for (const [label, filters] of variants) {
    const out = await runYcPeopleMatch({ userId: uid, limit: 5, filters },
      { db, embed, cosine: cosineSimilarity, loadAlreadySent: async () => new Set<string>() })
    console.log(`\n=== ${label}  (facetMatched=${out.facetMatched} relaxed=${out.didRelax}) ===`)
    out.results.forEach(x => console.log(`  ${x.score.toFixed(3)}  ${x.name} — ${x.title} @ ${x.company}`))
  }
}
void main().then(()=>process.exit(0))
