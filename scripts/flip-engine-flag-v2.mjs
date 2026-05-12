#!/usr/bin/env node
/**
 * Adam directive 2026-05-12: skip shadow, flip default v1→v2 directly.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import admin from "firebase-admin"

const env = readFileSync("/Users/adam/Desktop/WeKruit/wekruit-pa/.env", "utf8")
const m = env.match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.+)$/m)
if (!m) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON missing")
const credPath = join(tmpdir(), `pa-cred-${Date.now()}.json`)
writeFileSync(credPath, m[1])
process.env.GOOGLE_APPLICATION_CREDENTIALS = credPath

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "wekruit-5f89b",
})
const db = admin.firestore()

await db.collection("pa-feature-flags").doc("onboarding-engine").set(
  {
    default: "v2",
    cohortPct: 0,
    users: {},
    description: "v1.8 — Adam directive 2026-05-12: skip 7-day shadow, flip default to v2 directly. ShadowDiffSweep still runs for monitoring.",
    updatedAt: new Date().toISOString(),
    updatedBy: "Adam directive: skip shadow",
  },
  { merge: false }
)
const snap = await db.collection("pa-feature-flags").doc("onboarding-engine").get()
console.log("flag flipped:")
console.log(JSON.stringify(snap.data(), null, 2))
process.exit(0)
