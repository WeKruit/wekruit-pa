/**
 * READ-ONLY A/B: does `companyProfile` actually make company facts FINDABLE?
 *
 * Enrichment that never reaches a vector is invisible to every query, so this measures
 * by QUERY, not by field count. For each company-shaped ask it ranks the live pool twice:
 *   BASELINE  — the stored `matchEmbedding` exactly as it is today.
 *   AUGMENTED — the same, except the 120 founders' vectors are recomputed from
 *               `matchText + companyProfile.matchLine`.
 * Then it prints the top hits with their actual company facts, so a claimed win can be
 * checked against whether the people returned really ARE what was asked for.
 *
 * Writes nothing. Costs ~120 embeddings.
 *
 *   node --import tsx apps/functions/scripts/probe-company-ask-signal.ts
 */
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { cosineSimilarity } from "@pa/job-rec"
import { loadCohortPool, roundTypeToStage, YC_COHORT_2026 } from "../src/yc-people-match.js"

const require = createRequire("/Users/adam/Desktop/WeKruit/wekruit-pa/.claude/worktrees/serene-diffie-15b15a/apps/functions/")
const admin = require("firebase-admin")
const OpenAI = require("openai")

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS!, "utf8"))),
})
const db = admin.firestore()
const client = new OpenAI({ apiKey: process.env.PA_OPENAI_AGENT_API_KEY ?? process.env.OPENAI_API_KEY })

const ASKS = [
  "founders at a company that raised a seed round",
  "YC startup",
  "Y Combinator backed founders",
  "pre-seed stage startup",
  "series A or later company",
  "big company, not a startup",
  "very early startup, just a couple of people",
  "founders backed by well known investors",
]

async function embed(texts: string[]): Promise<number[][]> {
  const out: number[][] = []
  for (let i = 0; i < texts.length; i += 100) {
    const r = await client.embeddings.create({ model: "text-embedding-3-small", input: texts.slice(i, i + 100) })
    out.push(...r.data.map((d: { embedding: number[] }) => d.embedding))
  }
  return out
}

/** Does this person's OWN company data actually satisfy the ask? Used to score honestly. */
function satisfies(ask: string, cp: Record<string, any> | undefined): boolean | null {
  if (!cp?.companyName) return null // unknown company — cannot be counted either way
  const stage = String(cp.stage ?? "").toLowerCase()
  const emp = typeof cp.employeesCount === "number" ? cp.employeesCount : null
  if (ask.includes("YC") || ask.includes("Y Combinator")) return Boolean(cp.ycBatch) || (cp.investors ?? []).some((i: string) => /y combinator/i.test(i))
  if (ask.includes("seed round")) return stage.includes("seed")
  if (ask.includes("pre-seed")) return stage.includes("pre seed") || stage.includes("preseed")
  if (ask.includes("series A or later")) return /series [a-d]/.test(stage)
  if (ask.includes("big company")) return emp !== null && emp >= 500
  if (ask.includes("just a couple")) return emp !== null && emp <= 10
  if (ask.includes("well known investors")) return (cp.investors ?? []).length > 0
  return null
}

/**
 * The FACET half: `fundingStage` is matched exactly against `inferCompanyStage`, which
 * today guesses stage from HEADCOUNT. This checks that guess against the real funding
 * round we now hold. Headcount is a bad proxy for a YC startup — they hire before they
 * raise — so a wrong guess here silently answers "series A founders" with pre-seed ones.
 */
async function facetCheck(cp: Map<string, Record<string, any>>) {
  const { inferCompanyStage } = await import("../src/yc-people-match.js")
  let agree = 0, disagree = 0, fillsUnknown = 0
  const wrong: string[] = []
  for (const p of cp.values()) {
    const real = roundTypeToStage(p.stage)
    if (!real) continue
    const g = inferCompanyStage({
      currentTitle: null, currentCompany: p.statedCompany,
      experience: [{ currentRole: true, companySizeRange: p.sizeRange }],
      libraryStage: p.internalLibStage,
    })
    if (g.stage === "unknown") { fillsUnknown++; continue }
    if (g.stage === real) agree++
    else { disagree++; wrong.push(`    ${p.companyName}: inferred=${g.stage} (${g.source})  REAL=${real} [${p.stage}, ${p.employeesCount} emp]`) }
  }
  console.log(`\n=== FACET: inferCompanyStage vs the real funding round (n=${agree + disagree + fillsUnknown}) ===`)
  console.log(`  agrees=${agree}  DISAGREES=${disagree}  fills an "unknown"=${fillsUnknown}`)
  console.log(wrong.join("\n"))
}

async function main() {
  const pool = (await loadCohortPool(db, YC_COHORT_2026)).filter((m) => m.embedding?.length)
  const snap = await db.collection("pa-external-candidate-records").where("enrichment.cohort", "==", YC_COHORT_2026).get()
  const cp = new Map<string, Record<string, any>>()
  for (const d of snap.docs) { const p = d.data().companyProfile; if (p) cp.set(d.id, p) }

  await facetCheck(cp)

  const augTargets = pool.filter((m) => cp.get(m.recordId)?.matchLine)
  console.log(`pool=${pool.length}  withCompanyProfile=${cp.size}  augmenting=${augTargets.length}`)

  const newVecs = await embed(augTargets.map((m) => `${m.matchText}\n${cp.get(m.recordId)!.matchLine}`))
  const augEmb = new Map(augTargets.map((m, i) => [m.recordId, newVecs[i]]))

  const askVecs = await embed(ASKS)

  for (let a = 0; a < ASKS.length; a++) {
    const q = askVecs[a]
    const rank = (useAug: boolean) =>
      pool
        .map((m) => ({ m, s: cosineSimilarity(q, (useAug ? augEmb.get(m.recordId) : null) ?? m.embedding!) }))
        .sort((x, y) => y.s - x.s)
    const base = rank(false), aug = rank(true)
    const hits = (r: typeof base) => {
      const top = r.slice(0, 10)
      const judged = top.map((x) => satisfies(ASKS[a], cp.get(x.m.recordId))).filter((v) => v !== null)
      return { correct: judged.filter(Boolean).length, judged: judged.length, best: r[0].s }
    }
    const b = hits(base), g = hits(aug)
    console.log(`\n=== "${ASKS[a]}"`)
    console.log(`  BASELINE  p@10 ${b.correct}/${b.judged || "0"} judged   topSim ${b.best.toFixed(3)}`)
    console.log(`  AUGMENTED p@10 ${g.correct}/${g.judged || "0"} judged   topSim ${g.best.toFixed(3)}`)
    for (const x of aug.slice(0, 3)) {
      const c = cp.get(x.m.recordId)
      console.log(`    ${x.s.toFixed(3)} ${x.m.name} — ${c?.companyName ?? "?"} | stage=${c?.stage ?? "-"} yc=${c?.ycBatch ?? "-"} emp=${c?.employeesCount ?? "-"} inv=${(c?.investors ?? []).slice(0, 2).join("/") || "-"}`)
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
