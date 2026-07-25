/**
 * Backfill: put ALREADY-ENRICHED YC scanners into the matchable pool.
 *
 * The pool was the frozen 1066-row CSV import. `syncYcPoolMember` existed and was tested but was
 * never called from production, so measured mid-event 2026-07-25: 143 people had scanned, 40 were
 * fully enriched, and ZERO were in the pool — every attendee invisible to everyone who arrived
 * after them. The live wiring is now in both enrich paths; this catches the people who enriched
 * BEFORE that shipped.
 *
 * Reuses `syncYcPoolMember` exactly as production does — same YC gate (fail-closed), same company
 * resolution, same descriptor, same two vectors — so a backfilled row is indistinguishable from a
 * live one. Idempotent: re-running updates rather than duplicating.
 *
 *   export GOOGLE_APPLICATION_CREDENTIALS=... PA_OPENAI_AGENT_API_KEY=... CORESIGNAL_API_KEY=...
 *   node --import tsx apps/functions/scripts/backfill-yc-pool-scanners.ts [--apply] [--limit N]
 */
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { syncYcPoolMember } from "../src/yc-pool-sync.js"
import { normalizeCoresignalCollectV2 } from "../src/external-supply/adapters/coresignal-collect-v2.js"

const require = createRequire(`${process.cwd()}/apps/functions/`)
const admin = require("firebase-admin")

const CONCURRENCY = 6

async function main() {
  const apply = process.argv.includes("--apply")
  const li = process.argv.indexOf("--limit")
  const limit = li >= 0 ? Number(process.argv[li + 1]) : Infinity

  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS!, "utf8")),
    ),
  })
  const db = admin.firestore()

  const users = await db.collection("pa-users").where("source", "==", "yc_startup_school").get()
  type Todo = { userId: string; employeeId: number }
  const todo: Todo[] = []
  for (const d of users.docs) {
    const u = d.data() as Record<string, unknown>
    const employeeId = Number(u.coresignalEmployeeId ?? 0)
    // Enriched = we actually hold their Coresignal identity. Without it there is nothing to
    // project, and a row with no vectors is worse than no row (it dilutes without ever ranking).
    if (!employeeId) continue
    todo.push({ userId: d.id, employeeId })
  }
  const slice = todo.slice(0, limit === Infinity ? todo.length : limit)
  console.log(`[yc-pool-backfill] yc users=${users.size} enriched=${todo.length} todo=${slice.length} mode=${apply ? "APPLY" : "DRY"}`)
  if (!apply) {
    console.log("[yc-pool-backfill] DRY RUN — pass --apply")
    return
  }

  const counts: Record<string, number> = {}
  let done = 0
  const queue = [...slice]
  const worker = async () => {
    for (;;) {
      const item = queue.shift()
      if (!item) return
      try {
        // The cache holds the collect payload the mirror already fetched — no new Coresignal call.
        // Keyed by `linkedinHash`, NOT by employee id, so query the indexed `coresignalId` field.
        const cached = await db
          .collection("pa-coresignal-cache")
          .where("coresignalId", "==", item.employeeId)
          .limit(1)
          .get()
        const employee = cached.empty
          ? null
          : ((cached.docs[0]!.data() as Record<string, unknown>).employee as Record<string, unknown> | null)
        if (!employee) {
          counts.no_cached_payload = (counts.no_cached_payload ?? 0) + 1
          continue
        }
        const draft = normalizeCoresignalCollectV2(employee)
        const record = {
          ...draft,
          recordId: `yc-scanner:${item.userId}:${item.employeeId}`,
          batchId: `yc-scanner-backfill`,
          createdAt: new Date().toISOString(),
          identityResolutionStatus: "merge_existing" as const,
          resolvedUserId: item.userId,
        }
        const res = await syncYcPoolMember({
          db,
          userId: item.userId,
          record: record as never,
          log: () => undefined,
        })
        const key = res.ok ? "ok" : `skip_${res.reason ?? "unknown"}`
        counts[key] = (counts[key] ?? 0) + 1
      } catch (err) {
        counts.error = (counts.error ?? 0) + 1
        console.error(`  ${item.userId.slice(0, 8)} ${err instanceof Error ? err.message : String(err)}`)
      }
      done++
      if (done % 10 === 0) console.log(`[yc-pool-backfill] ${done}/${slice.length}`)
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  console.log(`[yc-pool-backfill] DONE ${done}`, JSON.stringify(counts))
}

void main().then(() => process.exit(0))
