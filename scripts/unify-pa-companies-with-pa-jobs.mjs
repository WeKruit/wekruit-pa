#!/usr/bin/env node
/**
 * Unify pa-companies with pa-jobs (employer-authored collab partners).
 *
 * Every distinct companyId in pa-jobs MUST have a pa-companies/{companyId}
 * row with wekruitCollab=true. Synthesize displayName from companyId when
 * no real metadata is present. Preserves any existing fields via
 * { merge: true }. Also bumps jobsCount to include pa-jobs entries (not
 * just scraped matching-jobs).
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
    const tmp = join(tmpdir(), `unify-${Date.now()}.json`)
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

function titleCaseSlug(slug) {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
}

const NOW = new Date().toISOString()

// 1. Walk pa-jobs → group jobs by companyId.
const allJobs = await db.collection("pa-jobs").get()
const counts = new Map() // companyId -> active job count
const samples = new Map() // companyId -> first job for displayName fallback
for (const d of allJobs.docs) {
  const j = d.data()
  const cid = typeof j.companyId === "string" ? j.companyId : null
  if (!cid) continue
  // Skip prod-smoke synthetic data.
  if (cid.startsWith("prod-smoke-")) continue
  counts.set(cid, (counts.get(cid) ?? 0) + 1)
  if (!samples.has(cid)) samples.set(cid, j)
}

console.log(`pa-jobs scanned: ${allJobs.size}`)
console.log(`distinct companyIds (excl smoke): ${counts.size}`)
for (const [cid, n] of counts) console.log(`  - ${cid}: ${n} job(s)`)

// 2. Upsert pa-companies/{cid} with wekruitCollab=true + synthesized displayName.
let created = 0
let updated = 0
for (const [cid, jobCount] of counts) {
  const existing = await db.collection("pa-companies").doc(cid).get()
  const sample = samples.get(cid) ?? {}
  const fallbackName =
    (typeof sample.companyName === "string" && sample.companyName.trim()) ||
    (typeof sample.company === "string" && sample.company.trim()) ||
    titleCaseSlug(cid)

  const patch = {
    wekruitCollab: true,
    jobsCount: jobCount,
    jobsCountUpdatedAt: NOW,
    updatedAt: NOW,
  }
  if (!existing.exists) {
    patch.id = cid
    patch.displayName = fallbackName
    patch.normalizedName = cid
    patch.companyStage = "unknown"
    patch.companyTags = []
    patch.enrichmentSource = "manual"
    patch.enrichedAt = NOW
    patch.createdAt = NOW
    patch.lastReviewedBy = "system@wekruit.com"
    created++
  } else {
    // Only set displayName if existing doc has none.
    const data = existing.data() ?? {}
    if (!data.displayName && !data.name) {
      patch.displayName = fallbackName
    }
    updated++
  }
  await db.collection("pa-companies").doc(cid).set(patch, { merge: true })
  console.log(`  ${existing.exists ? "UPDATED" : "CREATED"} pa-companies/${cid} (jobs=${jobCount}, name=${patch.displayName ?? existing.data()?.displayName ?? existing.data()?.name})`)
}

console.log(`\n✓ created ${created} new pa-companies docs`)
console.log(`✓ updated ${updated} existing pa-companies docs (wekruitCollab=true)`)

// 3. Verify.
const collabSnap = await db.collection("pa-companies").where("wekruitCollab", "==", true).get()
console.log(`\npost-state: pa-companies with wekruitCollab=true → ${collabSnap.size}`)
for (const d of collabSnap.docs) {
  const x = d.data()
  console.log(`  - ${d.id.padEnd(30)} name=${(x.displayName ?? x.name ?? "?").padEnd(25)} jobs=${x.jobsCount ?? 0}`)
}
