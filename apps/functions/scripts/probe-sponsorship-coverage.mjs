#!/usr/bin/env node
/**
 * v1.7 Phase 64 — Live coverage probe for `matching-jobs.sponsorship`.
 *
 * Reads up to N (default 2000) active matching-jobs and prints the
 * distribution of `sponsorship` (true/false/null/missing) plus a sample.
 *
 * Used to verify Phase 64 backfill progress and v1.6 D4 visa hard filter
 * health. Prior to the v1.9.0 auto-enrich trigger fix (commit f979a9e),
 * boolean coverage was 5.6% (84 true + 28 false / 2000) — far below the
 * Phase 64 target. Post-fix + backfill, boolean coverage rises as the
 * allowlist absorbs ~30-40% of jobs and LLM JD inference handles the rest
 * (most return null per the strict-prompt design — see CLAUDE.md v1.6 D4).
 *
 * Usage:
 *   node scripts/probe-sponsorship-coverage.mjs              # default 2000
 *   node scripts/probe-sponsorship-coverage.mjs --limit 300  # smaller probe
 *
 * Env: GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT_JSON.
 */

import admin from 'firebase-admin'
import { readFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const LIMIT = (() => {
  const idx = argv.indexOf('--limit')
  return idx >= 0 ? parseInt(argv[idx + 1], 10) : 2000
})()

if (!admin.apps.length) {
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
  if (credPath) {
    const cred = JSON.parse(readFileSync(credPath, 'utf8'))
    admin.initializeApp({ credential: admin.credential.cert(cred), projectId: 'wekruit-5f89b' })
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const cred = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
    admin.initializeApp({ credential: admin.credential.cert(cred), projectId: 'wekruit-5f89b' })
  } else {
    admin.initializeApp({ projectId: 'wekruit-5f89b' })
  }
}
const db = admin.firestore()

const snap = await db.collection('matching-jobs')
  .where('status', '==', 'active')
  .limit(LIMIT)
  .get()

let total = 0
let sponsTrue = 0
let sponsFalse = 0
let sponsNull = 0
let sponsMissing = 0
let backfillStamped = 0
const sample = []

for (const doc of snap.docs) {
  const d = doc.data()
  total++
  const s = d.sponsorship
  if (s === true) sponsTrue++
  else if (s === false) sponsFalse++
  else if (s === null) sponsNull++
  else sponsMissing++
  if (typeof d.sponsorshipBackfilledAt === 'string') backfillStamped++
  if (sample.length < 5) {
    sample.push({
      jobId: doc.id,
      title: d.roleTitle,
      company: d.companyName,
      sponsorship: s ?? 'MISSING',
      sponsorshipSource: d.sponsorshipSource ?? null,
      sponsorshipBackfilledAt: d.sponsorshipBackfilledAt ?? null,
      enricherVersion: d.enricherVersion ?? null,
    })
  }
}

const cov = ((sponsTrue + sponsFalse) / total * 100).toFixed(2)
const attempted = (backfillStamped / total * 100).toFixed(2)

console.log(`scanned ${total} active jobs`)
console.log(JSON.stringify({
  total,
  sponsorship_true: sponsTrue,
  sponsorship_false: sponsFalse,
  sponsorship_null: sponsNull,
  sponsorship_missing: sponsMissing,
  coverage_boolean_pct: cov + '%',
  attempt_coverage_pct: attempted + '%',
  sample,
}, null, 2))
process.exit(0)
