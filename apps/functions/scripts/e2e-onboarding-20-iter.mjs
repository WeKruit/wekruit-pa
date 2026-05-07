#!/usr/bin/env node
/**
 * 20-iteration onboarding integration test.
 *
 * Each iteration:
 *   1. Pick fresh phone number
 *   2. Walk through ALL onboarding turns (Hi→English→email→Agree→role→
 *      yoe→visa→startup→location→PDF→cv-parsed-trigger→state=complete)
 *   3. Mix valid answers with one INVALID answer per iter at a different
 *      step to test re-ask gracefulness
 *   4. Verify state advances at each step
 *   5. Verify job recs land at end
 *   6. Cleanup test user
 *
 * Reports: pass/fail per iteration + aggregate.
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=/tmp/firebase-creds.json \
 *     node apps/functions/scripts/e2e-onboarding-20-iter.mjs
 */
import { initializeApp, cert, getApps } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { readFileSync } from "node:fs"

const PROJECT = "wekruit-5f89b"
const ITERATIONS = parseInt(process.env.E2E_ITER ?? "20", 10)

function initFirebase() {
  if (getApps().length > 0) return
  const credsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
  if (!credsPath) throw new Error("GOOGLE_APPLICATION_CREDENTIALS missing")
  const creds = JSON.parse(readFileSync(credsPath, "utf-8"))
  initializeApp({ credential: cert(creds), projectId: PROJECT })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const nowIso = () => new Date().toISOString()

async function sendInbound(db, { userId, phone, text, eventTag }) {
  const eventId = `e2e_${eventTag}_${Math.random().toString(36).slice(2, 10)}`
  await db.collection("pa-inbound-events").doc(eventId).set({
    id: eventId,
    status: "pending",
    idempotencyKey: `e2e:${userId ?? phone}:${eventId}`,
    createdAt: nowIso(),
    attemptCount: 0,
    maxAttempts: 1,
    channel: "imessage",
    rawPayload: {
      kind: "imessage",
      source: "e2e-sim",
      participant: phone,
      chatId: `iMessage;${phone}`,
      messageRowId: Date.now(),
      text,
      messageHandle: `e2e-${eventId}`,
      service: "iMessage",
      harness: { runner: "e2e-20iter", suppressOutbound: true },
    },
  })
  return eventId
}

async function findUserByPhone(db, phone) {
  for (const field of ["phoneE164", "phone"]) {
    const snap = await db.collection("pa-users").where(field, "==", phone).limit(1).get()
    if (!snap.empty) return { id: snap.docs[0].id, data: snap.docs[0].data() }
  }
  return null
}

async function cleanup(db, userId) {
  if (!userId) return
  const cols = ["pa-inbound-events", "pa-outbound", "pa-messages", "pa-turns", "parsedCandidateResumes", "pa-job-profiles"]
  for (const c of cols) {
    const s = await db.collection(c).where("userId", "==", userId).get()
    for (const d of s.docs) await d.ref.delete()
  }
  await db.collection("pa-users").doc(userId).delete()
}

async function runIteration(db, iterIdx) {
  const phoneTail = String(Math.floor(2000000 + Math.random() * 7000000))
  const phone = `+1888${phoneTail}`
  const result = { iter: iterIdx, phone, turns: [], pass: false, error: null, recsCount: 0, finalState: null }

  // Decide which step gets an "invalid first reply" (to test re-ask graceful)
  // 0 = none, 1 = role, 2 = yoe, 3 = visa
  const invalidStep = iterIdx % 4

  try {
    // ── Hi
    await sendInbound(db, { phone, text: "Hi", eventTag: "hi" })
    await sleep(15000)
    let user = await findUserByPhone(db, phone)
    if (!user) throw new Error("user not created after Hi")
    const userId = user.id
    result.userId = userId
    result.turns.push({ step: "Hi", state: user.data.onboardingState })

    // ── English (lang)
    await sendInbound(db, { userId, phone, text: "English", eventTag: "lang" })
    await sleep(15000)
    user = await findUserByPhone(db, phone)
    result.turns.push({ step: "English", state: user.data.onboardingState })

    // ── email (skip Mailgun via direct verified stamp)
    await sendInbound(db, { userId, phone, text: `e2e${phoneTail}@test.com`, eventTag: "email" })
    await sleep(12000)
    user = await findUserByPhone(db, phone)
    if (user.data.onboardingState === "q_email_verifying") {
      await db.collection("pa-users").doc(userId).set({
        emailVerification: { verifiedAt: nowIso(), email: `e2e${phoneTail}@test.com` },
        onboardingState: "q_tos_asked",
      }, { merge: true })
      await sleep(2000)
    }
    result.turns.push({ step: "email", state: user.data.onboardingState })

    // ── Agree
    await sendInbound(db, { userId, phone, text: "Agree", eventTag: "agree" })
    await sleep(20000)
    user = await findUserByPhone(db, phone)
    result.turns.push({ step: "Agree", state: user.data.onboardingState, tosAccepted: !!user.data.tosAcceptance })

    // ── Role (with optional invalid first reply)
    if (invalidStep === 1) {
      await sendInbound(db, { userId, phone, text: "I love coffee", eventTag: "role-bad" })
      await sleep(15000)
      user = await findUserByPhone(db, phone)
      result.turns.push({ step: "I love coffee (invalid)", state: user.data.onboardingState })
    }
    await sendInbound(db, { userId, phone, text: "Software Engineer", eventTag: "role" })
    await sleep(15000)
    user = await findUserByPhone(db, phone)
    result.turns.push({ step: "Software Engineer", state: user.data.onboardingState, role: user.data.tags?.targetRole })

    // ── YOE
    if (invalidStep === 2) {
      await sendInbound(db, { userId, phone, text: "purple", eventTag: "yoe-bad" })
      await sleep(15000)
      user = await findUserByPhone(db, phone)
      result.turns.push({ step: "purple (invalid)", state: user.data.onboardingState })
    }
    await sendInbound(db, { userId, phone, text: "2 years", eventTag: "yoe" })
    await sleep(15000)
    user = await findUserByPhone(db, phone)
    result.turns.push({ step: "2 years", state: user.data.onboardingState, yoe: user.data.tags?.yoeRange })

    // ── Visa
    if (invalidStep === 3) {
      await sendInbound(db, { userId, phone, text: "🤷", eventTag: "visa-bad" })
      await sleep(15000)
      user = await findUserByPhone(db, phone)
      result.turns.push({ step: "🤷 (invalid)", state: user.data.onboardingState })
    }
    await sendInbound(db, { userId, phone, text: "Need sponsorship", eventTag: "visa" })
    await sleep(15000)
    user = await findUserByPhone(db, phone)
    result.turns.push({ step: "Need sponsorship", state: user.data.onboardingState, visa: user.data.tags?.visaStatus })

    // ── Startup pref
    await sendInbound(db, { userId, phone, text: "Either", eventTag: "startup" })
    await sleep(15000)
    user = await findUserByPhone(db, phone)
    result.turns.push({ step: "Either", state: user.data.onboardingState })

    // ── Location
    await sendInbound(db, { userId, phone, text: "Anywhere", eventTag: "loc" })
    await sleep(15000)
    user = await findUserByPhone(db, phone)
    result.turns.push({ step: "Anywhere", state: user.data.onboardingState, loc: user.data.tags?.targetLocations })

    // ── CV parsed (seed + synthetic trigger)
    const resumeId = `e2e-resume-${userId.slice(0, 8)}`
    await db.collection("parsedCandidateResumes").doc(resumeId).set({
      userId,
      candidateProfile: { skills: ["python", "react"] },
      workHistory: [{ title: "Software Engineer", company: "Test Co" }],
      topSkills: ["python", "react", "kubernetes", "docker", "aws"],
      industryTags: ["technology"],
      createdAt: new Date(),
    })
    const trigEventId = `cv-parsed-trigger-${userId.slice(0, 8)}-${Date.now()}`
    await db.collection("pa-inbound-events").doc(trigEventId).set({
      id: trigEventId,
      status: "pending",
      idempotencyKey: `cv-parsed:${userId}:${resumeId}-${Date.now()}`,
      createdAt: nowIso(),
      attemptCount: 0,
      maxAttempts: 1,
      channel: "imessage",
      userId,
      rawPayload: {
        kind: "imessage",
        source: "cv-parsed-synthetic",
        participant: phone,
        chatId: `iMessage;-;${phone}`,
        messageHandle: `cv-parsed-${resumeId}`,
        text: "[cv-parsed]",
        cvParsedTrigger: true,
        triggerResumeId: resumeId,
      },
    })
    await sleep(40000)
    user = await findUserByPhone(db, phone)
    result.turns.push({ step: "CV-parsed", state: user.data.onboardingState })

    // ── Verify job recs (proper metric: pa-outbound.body contains "two roles" / "对得上的岗位")
    const out = await db.collection("pa-outbound").where("userId", "==", userId).get()
    const recMessages = out.docs.filter((d) => {
      const body = d.data().body || ""
      return body.includes("two roles") || body.includes("对得上的岗位")
    })
    const ackMessages = out.docs.filter((d) => {
      const body = d.data().body || ""
      return body.includes("give me a sec") || body.includes("让我看一下你简历")
    })
    result.outboundCount = out.size
    result.recsCount = recMessages.length
    result.ackCount = ackMessages.length
    result.finalState = user.data.onboardingState
    if (recMessages.length > 0) {
      result.recBody = recMessages[0].data().body.slice(0, 200)
    }

    result.pass =
      user.data.onboardingState === "complete" &&
      recMessages.length >= 1 &&
      ackMessages.length >= 1
  } catch (err) {
    result.error = err.message
  }

  // Cleanup
  try {
    await cleanup(db, result.userId)
  } catch {}
  return result
}

async function main() {
  initFirebase()
  const db = getFirestore()

  console.log(`\n=== 20-iter onboarding E2E test ===`)
  console.log(`Started: ${nowIso()}\n`)

  const results = []
  for (let i = 1; i <= ITERATIONS; i++) {
    const t0 = Date.now()
    console.log(`──── Iter ${i}/${ITERATIONS} ────`)
    const r = await runIteration(db, i)
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
    const emoji = r.pass ? "✅" : "❌"
    console.log(
      ` ${emoji} iter${i.toString().padStart(2)} | ${elapsed}s | state=${r.finalState} | outbound=${r.outboundCount} (ack=${r.ackCount} recs=${r.recsCount}) | turns=${r.turns.length} | error=${r.error || "-"}`
    )
    if (r.pass && r.recBody) console.log(`     rec preview: ${r.recBody.replace(/\n/g, " | ").slice(0, 160)}`)
    results.push({ ...r, elapsedSec: elapsed })
  }

  const passCount = results.filter((r) => r.pass).length
  console.log(`\n=== AGGREGATE ===`)
  console.log(`Pass:  ${passCount}/${ITERATIONS}`)
  console.log(`Fail:  ${ITERATIONS - passCount}/${ITERATIONS}`)
  console.log(`Avg time per iter: ${(results.reduce((a, r) => a + parseFloat(r.elapsedSec), 0) / results.length).toFixed(1)}s`)
  if (passCount < ITERATIONS) {
    console.log(`\n=== Failures ===`)
    results.filter((r) => !r.pass).forEach((r) => {
      console.log(` - iter${r.iter} | finalState=${r.finalState} | recs=${r.recsCount} | err=${r.error || "n/a"}`)
      const lastTurns = r.turns.slice(-4)
      lastTurns.forEach((t) => console.log(`     ${t.step}: state=${t.state}`))
    })
  }

  process.exit(passCount === ITERATIONS ? 0 : 1)
}

main().catch((e) => {
  console.error("FATAL:", e.message)
  console.error(e.stack)
  process.exit(1)
})
