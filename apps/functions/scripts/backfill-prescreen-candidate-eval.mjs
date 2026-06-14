/**
 * Backfill migration — run the prescreen candidate checklist eval over the EXISTING
 * pending-review queue.
 *
 * The `paPrescreenCandidateEval` CF fires only when a session NEWLY enters pending
 * review (onDocumentWritten transition). Sessions that were already pending before the
 * feature shipped have no `review.candidateChecklistEval` / regenerated `review.autoDraft`,
 * so the dashboard panel + draft are empty. This walks every pending session and runs
 * the SAME deps-injected handler the CF runs (Coresignal enrich + checklist judge +
 * draft regen). Advisory — never sends. Idempotent (skips sessions already evaluated
 * unless --force). Fail-open per session.
 *
 * Env: FIREBASE_SERVICE_ACCOUNT_JSON, PA_OPENAI_AGENT_API_KEY, CORESIGNAL_API_KEY
 *      (ANTHROPIC_API_KEY optional). Run from apps/functions.
 * Flags: --force (re-eval even if already done), --limit=N, --concurrency=N, --dry
 */
import { initializeApp, cert } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"

const argv = process.argv.slice(2)
const FORCE = argv.includes("--force")
const DRY = argv.includes("--dry")
const LIMIT = Number((argv.find((a) => a.startsWith("--limit=")) || "").split("=")[1]) || 1000
const CONCURRENCY = Number((argv.find((a) => a.startsWith("--concurrency=")) || "").split("=")[1]) || 4

const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
initializeApp({ credential: cert(sa) })
const db = getFirestore()

const { searchEmployeeIdByLinkedinUrl, fetchEmployeeCollect } = await import("@pa/external-supply")
const { callWithFallback } = await import("@pa/pa-resume-parser")
const { generateAndStorePrescreenAutoDraft } = await import("../src/evaluation-attempts.ts")
const { runPrescreenCandidateEval } = await import("../src/prescreen-candidate-eval.ts")

const deps = {
  db,
  now: () => new Date().toISOString(),
  callJudge: async (a) => {
    const o = await callWithFallback({
      apiKey: process.env.PA_OPENAI_AGENT_API_KEY,
      anthropicApiKey: process.env.ANTHROPIC_API_KEY || undefined,
      systemPrompt: a.systemPrompt,
      userText: a.userText,
      schemaName: a.schemaName,
      schema: a.schema,
    })
    return { rawJson: o.rawJson, usedModel: o.usedModel }
  },
  research: {
    apiKey: process.env.CORESIGNAL_API_KEY || null,
    searchEmployeeIdByLinkedinUrl,
    fetchEmployeeCollect,
  },
  regenerateDraft: generateAndStorePrescreenAutoDraft,
  log: (e, p) => {
    if (/error|no_match/.test(String(e))) console.error("  !", e, JSON.stringify(p || {}))
  },
}

// Collect pending-review session ids.
const ids = []
const snap = await db.collection("pa-prescreen-sessions").where("terminalActionPendingReview", "==", true).limit(LIMIT).get()
for (const d of snap.docs) {
  if (!FORCE && d.data()?.review?.candidateChecklistEval) continue
  ids.push(d.id)
}
console.log(`pending-review sessions to backfill: ${ids.length} (force=${FORCE}, dry=${DRY}, concurrency=${CONCURRENCY})`)
if (DRY) { console.log(ids.slice(0, 20).join("\n")); process.exit(0) }

const counts = { written: 0, skipped: 0, error: 0, enriched: 0, no_checklist: 0 }
let done = 0
const queue = [...ids]

async function worker(wid) {
  while (queue.length) {
    const sid = queue.shift()
    if (!sid) return
    try {
      const res = await runPrescreenCandidateEval(sid, deps, { force: FORCE })
      if (res.status === "written") { counts.written++; if (res.eval?.enriched) counts.enriched++ }
      else if (res.status === "skipped_no_job_checklist") counts.no_checklist++
      else if (res.status === "error") counts.error++
      else counts.skipped++
    } catch (e) {
      counts.error++
      console.error("  EXC", sid, e?.message)
    }
    done++
    if (done % 10 === 0) console.log(`  ...${done}/${ids.length} | ${JSON.stringify(counts)}`)
  }
}

await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, (_, i) => worker(i)))
console.log(`DONE ${done}/${ids.length} | ${JSON.stringify(counts)}`)
process.exit(0)
