#!/usr/bin/env node
/**
 * yc-qr-e2e-sim.mjs — LIVE probe of the YC Startup School QR cold-start
 * (2026-07-21). Walks the REAL prod chain:
 *   1. GET paQrStartRedirect?c=yc-startup-school → parse the sms: Location
 *      (number + prefilled YC opener with the minted scanToken).
 *   2. Inject that exact opener as a broker inbound from a FRESH reserved
 *      phone (suppressOutbound) → assert provision: source=yc_startup_school,
 *      firstTouchCampaign=yc-startup-school.
 *   3. Walk the intake with the real LLM: skip LinkedIn (expect ONE
 *      consequence-framed nudge), answer building, answer wants_to_meet →
 *      assert pa-users.ycIntake recorded + completedAt + the ~7pm close.
 * Run: GOOGLE_APPLICATION_CREDENTIALS=... node tests/scenarios/yc-qr-e2e-sim.mjs
 */
import { randomUUID } from "node:crypto"
import { initializeApp, cert, getApps } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { readFileSync } from "node:fs"

const PROJECT = "wekruit-5f89b"
if (!getApps().length) {
  initializeApp({
    credential: cert(JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8"))),
    projectId: PROJECT,
  })
}
const db = getFirestore()
const nowIso = () => new Date().toISOString()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const PHONE = process.env.SIM_PHONE ?? "+19999990771"
const CHAT = `iMessage;${PHONE}`
const report = { phone: PHONE, checks: [], transcript: [] }
const check = (name, ok, detail = "") => report.checks.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`)

async function pollUntil(probe, { timeoutMs, intervalMs = 1000, label }) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const r = await probe()
    if (r) return r
    await sleep(intervalMs)
  }
  throw new Error(`Timeout: ${label}`)
}

async function sendTurn(text, candidateId) {
  const id = `harness_${randomUUID()}`
  const turnStartIso = nowIso()
  await db.collection("pa-inbound-events").doc(id).set({
    id,
    status: "pending",
    idempotencyKey: `harness:${id}`,
    createdAt: turnStartIso,
    attemptCount: 0,
    maxAttempts: 1,
    channel: "imessage",
    rawPayload: {
      kind: "imessage",
      participant: PHONE,
      chatId: CHAT,
      messageRowId: Date.now(),
      text,
      harness: { runner: "tests/scenarios/yc-qr-e2e-sim.mjs", suppressOutbound: true },
    },
  })
  const completed = await pollUntil(
    async () => {
      const d = (await db.collection("pa-inbound-events").doc(id).get()).data()
      if (!d) return false
      if (d.status === "succeeded" || d.status === "completed") return d
      if (d.status === "failed" || d.status === "dead_letter") throw new Error(`inbound failed: ${d.lastError}`)
      return false
    },
    { timeoutMs: 120_000, label: `inbound ${id}` },
  )
  const uid = completed?.userId ?? candidateId
  await sleep(5000)
  const ob = await db.collection("pa-outbound").where("userId", "==", uid).get()
  const bubbles = ob.docs
    .map((d) => d.data())
    .filter((d) => typeof d.body === "string" && d.body.length > 0 && (d.createdAt ?? "") >= turnStartIso)
    .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""))
    .map((d) => d.body)
  return { resolvedUserId: uid, bubbles }
}

// 1. Real QR redirect.
const redirect = await fetch(
  `https://us-central1-${PROJECT}.cloudfunctions.net/paQrStartRedirect?c=yc-startup-school`,
  { redirect: "manual" },
)
const location = redirect.headers.get("location") ?? ""
check("QR redirect 302 with sms: location", redirect.status === 302 && location.startsWith("sms:"), location.slice(0, 60))
const bodyMatch = location.match(/[?&]&?body=(.+)$/)
const opener = decodeURIComponent(bodyMatch?.[1] ?? "")
check("opener carries the YC phrase", /I'm at YC Startup School/i.test(opener), opener.slice(0, 80))

// 2. First inbound = the exact prefilled opener.
const t1 = await sendTurn(opener, null)
const userId = t1.resolvedUserId
report.userId = userId
report.transcript.push({ user: opener, claire: t1.bubbles })
const u1 = (await db.collection("pa-users").doc(userId).get()).data() ?? {}
check("provisioned with source=yc_startup_school", u1.source === "yc_startup_school", String(u1.source))
check("firstTouchCampaign stamped", u1.firstTouchCampaign === "yc-startup-school", String(u1.firstTouchCampaign))
await db.collection("pa-users").doc(userId).set({ testMode: true, updatedAt: nowIso() }, { merge: true })
check("first reply offers LinkedIn link", /connect-linkedin/i.test(t1.bubbles.join("\n")), "")

// 3. Decline LinkedIn → expect ONE consequence nudge; then the two questions.
const t2 = await sendTurn("nah i'll skip the linkedin thing for now", userId)
report.transcript.push({ user: "nah i'll skip the linkedin thing for now", claire: t2.bubbles })

const t3 = await sendTurn("i'm building an eval harness for coding agents, kind of like CI for prompts", userId)
report.transcript.push({ user: "i'm building an eval harness for coding agents...", claire: t3.bubbles })

const t4 = await sendTurn("honestly i want to meet infra founders and anyone doing dev tools", userId)
report.transcript.push({ user: "honestly i want to meet infra founders and anyone doing dev tools", claire: t4.bubbles })

const u2 = (await db.collection("pa-users").doc(userId).get()).data() ?? {}
const intake = u2.ycIntake ?? {}
check("ycIntake.building recorded", typeof intake.building === "string" && intake.building.length > 0, String(intake.building).slice(0, 60))
check("ycIntake.wantsToMeet recorded", typeof intake.wantsToMeet === "string" && intake.wantsToMeet.length > 0, String(intake.wantsToMeet).slice(0, 60))
check("ycIntake.completedAt stamped", typeof intake.completedAt === "string", String(intake.completedAt))
const allReplies = report.transcript.flatMap((t) => t.claire).join("\n")
check("7pm close present", /7\s?pm|7 o'clock|around 7/i.test(allReplies), "")
check("consequence nudge fired once (thinner profile / weaker matching)", /(thinner|weaker|stronger match|better match)/i.test(allReplies), "")

console.log(JSON.stringify(report, null, 2))
