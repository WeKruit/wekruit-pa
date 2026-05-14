/**
 * One-shot backfill: re-parse `rawPayload.Link` on every
 * `pa-external-candidate-records` row and write the multi-link result to
 * `enrichment.links`. Lessie packs linkedin + github + x + medium into a
 * single cell; v1 of the adapter only kept the first linkedin link.
 *
 * Usage:
 *   export GOOGLE_APPLICATION_CREDENTIALS=$(mktemp) && ...
 *   node --import tsx apps/functions/scripts/backfill-record-links.ts
 *     [--batchId=<id>] [--dryRun]
 */
import { initializeApp, applicationDefault, getApps } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { parseLinkCell } from "@pa/external-supply"

async function main() {
  const args = process.argv.slice(2)
  const batchIdArg = args.find((a) => a.startsWith("--batchId="))?.split("=")[1]
  const dryRun = args.includes("--dryRun")
  if (!getApps().length) initializeApp({ credential: applicationDefault() })
  const db = getFirestore()

  let q: FirebaseFirestore.Query = db.collection("pa-external-candidate-records")
  if (batchIdArg) q = q.where("batchId", "==", batchIdArg)
  const snap = await q.get()
  console.log(
    `[backfill-links] scanning ${snap.size} records (batchId=${batchIdArg ?? "all"})${dryRun ? " — DRY RUN" : ""}`,
  )

  let updated = 0
  let skipped = 0
  const ops: Array<{ id: string; links: ReturnType<typeof parseLinkCell> }> = []
  for (const d of snap.docs) {
    const data = d.data() as {
      rawPayload?: Record<string, unknown>
      enrichment?: Record<string, unknown>
    }
    const raw = data.rawPayload ?? {}
    // Possible header keys for the link column — Lessie uses "Link", others
    // may use linkedin / linkedinUrl / Profile.
    const candidates: string[] = []
    for (const key of ["Link", "link", "LinkedIn", "LinkedIn URL", "linkedinUrl", "Profile", "URL"]) {
      if (typeof raw[key] === "string" && (raw[key] as string).trim()) {
        candidates.push(raw[key] as string)
      }
    }
    if (candidates.length === 0) {
      skipped += 1
      continue
    }
    const links = parseLinkCell(candidates.join("\n"))
    if (links.length === 0) {
      skipped += 1
      continue
    }
    const existing = (data.enrichment?.links ?? []) as Array<{ url?: string }>
    const existingUrls = new Set(existing.map((l) => l.url).filter(Boolean))
    const newUrls = links.map((l) => l.url)
    // Skip when nothing new + everything already classified.
    if (existing.length === links.length && newUrls.every((u) => existingUrls.has(u))) {
      skipped += 1
      continue
    }
    ops.push({ id: d.id, links })
    updated += 1
  }
  console.log(`[backfill-links] would update ${updated}, skip ${skipped}`)

  if (dryRun) {
    for (const op of ops.slice(0, 5)) {
      console.log(`  ${op.id} → ${JSON.stringify(op.links)}`)
    }
    process.exit(0)
  }

  // Chunked writes (max 400 per batch to leave headroom).
  for (let i = 0; i < ops.length; i += 400) {
    const slice = ops.slice(i, i + 400)
    const batch = db.batch()
    for (const op of slice) {
      const ref = db.collection("pa-external-candidate-records").doc(op.id)
      batch.set(ref, { enrichment: { links: op.links } }, { merge: true })
    }
    await batch.commit()
    console.log(`[backfill-links] wrote ${i + 1}..${i + slice.length}`)
  }
  console.log(`[backfill-links] DONE — updated ${updated} records`)
  process.exit(0)
}

main().catch((err) => {
  console.error("[backfill-links] FAILED:", err)
  process.exit(1)
})
