#!/usr/bin/env node
/**
 * Phase 11.3 backfill — populate `pa_users.{id}.mem0UserId` for legacy
 * users where the field is unset. Idempotent. Default mode is read-only
 * (`--dry-run`); pass `--apply` to actually write.
 *
 * Hard rules (locked by 11.3 PLAN §3 11.3.3):
 *   - NEVER overwrite a non-empty `mem0UserId` (operator-set values are
 *     authoritative — preserved as-is).
 *   - NEVER write any field other than `mem0UserId` and `updatedAt`.
 *   - NEVER touch Qdrant. This is a Firestore-only data-coercion pass —
 *     after it runs, the resolver returns identical strings to legacy
 *     code paths because `mem0UserId == id` for legacy users and
 *     dashboard / Mem0 behavior is byte-identical.
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json \
 *   node scripts/pa-backfill-mem0-user-id.mjs                      # dry-run (default)
 *
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json \
 *   node scripts/pa-backfill-mem0-user-id.mjs --apply              # writes
 *
 *   --page-size N      override the page size (default 200)
 *   --limit M          stop after scanning M users (smoke testing)
 */
import { initializeApp, getApps, applicationDefault, cert } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { readFileSync } from "node:fs"

const args = process.argv.slice(2)
const APPLY = args.includes("--apply")
const DRY = !APPLY // default
const pageArg = args.find((a) => a.startsWith("--page-size="))
const limitArg = args.find((a) => a.startsWith("--limit="))
const PAGE_SIZE = pageArg ? Math.max(1, Math.min(1000, Number(pageArg.split("=")[1]) || 200)) : 200
const LIMIT = limitArg ? Math.max(0, Number(limitArg.split("=")[1]) || 0) : 0

function nowIso() {
  return new Date().toISOString()
}

function initAdmin() {
  if (getApps().length) return
  const jsonEnv = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  const path = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || process.env.GOOGLE_APPLICATION_CREDENTIALS
  if (jsonEnv && jsonEnv.trim().length > 0) {
    const sa = JSON.parse(jsonEnv)
    initializeApp({ credential: cert(sa), projectId: sa.project_id })
    return
  }
  if (path) {
    const sa = JSON.parse(readFileSync(path, "utf8"))
    initializeApp({ credential: cert(sa), projectId: sa.project_id })
    return
  }
  initializeApp({
    credential: applicationDefault(),
    projectId: process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT,
  })
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0
}

/**
 * Decide what to do with a single user document.
 *
 * Returns one of:
 *   - { kind: "preserved" }                  — already populated; do nothing
 *   - { kind: "no_id" }                      — corruption signal (no `id`); skipped
 *   - { kind: "would_update", value: <id> }  — needs `mem0UserId = id`
 */
export function planUserUpdate(doc) {
  if (!isNonEmptyString(doc.id)) return { kind: "no_id" }
  if (isNonEmptyString(doc.mem0UserId)) return { kind: "preserved" }
  return { kind: "would_update", value: doc.id }
}

async function processPage(db, lastSnapshot) {
  let q = db.collection("pa-users").orderBy("__name__").limit(PAGE_SIZE)
  if (lastSnapshot) q = q.startAfter(lastSnapshot)
  const snap = await q.get()
  return snap
}

async function main() {
  initAdmin()
  const db = getFirestore()
  console.log(
    `[backfill] mode=${DRY ? "dry-run" : "apply"} pageSize=${PAGE_SIZE}` +
      (LIMIT > 0 ? ` limit=${LIMIT}` : "")
  )

  let scanned = 0
  let preserved = 0
  let updated = 0
  let skippedNoId = 0
  let lastDoc = null
  const writeAt = nowIso()

  while (true) {
    const snap = await processPage(db, lastDoc)
    if (snap.empty) break
    const batch = db.batch()
    let writesInBatch = 0
    for (const docSnap of snap.docs) {
      scanned++
      const data = docSnap.data() ?? {}
      // The Firestore document ID is the canonical user id; some legacy rows
      // also store it inside the doc body. Use the doc id for safety.
      const effective = { ...data, id: docSnap.id }
      const plan = planUserUpdate(effective)
      if (plan.kind === "preserved") {
        preserved++
      } else if (plan.kind === "no_id") {
        skippedNoId++
      } else if (plan.kind === "would_update") {
        updated++
        if (APPLY) {
          batch.set(
            docSnap.ref,
            { mem0UserId: plan.value, updatedAt: writeAt },
            { merge: true }
          )
          writesInBatch++
        }
      }
      if (LIMIT > 0 && scanned >= LIMIT) break
    }
    if (APPLY && writesInBatch > 0) {
      await batch.commit()
    }
    lastDoc = snap.docs[snap.docs.length - 1]
    if (snap.size < PAGE_SIZE) break
    if (LIMIT > 0 && scanned >= LIMIT) break
  }

  const tag = DRY ? "[dry-run] would_update" : "[apply] updated"
  console.log(
    `scanned=${scanned} preserved=${preserved} ${tag}=${updated} skipped_no_id=${skippedNoId}`
  )
  if (DRY) {
    console.log("(no writes performed; re-run with --apply to persist)")
  }
}

// Allow `import` from tests without auto-running main.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("[backfill] fatal:", e)
    process.exit(1)
  })
}
