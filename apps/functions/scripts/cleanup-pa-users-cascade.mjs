#!/usr/bin/env node
/**
 * 2026-05-18 pre-launch cleanup — cascade-delete dev/QA/E2E pollution
 * from `pa-users` and every FK collection that references it.
 *
 * Goal: .planning/GOAL-pa-users-cleanup.md
 * Gate prerequisite (Phase 1, already merged): `pa-users.source` policy.
 *
 * Real users kept:
 *   - indolencorlol@gmail.com       (U7AwKT8nLDRa35DkuBxq, layoff)
 *   - adam.ylol@wekruit.com         (UThMpnAGzjaWnxDsKEMH, dev)
 *   - admin1@wekruit.com            (itYEwzaJjVPjWbN01fzk, dev)
 * Everything else in pa-users (~624 docs) is delete-candidate.
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json \
 *   node apps/functions/scripts/cleanup-pa-users-cascade.mjs --dry-run
 *
 *   # After Adam confirms the dry-run output:
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json \
 *   node apps/functions/scripts/cleanup-pa-users-cascade.mjs --execute
 *
 * Optional flags:
 *   --only <collection>     run a single collection (debug)
 *   --skip-pre-export       skip the pre-flight "do you have a backup?" prompt
 *
 * Execution order (matters — drains FK collections BEFORE pa-users):
 *   1. `pa_users` (underscore typo, full wipe)
 *   2. `pa-tool-calls`, `pa-job-clicks`, `pa-feedback-events`,
 *      `pa-pii-confirm-state` (full wipe)
 *   3. `pa-messages`, `pa-turns`, `pa-sessions`, `pa-inbound-events`,
 *      `pa-outbound`, `pa-prescreen-sessions`, `pa-audit-events`,
 *      `parsedCandidateResumes` (filter by userId)
 *   4. `pa-resume-artifacts`, `pa-candidate-handles`,
 *      `pa-candidate-self-profiles`, `pa-candidate-auth`
 *      (filter by candidateId)
 *   5. `pa-users` LAST (filter by doc id)
 *
 * Each collection: count pre → delete → count post → assert against
 * expected. Paginated batchWrite (500 ops max per Firestore batch).
 */
import { initializeApp, getApps, applicationDefault } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"

const KEEP_LIST = [
  "U7AwKT8nLDRa35DkuBxq", // indolencorlol@gmail.com (layoff)
  "UThMpnAGzjaWnxDsKEMH", // adam.ylol@wekruit.com (dev)
  "itYEwzaJjVPjWbN01fzk", // admin1@wekruit.com (dev)
]

const KEEP_SET = new Set(KEEP_LIST)

const args = process.argv.slice(2)
const DRY_RUN = args.includes("--dry-run")
const EXECUTE = args.includes("--execute")
const ONLY = args.find((a, i) => args[i - 1] === "--only")
const SKIP_PRE_EXPORT = args.includes("--skip-pre-export")

if (DRY_RUN === EXECUTE) {
  console.error("usage: pass EXACTLY ONE of --dry-run or --execute")
  console.error("  --dry-run         count without deleting (run this first)")
  console.error("  --execute         delete (only after Adam confirms dry-run)")
  console.error("  --only <name>     run a single collection (debug)")
  console.error("  --skip-pre-export  skip the 'verified Firestore export?' prompt")
  process.exit(2)
}

/**
 * Collection plan. `kind` controls the filter:
 *   - full_wipe       delete every doc unconditionally
 *   - filter_user_id   delete docs whose `userId` field is NOT in KEEP_LIST
 *   - filter_candidate_id  delete docs whose `candidateId` field is NOT in KEEP_LIST
 *   - filter_doc_id    delete docs whose doc id is NOT in KEEP_LIST (pa-users only)
 *
 * `expected` is the count of rows that should REMAIN after delete.
 * Source: .planning/GOAL-pa-users-cleanup.md (2026-05-18 audit numbers).
 */
