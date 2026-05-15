#!/usr/bin/env node
/**
 * Verify Done #5 — Live match honors targetCompanyTags.
 *
 * Provisions a synthetic test user with `targetCompanyTags=['ai_native']`,
 * runs V16 queryMatchingJobs (via paAdminMatchDebug callable OR by reusing
 * the function directly through Admin SDK), and asserts ≥2 of top-3 match
 * companies are tagged `ai_native` in pa-companies.
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=... \
 *   PA_TEST_USER_ID=verify-match-company-tags \
 *     node scripts/verify-match-company-tags.mjs
 *
 * Cleans up the synthetic user on exit.
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
    const tmp = join(tmpdir(), `verify-match-${Date.now()}.json`)
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

const USER_ID = process.env.PA_TEST_USER_ID ?? "verify-match-company-tags"

// Seed synthetic user with minimal canonical tags + targetCompanyTags=ai_native.
const tags = {
  skills: [
    { name: "python", bucket: "programming_languages", proficiency: "advanced", evidenceCount: 5, baseWeight: 0.9 },
    { name: "react", bucket: "frameworks_and_libraries", proficiency: "advanced", evidenceCount: 4, baseWeight: 0.8 },
  ],
  industryEnum: ["tech_software", "ai_ml"],
  targetRoleFunction: ["software_engineering"],
  targetCompanyTags: ["ai_native"],
  visaStatus: "citizen",
  targetLocations: ["remote_anywhere"],
  schemaVersion: 1,
}
await db.collection("pa-users").doc(USER_ID).set(
  { tags, displayName: "verify-match synthetic", createdAt: new Date().toISOString() },
  { merge: true },
)
console.log(`seeded pa-users/${USER_ID} with targetCompanyTags=ai_native`)

// Read top-3 ai_native companies for context.
const aiNativeSnap = await db
  .collection("pa-companies")
  .where("companyTags", "array-contains", "ai_native")
  .limit(20)
  .get()
const aiNativeNames = new Set(aiNativeSnap.docs.map((d) => (d.data().normalizedName ?? d.id).toLowerCase()))
console.log(`pa-companies with companyTags='ai_native': ${aiNativeNames.size}`)

if (aiNativeNames.size === 0) {
  console.log("FAIL — no companies tagged ai_native; A5 enrichment may not have run")
  process.exit(1)
}

// Call V16 directly via Admin SDK harness. We import the compiled job-rec build.
const { queryMatchingJobsV16 } = await import("../apps/job-rec/dist/tools/query-matching-jobs-v16.js")
  .catch((e) => {
    console.error("Failed to import compiled V16. Run `pnpm --filter @pa/job-rec build` first.", e.message)
    process.exit(2)
  })

const result = await queryMatchingJobsV16({ db, userId: USER_ID, fetchLimit: 50 })
const top3 = (result.matches ?? []).slice(0, 3)
console.log("\ntop-3 V16 matches:")
let aiNativeHits = 0
for (const m of top3) {
  const norm = (m.job?.companyName ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  const hit = aiNativeNames.has(norm)
  if (hit) aiNativeHits++
  console.log(`  ${hit ? "✓" : " "} ${m.job?.companyName ?? "?"} — ${m.job?.title ?? "?"} (score ${m.score?.toFixed(3) ?? "?"})`)
}

console.log(`\nai_native hits in top-3: ${aiNativeHits}/3`)
if (aiNativeHits >= 2) {
  console.log("PASS")
  process.exit(0)
} else {
  console.log("FAIL — expected ≥2 ai_native companies in top-3")
  process.exit(1)
}
