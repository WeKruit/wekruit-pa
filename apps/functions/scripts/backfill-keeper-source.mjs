#!/usr/bin/env node
/**
 * Backfill `source: "admin"` on the two keeper docs that pre-date the
 * Phase 1 source-label policy. Idempotent (merge:true).
 */
import { initializeApp, getApps, applicationDefault } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"

if (!getApps().length) initializeApp({ credential: applicationDefault() })
const db = getFirestore()

const TARGETS = [
  { uid: "UThMpnAGzjaWnxDsKEMH", label: "adam.ylol", source: "admin" },
  { uid: "itYEwzaJjVPjWbN01fzk", label: "admin1", source: "admin" },
]

async function main() {
  for (const { uid, label, source } of TARGETS) {
    const ref = db.collection("pa-users").doc(uid)
    const snap = await ref.get()
    if (!snap.exists) {
      console.log(`  ✗ ${uid} (${label}) — doc missing`)
      continue
    }
    const existing = snap.data()?.source
    if (existing) {
      console.log(`  · ${uid} (${label}) — already has source=${existing}, skip`)
      continue
    }
    await ref.set({ source, updatedAt: new Date().toISOString() }, { merge: true })
    console.log(`  ✓ ${uid} (${label}) — set source=${source}`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
