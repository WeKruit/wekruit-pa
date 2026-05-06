#!/usr/bin/env node
/**
 * v1.7 Phase 64 — Seed `pa-sponsorship-allowlist` Firestore collection.
 *
 * Reads `apps/functions/data/sponsorship-allowlist.json` (curated H-1B
 * data + manual additions, 200+ companies) and writes one Firestore doc
 * per company at `pa-sponsorship-allowlist/{slug}` where `slug =
 * company.toLowerCase().trim()` (matches `companySlug()` in
 * `src/lib/sponsorship-inference.ts`).
 *
 * Idempotent: re-running overwrites existing docs (last-writer-wins).
 *
 * DRY-RUN by default — print plan + slug examples. Use `--apply` to write.
 *
 * Usage:
 *   node scripts/seed-sponsorship-allowlist.mjs                  # dry-run
 *   node scripts/seed-sponsorship-allowlist.mjs --apply
 *   node scripts/seed-sponsorship-allowlist.mjs --project foo --apply
 */

import { initializeApp, cert, getApps } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const argv = process.argv.slice(2)
const DRY_RUN = !argv.includes("--apply")
const PROJECT = (() => {
  const idx = argv.indexOf("--project")
  return idx >= 0 ? argv[idx + 1] : "wekruit-5f89b"
})()

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const ALLOWLIST_PATH = resolve(__dirname, "..", "data", "sponsorship-allowlist.json")
const COLLECTION = "pa-sponsorship-allowlist"

// Mirror of `companySlug()` in `src/lib/sponsorship-inference.ts`.
// Keep these two in sync; tests guard the behavior on the lib side.
export function slugify(name) {
  if (!name || typeof name !== "string") return ""
  return name.trim().toLowerCase().replace(/\s+/g, " ")
}

function initFirebase() {
  if (getApps().length > 0) return
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
  if (credPath) {
    try {
      const cred = JSON.parse(readFileSync(credPath, "utf8"))
      initializeApp({ credential: cert(cred), projectId: PROJECT })
      return
    } catch {
      // fall through
    }
  }
  const inlineJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  if (inlineJson) {
    try {
      const cred = JSON.parse(inlineJson)
      initializeApp({ credential: cert(cred), projectId: PROJECT })
      return
    } catch {
      // fall through
    }
  }
  initializeApp({ projectId: PROJECT })
}

export function loadAllowlist(path = ALLOWLIST_PATH) {
  const raw = readFileSync(path, "utf8")
  const arr = JSON.parse(raw)
  if (!Array.isArray(arr)) throw new Error("allowlist JSON must be an array")
  const seen = new Set()
  const out = []
  for (const row of arr) {
    if (!row || typeof row !== "object") continue
    const slug = slugify(row.company)
    if (!slug) continue
    if (seen.has(slug)) {
      // last-writer-wins among dups within JSON
      const idx = out.findIndex((r) => r.slug === slug)
      if (idx >= 0) {
        out[idx] = { slug, ...row, sponsorship: row.sponsorship === true }
      }
      continue
    }
    seen.add(slug)
    out.push({
      slug,
      company: row.company,
      sponsorship: row.sponsorship === true ? true : row.sponsorship === false ? false : null,
      source: typeof row.source === "string" ? row.source : "manual_curation",
      confidence: typeof row.confidence === "number" ? row.confidence : 1.0,
    })
  }
  return out
}

async function main() {
  const startedAt = new Date().toISOString()
  console.log(
    `Phase 64 sponsorship-allowlist seed\n` +
      `  project=${PROJECT}\n` +
      `  mode=${DRY_RUN ? "DRY-RUN (no writes)" : "APPLY"}\n` +
      `  source=${ALLOWLIST_PATH}`
  )

  const entries = loadAllowlist()
  const sponsorCount = entries.filter((e) => e.sponsorship === true).length
  const nonSponsorCount = entries.filter((e) => e.sponsorship === false).length
  const nullCount = entries.filter((e) => e.sponsorship === null).length

  console.log(
    `  total=${entries.length}\n` +
      `    sponsors=${sponsorCount}\n` +
      `    non-sponsors=${nonSponsorCount}\n` +
      `    null/unknown=${nullCount}\n` +
      `  startedAt=${startedAt}\n`
  )

  console.log("first 10 slugs:")
  for (const e of entries.slice(0, 10)) {
    console.log(`  ${e.slug.padEnd(30)} → ${e.sponsorship} (conf=${e.confidence}, src=${e.source})`)
  }

  if (DRY_RUN) {
    console.log("\nDRY-RUN complete. Re-run with --apply to write.")
    return
  }

  initFirebase()
  const db = getFirestore()
  let written = 0
  let failed = 0
  const errors = []

  // Batched writes — 400 per batch to stay under the 500 op/batch limit.
  const BATCH_SIZE = 400
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const slice = entries.slice(i, i + BATCH_SIZE)
    const batch = db.batch()
    for (const e of slice) {
      const ref = db.collection(COLLECTION).doc(e.slug)
      batch.set(
        ref,
        {
          company: e.company,
          sponsorship: e.sponsorship,
          source: e.source,
          confidence: e.confidence,
          updatedAt: new Date().toISOString(),
        },
        { merge: true }
      )
    }
    try {
      await batch.commit()
      written += slice.length
      console.log(`  batch ${i / BATCH_SIZE + 1}: wrote ${slice.length} (running total: ${written})`)
    } catch (err) {
      failed += slice.length
      const msg = err?.message ?? String(err)
      errors.push({ batchStart: i, error: msg })
      console.error(`  batch ${i / BATCH_SIZE + 1} FAILED: ${msg}`)
    }
  }

  const completedAt = new Date().toISOString()
  console.log(
    `\nSeed complete.\n` +
      `  written=${written}\n` +
      `  failed=${failed}\n` +
      `  startedAt=${startedAt}\n` +
      `  completedAt=${completedAt}`
  )
  if (errors.length) {
    console.log("\nErrors:", JSON.stringify(errors.slice(0, 10), null, 2))
  }
}

const isMain =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] &&
  import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  main().catch((err) => {
    console.error("FATAL:", err?.stack ?? err?.message ?? String(err))
    process.exit(1)
  })
}
