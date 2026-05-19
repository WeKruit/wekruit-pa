#!/usr/bin/env node
/**
 * Pre-cleanup preservation audit. Read-only. Counts every FK collection
 * by userId state so Adam can verify exactly what's protected.
 *
 * For each collection:
 *   - per-keeper count (rows owned by each of the 3 KEEP_LIST uids)
 *   - no-userId count (rows missing the field — preserved by predicate)
 *   - deletable count (userId present + not in KEEP_LIST)
 *   - total
 *
 * Plus sample doc IDs from each keeper so Adam can spot-check.
 */
import { initializeApp, getApps, applicationDefault } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"

const KEEP_LIST = [
  "U7AwKT8nLDRa35DkuBxq", // indolencorlol@gmail.com (layoff)
  "UThMpnAGzjaWnxDsKEMH", // adam.ylol@wekruit.com (dev)
  "itYEwzaJjVPjWbN01fzk", // admin1@wekruit.com (dev)
]

const KEEP_LABELS = {
  U7AwKT8nLDRa35DkuBxq: "indolencorlol",
  UThMpnAGzjaWnxDsKEMH: "adam.ylol",
  itYEwzaJjVPjWbN01fzk: "admin1",
}

const USER_FK_COLLECTIONS = [
  "pa-messages",
  "pa-turns",
  "pa-sessions",
  "pa-inbound-events",
  "pa-outbound",
  "pa-prescreen-sessions",
  "pa-audit-events",
  "parsedCandidateResumes",
]
const CANDIDATE_FK_COLLECTIONS = [
  "pa-resume-artifacts",
  "pa-candidate-handles",
  "pa-candidate-self-profiles",
  "pa-candidate-auth",
]

if (!getApps().length) initializeApp({ credential: applicationDefault() })
const db = getFirestore()

async function countByField(collection, field, value) {
  return (await db.collection(collection).where(field, "==", value).count().get()).data().count
}

async function countTotal(collection) {
  return (await db.collection(collection).count().get()).data().count
}

async function sampleByField(collection, field, value, limit = 3) {
  const snap = await db.collection(collection).where(field, "==", value).limit(limit).get()
  return snap.docs.map((d) => d.id)
}

async function auditUserFkCollection(collection) {
  const total = await countTotal(collection)
  const perKeeper = {}
  let keeperSum = 0
  for (const uid of KEEP_LIST) {
    const n = await countByField(collection, "userId", uid)
    perKeeper[KEEP_LABELS[uid]] = n
    keeperSum += n
  }
  // deletable = total - keepers - no-userId.
  // not-in filter excludes missing-field docs, so:
  //   not_in_count = total_with_userid - keepers
  //   no_userid_count = total - total_with_userid
  // We back-derive via: deletable = (not-in count); no-userId = total - keepers - deletable.
  const notInCount = (
    await db.collection(collection).where("userId", "not-in", KEEP_LIST).count().get()
  ).data().count
  const deletable = notInCount
  const noUserId = total - keeperSum - deletable
  return { collection, total, perKeeper, keeperSum, deletable, noUserId }
}

async function auditCandidateFkCollection(collection) {
  const total = await countTotal(collection)
  const perKeeper = {}
  let keeperSum = 0
  for (const uid of KEEP_LIST) {
    const n = await countByField(collection, "candidateId", uid)
    perKeeper[KEEP_LABELS[uid]] = n
    keeperSum += n
  }
  const notInCount = (
    await db
      .collection(collection)
      .where("candidateId", "not-in", KEEP_LIST)
      .count()
      .get()
  ).data().count
  const deletable = notInCount
  const noCandidateId = total - keeperSum - deletable
  return { collection, total, perKeeper, keeperSum, deletable, noField: noCandidateId }
}

