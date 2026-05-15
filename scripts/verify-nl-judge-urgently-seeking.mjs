#!/usr/bin/env node
/**
 * Verify Done #6 — NL judge writes urgentlySeeking via tag-side-effects.
 *
 * Direct invocation of `applyTagSideEffect` against production Firestore.
 * Bypasses the downstream-trigger eval (which ships disabled by default)
 * to prove the runtime path works end-to-end.
 *
 * Pre-state: pa-users/{uid}.tags.urgentlySeeking missing or false.
 * Action:    applyTagSideEffect(db, uid, "mentioned_layoff", snippet)
 * Post:      pa-users/{uid}.tags.urgentlySeeking === true
 */
import { readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applicationDefault, cert, getApps, initializeApp } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"

function bootstrapCreds() {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      const env = readFileSync(".env", "utf8")
      const m = env.match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.+)$/m)
      if (m) process.env.FIREBASE_SERVICE_ACCOUNT_JSON = m[1].trim()
    } catch {}
  }
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const tmp = join(tmpdir(), `verify-nl-judge-${Date.now()}.json`)
    writeFileSync(tmp, process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
    process.env.GOOGLE_APPLICATION_CREDENTIALS = tmp
  }
}

bootstrapCreds()
if (!getApps().length) {
  const p = process.env.GOOGLE_APPLICATION_CREDENTIALS
  if (p) initializeApp({ credential: cert(JSON.parse(readFileSync(p, "utf8"))) })
  else initializeApp({ credential: applicationDefault() })
}
const db = getFirestore()

const USER_ID = process.env.PA_TEST_USER_ID ?? "verify-nl-judge-laid-off"
const SNIPPET = "I just got laid off from my last job."

// Reset state.
await db.collection("pa-users").doc(USER_ID).set(
  {
    tags: { urgentlySeeking: false, skills: [], industryEnum: [], schemaVersion: 1 },
    displayName: "verify-nl-judge synthetic",
    createdAt: new Date().toISOString(),
  },
  { merge: true },
)
console.log(`seeded pa-users/${USER_ID} with urgentlySeeking=false`)

const { applyTagSideEffect } = await import("../packages/pa-orchestrator/dist/tag-side-effects.js")
  .catch((e) => {
    console.error("compiled tag-side-effects missing; run `pnpm --filter pa-orchestrator build`", e.message)
    process.exit(2)
  })

await applyTagSideEffect(db, USER_ID, "mentioned_layoff", SNIPPET, (msg, fields) => {
  console.log(`[side-effect] ${msg}`, fields ?? "")
})

// Read back.
const snap = await db.collection("pa-users").doc(USER_ID).get()
const tags = (snap.data() ?? {}).tags ?? {}
console.log("\npost-state tags subset:")
console.log("  urgentlySeeking:", tags.urgentlySeeking)
console.log("  companyNegativeList:", tags.companyNegativeList ?? "(unset)")
console.log("  companyPositiveList:", tags.companyPositiveList ?? "(unset)")

if (tags.urgentlySeeking === true) {
  console.log("\nPASS — Done #6: NL judge laid-off side-effect writes urgentlySeeking=true")
  process.exit(0)
} else {
  console.log("\nFAIL — urgentlySeeking did NOT flip to true")
  process.exit(1)
}
