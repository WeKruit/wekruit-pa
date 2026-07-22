#!/usr/bin/env node
// READ-ONLY: raw inbound + webhook rows for Noah's phone in the last 3h.
import { initializeApp, cert, getApps } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { readFileSync } from "node:fs"

const PHONE = "+12154034668"
const SINCE = new Date(Date.now() - 3 * 3600e3).toISOString()
if (!getApps().length) {
  initializeApp({
    credential: cert(JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8"))),
    projectId: "wekruit-5f89b",
  })
}
const db = getFirestore()

const inb = await db.collection("pa-inbound-events").where("createdAt", ">=", SINCE).get()
for (const d of inb.docs) {
  const v = d.data()
  if ((v.rawPayload?.participant ?? "") !== PHONE) continue
  console.log("INBOUND:", JSON.stringify({ t: v.createdAt, status: v.status, userId: v.userId, err: v.lastError, text: (v.rawPayload?.text ?? "").slice(0, 160) }))
}

const raw = await db.collection("pa-sendblue-webhook-raw").where("receivedAt", ">=", SINCE).get().catch(() => ({ docs: [] }))
for (const d of raw.docs) {
  const v = d.data()
  const from = v.payload?.from_number ?? v.payload?.number ?? ""
  if (String(from).includes("2154034668")) console.log("RAW:", JSON.stringify({ t: v.receivedAt, from, text: (v.payload?.content ?? "").slice(0, 160) }))
}

const scans = await db.collection("pa-qr-scan-pending").where("createdAt", ">=", SINCE).get().catch(() => ({ docs: [] }))
console.log("recent scans:", scans.docs.length)
for (const d of scans.docs) {
  const v = d.data()
  console.log("SCAN:", JSON.stringify({ t: v.createdAt, campaign: v.campaign, number: v.number ?? v.sendblueNumber, consumed: v.consumedAt ?? v.consumedBy ?? null }))
}
