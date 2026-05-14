/**
 * One-shot backfill: write the three job-lifecycle fields on every pa-jobs
 * doc per the 2026-05-14 unified-job-lifecycle contract:
 *
 *   publicVisible: boolean
 *   wekruitCollaborationStatus: "collaborated" | "not_collaborated"
 *   candidatePageStatus: "draft" | "ready" | "published"
 *
 * Rules:
 *   - jobId begins with `hs-` and contains `invoko`        → collaborated, published, public
 *   - companyId starts with `rain-` (or jobId starts `rain-`) → not_collaborated, draft, NOT public
 *   - existing publicVisible === true                       → not_collaborated, published, public
 *   - everything else                                       → not_collaborated, draft, NOT public
 *
 * Idempotent: merge: true; only touches the three fields.
 */
import { initializeApp, applicationDefault, getApps } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"

interface JobDoc {
  companyId?: string
  publicVisible?: boolean
  wekruitCollaborationStatus?: string
  candidatePageStatus?: string
}

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes("--dryRun")
  if (!getApps().length) initializeApp({ credential: applicationDefault() })
  const db = getFirestore()
  const snap = await db.collection("pa-jobs").get()
  console.log(
    `[backfill-job-lifecycle] scanning ${snap.size} pa-jobs${dryRun ? " — DRY RUN" : ""}`,
  )

  interface Op {
    id: string
    publicVisible: boolean
    wekruitCollaborationStatus: "collaborated" | "not_collaborated"
    candidatePageStatus: "draft" | "ready" | "published"
    reason: string
  }
  const ops: Op[] = []
  let skip = 0
  for (const d of snap.docs) {
    const data = d.data() as JobDoc
    const id = d.id
    const companyId = (data.companyId ?? "").toLowerCase()
    let next: Omit<Op, "id">
    if (companyId.startsWith("rain") || id.toLowerCase().startsWith("rain-")) {
      next = {
        publicVisible: false,
        wekruitCollaborationStatus: "not_collaborated",
        candidatePageStatus: "draft",
        reason: "rain-sourced (admin-only)",
      }
    } else if (id.toLowerCase().includes("invoko")) {
      next = {
        publicVisible: true,
        wekruitCollaborationStatus: "collaborated",
        candidatePageStatus: "published",
        reason: "invoko collaborated",
      }
    } else if (data.publicVisible === true) {
      next = {
        publicVisible: true,
        wekruitCollaborationStatus: "not_collaborated",
        candidatePageStatus: "published",
        reason: "already-public test/non-partner",
      }
    } else {
      next = {
        publicVisible: false,
        wekruitCollaborationStatus: "not_collaborated",
        candidatePageStatus: "draft",
        reason: "default draft",
      }
    }
    // Skip when all three already match.
    if (
      data.publicVisible === next.publicVisible &&
      data.wekruitCollaborationStatus === next.wekruitCollaborationStatus &&
      data.candidatePageStatus === next.candidatePageStatus
    ) {
      skip += 1
      continue
    }
    ops.push({ id, ...next })
  }
  console.log(`[backfill-job-lifecycle] would update ${ops.length}, skip ${skip}`)
  for (const op of ops.slice(0, 10)) {
    console.log(
      `  ${op.id} → public=${op.publicVisible} collab=${op.wekruitCollaborationStatus} page=${op.candidatePageStatus} (${op.reason})`,
    )
  }
  if (dryRun) process.exit(0)
  for (let i = 0; i < ops.length; i += 400) {
    const slice = ops.slice(i, i + 400)
    const batch = db.batch()
    for (const op of slice) {
      const ref = db.collection("pa-jobs").doc(op.id)
      batch.set(
        ref,
        {
          publicVisible: op.publicVisible,
          wekruitCollaborationStatus: op.wekruitCollaborationStatus,
          candidatePageStatus: op.candidatePageStatus,
        },
        { merge: true },
      )
    }
    await batch.commit()
    console.log(`[backfill-job-lifecycle] wrote ${i + 1}..${i + slice.length}`)
  }
  console.log(`[backfill-job-lifecycle] DONE — updated ${ops.length}`)
  process.exit(0)
}

main().catch((err) => {
  console.error("[backfill-job-lifecycle] FAILED:", err)
  process.exit(1)
})
