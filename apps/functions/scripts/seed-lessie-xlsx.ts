/**
 * One-shot prod ingest: a single Lessie xlsx → batch + records bound to a
 * company+job. Bypasses the UI entirely so the e2e closure ships.
 *
 * Reads the local xlsx, parses through the loose manual_csv adapter
 * (`parseManualSheetBuffer`), normalizes identity hashes, dedupes, and
 * writes `pa-external-sourcing-batches/{batchId}` + a record per row to
 * Firestore. Idempotent on `(sha256, source)` — re-run updates the existing
 * batch instead of duplicating.
 *
 * Run:
 *   export GOOGLE_APPLICATION_CREDENTIALS=$(mktemp) && \
 *     grep -E "^FIREBASE_SERVICE_ACCOUNT_JSON=" .env | \
 *     sed 's/^FIREBASE_SERVICE_ACCOUNT_JSON=//' > "$GOOGLE_APPLICATION_CREDENTIALS"
 *   node --import tsx apps/functions/scripts/seed-lessie-xlsx.ts \
 *     '/Users/adam/Downloads/lessie_export (1).xlsx' rain-xyz rain-android-engineer-c1351eb6
 */
import { readFileSync, statSync } from "node:fs"
import { createHash, randomUUID } from "node:crypto"
import { basename } from "node:path"
import { initializeApp, applicationDefault, getApps } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { dedupeWithinBatch } from "@pa/external-supply"
import { parseManualSheetBuffer } from "../src/external-supply/adapters/manual-csv.js"

async function main() {
  const [, , filePath, companyId, jobId] = process.argv
  if (!filePath || !companyId || !jobId) {
    console.error("usage: seed-lessie-xlsx.ts <xlsx-path> <companyId> <jobId>")
    process.exit(2)
  }
  const buf = readFileSync(filePath)
  const size = statSync(filePath).size
  console.log(
    `[seed-lessie] file=${filePath} size=${size}B company=${companyId} job=${jobId}`,
  )
  const sha256 = createHash("sha256").update(buf).digest("hex")
  const fname = basename(filePath)

  // 1. Parse via the loose manual_csv adapter (auto-detects xlsx + 6 stable
  //    Lessie headers + preserves rubric columns).
  const { drafts, inferred, sheetKind, effectiveMapping } = parseManualSheetBuffer(
    buf,
    fname,
    undefined, // no operator mapping override — let the inferrer do its job
  )
  console.log(
    `[seed-lessie] parsed kind=${sheetKind} rows=${drafts.length} rubricCols=${inferred.rubricColumns.length}`,
  )
  console.log(`[seed-lessie] mapping:`, effectiveMapping)
  console.log(`[seed-lessie] rubricColumns:`, inferred.rubricColumns)

  const dedupe = dedupeWithinBatch(drafts)
  console.log(
    `[seed-lessie] dedup kept=${dedupe.kept.length} duplicates=${dedupe.duplicateCount}`,
  )

  // 2. Firestore admin client.
  if (!getApps().length) {
    initializeApp({ credential: applicationDefault() })
  }
  const db = getFirestore()

  // Idempotency — re-run hits the same batch id.
  const existing = await db
    .collection("pa-external-sourcing-batches")
    .where("sha256", "==", sha256)
    .where("source", "==", "manual_csv")
    .limit(1)
    .get()
  const batchId = existing.empty ? randomUUID() : (existing.docs[0]!.id)
  console.log(
    `[seed-lessie] batchId=${batchId} (${existing.empty ? "new" : "existing — will overwrite"})`,
  )

  const nowIso = new Date().toISOString()
  const validLinkedIn = dedupe.kept.filter((r) => Boolean(r.canonicalLinkedInUrl)).length
  const validEmail = dedupe.kept.filter((r) => r.emails.length > 0).length
  const readyToProfile = dedupe.kept.filter((r) => r.normalizationStatus === "ok").length

  const batchDoc = {
    batchId,
    source: "manual_csv",
    // ExternalSourcingBatchSchema (core-types) requires both `rawFileRef`
    // (storageUri+mime+sha256+sizeBytes) and `normalizerVersion`. Without
    // these the dashboard's safeParse drops the row and BatchDetail
    // renders an empty page.
    rawFileRef: {
      storageUri: `inline://manual_csv/${sha256}/${fname}`,
      mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      sha256,
      sizeBytes: size,
    },
    normalizerVersion: "manual-csv-2026-05-B",
    adapterVersion: "manual-csv-2026-05-B",
    storageUri: `inline://manual_csv/${sha256}/${fname}`,
    sha256,
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    sizeBytes: size,
    rowCount: drafts.length,
    validLinkedInCount: validLinkedIn,
    validEmailCount: validEmail,
    duplicateCount: dedupe.duplicateCount,
    needsReviewCount: 0,
    readyToProfileCount: readyToProfile,
    importedBy: "script:seed-lessie-xlsx",
    importedAt: nowIso,
    status: "normalized" as const,
    companyId,
    jobId,
    createdAt: nowIso,
    updatedAt: nowIso,
    meta: {
      adapterVersion: "manual-csv-2026-05-B",
      filename: fname,
      sheetKind,
      inferredMapping: effectiveMapping,
      rubricColumns: inferred.rubricColumns,
      matchScoreColumn: inferred.matchScoreColumn ?? null,
    },
  }

  await db.collection("pa-external-sourcing-batches").doc(batchId).set(batchDoc, { merge: true })

  // 2.5. Clean any stale records for this batch so re-runs don't multiply.
  const stale = await db
    .collection("pa-external-candidate-records")
    .where("batchId", "==", batchId)
    .get()
  if (!stale.empty) {
    console.log(`[seed-lessie] cleaning ${stale.size} stale records before re-seed`)
    for (let i = 0; i < stale.docs.length; i += 400) {
      const slice = stale.docs.slice(i, i + 400)
      const delBatch = db.batch()
      for (const d of slice) delBatch.delete(d.ref)
      await delBatch.commit()
    }
  }

  // 3. Write records in chunks of 400 (Firestore batch limit 500, leave headroom).
  let writtenRecords = 0
  for (let i = 0; i < dedupe.kept.length; i += 400) {
    const slice = dedupe.kept.slice(i, i + 400)
    const batch = db.batch()
    for (const draft of slice) {
      const recordId = randomUUID()
      const ref = db.collection("pa-external-candidate-records").doc(recordId)
      // Strip undefined fields so Firestore doesn't reject.
      const doc: Record<string, unknown> = {
        recordId,
        batchId,
        createdAt: nowIso,
      }
      for (const [k, v] of Object.entries(draft)) {
        if (v !== undefined) doc[k] = v
      }
      batch.set(ref, doc, { merge: false })
    }
    await batch.commit()
    writtenRecords += slice.length
    console.log(`[seed-lessie] wrote records ${i + 1}..${i + slice.length}`)
  }

  // 4. Verify.
  const batchSnap = await db.collection("pa-external-sourcing-batches").doc(batchId).get()
  const recordsSnap = await db
    .collection("pa-external-candidate-records")
    .where("batchId", "==", batchId)
    .limit(1000)
    .get()
  console.log(
    `[seed-lessie] DONE — batch.exists=${batchSnap.exists}, records.size=${recordsSnap.size}, expected=${dedupe.kept.length}`,
  )
  console.log(
    `[seed-lessie] view → https://wekruit-pa.web.app/admin/external-supply/batches/${batchId}/candidates`,
  )
  process.exit(0)
}

main().catch((err) => {
  console.error("[seed-lessie] FAILED:", err)
  process.exit(1)
})
