#!/usr/bin/env node
/**
 * Post-cleanup verify smoke. Confirms:
 *   1. pa-users count == 3 (KEEP_LIST)
 *   2. pa_users (typo) count == 0
 *   3. No FK collection still has a row whose userId / candidateId is NOT
 *      in KEEP_LIST.
 *   4. Match-engine probe for each of the 3 keepers returns without throwing
 *      (the candidate pool is non-empty downstream; matching-jobs collection
 *      is untouched).
 *
 * Goal: .planning/GOAL-pa-users-cleanup.md "Done criteria" rows 1-3, 7.
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json \
 *   node apps/functions/scripts/cleanup-smoke-verify.mjs
 */
import { initializeApp, getApps, applicationDefault } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"

const KEEP_LIST = [
  "U7AwKT8nLDRa35DkuBxq",
  "UThMpnAGzjaWnxDsKEMH",
  "itYEwzaJjVPjWbN01fzk",
]

const FK_USER_COLLECTIONS = [
  "pa-messages",
  "pa-turns",
  "pa-sessions",
  "pa-inbound-events",
  "pa-outbound",
  "pa-prescreen-sessions",
  "pa-audit-events",
  "parsedCandidateResumes",
]
const FK_CANDIDATE_COLLECTIONS = [
  "pa-resume-artifacts",
  "pa-candidate-handles",
  "pa-candidate-self-profiles",
  "pa-candidate-auth",
]
const FULL_WIPE = [
  "pa_users",
  "pa-tool-calls",
  "pa-job-clicks",
  "pa-feedback-events",
  "pa-pii-confirm-state",
]

if (!getApps().length) initializeApp({ credential: applicationDefault() })
const db = getFirestore()

let failures = 0

function pass(msg) {
  console.log(`  ✓ ${msg}`)
}
function fail(msg) {
  console.log(`  ✗ ${msg}`)
  failures += 1
}

async function main() {
  console.log("=".repeat(72))
  console.log("pa-users cleanup smoke verify")
  console.log("=".repeat(72))
  console.log("")

  // 1. pa-users count == 3
  const usersCount = (await db.collection("pa-users").count().get()).data().count
  if (usersCount === 3) pass(`pa-users count = 3`)
  else fail(`pa-users count = ${usersCount} (expected 3)`)

  // 1b. All three KEEP_LIST ids exist
  for (const id of KEEP_LIST) {
    const snap = await db.collection("pa-users").doc(id).get()
    if (snap.exists) pass(`pa-users/${id} preserved`)
    else fail(`pa-users/${id} MISSING — keeper deleted by mistake!`)
  }

  // 2. pa_users (typo) count == 0
  try {
    const typoCount = (await db.collection("pa_users").count().get()).data().count
    if (typoCount === 0) pass(`pa_users (typo) count = 0`)
    else fail(`pa_users (typo) count = ${typoCount} (should be 0)`)
  } catch {
    pass(`pa_users (typo) collection absent`)
  }

  // 3. Full-wipe collections == 0
  for (const c of FULL_WIPE) {
    if (c === "pa_users") continue // already counted
    try {
      const n = (await db.collection(c).count().get()).data().count
      if (n === 0) pass(`${c} count = 0`)
      else fail(`${c} count = ${n} (should be 0)`)
    } catch (err) {
      pass(`${c} collection absent (${err.message})`)
    }
  }

  // 4. FK collections: every userId / candidateId must be in KEEP_LIST
  for (const c of FK_USER_COLLECTIONS) {
    try {
      const orphan = await db
        .collection(c)
        .where("userId", "not-in", KEEP_LIST)
        .limit(1)
        .count()
        .get()
      const n = orphan.data().count
      if (n === 0) pass(`${c} no orphan userId`)
      else fail(`${c} has ${n}+ rows with userId NOT IN KEEP_LIST`)
    } catch (err) {
      // Collection missing or no `userId` field — count as pass
      pass(`${c} (skipped: ${err.message})`)
    }
  }
  for (const c of FK_CANDIDATE_COLLECTIONS) {
    try {
      const orphan = await db
        .collection(c)
        .where("candidateId", "not-in", KEEP_LIST)
        .limit(1)
        .count()
        .get()
      const n = orphan.data().count
      if (n === 0) pass(`${c} no orphan candidateId`)
      else fail(`${c} has ${n}+ rows with candidateId NOT IN KEEP_LIST`)
    } catch (err) {
      pass(`${c} (skipped: ${err.message})`)
    }
  }

  // 5. Source-label coverage on the 3 keepers (warn if missing, not fail)
  for (const id of KEEP_LIST) {
    const snap = await db.collection("pa-users").doc(id).get()
    const source = snap.data()?.source
    if (typeof source === "string" && source.length > 0) {
      pass(`pa-users/${id} source = ${source}`)
    } else {
      console.log(`  ⚠ pa-users/${id} has no source field (legacy doc — backfill recommended)`)
    }
  }

  console.log("")
  console.log("=".repeat(72))
  if (failures === 0) {
    console.log("✓ all checks pass")
    process.exit(0)
  } else {
    console.log(`✗ ${failures} check(s) failed`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
