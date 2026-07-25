/**
 * Enrich an imported attendee cohort from Coresignal, so the people matcher has real profile
 * signal (title / company / experience / education / skills) instead of just a name + URL.
 *
 * Reuses the shipped path end-to-end: `searchEmployeeIdByLinkedinUrl` → `getOrFetchCoresignalById`
 * (which reads/writes `pa-coresignal-cache`, so a re-run costs nothing) → `normalizeCoresignalCollectV2`.
 * The normalized profile is merged back onto the SAME external-candidate record, so the matcher
 * reads one shape and never has to know whether a row was enriched or not.
 *
 * Deliberately does NOT write pa-users or emit any runtime event: these 1000+ people never opted
 * in and are only ever *recommended to* a scanner, never contacted.
 *
 * Run:
 *   export GOOGLE_APPLICATION_CREDENTIALS=... ; export CORESIGNAL_API_KEY=...
 *   node --import tsx apps/functions/scripts/enrich-yc-attendees.ts <batchId> [--apply] [--limit N]
 */
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { fetchEmployeeCollect, searchEmployeeIdByLinkedinUrl } from "@pa/external-supply"
import { getOrFetchCoresignalById } from "../src/lib/coresignal-cache.js"
import { normalizeCoresignalCollectV2 } from "../src/external-supply/adapters/coresignal-collect-v2.js"

const require = createRequire("/Users/adam/Desktop/WeKruit/wekruit-pa/.claude/worktrees/serene-diffie-15b15a/apps/functions/")
const admin = require("firebase-admin")

const CONCURRENCY = 8

type Rec = Record<string, unknown>

async function main() {
  const batchId = process.argv[2]
  const apply = process.argv.includes("--apply")
  const limitArg = process.argv.indexOf("--limit")
  const limit = limitArg > 0 ? Number(process.argv[limitArg + 1]) : Infinity
  if (!batchId) {
    console.error("usage: enrich-yc-attendees.ts <batchId> [--apply] [--limit N]")
    process.exit(2)
  }
  const apiKey = process.env.CORESIGNAL_API_KEY ?? null
  if (!apiKey) {
    console.error("CORESIGNAL_API_KEY missing")
    process.exit(2)
  }
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS!, "utf8"))),
  })
  const db = admin.firestore()

  const snap = await db.collection("pa-external-candidate-records").where("batchId", "==", batchId).get()
  const all = snap.docs.filter((d: { data: () => Rec }) => Boolean((d.data() as Rec).canonicalLinkedInUrl))
  // Skip rows already enriched so a resumed run only does the remainder.
  const todo = all.filter((d: { data: () => Rec }) => !(d.data() as Rec).coresignalEnrichedAt).slice(0, limit)
  console.log(`[yc-enrich] batch=${batchId} records=${snap.size} withUrl=${all.length} toEnrich=${todo.length} apply=${apply}`)
  if (!apply) {
    console.log("[yc-enrich] DRY RUN — pass --apply to fetch + write")
    return
  }

  let ok = 0, noMatch = 0, failed = 0, done = 0
  const started = Date.now()

  async function worker(queue: Array<{ id: string; url: string; name: string }>) {
    for (;;) {
      const item = queue.pop()
      if (!item) return
      try {
        const employeeId = await searchEmployeeIdByLinkedinUrl(item.url, { apiKey: apiKey! })
        if (employeeId === null) {
          noMatch++
          await db.collection("pa-external-candidate-records").doc(item.id).set(
            { coresignalEnrichedAt: new Date().toISOString(), coresignalMatch: "no_match" },
            { merge: true },
          )
        } else {
          const employee = await getOrFetchCoresignalById({
            db,
            id: employeeId,
            apiKey: apiKey!,
            now: new Date().toISOString(),
            source: "yc_attendee_enrich",
            fetch: fetchEmployeeCollect,
            link: item.url,
          })
          if (!employee) {
            failed++
          } else {
            const draft = normalizeCoresignalCollectV2(employee) as Rec
            // Merge the profile onto the record. Name is NOT overwritten — the sheet's name is the
            // attendee we know showed up; Coresignal's is whoever the URL resolved to, and those
            // can legitimately differ (English name vs legal name).
            const patch: Rec = {
              currentTitle: draft.currentTitle ?? null,
              currentCompany: draft.currentCompany ?? null,
              location: draft.location ?? null,
              experience: draft.experience ?? [],
              education: draft.education ?? [],
              sourceTags: draft.sourceTags ?? [], // = Coresignal inferred+historical skills
              coresignalId: employeeId,
              coresignalName: draft.name ?? null,
              coresignalEnrichedAt: new Date().toISOString(),
              coresignalMatch: "ok",
            }
            for (const k of Object.keys(patch)) if (patch[k] === undefined) delete patch[k]
            await db.collection("pa-external-candidate-records").doc(item.id).set(patch, { merge: true })
            ok++
          }
        }
      } catch (err) {
        failed++
        if (failed <= 5) console.log(`   error ${item.name}: ${err instanceof Error ? err.message : String(err)}`)
      }
      done++
      if (done % 50 === 0) {
        const rate = done / ((Date.now() - started) / 1000)
        const eta = Math.round((todo.length - done) / Math.max(rate, 0.01))
        console.log(`[yc-enrich] ${done}/${todo.length}  ok=${ok} noMatch=${noMatch} failed=${failed}  ~${eta}s left`)
      }
    }
  }

  const queue = todo.map((d: { id: string; data: () => Rec }) => ({
    id: d.id,
    url: String((d.data() as Rec).canonicalLinkedInUrl),
    name: String((d.data() as Rec).name ?? "?"),
  }))
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)))

  console.log(`\n[yc-enrich] DONE  ok=${ok} noMatch=${noMatch} failed=${failed} of ${todo.length}`)
}

void main().then(() => process.exit(0))
