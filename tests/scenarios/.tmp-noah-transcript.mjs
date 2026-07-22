#!/usr/bin/env node
// READ-ONLY: dump Noah's NEW user state + full conversation since the reset.
import { initializeApp, cert, getApps } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { readFileSync } from "node:fs"

const PHONE = "+12154034668"
if (!getApps().length) {
  initializeApp({
    credential: cert(JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8"))),
    projectId: "wekruit-5f89b",
  })
}
const db = getFirestore()

const users = await db.collection("pa-users").where("phoneE164", "==", PHONE).get()
for (const d of users.docs) {
  const u = d.data()
  console.log("USER:", d.id, JSON.stringify({
    source: u.source,
    firstTouchCampaign: u.firstTouchCampaign,
    createdAt: u.createdAt,
    onboardingState: u.onboardingState,
    ycIntake: u.ycIntake,
    sharedOnboarding: u.sharedOnboarding ? { completed: u.sharedOnboarding.completed, askedKeys: u.sharedOnboarding.askedKeys ?? Object.keys(u.sharedOnboarding) } : null,
    latestResumeArtifactId: u.latestResumeArtifactId,
    pitchedAt: u.pitchedAt,
  }, null, 2))
  const uid = d.id

  const inb = await db.collection("pa-inbound-events").where("rawPayload.participant", "==", PHONE).orderBy("createdAt", "desc").limit(30).get().catch(async () => await db.collection("pa-inbound-events").where("userId", "==", uid).limit(30).get())
  const out = await db.collection("pa-outbound").where("userId", "==", uid).get()
  const rows = []
  for (const x of inb.docs) {
    const v = x.data()
    if ((v.userId ?? "") === uid || (v.rawPayload?.participant ?? "") === PHONE)
      rows.push({ t: v.createdAt, who: "USER", text: v.rawPayload?.text ?? "" })
  }
  for (const x of out.docs) {
    const v = x.data()
    rows.push({ t: v.createdAt, who: "CLAIRE", text: v.body, src: v.runtimeSource, status: v.sendblueStatus ?? v.status })
  }
  rows.sort((a, b) => (a.t ?? "").localeCompare(b.t ?? ""))
  for (const r of rows) console.log(`[${r.t}] ${r.who}${r.src ? ` (${r.src})` : ""}: ${String(r.text).slice(0, 400)}`)
}
