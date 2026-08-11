/**
 * READ-ONLY diagnostic for the 2026-07-25 "bad people matches" incident. Sends nothing, writes nothing.
 *
 * For each live phone: dump the asker's real ycIntake, the REAL tool args the agent composed
 * (from pa-turns), and the top-N ranking with a per-row breakdown of WHY it scored what it did —
 * profile cosine vs descriptor cosine, which of the two won, and every adjustment.
 *
 *   node --import tsx apps/functions/scripts/probe-yc-bad-matches.ts
 */
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { cosineSimilarity } from "@pa/job-rec"
import { loadCohortPool, ycPoolRecordId, YC_COHORT_2026, passesFacets } from "../src/yc-people-match.js"

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

const PHONES = ["+16692068874", "+447470866300", "+16133258788", "+19738455757"]

async function uidFor(phone: string): Promise<string | null> {
  const r = await db.collection("pa-users").where("phoneE164", "==", phone).get()
  return r.docs[0]?.id ?? null
}

/** Every match_yc_people tool call this user's agent actually made, oldest first. */
async function realToolCalls(uid: string): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  const snap = await db.collection("pa-turns").where("userId", "==", uid).limit(400).get()
  const rows = snap.docs
    .map((d: any) => ({ id: d.id, ...(d.data() as Record<string, unknown>) }))
    .sort((a: any, b: any) => String(a.createdAt ?? a.at ?? "").localeCompare(String(b.createdAt ?? b.at ?? "")))
  for (const r of rows) {
    const calls = (r as any).toolCalls
    if (!Array.isArray(calls)) continue
    for (const c of calls) {
      const nm = String(c?.name ?? c?.tool ?? "")
      if (!nm.includes("yc_people")) continue
      out.push({ at: (r as any).createdAt ?? (r as any).at ?? null, ...c })
    }
  }
  return out
}

async function main() {
  const pool = (await loadCohortPool(db, YC_COHORT_2026)).filter((m) => m.embedding?.length)
  console.log(`pool=${pool.length}\n${"=".repeat(100)}`)

  for (const phone of PHONES) {
    const uid = await uidFor(phone)
    console.log(`\n\n${"#".repeat(100)}\n# ${phone}   uid=${uid ?? "NOT FOUND"}`)
    if (!uid) continue
    const u = (await db.collection("pa-users").doc(uid).get()).data() ?? {}
    const intake = (u.ycIntake ?? {}) as Record<string, unknown>
    console.log(`# name        : ${u.firstName ?? ""} ${u.lastName ?? ""}  | ${u.recentRoleTitle ?? "?"} @ ${u.recentCompany ?? "?"}`)
    console.log(`# building    : ${JSON.stringify(intake.building ?? null)}`)
    console.log(`# wantsToMeet : ${JSON.stringify(intake.wantsToMeet ?? null)}`)
    const sent = Array.isArray(u.ycPeopleMatchSent) ? (u.ycPeopleMatchSent as string[]) : []
    console.log(`# alreadySent : ${sent.length}`)
    const calls = await realToolCalls(uid)
    console.log(`# toolCalls   : ${calls.length}`)
    for (const c of calls) console.log(`#   ${JSON.stringify(c).slice(0, 600)}`)

    // What DID they receive? Resolve the sent recordIds to names.
    if (sent.length) {
      console.log(`# received:`)
      for (const id of sent) {
        const m = pool.find((p) => p.recordId === id)
        console.log(`#   ${m ? `${m.name} — ${m.currentTitle} @ ${m.currentCompany}` : id}`)
      }
    }

    // Reproduce ranking for the intake-derived query (the auto-fire lane) AND for each real tool query.
    const intent = [intake.building, intake.wantsToMeet].filter((x) => typeof x === "string" && x).join(". ")
    const queries: Array<[string, string, string[]?]> = [["intake auto-fire", intent, []]]
    for (const c of calls) {
      const raw = (c as any).arguments ?? (c as any).args ?? (c as any).input ?? {}
      let args: Record<string, unknown> = {}
      try {
        args = (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, unknown>
      } catch { /* leave empty */ }
      const q = typeof args.query === "string" ? args.query : ""
      if (q) {
        queries.push([
          `LIVE tool query  personType=${JSON.stringify(args.personType ?? null)}`,
          q,
          Array.isArray(args.personType) ? (args.personType as string[]) : [],
        ])
      }
    }

    const selfId = ycPoolRecordId(uid)
    for (const [label, q, pt] of queries) {
      if (!q.trim()) continue
      const qv = await embed(q)
      const rows = pool
        .filter((m) => m.recordId !== selfId)
        .filter((m) => !pt?.length || passesFacets(m, { personType: pt }, { schools: [], companies: [], majors: [] }))
        .map((m) => {
          const p = cosineSimilarity(qv, m.embedding!)
          const d = m.descriptorEmbedding?.length ? cosineSimilarity(qv, m.descriptorEmbedding) : -1
          let s = Math.max(p, d)
          const adj: string[] = []
          if (m.matchStatus === "Needs Review") { s -= 0.05; adj.push("-.05 review") }
          if (m.exposureCount > 0) { const e = 0.04 * Math.min(m.exposureCount, 5); s -= e; adj.push(`-${e.toFixed(2)} exp×${m.exposureCount}`) }
          if (m.personType.includes("founder")) { s += 0.03; adj.push("+.03 founder") }
          return { m, p, d, s, adj, won: d > p ? "DESC" : "prof" }
        })
        .sort((a, b) => b.s - a.s)
      // LENGTH-BIAS DIAGNOSTIC: max(profile, descriptor) compares cosines from texts of wildly
      // different length. If the descriptor vector wins nearly every row and its spread is tiny,
      // the "max" is not picking the better surface — it is picking the shorter text.
      const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1)
      const sd = (xs: number[]) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))) }
      const ps = rows.map((r) => r.p)
      const ds = rows.filter((r) => r.d >= 0).map((r) => r.d)
      const descWins = rows.filter((r) => r.d > r.p).length
      console.log(`\n--- ${label}\n    q="${q.slice(0, 200)}"  qLen=${q.length}  candidates=${rows.length}`)
      console.log(
        `    profile cos  mean=${mean(ps).toFixed(3)} sd=${sd(ps).toFixed(3)} max=${Math.max(...ps).toFixed(3)}` +
          `   descriptor cos mean=${mean(ds).toFixed(3)} sd=${sd(ds).toFixed(3)} max=${Math.max(...ds).toFixed(3)}` +
          `   DESC wins ${descWins}/${rows.length}`,
      )
      rows.slice(0, 10).forEach((r, i) => {
        console.log(
          `  ${String(i + 1).padStart(2)}. ${r.s.toFixed(3)} [${r.won} p=${r.p.toFixed(3)} d=${r.d < 0 ? " n/a " : r.d.toFixed(3)}] ${r.adj.join(" ")}\n      ${r.m.name} — ${r.m.currentTitle} @ ${r.m.currentCompany}  {${r.m.personType.join(",")}}\n      build: ${String(r.m.whatTheyBuild ?? "—").slice(0, 150)}`,
        )
      })
    }
  }
}
void main().then(() => process.exit(0))
