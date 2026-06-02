#!/usr/bin/env node
/**
 * Set one Sendblue pool line's `capacity` field (Adam 2026-06-01: raise the 717
 * public candidate line 200 -> 350; a new number gets added later when we
 * approach it).
 *
 * SAFE: dry-run by default (prints before/after, writes NOTHING). Pass --apply
 * to perform the single-field write to pa-config/sendblue-pool. Idempotent:
 * re-running with the target already set is a no-op. Reads + mutates ONLY the
 * matching line's `capacity` in the legacy `numbers` array; every other field
 * and line is preserved verbatim (read whole array -> map -> write whole array).
 *
 * Usage (from apps/functions):
 *   node --import tsx scripts/set-sendblue-line-capacity.mjs                 # dry-run
 *   node --import tsx scripts/set-sendblue-line-capacity.mjs --apply         # write
 *   node --import tsx scripts/set-sendblue-line-capacity.mjs --number=+17174919939 --to=350 --apply
 */
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { cert, getApps, initializeApp } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"

const PROJECT_ID = "wekruit-5f89b"
const POOL_DOC = "pa-config/sendblue-pool"

const args = process.argv.slice(2)
const APPLY = args.includes("--apply")
const TARGET_NUMBER = (args.find((a) => a.startsWith("--number="))?.split("=")[1] ?? "+17174919939").trim()
const TARGET_CAP = Number(args.find((a) => a.startsWith("--to="))?.split("=")[1] ?? "350")

function loadServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS && existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)) {
    return JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8"))
  }
  for (const candidate of [
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "../../.env"),
    "/Users/adam/Desktop/WeKruit/wekruit-pa/.env",
  ]) {
    if (existsSync(candidate)) {
      const envText = readFileSync(candidate, "utf8")
      const match = envText.match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.+)$/m)
      if (match) return JSON.parse(match[1].replace(/^"/, "").replace(/"$/, ""))
    }
  }
  throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON missing. Export it or GOOGLE_APPLICATION_CREDENTIALS.")
}

function initDb() {
  if (!getApps().length) {
    const sa = loadServiceAccount()
    initializeApp({ credential: cert(sa), projectId: sa.project_id ?? PROJECT_ID })
  }
  return getFirestore()
}

function lineNumberOf(entry) {
  if (typeof entry === "string") return entry.trim()
  return String(entry?.number ?? entry?.phoneE164 ?? entry?.phone ?? "").trim()
}

async function main() {
  if (!Number.isFinite(TARGET_CAP) || TARGET_CAP <= 0) {
    throw new Error(`--to must be a positive number, got ${TARGET_CAP}`)
  }
  const db = initDb()
  const ref = db.doc(POOL_DOC)
  const snap = await ref.get()
  if (!snap.exists) throw new Error(`${POOL_DOC} does not exist`)
  const data = snap.data() ?? {}

  const numbers = Array.isArray(data.numbers) ? data.numbers : []
  if (!numbers.length) throw new Error(`${POOL_DOC} has no legacy 'numbers' array (shape changed?)`)

  console.log(`\n=== ${POOL_DOC} — BEFORE ===`)
  for (const entry of numbers) {
    if (typeof entry === "string") {
      console.log(`  ${entry}  (string-shorthand, no capacity field)`)
    } else {
      console.log(
        `  ${lineNumberOf(entry)} | label=${JSON.stringify(entry.label ?? "")} | status=${entry.status} | capacity=${entry.capacity} | adminOnly=${entry.adminOnly} | audience=${entry.audience}`,
      )
    }
  }

  let matched = 0
  let changed = 0
  const nextNumbers = numbers.map((entry) => {
    if (typeof entry === "string") return entry
    if (lineNumberOf(entry) !== TARGET_NUMBER) return entry
    matched += 1
    const prev = entry.capacity
    if (prev === TARGET_CAP) {
      console.log(`\n[noop] ${TARGET_NUMBER} capacity already ${TARGET_CAP}.`)
      return entry
    }
    changed += 1
    console.log(`\n[change] ${TARGET_NUMBER} capacity ${prev} -> ${TARGET_CAP}`)
    return { ...entry, capacity: TARGET_CAP }
  })

  if (matched === 0) throw new Error(`No line matched ${TARGET_NUMBER} in 'numbers' array — aborting (no write).`)
  if (matched > 1) throw new Error(`${matched} lines matched ${TARGET_NUMBER} — ambiguous, aborting (no write).`)

  if (changed === 0) {
    console.log("\nNothing to change. Exiting.")
    return
  }

  if (!APPLY) {
    console.log("\n=== DRY-RUN (no write). Re-run with --apply to commit. ===")
    return
  }

  // Single-field-on-one-line write: replace ONLY the `numbers` array, merge:true
  // so every other top-level field on the doc is untouched.
  await ref.set({ numbers: nextNumbers }, { merge: true })

  // Verify by re-reading.
  const after = (await ref.get()).data()?.numbers ?? []
  const verified = after.find((e) => typeof e !== "string" && lineNumberOf(e) === TARGET_NUMBER)
  console.log(`\n=== AFTER (re-read) ===`)
  console.log(
    `  ${TARGET_NUMBER} | capacity=${verified?.capacity} | status=${verified?.status} | adminOnly=${verified?.adminOnly} | audience=${verified?.audience}`,
  )
  if (verified?.capacity !== TARGET_CAP) throw new Error(`VERIFY FAILED: capacity is ${verified?.capacity}, expected ${TARGET_CAP}`)
  console.log(`\n✔ Wrote ${TARGET_NUMBER} capacity = ${TARGET_CAP}. All other fields/lines preserved.`)
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("\n✖", err?.message ?? err)
    process.exit(1)
  },
)
