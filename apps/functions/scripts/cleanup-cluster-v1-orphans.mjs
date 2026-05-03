#!/usr/bin/env node
/**
 * Backlog TD-#6 (Phase 51 closeout, commit c47dfd2) — one-shot cleanup of
 * orphan v1 cluster docs in `pa-rec-tag-clusters`. Phase 51 D9 flipped the
 * collection name to `pa-rec-tag-clusters-v2`; the v1 docs (~6549, ~33MB)
 * are no longer read but still occupy free-tier storage. Script defaults
 * to dry-run; pass `--confirm` to actually delete.
 *
 * Usage:
 *   # Dry-run (counts only, no writes):
 *   node apps/functions/scripts/cleanup-cluster-v1-orphans.mjs
 *
 *   # Real delete:
 *   node apps/functions/scripts/cleanup-cluster-v1-orphans.mjs --confirm
 *
 * Auth: relies on `GOOGLE_APPLICATION_CREDENTIALS` or default ADC. Same
 * pattern as cleanup-stuck-outbound.ts. Run from repo root.
 *
 * Safety:
 *   - Hard-codes the legacy collection string ("pa-rec-tag-clusters") so
 *     this script can NEVER touch the v2 collection by accident even if
 *     someone refactors `TAG_CLUSTERS_COLLECTION`.
 *   - Batch size 500 (Firestore hard cap). Progress log every batch.
 *   - Idempotent: safe to re-run (queries fresh paginated snapshot each batch).
 */
import { initializeApp, applicationDefault, getApps } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"

const LEGACY_COLLECTION = "pa-rec-tag-clusters" // intentionally NOT TAG_CLUSTERS_COLLECTION (v2)
const BATCH = 500

function parseArgs(argv) {
  return {
    confirm: argv.includes("--confirm"),
    project: (argv.find((a) => a.startsWith("--project=")) ?? "").split("=")[1] ?? process.env.GCLOUD_PROJECT ?? "wekruit-5f89b",
  }
}

async function main() {
  const { confirm, project } = parseArgs(process.argv.slice(2))

  if (getApps().length === 0) {
    initializeApp({ credential: applicationDefault(), projectId: project })
  }
  const db = getFirestore()

  console.log(`[cleanup-cluster-v1] target collection: ${LEGACY_COLLECTION}`)
  console.log(`[cleanup-cluster-v1] project: ${project}`)
  console.log(`[cleanup-cluster-v1] mode: ${confirm ? "DELETE (real)" : "DRY-RUN"}`)

  // Phase 1 — count.
  const snap = await db.collection(LEGACY_COLLECTION).select().get()
  const total = snap.size
  console.log(`[cleanup-cluster-v1] doc count: ${total}`)

  if (!confirm) {
    console.log(`[cleanup-cluster-v1] DRY-RUN complete. Re-run with --confirm to delete ${total} docs.`)
    return
  }

  if (total === 0) {
    console.log(`[cleanup-cluster-v1] nothing to delete.`)
    return
  }

  // Phase 2 — delete in batches of 500.
  let deleted = 0
  let cursor = undefined
  while (deleted < total) {
    let q = db.collection(LEGACY_COLLECTION).select().limit(BATCH)
    if (cursor) q = q.startAfter(cursor)
    const page = await q.get()
    if (page.empty) break

    const batch = db.batch()
    for (const doc of page.docs) batch.delete(doc.ref)
    await batch.commit()

    deleted += page.size
    cursor = page.docs[page.docs.length - 1]
    console.log(`[cleanup-cluster-v1] deleted ${deleted}/${total}`)

    // If page was less than BATCH we're done; the cursor advance fetches
    // a fresh page next iter and we'd see empty.
    if (page.size < BATCH) break
  }

  console.log(`[cleanup-cluster-v1] DONE. deleted=${deleted}`)
}

main().catch((err) => {
  console.error("[cleanup-cluster-v1] FATAL", err)
  process.exit(1)
})