async function main() {
  console.log("=".repeat(86))
  console.log("Pre-cleanup preservation audit (read-only)")
  console.log("KEEP_LIST:")
  for (const uid of KEEP_LIST) {
    console.log(`  - ${uid}  (${KEEP_LABELS[uid]})`)
  }
  console.log("=".repeat(86))
  console.log("")
  console.log("User-FK collections (filter: userId)")
  console.log("")
  console.log(
    `  ${"collection".padEnd(28)}  ${"total".padStart(6)}  ${"indolencorlol".padStart(13)}  ${"adam.ylol".padStart(10)}  ${"admin1".padStart(7)}  ${"deletable".padStart(9)}  ${"no-userId".padStart(9)}`
  )
  console.log("  " + "─".repeat(82))
  for (const c of USER_FK_COLLECTIONS) {
    const r = await auditUserFkCollection(c)
    console.log(
      `  ${c.padEnd(28)}  ${String(r.total).padStart(6)}  ${String(r.perKeeper.indolencorlol).padStart(13)}  ${String(r.perKeeper["adam.ylol"]).padStart(10)}  ${String(r.perKeeper.admin1).padStart(7)}  ${String(r.deletable).padStart(9)}  ${String(r.noUserId).padStart(9)}`
    )
  }

  console.log("")
  console.log("Candidate-FK collections (filter: candidateId)")
  console.log("")
  console.log(
    `  ${"collection".padEnd(28)}  ${"total".padStart(6)}  ${"indolencorlol".padStart(13)}  ${"adam.ylol".padStart(10)}  ${"admin1".padStart(7)}  ${"deletable".padStart(9)}  ${"no-cand-id".padStart(10)}`
  )
  console.log("  " + "─".repeat(82))
  for (const c of CANDIDATE_FK_COLLECTIONS) {
    const r = await auditCandidateFkCollection(c)
    console.log(
      `  ${c.padEnd(28)}  ${String(r.total).padStart(6)}  ${String(r.perKeeper.indolencorlol).padStart(13)}  ${String(r.perKeeper["adam.ylol"]).padStart(10)}  ${String(r.perKeeper.admin1).padStart(7)}  ${String(r.deletable).padStart(9)}  ${String(r.noField).padStart(10)}`
    )
  }

  console.log("")
  console.log("Sample preserved row ids (first 3 per keeper per collection)")
  console.log("")
  for (const c of [...USER_FK_COLLECTIONS, ...CANDIDATE_FK_COLLECTIONS]) {
    const field = USER_FK_COLLECTIONS.includes(c) ? "userId" : "candidateId"
    console.log(`  [${c}]`)
    for (const uid of KEEP_LIST) {
      const ids = await sampleByField(c, field, uid, 2)
      console.log(`    ${KEEP_LABELS[uid].padEnd(14)}: ${ids.length === 0 ? "(none)" : ids.join(", ")}`)
    }
  }

  // pa-users itself
  console.log("")
  console.log("pa-users (filter: doc id)")
  console.log("")
  const usersTotal = await countTotal("pa-users")
  console.log(`  total = ${usersTotal}`)
  for (const uid of KEEP_LIST) {
    const snap = await db.collection("pa-users").doc(uid).get()
    const data = snap.exists ? snap.data() : null
    console.log(
      `  ${uid}  ${KEEP_LABELS[uid].padEnd(14)}  source=${data?.source ?? "(unset)"}  onboardingState=${data?.onboardingState ?? "(unset)"}  has-tags=${data?.tags ? "yes" : "no"}`
    )
  }

  console.log("")
  console.log("=".repeat(86))
  console.log("Predicate semantics (cleanup-pa-users-cascade.mjs):")
  console.log("  - filter_user_id      delete iff userId is a string AND not in KEEP_LIST")
  console.log("                        → rows with no userId field are PRESERVED")
  console.log("  - filter_candidate_id delete iff candidateId is a string AND not in KEEP_LIST")
  console.log("                        → rows with no candidateId field are PRESERVED")
  console.log("  - filter_doc_id       delete iff doc id is not in KEEP_LIST (pa-users only)")
  console.log("  - full_wipe           delete every doc unconditionally (pre-validated: 0 keeper rows)")
  console.log("=".repeat(86))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
