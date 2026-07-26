/**
 * Put the enriched-but-unpooled event signups into the YC matching pool.
 *
 * Being enriched is what makes someone MATCHABLE BY OTHERS, and `syncYcPoolMember` was wired into
 * the enrich path partway through the event — so everyone enriched before that never joined.
 * Measured 2026-07-26: 251 signups hold real background, only 131 are in the pool. The other 120
 * are invisible to every attendee who arrives after them.
 *
 * Re-derives each person's pool record from the Coresignal profile we already hold (cache hit — no
 * new provider spend) and runs the SAME `syncYcPoolMember` the live path calls, so a backfilled
 * member is byte-identical to one synced at signup. The gate inside it is fail-closed on
 * `isYcPeopleUser`, so a non-YC candidate can never be swept in.
 *
 * DATA ONLY. Texts nobody, emits no runtime event.
 * Dry run by default; `--apply` to write. `--limit N` to ramp.
 */
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { getOrFetchCoresignalById } from "../src/lib/coresignal-cache.js"
import { normalizeCoresignalCollectV2 } from "../src/external-supply/adapters/coresignal-collect-v2.js"
import { syncYcPoolMember } from "../src/yc-pool-sync.js"
import { fetchEmployeeCollect } from "@pa/external-supply"
import type { ExternalCandidateRecord } from "@pa/core-types"

const require = createRequire(`${process.cwd()}/apps/functions/`)
const admin = require("firebase-admin")
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS!, "utf8"))),
})
const db = admin.firestore()

const KEY = (process.env.CORESIGNAL_API_KEY ?? "").trim()
if (!KEY) throw new Error("CORESIGNAL_API_KEY missing (Firebase secret, not .env). Refusing to run half-blind.")

const COHORT = "yc_startup_school_2026"

async function main() {
  const argv = process.argv.slice(2)
  const apply = argv.includes("--apply")
  const li = argv.indexOf("--limit")
  const LIMIT = li > -1 ? Number(argv[li + 1]) : Infinity

  const pooled = new Set<string>()
  const pool = await db.collection("pa-external-candidate-records").where("enrichment.cohort", "==", COHORT).get()
  for (const d of pool.docs) {
    const uid = d.data().resolvedUserId
    if (typeof uid === "string") pooled.add(uid)
  }

  const since = new Date(Date.now() - 48 * 3600 * 1000).toISOString()
  const users = (await db.collection("pa-users").where("createdAt", ">=", since).get()).docs
    .map((d: { id: string; data: () => Record<string, unknown> }) => ({ id: d.id, ...d.data() }))
  const todo = users.filter((u: Record<string, unknown>) => {
    const isYc = Boolean(u.ycIntake) || String(u.source ?? "").includes("yc") || String(u.firstTouchCampaign ?? "").includes("yc")
    const enriched = typeof u.coresignalEmployeeId === "number"
    return isYc && enriched && !pooled.has(String(u.id))
  })

  console.log(`pool already holds ${pooled.size} signup members · enriched-but-unpooled: ${todo.length}`)
  const batch = todo.slice(0, LIMIT)
  if (!apply) {
    for (const u of batch.slice(0, 10)) console.log(`   would pool ${u.phoneE164 ?? u.id}  csId=${u.coresignalEmployeeId}`)
    console.log(`\nDRY RUN — would pool ${batch.length}. Pass --apply`)
    return
  }

  let ok = 0, skipped = 0, failed = 0
  const reasons = new Map<string, number>()
  for (const u of batch) {
    const nowIso = new Date().toISOString()
    try {
      const employee = await getOrFetchCoresignalById({
        db,
        id: u.coresignalEmployeeId as number,
        apiKey: KEY,
        now: nowIso,
        source: "yc_pool_backfill",
        fetch: fetchEmployeeCollect,
        log: () => {},
      })
      if (!employee) { failed++; reasons.set("collect_unavailable", (reasons.get("collect_unavailable") ?? 0) + 1); continue }
      const draft = normalizeCoresignalCollectV2(employee)
      const record: ExternalCandidateRecord = {
        ...draft,
        recordId: `yc-pool-backfill:${u.id}:${u.coresignalEmployeeId}`,
        batchId: `yc-pool-backfill:${nowIso.slice(0, 10)}`,
        createdAt: nowIso,
        identityResolutionStatus: "merge_existing",
        resolvedUserId: String(u.id),
      }
      const r = await syncYcPoolMember({ db, userId: String(u.id), record, nowIso, log: () => {} })
      if (r?.ok) ok++
      else { skipped++; reasons.set(String(r?.reason ?? "unknown"), (reasons.get(String(r?.reason ?? "unknown")) ?? 0) + 1) }
    } catch (err) {
      failed++
      reasons.set(String(err).slice(0, 40), (reasons.get(String(err).slice(0, 40)) ?? 0) + 1)
    }
    if ((ok + skipped + failed) % 25 === 0) console.log(`  ${ok + skipped + failed}/${batch.length}  pooled=${ok}`)
    await new Promise((r) => setTimeout(r, 120))
  }
  console.log(`\nDONE pooled=${ok} skipped=${skipped} failed=${failed} of ${batch.length}`)
  for (const [r, n] of [...reasons].sort((a, b) => b[1] - a[1])) console.log(`   ${n}× ${r}`)
}

void main().then(() => process.exit(0))
