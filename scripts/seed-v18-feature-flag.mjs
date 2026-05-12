#!/usr/bin/env node
/**
 * v1.8 Phase 81 — seed pa-feature-flags/onboarding-engine doc.
 *
 * Starts the shadow window: 5% cohort runs v2_shadow (double-write),
 * rest stays v1. Diff aggregator (paOnboardingShadowDiffSweep CF, future
 * deploy) reads pa-onboarding-shadow-diff for gate evaluation.
 */
import "dotenv/config"
import { readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import admin from "firebase-admin"

const envPath = "/Users/adam/Desktop/WeKruit/wekruit-pa/.env"
const env = readFileSync(envPath, "utf8")
const match = env.match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.+)$/m)
if (!match) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON missing")
const credPath = join(tmpdir(), `pa-cred-${Date.now()}.json`)
writeFileSync(credPath, match[1])
process.env.GOOGLE_APPLICATION_CREDENTIALS = credPath

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "wekruit-5f89b",
})
const db = admin.firestore()

const flag = {
  default: "v1",
  cohortPct: 5,
  users: {},
  description:
    "v1.8 PS10 — onboarding engine migration. v1=legacy, v2_shadow=double-write, v2=cutover. cohortPct=5 starts 7-day shadow window per PS10 cutover gate (< 1% diff rate over 7 days → flip default to v2).",
  createdAt: new Date().toISOString(),
  createdBy: "v1.8 milestone autonomous deploy",
}

await db.collection("pa-feature-flags").doc("onboarding-engine").set(flag, { merge: true })
const snap = await db.collection("pa-feature-flags").doc("onboarding-engine").get()
console.log("wrote pa-feature-flags/onboarding-engine:")
console.log(JSON.stringify(snap.data(), null, 2))
process.exit(0)
