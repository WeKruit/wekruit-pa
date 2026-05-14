#!/usr/bin/env node
/**
 * P2 live smoke — pick one existing wekruit-pa external-supply batch on prod
 * that has no `sourcing.runId` yet, run the bridge against the deployed
 * sourcing-api, then assert:
 *   1. wekruit-pa batch doc now carries `sourcing.runId`
 *   2. sourcing-api `/api/sourcing/source-runs/:runId/source-records` returns
 *      the synced records.
 *
 * Run with GOOGLE_APPLICATION_CREDENTIALS pointing at the wekruit-5f89b SA
 * exported from the wekruit-pa .env file (see CLAUDE.md operational anchors).
 *
 * Usage:
 *   node apps/functions/scripts/smoke-sourcing-bridge.mjs [batchId]
 *
 * If batchId is omitted, picks the first batch (orderBy createdAt desc) that
 * lacks `sourcing.runId`. Idempotent: a second run skips already-synced.
 */
import process from "node:process"
import { initializeApp, applicationDefault, getApps } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"

const SOURCING_BASE = process.env.SOURCING_API_BASE_URL ?? "https://us-central1-wekruit-5f89b.cloudfunctions.net/sourcing-api"
const SOURCING_DOMAIN = "wekruit-pa"
const SOURCING_NAME = "wekruit-pa-external-supply"
const BATCH_UPSERT_MAX = 100

if (!getApps().length) {
  initializeApp({ credential: applicationDefault() })
}
const db = getFirestore()

async function pickUnsyncedBatch(explicitId) {
  if (explicitId) {
    const snap = await db.collection("pa-external-sourcing-batches").doc(explicitId).get()
    if (!snap.exists) throw new Error(`batch ${explicitId} not found`)
    return { batchId: explicitId, data: snap.data() }
  }
  const q = await db
    .collection("pa-external-sourcing-batches")
    .orderBy("createdAt", "desc")
    .limit(20)
    .get()
  for (const doc of q.docs) {
    const data = doc.data()
    if (!data?.sourcing?.runId) {
      return { batchId: doc.id, data }
    }
  }
  throw new Error("no unsynced batch found in latest 20")
}

async function loadRecords(batchId) {
  const q = await db.collection("pa-external-candidate-records").where("batchId", "==", batchId).get()
  return q.docs.map((d) => d.data())
}

function mapRecord(r, runId, batch) {
  const out = {
    sourceRecordId: r.recordId,
    runId,
    domain: SOURCING_DOMAIN,
    source: SOURCING_NAME,
    sourceNativeId: r.recordId,
    entityType: "person",
    raw: {
      wekruitPaBatchId: batch.batchId,
      sourceTag: r.source,
      recordId: r.recordId,
      name: r.name ?? null,
      linkedinUrl: r.canonicalLinkedInUrl ?? null,
      emails: r.emails ?? [],
      phoneHash: r.phoneHash ?? null,
      currentTitle: r.currentTitle ?? null,
      currentCompany: r.currentCompany ?? null,
      location: r.location ?? null,
      experience: r.experience ?? [],
      education: r.education ?? [],
      sourceTags: r.sourceTags ?? [],
      // CRITICAL — enrichment.links[] is the only place v2.3-parsed records
      // store linkedin/github URLs when canonicalLinkedInUrl is absent. The
      // vendor-profile-lookup pickers fall back to this.
      enrichment: r.enrichment ?? null,
      identityResolutionStatus: r.identityResolutionStatus ?? null,
      resolvedUserId: r.resolvedUserId ?? null,
      reviewReasons: r.reviewReasons ?? [],
    },
  }
  if (r.name) out.displayName = r.name
  if (r.canonicalLinkedInUrl) out.sourceUrl = r.canonicalLinkedInUrl
  if (r.currentCompany) out.institution = r.currentCompany
  return out
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = text }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}: ${text.slice(0, 300)}`)
  return json
}

async function main() {
  const explicitId = process.argv[2]
  const { batchId, data: batch } = await pickUnsyncedBatch(explicitId)
  console.log(`[smoke] picked batch ${batchId} (source=${batch.source}, rowCount=${batch.rowCount})`)
  const records = await loadRecords(batchId)
  console.log(`[smoke] loaded ${records.length} candidate records`)

  if (records.length === 0) {
    console.log("[smoke] empty batch — nothing to sync")
    return
  }

  console.log(`[smoke] POST ${SOURCING_BASE}/api/sourcing/source-runs`)
  const runResp = await postJson(`${SOURCING_BASE}/api/sourcing/source-runs`, {
    sourceName: SOURCING_NAME,
    sourceDomain: SOURCING_DOMAIN,
    pipelineName: "external-supply",
    trigger: "api",
    metadata: {
      wekruitPaBatchId: batchId,
      smokeRun: true,
      sourceTag: batch.source,
      companyId: batch.companyId ?? null,
      jobId: batch.jobId ?? null,
      sha256: batch.rawFileRef?.sha256,
      rowCount: batch.rowCount,
    },
  })
  const runId = runResp.runId ?? runResp.id ?? runResp.data?.id
  if (!runId) {
    console.error("[smoke] failed to extract runId from response", runResp)
    process.exit(1)
  }
  console.log(`[smoke] created sourcing runId=${runId}`)

  for (let i = 0; i < records.length; i += BATCH_UPSERT_MAX) {
    const chunk = records.slice(i, i + BATCH_UPSERT_MAX)
    const payload = { runId, records: chunk.map((r) => mapRecord(r, runId, batch)) }
    const resp = await postJson(`${SOURCING_BASE}/api/sourcing/source-records:batchUpsert`, payload)
    console.log(`[smoke] batchUpsert ${i + 1}..${i + chunk.length} -> ${JSON.stringify(resp).slice(0, 120)}`)
  }

  const completeResp = await postJson(
    `${SOURCING_BASE}/api/sourcing/source-runs/${encodeURIComponent(runId)}/complete`,
    { status: "completed" },
  )
  console.log(`[smoke] completed run -> ${JSON.stringify(completeResp).slice(0, 200)}`)

  await db
    .collection("pa-external-sourcing-batches")
    .doc(batchId)
    .set({ sourcing: { runId, syncedAt: new Date().toISOString(), smoke: true } }, { merge: true })

  console.log(`\n[smoke] verifying...`)
  const verifyRecords = await fetch(
    `${SOURCING_BASE}/api/sourcing/source-runs/${encodeURIComponent(runId)}/source-records`,
  )
  if (!verifyRecords.ok) {
    console.error(`[smoke] verify GET failed: ${verifyRecords.status}`)
    process.exit(1)
  }
  const verifyJson = await verifyRecords.json()
  const synced = Array.isArray(verifyJson.data) ? verifyJson.data : []
  console.log(`[smoke] sourcing-source-records?runId=${runId} -> count=${synced.length} (expected ${records.length})`)

  const writeBack = (await db.collection("pa-external-sourcing-batches").doc(batchId).get()).data()
  console.log(`[smoke] writeback: ${JSON.stringify(writeBack?.sourcing)}`)
  if (synced.length === records.length && writeBack?.sourcing?.runId === runId) {
    console.log("\n[smoke] ✅ PASS")
  } else {
    console.log("\n[smoke] ❌ FAIL — counts mismatch or writeback missing")
    process.exit(1)
  }
}

main().catch((err) => {
  console.error("[smoke] FAILED:", err)
  process.exit(1)
})
