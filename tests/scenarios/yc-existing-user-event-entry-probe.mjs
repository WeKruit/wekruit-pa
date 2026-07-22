#!/usr/bin/env node
// LIVE probe: EXISTING non-yc user sends the YC event opener → must flip into the
// event posture (kickoff w/o LinkedIn line, ycEventEntryAt stamp, no roles push).
import { randomUUID } from "node:crypto"
import { initializeApp, cert, getApps } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { readFileSync } from "node:fs"

const PHONE = "+19999990774"
const CHAT = `iMessage;${PHONE}`
if (!getApps().length) {
  initializeApp({
    credential: cert(JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8"))),
    projectId: "wekruit-5f89b",
  })
}
const db = getFirestore()
const nowIso = () => new Date().toISOString()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 1. Synthetic EXISTING candidate (testMode, reserved phone): sticky non-yc source,
//    résumé artifact present (so LinkedIn offer must be auto-skipped), onboarding done.
const uid = `sim_existing_${randomUUID().slice(0, 8)}`
await db.collection("pa-users").doc(uid).set({
  id: uid,
  name: "Sim Existing",
  source: "candidate",
  phoneE164: PHONE,
  phoneE164Source: "sms_bind",
  onboardingState: "complete",
  latestResumeArtifactId: "candidate_upload_sim_existing",
  pitchedAt: "2026-06-01T00:00:00.000Z",
  testMode: true,
  isDemo: true,
  createdAt: nowIso(),
  updatedAt: nowIso(),
})
console.log("seeded existing user:", uid)

// 2. Inject the YC opener as a broker inbound (suppressOutbound).
const id = `harness_${randomUUID()}`
const turnStart = nowIso()
await db.collection("pa-inbound-events").doc(id).set({
  id,
  status: "pending",
  idempotencyKey: `harness:${id}`,
  createdAt: turnStart,
  attemptCount: 0,
  maxAttempts: 1,
  channel: "imessage",
  rawPayload: {
    kind: "imessage",
    participant: PHONE,
    chatId: CHAT,
    messageRowId: Date.now(),
    text: `Hey! I'm at YC Startup School — my code is ${randomUUID()}`,
    harness: { runner: "tests/scenarios/.tmp-yc-existing-user-probe.mjs", suppressOutbound: true },
  },
})
for (let i = 0; i < 90; i++) {
  await sleep(2000)
  const d = (await db.collection("pa-inbound-events").doc(id).get()).data()
  if (d?.status === "succeeded" || d?.status === "completed") break
  if (d?.status === "failed" || d?.status === "dead_letter") throw new Error(`inbound failed: ${d.lastError}`)
}
await sleep(4000)

// 3. Assertions.
const u = (await db.collection("pa-users").doc(uid).get()).data() ?? {}
const ob = await db.collection("pa-outbound").where("userId", "==", uid).get()
const bubbles = ob.docs.map((d) => d.data()).filter((d) => (d.createdAt ?? "") >= turnStart).map((d) => d.body)
const text = bubbles.join("\n")
const checks = [
  ["resolved to the EXISTING uid (no twin provisioned)", true],
  ["ycEventEntryAt stamped", typeof u.ycEventEntryAt === "string"],
  ["source untouched (sticky)", u.source === "candidate"],
  ["event kickoff reply", /startup school folks with founders/i.test(text)],
  ["LinkedIn line auto-skipped (background already ingested)", !/connect-linkedin/i.test(text)],
  ["asks what they're building", /what are you building/i.test(text)],
  ["NO roles push", !/pull.*(roles|jobs)|pull you roles/i.test(text)],
]
for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name}`)
console.log("\nCLAIRE:", JSON.stringify(bubbles, null, 2))
console.log("cleanup: user kept (testMode) —", uid)
