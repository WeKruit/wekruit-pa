#!/usr/bin/env node
// READ-ONLY deep dump: full inbound event docs, current user doc, outbound bodies.
import { initializeApp, cert, getApps } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { readFileSync } from "node:fs"

const PHONE = "+12154034668"
const UID = "UKFaKdsMzzfPW2CDl5ve"
const SINCE = "2026-07-22T18:00:00.000Z"
if (!getApps().length) {
  initializeApp({
    credential: cert(JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8"))),
    projectId: "wekruit-5f89b",
  })
}
const db = getFirestore()

const u = (await db.collection("pa-users").doc(UID).get()).data() ?? {}
console.log("USER DOC now:", JSON.stringify({
  phoneE164: u.phoneE164 ?? null,
  phoneE164Source: u.phoneE164Source ?? null,
  archivedPhoneE164: u.archivedPhoneE164 ?? null,
  phoneResetAt: u.phoneResetAt ?? null,
  source: u.source,
  ycIntake: u.ycIntake ?? null,
  onboardingState: u.onboardingState,
  imessageHandle: u.imessageHandle ?? u.imessageChatId ?? null,
  updatedAt: u.updatedAt,
}))

const inb = await db.collection("pa-inbound-events").where("createdAt", ">=", SINCE).get()
for (const d of inb.docs) {
  const v = d.data()
  if ((v.rawPayload?.participant ?? "") !== PHONE) continue
  const { rawPayload, ...rest } = v
  console.log("\nEVENT:", JSON.stringify({ text: rawPayload?.text, chatId: rawPayload?.chatId, ...rest }).slice(0, 900))
}

const out = await db.collection("pa-outbound").where("userId", "==", UID).get()
const rows = out.docs.map((d) => d.data()).filter((v) => (v.createdAt ?? "") >= SINCE)
rows.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""))
for (const r of rows) console.log(`\nCLAIRE [${r.createdAt}] (${r.runtimeSource ?? r.source}): ${String(r.body).slice(0, 500)}`)

// any OTHER yc users created today (did provision create a twin?)
const fresh = await db.collection("pa-users").where("firstTouchCampaign", "==", "yc-startup-school").get()
for (const d of fresh.docs) {
  const v = d.data()
  if ((v.createdAt ?? "") >= "2026-07-22T00:00:00Z") console.log("\nYC-PROVISIONED TODAY:", d.id, v.phoneE164 ?? "(no phone)", v.createdAt)
}
