/**
 * Does folding `industrySector` / `roleFunction` into the semantic query LOSE anybody?
 *
 * WHY THIS EXISTS: those two were never real facets. Coresignal stores no canonical industry or
 * roleFunction per attendee, so the "facet" compared a canonical enum value against free prose by
 * substring — a membership gate built on string containment. Deleting it is right, but "right" is
 * not a measurement: the ask still has to return the right people through the semantic path.
 *
 * WHAT IS COMPARED, at the production limit of 5:
 *   BEFORE  substring-probe the pool, then rank semantically INSIDE the survivors, take 5.
 *   AFTER   no membership gate at all, rank semantically over the WHOLE pool, take 5.
 * Both lists are printed with names and roles so the answer is judged, not asserted — a score can
 * improve while the same wrong people come back (the lesson from probe-yc-people-queries.ts).
 *
 * READ-ONLY. Run:
 *   export GOOGLE_APPLICATION_CREDENTIALS=... ; export PA_OPENAI_AGENT_API_KEY=...
 *   node --import tsx apps/functions/scripts/probe-yc-industry-fold.ts
 */
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { cosineSimilarity } from "@pa/job-rec"
import { YC_COHORT_2026, loadCohortPool, type PeoplePoolMember } from "../src/yc-people-match.js"

const require = createRequire(`${process.cwd()}/apps/functions/`)
const admin = require("firebase-admin")
const OpenAI = require("openai")

const LIMIT = 5

// ── the legacy substring probe, frozen verbatim from passesFacets @ 7e4ea1c4 ──
function escapeRe(x: string): string {
  return x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
function legacyLooseHit(haystack: string[], needles: string[]): boolean {
  if (needles.length === 0) return true
  const hay = haystack.map((h) => h.trim().toLowerCase()).filter((h) => h.length > 0)
  return needles.some((n) => {
    const q = n.trim().toLowerCase()
    if (!q) return false
    return hay.some((h) => {
      if (q.length < 4) {
        if (new RegExp(`\\b${escapeRe(q)}\\b`).test(h)) return true
      } else if (h.includes(q)) return true
      if (h.length < 4) return false
      return new RegExp(`\\b${escapeRe(h)}\\b`).test(q)
    })
  })
}
function legacyFacet(pool: PeoplePoolMember[], values: string[]): PeoplePoolMember[] {
  const needles = values.map((x) => x.replace(/_/g, " "))
  return pool.filter((m) =>
    legacyLooseHit([m.currentTitle ?? "", m.currentCompany ?? "", ...m.skills].filter(Boolean), needles),
  )
}
// ──────────────────────────────────────────────────────────────────────────────

/** The canonical enum values an agent would actually set, and how they read as an ask. */
const CASES: Array<{ kind: "industrySector" | "roleFunction"; value: string; ask: string }> = [
  { kind: "industrySector", value: "financial_technology", ask: "fintech" },
  { kind: "industrySector", value: "artificial_intelligence_and_machine_learning", ask: "artificial intelligence and machine learning" },
  { kind: "industrySector", value: "healthcare_and_life_sciences", ask: "healthcare and life sciences" },
  { kind: "industrySector", value: "crypto_web3_blockchain", ask: "crypto web3 blockchain" },
  { kind: "roleFunction", value: "software_engineering", ask: "software engineers" },
  { kind: "roleFunction", value: "creatives_and_design", ask: "designers" },
  { kind: "roleFunction", value: "product_management", ask: "product managers" },
  { kind: "roleFunction", value: "sales", ask: "sales" },
]

function label(m: PeoplePoolMember): string {
  const t = [m.currentTitle, m.currentCompany].filter(Boolean).join(" @ ")
  return `${m.name ?? m.recordId} — ${t || "?"}`
}

async function main() {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS!, "utf8")),
    ),
  })
  const client = new OpenAI({ apiKey: process.env.PA_OPENAI_AGENT_API_KEY ?? process.env.OPENAI_API_KEY })
  const embed = async (text: string) => {
    const r = await client.embeddings.create({ model: "text-embedding-3-small", input: text })
    return r.data[0].embedding as number[]
  }

  const pool = await loadCohortPool(admin.firestore(), YC_COHORT_2026)
  console.log(`pool=${pool.length}  limit=${LIMIT}\n`)

  const rank = (ms: PeoplePoolMember[], q: number[]) =>
    ms
      .filter((m) => m.embedding?.length)
      .map((m) => {
        let s = cosineSimilarity(q, m.embedding!)
        if (m.descriptorEmbedding?.length) s = Math.max(s, cosineSimilarity(q, m.descriptorEmbedding))
        return { m, s }
      })
      .sort((a, b) => b.s - a.s)
      .slice(0, LIMIT)

  for (const c of CASES) {
    const q = await embed(c.ask)
    const gated = legacyFacet(pool, [c.value])
    const before = rank(gated, q)
    const after = rank(pool, q)
    const beforeIds = new Set(before.map((x) => x.m.recordId))
    const kept = after.filter((x) => beforeIds.has(x.m.recordId)).length
    console.log(`━━ ${c.kind} = ${c.value}   (ask: "${c.ask}")`)
    console.log(`   substring gate admitted ${gated.length}/${pool.length}; top-${LIMIT} overlap ${kept}/${before.length}`)
    console.log(`   BEFORE (gated then ranked):`)
    for (const x of before) console.log(`     ${x.s.toFixed(3)}  ${label(x.m)}`)
    console.log(`   AFTER  (semantic over whole pool):`)
    for (const x of after) console.log(`     ${x.s.toFixed(3)}  ${label(x.m)}${beforeIds.has(x.m.recordId) ? "  (also before)" : ""}`)
    console.log()
  }
}

void main().then(() => process.exit(0))
