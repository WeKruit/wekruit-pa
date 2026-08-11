/**
 * READ-ONLY: does folding the asker's OWN `ycIntake.building` back into an explicit ask fix the
 * 2026-07-25 bad matches, and at what weight? Sends nothing, writes nothing.
 *
 * Variants, all on the same query embedding budget:
 *   ask            — TODAY. The explicit query alone; `building` is discarded.
 *   concat         — embed "<ask>. <building>" as one string.
 *   ctxW=<w>       — two vectors, score = (askCos + w*ctxCos) / (1+w), each side still max(profile,
 *                    descriptor). Keeps a sharp ask sharp and lets domain break the near-ties.
 *
 *   node --import tsx apps/functions/scripts/probe-yc-ask-context.ts
 */
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { cosineSimilarity } from "@pa/job-rec"
import {
  loadCohortPool,
  passesFacets,
  ycPoolRecordId,
  YC_COHORT_2026,
  type PeoplePoolMember,
} from "../src/yc-people-match.js"

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
const embed = async (t: string): Promise<number[]> =>
  (await client.embeddings.create({ model: "text-embedding-3-small", input: t.slice(0, 8000) })).data[0]
    .embedding as number[]

/** The four live asks Adam flagged, with the real tool args the agent produced. */
const CASES: Array<{ phone: string; who: string; ask: string; personType: string[] }> = [
  { phone: "+16692068874", who: "Idan (robotics / corexy gantry)", ask: "builders", personType: [] },
  { phone: "+447470866300", who: "PhD ML + drug development", ask: "investors/operators", personType: ["investor", "operator"] },
  { phone: "+16133258788", who: "Jason (ex-Jane Street, research)", ask: "researchers", personType: ["researcher"] },
  { phone: "+447470866300", who: "PhD ML + drug dev (2nd live call)", ask: "founders who are hiring; investors/operators", personType: ["founder", "investor", "operator"] },
  { phone: "+19738455757", who: "UPenn / fintech + robotics", ask: "people at UPenn M&T", personType: [] },
  { phone: "+19738455757", who: "UPenn / fintech + robotics", ask: "open to all", personType: [] },
]

/** Weighted two-vector blend — MEASURED AND REJECTED, kept here so nobody re-derives it. */
const WEIGHTS: number[] = []

function adjust(m: PeoplePoolMember, base: number): number {
  let s = base
  if (m.matchStatus === "Needs Review") s -= 0.05
  if (m.exposureCount > 0) s -= 0.04 * Math.min(m.exposureCount, 5)
  if (m.personType.includes("founder")) s += 0.03
  return s
}

const surfaceCos = (m: PeoplePoolMember, q: number[]) =>
  Math.max(
    cosineSimilarity(q, m.embedding!),
    m.descriptorEmbedding?.length ? cosineSimilarity(q, m.descriptorEmbedding) : -1,
  )

async function main() {
  const pool = (await loadCohortPool(db, YC_COHORT_2026)).filter((m) => m.embedding?.length)
  console.log(`pool=${pool.length}`)

  for (const c of CASES) {
    const r = await db.collection("pa-users").where("phoneE164", "==", c.phone).get()
    const uid = r.docs[0]!.id
    const u = r.docs[0]!.data() as Record<string, unknown>
    const intake = (u.ycIntake ?? {}) as Record<string, unknown>
    const building = typeof intake.building === "string" ? intake.building : ""
    const selfId = ycPoolRecordId(uid)
    const cands = pool
      .filter((m) => m.recordId !== selfId)
      .filter((m) => !c.personType.length || passesFacets(m, { personType: c.personType }, { schools: [], companies: [], majors: [] }))

    console.log(`\n${"=".repeat(100)}\n${c.who}   ask="${c.ask}"  personType=[${c.personType}]  candidates=${cands.length}`)
    console.log(`  building: "${building}"`)

    const qAsk = await embed(c.ask)
    const qCtx = building ? await embed(building) : null
    const qCat = building ? await embed(`${c.ask}. ${building}`) : null

    const show = (label: string, scoreOf: (m: PeoplePoolMember) => number) => {
      const rows = cands
        .map((m) => ({ m, s: adjust(m, scoreOf(m)) }))
        .sort((a, b) => b.s - a.s)
        .slice(0, 5)
      console.log(`  --- ${label}`)
      for (const { m, s } of rows) {
        console.log(`      ${s.toFixed(3)}  ${m.name} — ${m.currentTitle} @ ${m.currentCompany}`)
        console.log(`             ${String(m.whatTheyBuild ?? "—").slice(0, 120)}`)
      }
    }

    show("ask ALONE (today)", (m) => surfaceCos(m, qAsk))
    if (qCat) {
      show("concat  ask+building", (m) => surfaceCos(m, qCat))
      // DESCRIPTOR DE-BIAS: the descriptor text is ~40 tokens and the profile ~1500, so a short query
      // scores systematically higher against the descriptor for every member alike. max() then picks
      // the surface by TEXT LENGTH, not by fit. Subtract the pool-wide offset before max() — self-
      // calibrating (long query → offset ≤ 0 → today's behaviour exactly), clamped at 0 so it can
      // only remove an advantage, never grant one.
      const withD = cands.filter((m) => m.descriptorEmbedding?.length)
      const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1)
      const off = Math.max(
        0,
        mean(withD.map((m) => cosineSimilarity(qCat, m.descriptorEmbedding!))) -
          mean(withD.map((m) => cosineSimilarity(qCat, m.embedding!))),
      )
      show(`concat + descDebias (offset=${off.toFixed(3)})`, (m) =>
        Math.max(
          cosineSimilarity(qCat, m.embedding!),
          m.descriptorEmbedding?.length ? cosineSimilarity(qCat, m.descriptorEmbedding) - off : -1,
        ),
      )
    }
    if (qCtx) {
      for (const w of WEIGHTS) {
        show(`ctxW=${w}`, (m) => (surfaceCos(m, qAsk) + w * surfaceCos(m, qCtx)) / (1 + w))
      }
    }
  }
}
void main().then(() => process.exit(0))
