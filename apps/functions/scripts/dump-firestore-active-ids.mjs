#!/usr/bin/env node
/**
 * Inverse backfill helper: dump every Firestore `matching-jobs` doc with
 * `status='active'` to stdout (one job_id per line).
 *
 * Why inverse: source-of-truth says Postgres has 32k active rows but
 * Firestore has 4,797. The forward approach (read all 136k inactive +
 * propagate) is slow over the public tunnel. The inverse approach reads
 * the much smaller active set, then macmini-side SQL flips every row
 * NOT in the active list. One UPDATE statement, runs in seconds.
 *
 * Output: plain text, one job_id per line. Pipe into macmini-side SQL
 * via SSH.
 *
 * Usage:
 *     node apps/functions/scripts/dump-firestore-active-ids.mjs > active.txt
 */
import { initializeApp, getApps, applicationDefault, cert } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"

const PAGE_SIZE = 1000

function initAdmin() {
  if (getApps().length) return
  const inlineJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  if (inlineJson) {
    initializeApp({ credential: cert(JSON.parse(inlineJson)) })
  } else {
    initializeApp({ credential: applicationDefault() })
  }
}

async function main() {
  initAdmin()
  const db = getFirestore()
  const collection = db.collection("matching-jobs")
  let lastDoc = null
  let total = 0
  for (;;) {
    let q = collection.where("status", "==", "active")
                      .orderBy("__name__")
                      .limit(PAGE_SIZE)
    if (lastDoc) q = q.startAfter(lastDoc)
    const snap = await q.get()
    if (snap.empty) break
    for (const doc of snap.docs) {
      process.stdout.write(doc.id + "\n")
    }
    total += snap.docs.length
    process.stderr.write(`[dump] streamed ${total}\n`)
    if (snap.size < PAGE_SIZE) break
    lastDoc = snap.docs[snap.docs.length - 1]
  }
  process.stderr.write(`[dump] done — ${total} active doc ids\n`)
}

main().catch((err) => {
  process.stderr.write(`[dump] FATAL: ${err.message}\n${err.stack}\n`)
  process.exit(1)
})