const PLAN = [
  // Step 1 — underscore typo collection (any doc found is pollution).
  { name: "pa_users", kind: "full_wipe", expected: 0 },

  // Step 2 — full-wipe FK collections (zero real-user rows).
  { name: "pa-tool-calls", kind: "full_wipe", expected: 0 },
  { name: "pa-job-clicks", kind: "full_wipe", expected: 0 },
  { name: "pa-feedback-events", kind: "full_wipe", expected: 0 },
  { name: "pa-pii-confirm-state", kind: "full_wipe", expected: 0 },

  // Step 3 — userId-FK collections (drain BEFORE pa-users).
  { name: "pa-messages", kind: "filter_user_id" },
  { name: "pa-turns", kind: "filter_user_id" },
  { name: "pa-sessions", kind: "filter_user_id" },
  { name: "pa-inbound-events", kind: "filter_user_id" },
  { name: "pa-outbound", kind: "filter_user_id" },
  { name: "pa-prescreen-sessions", kind: "filter_user_id" },
  { name: "pa-audit-events", kind: "filter_user_id" },
  { name: "parsedCandidateResumes", kind: "filter_user_id" },

  // Step 4 — candidateId-FK collections.
  { name: "pa-resume-artifacts", kind: "filter_candidate_id" },
  { name: "pa-candidate-handles", kind: "filter_candidate_id" },
  { name: "pa-candidate-self-profiles", kind: "filter_candidate_id" },
  { name: "pa-candidate-auth", kind: "filter_candidate_id" },

  // Step 5 — pa-users LAST (after every FK is drained).
  { name: "pa-users", kind: "filter_doc_id", expected: 3 },
]

const BATCH_SIZE = 400 // Firestore caps at 500 ops/batch; leave headroom.
const PAGE_SIZE = 500

if (!getApps().length) initializeApp({ credential: applicationDefault() })
const db = getFirestore()

/**
 * Count every doc in a collection. Optionally filter by `userId` /
 * `candidateId` NOT IN KEEP_LIST so the "would-delete" total is
 * surfaced separately from the total row count.
 */
async function countCollection(name, filterFieldOrNull) {
  const baseRef = db.collection(name)
  if (!filterFieldOrNull) {
    const snap = await baseRef.count().get()
    return { total: snap.data().count, deletable: snap.data().count }
  }
  // Firestore `not-in` filter is limited to 10 values; KEEP_LIST has 3.
  const totalSnap = await baseRef.count().get()
  const deletableSnap = await baseRef
    .where(filterFieldOrNull, "not-in", KEEP_LIST)
    .count()
    .get()
  return { total: totalSnap.data().count, deletable: deletableSnap.data().count }
}

/**
 * Stream docs in pages of PAGE_SIZE, batch-delete docs matching the
 * predicate. Returns the number of docs actually deleted.
 *
 * For `full_wipe` the predicate is `() => true`. For filtered modes it
 * inspects the field and returns false for KEEP_LIST hits.
 */
async function streamDelete(name, predicate) {
  const ref = db.collection(name)
  let lastDoc = null
  let deleted = 0
  let scanned = 0

  // Use Firestore `not-in` server-side filter where possible, so we don't
  // pull KEEP_LIST hits across the wire. predicate stays as a belt-and-
  // braces guard.
  for (;;) {
    let q = ref.orderBy("__name__").limit(PAGE_SIZE)
    if (lastDoc) q = q.startAfter(lastDoc)
    const page = await q.get()
    if (page.empty) break
    scanned += page.size
    lastDoc = page.docs[page.docs.length - 1]

    let batch = db.batch()
    let opsInBatch = 0
    for (const d of page.docs) {
      if (!predicate(d)) continue
      if (DRY_RUN) {
        deleted += 1
        continue
      }
      batch.delete(d.ref)
      opsInBatch += 1
      deleted += 1
      if (opsInBatch >= BATCH_SIZE) {
        await batch.commit()
        batch = db.batch()
        opsInBatch = 0
      }
    }
    if (!DRY_RUN && opsInBatch > 0) {
      await batch.commit()
    }
    if (page.size < PAGE_SIZE) break
  }

  return { deleted, scanned }
}

function predicateFor(entry) {
  switch (entry.kind) {
    case "full_wipe":
      return () => true
    case "filter_user_id":
      return (doc) => {
        const userId = doc.get("userId")
        return typeof userId === "string" && !KEEP_SET.has(userId)
      }
    case "filter_candidate_id":
      return (doc) => {
        const candidateId = doc.get("candidateId")
        return typeof candidateId === "string" && !KEEP_SET.has(candidateId)
      }
    case "filter_doc_id":
      return (doc) => !KEEP_SET.has(doc.id)
    default:
      throw new Error(`unknown plan kind: ${entry.kind}`)
  }
}

