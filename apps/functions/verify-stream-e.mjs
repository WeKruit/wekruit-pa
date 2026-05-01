/**
 * Stream E live-verify snippet — run with `node verify-stream-e.mjs` from
 * apps/functions/. Service account at /Users/adam/Downloads/wekruit-5f89b-e79a30c4ccd1.json.
 *
 * Validates that Adam's most recent CV upload (after deploy 05:17 UTC
 * 2026-05-01, revision pasendbluewebhook-00042-joh) produced:
 *   1. parsedCandidateResumes/<auto-id> — Stream D output (pre-existing)
 *   2. pa-outbound/out-cvfindings-<resumeId> — Stream E1 output (NEW)
 *   3. mem0 fact in Qdrant 'pa-memory' partition userId=e5d97cd8-... (NEW; verify via mem0Search)
 */
import admin from "firebase-admin"
import { readFileSync } from "node:fs"

const sa = JSON.parse(readFileSync("/Users/adam/Downloads/wekruit-5f89b-e79a30c4ccd1.json", "utf8"))
admin.initializeApp({ credential: admin.credential.cert(sa) })
const db = admin.firestore()

const ADAM_PA_USER = "e5d97cd8-1e1d-439d-8672-3008f8aeef2e"
const ADAM_PHONE = "+14243201960"
const DEPLOY_CUTOFF_ISO = "2026-05-01T05:17:00.000Z"

// 1. webhook-raw rows for Adam since deploy
const rawAll = await db.collection("pa-sendblue-webhook-raw").limit(60).get()
const adamRecent = rawAll.docs
  .map((d) => ({ id: d.id, x: d.data() }))
  .filter(({ x }) => {
    if (!x.receivedAt || x.receivedAt < DEPLOY_CUTOFF_ISO) return false
    try {
      return JSON.parse(x.bodyText ?? "{}").from_number === ADAM_PHONE
    } catch {
      return false
    }
  })
  .sort((a, b) => (b.x.receivedAt ?? "").localeCompare(a.x.receivedAt ?? ""))
console.log(`\n[1] webhook-raw from Adam since ${DEPLOY_CUTOFF_ISO}: ${adamRecent.length}`)
const cvUploads = adamRecent.filter(({ x }) => {
  try { return !!JSON.parse(x.bodyText).media_url } catch { return false }
})
console.log(`    of which CV uploads (media_url present): ${cvUploads.length}`)
for (const { id, x } of cvUploads.slice(0, 3)) {
  let body = {}; try { body = JSON.parse(x.bodyText) } catch {}
  console.log(`    - ${id} ${x.receivedAt} media=${(body.media_url ?? "").slice(0, 80)}`)
}

// 2. parsedCandidateResumes rows for Adam since deploy
const cvAll = await db.collection("parsedCandidateResumes").where("userId", "==", ADAM_PA_USER).limit(20).get()
const cvRecent = cvAll.docs
  .map((d) => ({ id: d.id, x: d.data() }))
  .filter(({ x }) => (x.ingestedAt ?? "") >= DEPLOY_CUTOFF_ISO)
  .sort((a, b) => (b.x.ingestedAt ?? "").localeCompare(a.x.ingestedAt ?? ""))
console.log(`\n[2] parsedCandidateResumes for Adam since deploy: ${cvRecent.length}`)
for (const { id, x } of cvRecent) {
  console.log(`    - ${id} ingestedAt=${x.ingestedAt} ingestedVia=${x.ingestedVia} name=${x.candidateProfile?.name}`)
}

// 3. pa-outbound out-cvfindings-* rows
const outAll = await db.collection("pa-outbound").limit(50).get()
const cvf = outAll.docs.filter((d) => d.id.startsWith("out-cvfindings-"))
console.log(`\n[3] pa-outbound out-cvfindings-* rows (any time): ${cvf.length}`)
for (const d of cvf) {
  const x = d.data()
  console.log(`    - ${d.id} status=${x.status} createdAt=${x.createdAt} createdBy=${x.createdBy}`)
  console.log(`      body: "${(x.body ?? "").slice(0, 140)}..."`)
  if (x.error) console.log(`      ERROR: ${x.error}`)
}

// 4. Verdict
console.log(`\n=== VERDICT ===`)
if (cvUploads.length === 0) {
  console.log(`  ⏳ No CV upload from Adam since deploy (${DEPLOY_CUTOFF_ISO}). Have Adam re-send a CV; rerun this script.`)
} else if (cvRecent.length === 0) {
  console.log(`  ⚠ Webhook saw CV upload(s) but Stream D didn't write parsedCandidateResumes. Check pa-orchestrator function logs for cv-ingest errors.`)
} else if (cvf.length === 0) {
  console.log(`  ⚠ Stream D wrote parsedCandidateResumes but Stream E1 (cv-findings followup) didn't enqueue. Check logs for pa.cv_followup.error`)
} else {
  const lastResumeId = cvRecent[0].id
  const expectedDocId = `out-cvfindings-${lastResumeId}`
  const found = cvf.find((d) => d.id === expectedDocId)
  if (found) {
    console.log(`  ✅ Stream E1 verified: ${expectedDocId} exists, status=${found.data().status}`)
  } else {
    console.log(`  ⚠ Latest resumeId=${lastResumeId} but no matching out-cvfindings-${lastResumeId} doc.`)
  }
}
console.log(`  ℹ Stream E2 (Mem0 write): no Firestore artifact — verify via mem0Search or 'pa.cv_mem0.ok' log line in pa-orchestrator function logs.`)

process.exit(0)
