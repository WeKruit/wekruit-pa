/**
 * Derive a business descriptor for every attendee in a cohort and cache it on the record.
 *
 * WHY: a LinkedIn profile says "Software Engineer @ Faire", never "two-sided marketplace".
 * Concrete-domain queries ("robotics") match verbatim text; business-MODEL queries
 * ("marketplace", "B2B SaaS", "vertical SaaS") have nothing to bind to, so they rank noise
 * (measured: top hit for "marketplace" was a web agency, cosine 0.31). Company → business model
 * is world knowledge the LLM has and the profile does not state, so we materialise it at index
 * time and fold it into the embedded text (`synthesizePeopleMatchText({ businessDescriptor })`).
 *
 * Cheap tier only (`callWithFallback` → gpt-5.4-nano first), once per record, cached on
 * `businessDescriptor`. Re-embed afterwards with `embed-yc-attendees.ts --refresh`.
 *
 * Run:
 *   export GOOGLE_APPLICATION_CREDENTIALS=... ; export PA_OPENAI_AGENT_API_KEY=...
 *   node --import tsx apps/functions/scripts/describe-yc-attendees.ts <cohort> [--apply] [--limit N]
 */
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { YC_COHORT_2026 } from "../src/yc-people-match.js"
// The prompt/schema/projection now live in src/ so the LIVE scanner path (yc-pool-sync.ts) runs the
// SAME generator — a second copy would describe new arrivals in a different vocabulary than the pool
// they are ranked against.
import { buildDescriptorInput, describeBusiness } from "../src/yc-business-descriptor.js"

const require = createRequire(`${process.cwd()}/apps/functions/`)
const admin = require("firebase-admin")

const CONCURRENCY = 8
const RECORDS = "pa-external-candidate-records"

type Row = { id: string; text: string }

async function main() {
  const cohort = process.argv[2] ?? YC_COHORT_2026
  const apply = process.argv.includes("--apply")
  const refresh = process.argv.includes("--refresh")
  const limitIdx = process.argv.indexOf("--limit")
  const limit = limitIdx >= 0 ? Number(process.argv[limitIdx + 1]) : Infinity
  const apiKey = process.env.PA_OPENAI_AGENT_API_KEY ?? process.env.OPENAI_API_KEY
  if (!apiKey) {
    console.error("OPENAI key missing")
    process.exit(2)
  }

  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS!, "utf8")),
    ),
  })
  const db = admin.firestore()

  const snap = await db.collection(RECORDS).where("enrichment.cohort", "==", cohort).get()
  const todo: Row[] = []
  for (const doc of snap.docs) {
    const d = doc.data() as Record<string, unknown>
    if (d.coresignalMatch !== "ok") continue
    // `--refresh` re-describes rows that already have a descriptor — needed whenever the SCHEMA
    // grows (personType was added 2026-07-25 and every existing row predates it).
    if (d.businessDescriptor && !refresh) continue
    // Without --refresh, still fill rows whose descriptor predates a schema field.
    if (d.businessDescriptor && refresh === false) continue
    const text = buildDescriptorInput(d)
    if (text.length < 20) continue
    todo.push({ id: doc.id, text })
  }
  const work = todo.slice(0, limit === Infinity ? todo.length : limit)
  console.log(`[yc-describe] cohort=${cohort} records=${snap.size} needDescriptor=${todo.length} doing=${work.length}`)
  if (!apply) {
    console.log("[yc-describe] DRY RUN — pass --apply")
    console.log(work[0]?.text)
    return
  }

  let done = 0
  let failed = 0
  const now = new Date().toISOString()
  let cursor = 0
  const worker = async () => {
    while (cursor < work.length) {
      const row = work[cursor++]!
      try {
        const descriptor = await describeBusiness(row.text, apiKey)
        await db.collection(RECORDS).doc(row.id).set(
          { businessDescriptor: { ...descriptor, generatedAt: now } },
          { merge: true },
        )
        done++
      } catch (err) {
        failed++
        console.error(`[yc-describe] fail ${row.id}: ${err instanceof Error ? err.message : String(err)}`)
      }
      if ((done + failed) % 25 === 0) console.log(`[yc-describe] ${done + failed}/${work.length} (failed=${failed})`)
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  console.log(`[yc-describe] DONE ok=${done} failed=${failed}`)
}

void main().then(() => process.exit(0))
