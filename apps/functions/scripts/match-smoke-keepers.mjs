#!/usr/bin/env node
/**
 * Post-cleanup match-engine smoke. Calls queryMatchingJobsV16 directly
 * for each of the 3 keepers; asserts no exception thrown + reports
 * top-3 jobs (or noUserTags / empty fallback).
 */
import { initializeApp, getApps, applicationDefault } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { queryMatchingJobsV16 } from "@pa/job-rec"

if (!getApps().length) initializeApp({ credential: applicationDefault() })
const db = getFirestore()

const KEEPERS = [
  { uid: "U7AwKT8nLDRa35DkuBxq", label: "indolencorlol (layoff)" },
  { uid: "UThMpnAGzjaWnxDsKEMH", label: "adam.ylol (dev)" },
  { uid: "itYEwzaJjVPjWbN01fzk", label: "admin1 (dev)" },
]

async function main() {
  let failures = 0
  for (const { uid, label } of KEEPERS) {
    console.log(`\n=== ${label}  (${uid}) ===`)
    try {
      const r = await queryMatchingJobsV16(
        { userId: uid, limit: 5 },
        { db, log: (e, p) => console.log(`  log: ${e} ${JSON.stringify(p ?? {})}`) }
      )
      if (r.noUserTags) {
        console.log(`  result: noUserTags=true (empty pa-users.tags)`)
        continue
      }
      console.log(`  jobs.length=${r.jobs.length}  total_survivors=${r.total}  dropped=${r.dropped}`)
      if (r.needsOnboarding) {
        console.log(`  needsOnboarding=true  missingAxes=${JSON.stringify(r.missingAxes)}`)
      }
      console.log(`  hardFilter: ${JSON.stringify(r.hardFilter)}`)
      for (const j of r.jobs.slice(0, 3)) {
        console.log(`    - ${j.id}  score=${j.v16Score?.total?.toFixed(3)}  title=${(j.jobTitle ?? "").slice(0, 60)}`)
      }
    } catch (err) {
      failures += 1
      console.log(`  ✗ FAIL — ${err.message ?? err}`)
    }
  }
  console.log("\n" + "=".repeat(60))
  if (failures === 0) {
    console.log("✓ match-engine smoke: 0 errors across 3 keepers")
    process.exit(0)
  }
  console.log(`✗ ${failures} keeper(s) failed`)
  process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
