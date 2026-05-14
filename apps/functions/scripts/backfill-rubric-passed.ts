/**
 * One-shot: re-classify the `enrichment.rubric[*].passed` flag on every
 * external-candidate record using the corrected `classifyRubricCell`
 * logic (Lessie reasoning-text-as-evidence rule). v1 misclassified every
 * non-prefix cell as `passed=null`, which made the dashboard table show
 * `0/N` rubric counts even when every criterion had reasoning text.
 */
import { initializeApp, applicationDefault, getApps } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { classifyRubricCell } from "@pa/external-supply"

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes("--dryRun")
  if (!getApps().length) initializeApp({ credential: applicationDefault() })
  const db = getFirestore()
  const snap = await db.collection("pa-external-candidate-records").get()
  console.log(
    `[backfill-rubric] scanning ${snap.size} records${dryRun ? " — DRY RUN" : ""}`,
  )

  let updated = 0
  let skipped = 0
  type Op = { id: string; rubric: Record<string, { value: string; passed: boolean | null }> }
  const ops: Op[] = []
  for (const d of snap.docs) {
    const data = d.data() as {
      enrichment?: { rubric?: Record<string, { value: string; passed: boolean | null }> }
    }
    const rubric = data.enrichment?.rubric
    if (!rubric || Object.keys(rubric).length === 0) {
      skipped += 1
      continue
    }
    const next: Record<string, { value: string; passed: boolean | null }> = {}
    let changed = false
    for (const [label, cell] of Object.entries(rubric)) {
      const reclassified = classifyRubricCell(cell?.value ?? "")
      next[label] = reclassified
      if (reclassified.passed !== cell.passed) changed = true
    }
    if (!changed) {
      skipped += 1
      continue
    }
    ops.push({ id: d.id, rubric: next })
    updated += 1
  }
  console.log(`[backfill-rubric] would update ${updated}, skip ${skipped}`)
  if (dryRun) {
    for (const op of ops.slice(0, 3)) {
      const sample = Object.entries(op.rubric).slice(0, 3)
      console.log(`  ${op.id} sample:`, sample.map(([k, c]) => `${k}=${c.passed}`).join(", "))
    }
    process.exit(0)
  }
  for (let i = 0; i < ops.length; i += 400) {
    const slice = ops.slice(i, i + 400)
    const batch = db.batch()
    for (const op of slice) {
      const ref = db.collection("pa-external-candidate-records").doc(op.id)
      batch.set(ref, { enrichment: { rubric: op.rubric } }, { merge: true })
    }
    await batch.commit()
    console.log(`[backfill-rubric] wrote ${i + 1}..${i + slice.length}`)
  }
  console.log(`[backfill-rubric] DONE — updated ${updated}`)
  process.exit(0)
}

main().catch((err) => {
  console.error("[backfill-rubric] FAILED:", err)
  process.exit(1)
})
