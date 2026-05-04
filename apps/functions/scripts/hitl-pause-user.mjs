#!/usr/bin/env node
/**
 * iter31 — Operator pause script for HITL.
 *
 * Usage:
 *   node apps/functions/scripts/hitl-pause-user.mjs <userId> [reason...]
 *   node apps/functions/scripts/hitl-pause-user.mjs e5d97cd8-... "investigating reply quality regression"
 *
 * Auth:
 *   Requires GOOGLE_APPLICATION_CREDENTIALS pointed at a Firebase admin
 *   service-account JSON, or a logged-in `gcloud auth application-default
 *   login` session with project access.
 *
 * Effect:
 *   Sets user.runtimeMode = "paused", user.runtimeModeAt, user.runtimeModeSetBy,
 *   user.runtimeModeReason. Appends pa-audit-events row.
 *
 * Orchestrator skips reply generation but still appends inbound to pa-messages
 * so memory + audit are preserved while the operator works manually.
 */
import { initializeApp, applicationDefault, getApps } from "firebase-admin/app"
import { getFirestore, FieldValue } from "firebase-admin/firestore"

const PROJECT_ID = process.env.PA_FIREBASE_PROJECT_ID || "wekruit-5f89b"
const COLLECTIONS = { users: "pa-users", auditEvents: "pa-audit-events" }

if (!getApps().length) {
  initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID })
}
const db = getFirestore()

async function main() {
  const args = process.argv.slice(2)
  const userId = args[0]
  const reason = args.slice(1).join(" ")
  if (!userId) {
    console.error("usage: hitl-pause-user.mjs <userId> [reason...]")
    process.exit(2)
  }
  const setBy = process.env.USER || process.env.LOGNAME || "ops-script"
  const now = new Date().toISOString()
  await db.collection(COLLECTIONS.users).doc(userId).set(
    {
      runtimeMode: "paused",
      runtimeModeAt: now,
      runtimeModeSetBy: setBy,
      ...(reason ? { runtimeModeReason: reason } : {}),
      updatedAt: now,
    },
    { merge: true }
  )
  await db.collection(COLLECTIONS.auditEvents).add({
    kind: "hitl_runtime_mode",
    userId,
    actor: setBy,
    createdAt: now,
    message: "Runtime mode set to paused (script)",
    meta: { mode: "paused", reason: reason || null, source: "hitl-pause-user.mjs" },
  })
  console.log(`✓ paused ${userId} at ${now} by ${setBy}${reason ? ` — ${reason}` : ""}`)
  console.log(`  inbound writes still flow into pa-messages; outbound suppressed`)
  console.log(`  resume with: node apps/functions/scripts/hitl-resume-user.mjs ${userId} [reason]`)
}

main().catch((e) => {
  console.error("fatal", e)
  process.exit(1)
})
// FieldValue not used today but exported in case future caller wants `serverTimestamp`.
void FieldValue