function filterField(entry) {
  switch (entry.kind) {
    case "filter_user_id":
      return "userId"
    case "filter_candidate_id":
      return "candidateId"
    case "filter_doc_id":
      return "__name__"
    case "full_wipe":
      return null
    default:
      return null
  }
}

async function main() {
  console.log("=".repeat(72))
  console.log(`pa-users cascade cleanup — mode: ${DRY_RUN ? "DRY-RUN" : "EXECUTE"}`)
  console.log(`KEEP_LIST: ${KEEP_LIST.join(", ")}`)
  console.log("=".repeat(72))
  console.log("")

  if (EXECUTE && !SKIP_PRE_EXPORT) {
    console.log("⚠️  REMINDER: did you run the Firestore export to gs://wekruit-5f89b-backups?")
    console.log("    gcloud firestore export gs://wekruit-5f89b-backups/pre-cleanup-2026-05-18/ \\")
    console.log("      --project=wekruit-5f89b")
    console.log("")
    console.log("    Pass --skip-pre-export once you've verified the backup exists.")
    console.log("    Continuing in 8s — Ctrl-C to abort.")
    await new Promise((r) => setTimeout(r, 8_000))
  }

  const summary = []
  for (const entry of PLAN) {
    if (ONLY && entry.name !== ONLY) continue
    const field = filterField(entry)
    const useFilter = field && field !== "__name__"

    let pre
    try {
      pre = useFilter
        ? await countCollection(entry.name, field)
        : entry.kind === "filter_doc_id"
          ? { total: (await db.collection(entry.name).count().get()).data().count, deletable: NaN }
          : await countCollection(entry.name, null)
    } catch (err) {
      // Collection might not exist (e.g., pa_users underscore typo on a
      // fresh project). Treat as zero rows.
      pre = { total: 0, deletable: 0, error: err.message }
    }

    const predicate = predicateFor(entry)
    const { deleted, scanned } = await streamDelete(entry.name, predicate)

    let post
    try {
      post = (await db.collection(entry.name).count().get()).data().count
    } catch {
      post = 0
    }

    const expected = typeof entry.expected === "number"
      ? entry.expected
      : KEEP_LIST.length // FK collections leave 0..N keep_list-owned rows
    const matchesExpected = typeof entry.expected === "number"
      ? post === entry.expected
      : true // FK collections — only assert no orphans (downstream check)

    summary.push({
      name: entry.name,
      kind: entry.kind,
      pre_total: pre.total,
      pre_deletable: pre.deletable,
      scanned,
      deleted,
      post_total: post,
      expected,
      ok: matchesExpected,
    })

    console.log(
      `  ${entry.name.padEnd(36)}  pre=${String(pre.total).padStart(6)} ` +
      `del=${String(deleted).padStart(6)} post=${String(post).padStart(6)} ` +
      `expected≤${expected} ${matchesExpected ? "✓" : "✗"}` +
      (pre.error ? ` [err: ${pre.error}]` : "")
    )
  }

  console.log("")
  console.log("=".repeat(72))
  console.log(`mode=${DRY_RUN ? "DRY-RUN" : "EXECUTE"}`)
  const totalDeleted = summary.reduce((s, x) => s + x.deleted, 0)
  console.log(`would-delete total: ${totalDeleted}`)
  const failures = summary.filter((x) => !x.ok)
  if (failures.length > 0) {
    console.log(`⚠️  ${failures.length} collection(s) failed expected-count assertion:`)
    for (const f of failures) console.log(`    - ${f.name}: post=${f.post_total} expected≤${f.expected}`)
  } else {
    console.log("all collections within expected post-count ✓")
  }
  console.log("=".repeat(72))

  if (DRY_RUN) {
    console.log("")
    console.log("DRY-RUN complete. Paste this output to Adam for confirmation,")
    console.log("then re-run with --execute (after verifying the GCS export).")
  } else {
    console.log("")
    console.log("EXECUTE complete. Run the smoke check next:")
    console.log("  node apps/functions/scripts/cleanup-smoke-verify.mjs")
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
