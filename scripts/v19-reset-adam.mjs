#!/usr/bin/env node
/**
 * v1.9 — Full reset of Adam's pa-user for clean live-SMS test.
 *
 * Adam directive 2026-05-12: "remove my current pa-user registration & run the
 * __PA_RESET__ so it's completely clean".
 *
 * Hard-deletes:
 *   - pa-users/{ADAM_UID}                          (entire user doc)
 *   - parsedCandidateResumes where userId == uid   (all resumes)
 *   - pa-prescreen-sessions/{ps_*_<uid>_*}         (active sessions)
 *   - pa-pii-confirm-state/{uid}                   (PII pipeline state)
 *   - pa-pii-confirm-meta/{uid}                    (PII source meta)
 *   - pa-prescreen-pending-invites/{uid}           (pending public-page invite)
 *   - pa-ats-pending-trigger/{phone}               (24h ATS-trigger virtualize)
 *   - pa-prescreen-trigger-idempotency/* with uid  (60-min idempotency stamps)
 *   - pa-apply-trigger-idempotency/* with uid      (Apply trigger stamps)
 *
 * Preserves intentionally (audit / forensics):
 *   - pa-messages                                  (transcript history)
 *   - pa-inbound-events / pa-outbound              (event log)
 *   - pa-audit-events                              (audit trail)
 *
 * After running this, Adam's NEXT inbound creates a fresh pa-users doc with
 * a new UID. His phone E.164 stays bound to the new uid via the webhook
 * lookup-or-create path.
 *
 * Run:  node scripts/v19-reset-adam.mjs
 *
 * Optional env: WKR_RESET_UID=<other-uid> to target a non-Adam user.
 */
import { readFileSync } from "node:fs"
import { homedir } from "node:os"

const PROJECT_ID = "wekruit-5f89b"
const ADAM_UID = process.env.WKR_RESET_UID ?? "e5d97cd8-1e1d-439d-8672-3008f8aeef2e"
const ADAM_PHONE = process.env.WKR_RESET_PHONE ?? "+14243201960"

// ─── Auth via firebase-tools cached OAuth token ─────────────────────────
const cfg = JSON.parse(
  readFileSync(`${homedir()}/.config/configstore/firebase-tools.json`, "utf8")
)
const tokRes = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_id:
      "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com",
    client_secret: "j9iVZfS8kkCEFUPaAeJV0sAi",
    refresh_token: cfg.tokens.refresh_token,
    grant_type: "refresh_token",
  }),
})
const { access_token } = await tokRes.json()
if (!access_token) {
  console.error("auth: no access_token — run `firebase login` first")
  process.exit(2)
}

