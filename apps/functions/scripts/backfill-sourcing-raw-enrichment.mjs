#!/usr/bin/env node
/**
 * One-shot backfill: copy `enrichment` from pa-external-candidate-records.{id}
 * into the matching sourcing-source-records.{id}.raw.enrichment, for every
 * batch synced via the old smoke-script path (which didn't include
 * enrichment when mapping records).
 *
 * Without this, vendor-profile-lookup pickers can't find linkedin/github
 * URLs for records whose URLs only live in `enrichment.links[]` (v2.3
 * multi-link adapter records).
 *
 * Run:
 *   node apps/functions/scripts/backfill-sourcing-raw-enrichment.mjs
 *   node apps/functions/scripts/backfill-sourcing-raw-enrichment.mjs <batchId>
 */
import { initializeApp, applicationDefault, getApps } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"

if (!getApps().length) initializeApp({ credential: applicationDefault() })
const db = getFirestore()

async function backfillBatch(batchId) {
  const batchSnap = await db.collection("pa-external-sourcing-batches").doc(batchId).get()
  if (!batchSnap.exists) return { batchId, skipped: "batch_not_found" }
  const batch = batchSnap.data()
  if (!batch.sourcing?.runId) return { batchId, skipped: "not_synced_yet" }

  const recordsSnap = await db
    .collection("pa-external-candidate-records")
    .where("batchId", "==", batchId)
    .get()

  let patched = 0
  let missingSourcing = 0
  let alreadyHas = 0
  for (const recDoc of recordsSnap.docs) {
    const rec = recDoc.data()
    if (!rec.enrichment) continue
    const srcRef = db.collection("sourcing-source-records").doc(rec.recordId)
    const srcSnap = await srcRef.get()
    if (!srcSnap.exists) {
      missingSourcing += 1
      continue
    }
    const src = srcSnap.data()
    if (src?.raw?.enrichment?.links && Array.isArray(src.raw.enrichment.links)) {
      alreadyHas += 1
      continue
    }
    await srcRef.set(
      {
        raw: {
          ...(src.raw ?? {}),
          enrichment: rec.enrichment,
          experience: rec.experience ?? [],
          education: rec.education ?? [],
        },
      },
      { merge: true },
    )
    patched += 1
  }
  return { batchId, runId: batch.sourcing.runId, patched, missingSourcing, alreadyHas, total: recordsSnap.size }
}

async function main() {
  const explicit = process.argv[2]
  if (explicit) {
    const r = await backfillBatch(explicit)
    console.log(JSON.stringify(r, null, 2))
    return
  }
  // All batches that have sourcing.runId set.
  const synced = await db.collection("pa-external-sourcing-batches").orderBy("createdAt", "desc").get()
  let total = 0
  for (const b of synced.docs) {
    if (!b.data()?.sourcing?.runId) continue
    const r = await backfillBatch(b.id)
    total += r.patched ?? 0
    console.log(`${b.id.slice(0, 8)}… ${JSON.stringify(r)}`)
  }
  console.log(`\nTOTAL patched: ${total}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
