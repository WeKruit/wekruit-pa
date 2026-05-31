#!/usr/bin/env node
/**
 * generate-rec-cards.mjs — pre-generate + CACHE the JOB-LEVEL rec-card image for
 * every WeKruit collab job (Adam 2026-05-31 cached-per-job architecture).
 *
 * For each `pa-jobs where wekruitCollaborationStatus=="collaborated"`:
 *   1. backfill the company logo source (pa-companies.logoUrl/domain via Google
 *      favicon) when missing,
 *   2. render the card PNG WITH the real logo (logo pre-fetched → data: URI),
 *   3. upload it to Sendblue's media store → permanent, non-signed, .png CDN URL,
 *   4. write `matching-jobs/{jobId}.recCardMediaUrl` + `.recCardContentHash`.
 *
 * IDEMPOTENT: skips a job whose stored `recCardContentHash` already matches the
 * freshly-computed content hash (no re-render/upload). Pass `--force` to re-gen
 * regardless. Pass `--dry-run` to compute + log without writing.
 *
 * Runtime maybeSendRecCard then just READS recCardMediaUrl — no per-send render.
 *
 * Run (Node 24, from repo root):
 *   source ~/.zshrc && nvm use 24
 *   export GOOGLE_APPLICATION_CREDENTIALS=$(mktemp) && \
 *     grep -E "^FIREBASE_SERVICE_ACCOUNT_JSON=" .env | sed 's/^FIREBASE_SERVICE_ACCOUNT_JSON=//' | sed 's/^"//; s/"$//' > "$GOOGLE_APPLICATION_CREDENTIALS"
 *   # Sendblue creds (Firebase Secret Manager):
 *   export SENDBLUE_API_KEY_ID=$(firebase functions:secrets:access SENDBLUE_API_KEY_ID --project wekruit-5f89b)
 *   export SENDBLUE_API_SECRET_KEY=$(firebase functions:secrets:access SENDBLUE_API_SECRET_KEY --project wekruit-5f89b)
 *   node --import tsx apps/functions/scripts/generate-rec-cards.mjs [--force] [--dry-run]
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import admin from "firebase-admin"

import {
  generateRecCardForJob,
  recCardContentHash,
} from "../src/job-rec-card/job-rec-card.ts"
import { buildRecCardPayload } from "../src/job-rec-card/card-payload.ts"
import {
  REC_CARD_MEDIA_URL_FIELD,
  REC_CARD_CONTENT_HASH_FIELD,
} from "../src/job-rec-card/send-rec-card.ts"

const __dirname = dirname(fileURLToPath(import.meta.url))
const FORCE = process.argv.includes("--force")
const DRY = process.argv.includes("--dry-run")

// ── Firebase admin bootstrap ────────────────────────────────────────────────
function bootstrap() {
  if (admin.apps.length) return admin.firestore()
  // GOOGLE_APPLICATION_CREDENTIALS (file) OR FIREBASE_SERVICE_ACCOUNT_JSON (inline).
  let cred
  const inline = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  const gac = process.env.GOOGLE_APPLICATION_CREDENTIALS
  if (inline) {
    cred = admin.credential.cert(JSON.parse(inline))
  } else if (gac) {
    cred = admin.credential.cert(JSON.parse(readFileSync(gac, "utf8")))
  } else {
    cred = admin.credential.applicationDefault()
  }
  admin.initializeApp({ credential: cred, projectId: "wekruit-5f89b" })
  return admin.firestore()
}

function getCreds() {
  const apiKeyId = (process.env.SENDBLUE_API_KEY_ID ?? "").trim()
  const apiSecretKey = (process.env.SENDBLUE_API_SECRET_KEY ?? "").trim()
  if (!apiKeyId || !apiSecretKey) {
    console.error(
      "ERROR: SENDBLUE_API_KEY_ID / SENDBLUE_API_SECRET_KEY must be set (firebase functions:secrets:access).",
    )
    process.exit(2)
  }
  return { apiKeyId, apiSecretKey }
}

const log = (event, payload) => console.log(`  [${event}]`, payload ? JSON.stringify(payload) : "")

// ── Logo backfill: derive domain → Google favicon → write pa-companies.logoUrl ─
import {
  deriveCompanyDomain,
  googleFaviconUrl,
} from "../src/job-rec-card/card-payload.ts"

async function normName(name) {
  try {
    const { normalizeCompanyName } = await import("@pa/core-types")
    return normalizeCompanyName(name)
  } catch {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  }
}

async function loadCompany(db, companyName) {
  const key = await normName(companyName)
  if (!key) return { key: null, data: null }
  const snap = await db.collection("pa-companies").doc(key).get()
  return { key, data: snap.exists ? snap.data() : null }
}

/** Backfill logoUrl/domain on the pa-companies doc when missing. Returns the company data. */
async function backfillCompanyLogo(db, companyName) {
  const { key, data } = await loadCompany(db, companyName)
  const company = data ?? {}
  const hasLogo = typeof company.logoUrl === "string" && /^https:\/\//.test(company.logoUrl)
  const domain = deriveCompanyDomain({
    domain: company.domain,
    websiteUrl: company.websiteUrl,
    companyName,
  })
  if (!hasLogo && domain && key) {
    const favicon = googleFaviconUrl(domain)
    if (!DRY) {
      await db
        .collection("pa-companies")
        .doc(key)
        .set({ logoUrl: favicon, domain, logoSource: "google_favicon", logoBackfilledAt: new Date().toISOString() }, { merge: true })
    }
    company.logoUrl = favicon
    company.domain = domain
    log("logo.backfilled", { company: companyName, key, domain, favicon })
  } else {
    log("logo.kept", { company: companyName, key, hasLogo, domain: domain ?? null })
  }
  return company
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const db = bootstrap()
  const creds = getCreds()
  console.log(`\ngenerate-rec-cards ${DRY ? "(DRY-RUN)" : ""}${FORCE ? " (FORCE)" : ""}`)

  const snap = await db
    .collection("pa-jobs")
    .where("wekruitCollaborationStatus", "==", "collaborated")
    .get()
  console.log(`collab jobs: ${snap.size}\n`)

  const results = []
  for (const doc of snap.docs) {
    const jobId = doc.id
    const x = doc.data()
    const companyName = (x.companyName ?? x.company ?? "").trim()
    const job = {
      companyName,
      jobTitle: x.jobTitle ?? x.title ?? null,
      roleTitle: x.roleTitle ?? null,
      seniorityLevel: x.seniorityLevel ?? null,
      salaryMin: typeof x.salaryMin === "number" ? x.salaryMin : null,
      salaryMax: typeof x.salaryMax === "number" ? x.salaryMax : null,
      locationRaw: x.location ?? x.locationRaw ?? x.rawLocation ?? null,
      jobType: x.jobType ?? null,
      atsApplyUrl: x.atsApplyUrl ?? null,
      primaryUrl: x.primaryUrl ?? null,
    }
    console.log(`\n● ${jobId}  (${companyName})`)

    // 1. Backfill the company logo source.
    let company = null
    try {
      company = await backfillCompanyLogo(db, companyName)
    } catch (e) {
      log("logo.backfill_failed", { error: String(e?.message ?? e) })
    }

    // 2. Idempotency check — compute the job-level content hash; skip if unchanged.
    const payload = buildRecCardPayload({ job, company, reasons: null })
    if (!payload) {
      log("skip.unrenderable", { jobId })
      results.push({ jobId, status: "unrenderable" })
      continue
    }
    const freshHash = recCardContentHash(payload)
    const mjRef = db.collection("matching-jobs").doc(jobId)
    const mjSnap = await mjRef.get()
    const existingHash = mjSnap.exists ? mjSnap.data()?.[REC_CARD_CONTENT_HASH_FIELD] : undefined
    const existingUrl = mjSnap.exists ? mjSnap.data()?.[REC_CARD_MEDIA_URL_FIELD] : undefined
    if (!FORCE && existingUrl && existingHash === freshHash) {
      log("skip.unchanged", { jobId, hash: freshHash })
      results.push({ jobId, status: "unchanged", mediaUrl: existingUrl })
      continue
    }

    // 3. Render + upload to Sendblue.
    const gen = await generateRecCardForJob({ jobId, job, company, deps: { creds, log } })
    if (!gen) {
      log("gen.failed", { jobId })
      results.push({ jobId, status: "gen_failed" })
      continue
    }

    // 4. Persist on matching-jobs (the runtime reader's source).
    if (!DRY) {
      await mjRef.set(
        {
          [REC_CARD_MEDIA_URL_FIELD]: gen.mediaUrl,
          [REC_CARD_CONTENT_HASH_FIELD]: gen.contentHash,
          recCardGeneratedAt: new Date().toISOString(),
        },
        { merge: true },
      )
    }
    log("written", { jobId, mediaUrl: gen.mediaUrl, bytes: gen.bytes, hasLogo: Boolean(gen.payload.logoDataUri) })
    results.push({ jobId, status: DRY ? "dry_generated" : "written", mediaUrl: gen.mediaUrl })
  }

  console.log("\n──────── summary ────────")
  for (const r of results) console.log(`  ${r.status.padEnd(14)} ${r.jobId}${r.mediaUrl ? "  " + r.mediaUrl : ""}`)
  const written = results.filter((r) => r.status === "written" || r.status === "dry_generated").length
  const unchanged = results.filter((r) => r.status === "unchanged").length
  const failed = results.filter((r) => /failed|unrenderable/.test(r.status)).length
  console.log(`\n  written=${written} unchanged=${unchanged} failed=${failed} total=${results.length}`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error("FATAL:", e)
  process.exit(1)
})
