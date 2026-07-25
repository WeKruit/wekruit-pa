/**
 * READ-ONLY before/after for the 2026-07-25 bad-match incident. Sends nothing, writes nothing.
 *
 * Runs the REAL `runYcPeopleMatch` — floors, exposure demotion, founder prior, honesty short-list and
 * all — twice per live ask:
 *   BEFORE — the asker doc is served through a read-only shim with `ycIntake.building` blanked, which
 *            is exactly the old `queryText = f.query || intent`: the ask alone, domain discarded.
 *   AFTER  — the real doc.
 * Nothing is mutated; the shim only rewrites what THIS process reads.
 *
 *   node --import tsx apps/functions/scripts/probe-yc-people-before-after.ts
 */
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import type { Firestore } from "firebase-admin/firestore"
import { cosineSimilarity } from "@pa/job-rec"
import { runYcPeopleMatch, type YcPeopleMatchFilters, type YcPeopleMatchOutput } from "../src/yc-people-match.js"

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
const embed = async (t: string) =>
  (await client.embeddings.create({ model: "text-embedding-3-small", input: t.slice(0, 8000) })).data?.[0]
    ?.embedding ?? null

/** Read-only view of Firestore that blanks `ycIntake.building` on the asker. Never writes. */
function withoutBuilding(real: Firestore, userId: string): Firestore {
  return {
    collection(name: string) {
      const c = (real as never as { collection: (n: string) => Record<string, unknown> }).collection(name)
      if (name !== "pa-users") return c
      return {
        ...c,
        doc: (id: string) => {
          const d = (c as { doc: (i: string) => { get: () => Promise<{ data: () => unknown }> } }).doc(id)
          if (id !== userId) return d
          return {
            ...d,
            get: async () => {
              const snap = await d.get()
              const data = (snap.data() ?? {}) as Record<string, unknown>
              const intake = { ...((data.ycIntake ?? {}) as Record<string, unknown>), building: "" }
              return { ...snap, data: () => ({ ...data, ycIntake: intake }) }
            },
          }
        },
      }
    },
  } as never as Firestore
}

/** The live asks, verbatim from each user's `pa-turns` toolCalls on 2026-07-25. */
const CASES: Array<{ phone: string; who: string; filters: YcPeopleMatchFilters }> = [
  { phone: "+16692068874", who: "1. Idan — robotics / corexy gantry for micro-vascular anastomosis", filters: { query: "builders" } },
  { phone: "+447470866300", who: "2. PhD ML + drug development modelling", filters: { query: "investors/operators", personType: ["investor", "operator"] } },
  { phone: "+447470866300", who: "2b. same user, 2nd live call", filters: { query: "founders who are hiring; investors/operators", personType: ["founder", "investor", "operator"] } },
  { phone: "+16133258788", who: "3. Jason — ex-Jane Street, research", filters: { query: "researchers", personType: ["researcher"] } },
  { phone: "+16133258788", who: "3b. same user, 2nd live call", filters: { query: "full time founders", personType: ["founder"] } },
  { phone: "+19738455757", who: "4. UPenn / fintech + hardware-robotics", filters: { query: "open to all" } },
  { phone: "+19738455757", who: "4b. same user, named-school ask", filters: { query: "people at UPenn M&T" } },
]

function render(out: YcPeopleMatchOutput): string {
  if (out.results.length === 0) return `      (nothing — reason=${out.reason ?? "no_results"})`
  return out.results
    .map(
      (r) =>
        `      ${r.score.toFixed(3)}  ${r.name} — ${r.title ?? "?"} @ ${r.company ?? "—"}\n` +
        `             ${String(r.summary ?? "—").slice(0, 130)}`,
    )
    .join("\n")
}

async function main() {
  for (const c of CASES) {
    const snap = await db.collection("pa-users").where("phoneE164", "==", c.phone).get()
    const uid = snap.docs[0]!.id
    const intake = (snap.docs[0]!.data().ycIntake ?? {}) as Record<string, unknown>
    console.log(`\n${"=".repeat(100)}\n${c.who}   ${c.phone}`)
    console.log(`   building    : ${JSON.stringify(intake.building ?? null)}`)
    console.log(`   live ask    : ${JSON.stringify(c.filters)}`)

    // Ignore the per-user already-sent ledger on BOTH sides — otherwise "after" is scored against a
    // pool the "before" run already ate, and the diff would measure the ledger, not the change.
    const base = { db, embed, cosine: cosineSimilarity, loadAlreadySent: async () => new Set<string>() }
    const before = await runYcPeopleMatch({ userId: uid, limit: 5, filters: c.filters }, {
      ...base,
      db: withoutBuilding(db, uid),
    })
    const after = await runYcPeopleMatch({ userId: uid, limit: 5, filters: c.filters }, base)
    console.log(`   --- BEFORE (ask alone)   returned=${before.results.length} facetMatched=${before.facetMatched} relaxed=${before.didRelax}`)
    console.log(render(before))
    console.log(`   --- AFTER  (ask + what they're building)   returned=${after.results.length} facetMatched=${after.facetMatched} relaxed=${after.didRelax}`)
    console.log(render(after))
  }
}
void main().then(() => process.exit(0))
