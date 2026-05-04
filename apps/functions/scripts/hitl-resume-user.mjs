#!/usr/bin/env node
/**
 * iter31 — Operator resume script for HITL.
 *
 * Usage:
 *   node apps/functions/scripts/hitl-resume-user.mjs <userId> [reason...]
 *
 * Effect: sets user.runtimeMode = "auto" and audits.
 *
 * Adam directive 2026-05-04 ("on resume it won't say anything until next
 * texts"): NO outbound is enqueued by this script. The next user inbound
 * flows through the normal orchestrator path which will generate a reply.
 */
import { initializeApp, applicationDefault, getApps } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"

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
    console.error("usage: hitl-resume-user.mjs <userId> [reason...]")
    process.exit(2)
  }
  const setBy = process.env.USER || process.env.LOGNAME || "ops-script"
  const now = new Date().toISOString()
  await db.collection(COLLECTIONS.users).doc(userId).set(
    {
      runtimeMode: "auto",
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
    message: "Runtime mode set to auto (script)",
    meta: { mode: "auto", reason: reason || null, source: "hitl-resume-user.mjs" },
  })
  console.log(`✓ resumed ${userId} at ${now} by ${setBy}${reason ? ` — ${reason}` : ""}`)
  console.log(`  no auto-reply emitted; next user inbound triggers normal orchestrator path`)
}

main().catch((e) => {
  console.error("fatal", e)
  process.exit(1)
})
