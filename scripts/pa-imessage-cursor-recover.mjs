#!/usr/bin/env node
/**
 * One-shot iMessage cursor recovery — find the highest already-processed
 * inbound ROWID in `pa_messages` and seed `pa_worker_cursors/{workerId}`
 * with it. After this runs, the worker's next boot will pick `source=firestore`
 * and catchup any messages that arrived after that ROWID but before its boot.
 *
 * Usage:
 *   FIREBASE_SERVICE_ACCOUNT_JSON='{...}' \
 *   node scripts/pa-imessage-cursor-recover.mjs [--worker-id=imessage-default] [--dry-run] [--from=<rowId>]
 *
 *   --worker-id   Override worker id (default: imessage-default).
 *   --dry-run     Print discovered max rowId without writing the cursor.
 *   --from=N      Skip discovery, force cursor to N (manual override).
 *
 * Idempotency-safe: replays produce no duplicate outbound because
 * `appendMessage(idempotencyKey="imessage-in-${rowId}")` collision-merges
 * and `findMessageByIdempotencyKey("out-${k}")` short-circuits already-replied.
 */
import { initializeApp, getApps, cert, applicationDefault } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"

const args = process.argv.slice(2)
const DRY = args.includes("--dry-run")
const workerArg = args.find((a) => a.startsWith("--worker-id="))
const fromArg = args.find((a) => a.startsWith("--from="))
const WORKER_ID = workerArg ? workerArg.split("=")[1] : "imessage-default"
const FORCED_FROM = fromArg ? Number(fromArg.split("=")[1]) : null

function initFirebase() {
  if (getApps().length) return
  const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  if (json) {
    try {
      initializeApp({ credential: cert(JSON.parse(json)) })
      return
    } catch (e) {
      console.error("[init] FIREBASE_SERVICE_ACCOUNT_JSON parse failed:", e.message)
    }
  }
  initializeApp({ credential: applicationDefault() })
}

function parseRowIdFromKey(key) {
  // idempotencyKey shape: `imessage-in-${rowId}`
  if (typeof key !== "string") return NaN
  const prefix = "imessage-in-"
  if (!key.startsWith(prefix)) return NaN
  return Number(key.slice(prefix.length))
}

async function discoverMaxRowId(db) {
  // Range-scan idempotencyKey range covers `imessage-in-*` cleanly.
  const snap = await db
    .collection("pa_messages")
    .where("idempotencyKey", ">=", "imessage-in-")
    .where("idempotencyKey", "<", "imessage-in.") // ASCII '.' > '-'
    .select("idempotencyKey")
    .get()
  let max = 0
  for (const doc of snap.docs) {
    const rowId = parseRowIdFromKey(doc.get("idempotencyKey"))
    if (Number.isFinite(rowId) && rowId > max) max = rowId
  }
  return { max, scanned: snap.size }
}

async function main() {
  initFirebase()
  const db = getFirestore()

  let target
  if (FORCED_FROM !== null) {
    if (!Number.isFinite(FORCED_FROM) || FORCED_FROM < 0) {
      console.error(`[recover] invalid --from=${FORCED_FROM}`)
      process.exit(2)
    }
    target = FORCED_FROM
    console.log(`[recover] manual override --from=${target}`)
  } else {
    const { max, scanned } = await discoverMaxRowId(db)
    console.log(`[recover] scanned ${scanned} processed inbound docs, max rowId=${max}`)
    if (max <= 0) {
      console.error("[recover] no processed inbound rows found — nothing to seed")
      process.exit(1)
    }
    target = max
  }

  if (DRY) {
    console.log(`[recover] DRY RUN — would seed pa_worker_cursors/${WORKER_ID} = ${target}`)
    return
  }

  const ref = db.collection("pa_worker_cursors").doc(WORKER_ID)
  await ref.set(
    {
      workerId: WORKER_ID,
      channel: "imessage",
      lastRowId: target,
      updatedAt: new Date().toISOString(),
      seededByRecoverScript: true,
    },
    { merge: true }
  )
  console.log(`[recover] cursor seeded: pa_worker_cursors/${WORKER_ID} lastRowId=${target}`)
  console.log(`[recover] restart worker — log will show: source=firestore from row ${target}`)
}

main().catch((e) => {
  console.error("[recover] failed:", e)
  process.exit(1)
})