const HDR = {
  authorization: `Bearer ${access_token}`,
  "content-type": "application/json",
}
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`

// ─── Helpers ────────────────────────────────────────────────────────────
async function deleteDoc(path) {
  const url = `${FS_BASE}/${path}`
  const res = await fetch(url, { method: "DELETE", headers: HDR })
  if (res.status === 200 || res.status === 404) return res.status === 200
  const body = await res.text()
  console.warn(`  ⚠ delete ${path} → ${res.status} ${body.slice(0, 120)}`)
  return false
}

async function runQuery(collection, fieldFilter) {
  const url = `${FS_BASE}:runQuery`
  const body = {
    structuredQuery: {
      from: [{ collectionId: collection }],
      where: fieldFilter,
      limit: 500,
    },
  }
  const res = await fetch(url, {
    method: "POST",
    headers: HDR,
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    console.warn(`  ⚠ query ${collection} failed: ${res.status}`)
    return []
  }
  const rows = await res.json()
  return rows
    .filter((r) => r.document)
    .map((r) => {
      // r.document.name = projects/.../databases/.../documents/<collection>/<docId>
      const parts = r.document.name.split("/documents/")[1]
      return parts
    })
}

async function deleteWhereUserId(collection, uid) {
  const docs = await runQuery(collection, {
    fieldFilter: {
      field: { fieldPath: "userId" },
      op: "EQUAL",
      value: { stringValue: uid },
    },
  })
  if (docs.length === 0) {
    console.log(`  · ${collection}: 0 matches`)
    return 0
  }
  let deleted = 0
  for (const p of docs) {
    if (await deleteDoc(p)) deleted++
  }
  console.log(`  ✓ ${collection}: ${deleted}/${docs.length} deleted`)
  return deleted
}

async function listCollectionIds(parent) {
  const url = `${FS_BASE}/${parent}:listCollectionIds`
  const res = await fetch(url, { method: "POST", headers: HDR, body: "{}" })
  if (!res.ok) return []
  const j = await res.json()
  return j.collectionIds ?? []
}

// ─── Main ───────────────────────────────────────────────────────────────
console.log(`v1.9 reset — target uid=${ADAM_UID}, phone=${ADAM_PHONE}\n`)

console.log("[1] pa-users doc (hard delete)")
await deleteDoc(`pa-users/${ADAM_UID}`)

console.log("[2] parsedCandidateResumes where userId == uid")
await deleteWhereUserId("parsedCandidateResumes", ADAM_UID)

console.log("[3] pa-prescreen-sessions where id contains uid")
// Sessions IDs are `ps_<jobId>_<uid>_<YYYYMMDD>`. Query by all-docs filter would
// be expensive; instead enumerate session docs and filter by ID prefix client-side.
{
  const url = `${FS_BASE}/pa-prescreen-sessions?pageSize=300`
  const res = await fetch(url, { headers: HDR })
  if (res.ok) {
    const j = await res.json()
    const docs = (j.documents ?? [])
      .map((d) => d.name.split("/documents/")[1])
      .filter((p) => p.includes(`_${ADAM_UID}_`))
    let n = 0
    for (const p of docs) {
      if (await deleteDoc(p)) n++
    }
    console.log(`  ✓ pa-prescreen-sessions: ${n}/${docs.length} deleted`)
  } else {
    console.log("  · pa-prescreen-sessions: list failed (non-fatal)")
  }
}

console.log("[4] pa-pii-confirm-state + pa-pii-confirm-meta")
await deleteDoc(`pa-pii-confirm-state/${ADAM_UID}`)
await deleteDoc(`pa-pii-confirm-meta/${ADAM_UID}`)

console.log("[5] pa-prescreen-pending-invites + pa-ats-pending-trigger")
await deleteDoc(`pa-prescreen-pending-invites/${ADAM_UID}`)
await deleteDoc(`pa-ats-pending-trigger/${encodeURIComponent(ADAM_PHONE)}`)

console.log("[6] pa-prescreen-trigger-idempotency + pa-apply-trigger-idempotency")
for (const coll of [
  "pa-prescreen-trigger-idempotency",
  "pa-apply-trigger-idempotency",
]) {
  const url = `${FS_BASE}/${coll}?pageSize=300`
  const res = await fetch(url, { headers: HDR })
  if (!res.ok) {
    console.log(`  · ${coll}: list failed (non-fatal)`)
    continue
  }
  const j = await res.json()
  const docs = (j.documents ?? [])
    .map((d) => d.name.split("/documents/")[1])
    .filter((p) => p.includes(ADAM_UID))
  let n = 0
  for (const p of docs) {
    if (await deleteDoc(p)) n++
  }
  console.log(`  ✓ ${coll}: ${n}/${docs.length} deleted`)
}

console.log("[7] pa-memory-* + pa-conversation-summaries + pa-tag-events (userId-keyed)")
for (const coll of [
  "pa-memory-facts",
  "pa-memory-actions",
  "pa-memory-events",
  "pa-memory-profiles",
  "pa-memory-evolution-events",
  "pa-conversation-summaries",
  "pa-tag-events",
  "pa-cv-pending",
  "pa-job-rec-explanations",
  "pa-scheduled-jobs",
]) {
  await deleteWhereUserId(coll, ADAM_UID)
}

console.log("[8] pa-entity-tags subcollection (entity-keyed)")
await deleteDoc(`pa-entity-tags/pa-user:${ADAM_UID}`)

console.log("\nReset done. Adam's next inbound SMS creates a fresh pa-users doc.")
console.log("Browser-side: localStorage.removeItem('wkr_uid') + localStorage.removeItem('wkr_has_cv')")
console.log("              to fully clean the public-page returning-user cache.\n")
