#!/usr/bin/env node
import { initializeApp, getApps, applicationDefault } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"

if (!getApps().length) initializeApp({ credential: applicationDefault() })
const db = getFirestore()

const KEEPERS = [
  "U7AwKT8nLDRa35DkuBxq",
  "UThMpnAGzjaWnxDsKEMH",
  "itYEwzaJjVPjWbN01fzk",
]

const QDRANT_URL = process.env.QDRANT_URL?.trim().replace(/\/+$/, "")
const QDRANT_API_KEY = process.env.QDRANT_API_KEY?.trim()
const headers = { "api-key": QDRANT_API_KEY, "content-type": "application/json" }

async function countByUserId(collection, uid) {
  const r = await fetch(`${QDRANT_URL}/collections/${collection}/points/count`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      filter: { must: [{ key: "user_id", match: { value: uid } }] },
      exact: true,
    }),
  })
  if (!r.ok) return null
  const j = await r.json()
  return j.result?.count ?? 0
}

async function sampleUserIds(collection, n = 10) {
  const r = await fetch(`${QDRANT_URL}/collections/${collection}/points/scroll`, {
    method: "POST",
    headers,
    body: JSON.stringify({ limit: n, with_payload: ["user_id"] }),
  })
  if (!r.ok) return []
  const j = await r.json()
  return (j.result?.points ?? []).map((p) => p.payload?.user_id).filter(Boolean)
}

async function main() {
  console.log("Firestore (pa-users) keepers:")
  for (const uid of KEEPERS) {
    const snap = await db.collection("pa-users").doc(uid).get()
    const d = snap.data()
    console.log(`  ${uid}  mem0UserId=${d?.mem0UserId ?? "(unset → falls back to id)"}  phoneE164=${d?.phoneE164 ?? "(unset)"}`)
  }
  console.log("")
  console.log("Qdrant per-keeper count (pa_memory, filter user_id == <keeper>):")
  for (const uid of KEEPERS) {
    for (const coll of ["pa_memory", "pa_memory_entities"]) {
      const n = await countByUserId(coll, uid)
      console.log(`  ${coll.padEnd(22)}  ${uid}  → ${n}`)
    }
  }
  console.log("")
  console.log("Qdrant sample user_id values (first 10 in pa_memory):")
  const sample = await sampleUserIds("pa_memory", 20)
  const uniq = [...new Set(sample)]
  for (const v of uniq.slice(0, 20)) console.log(`  ${v}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
