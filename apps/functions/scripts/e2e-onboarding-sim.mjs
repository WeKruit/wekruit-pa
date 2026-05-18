#!/usr/bin/env node
/**
 * E2E onboarding simulator — drives a fresh test user through the FULL
 * production CF flow turn-by-turn. Verifies that each question advances
 * after a valid answer, and that job recs land before/after the resume.
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=/tmp/firebase-creds.json \
 *     node apps/functions/scripts/e2e-onboarding-sim.mjs
 *
 * What it does:
 *   1. Pick a fresh phone number (random)
 *   2. Trigger orchestrator with "Hi" → expect q_email_asked
 *   3. Send email, then set email verification short-circuit
 *      (we can't fetch Mailgun code from the test, so we manually stamp
 *       emailVerification.verifiedAt so the orchestrator skips the
 *       q_email_verifying step entirely)
 *   4. "Agree" → expect q_role_asked
 *   5. "Software Engineer" → expect q_yoe_asked
 *   6. "2 years" → expect q_visa_asked
 *   7. "Need sponsorship" → expect q_startup_pref_asked
 *   8. "Either" → expect q_location_asked
 *   9. "Anywhere" → expect q_resume_asked
 *   10. seed parsedCandidateResume + fire synthetic cvParsed trigger →
 *       expect state→complete + job recs sent
 *   11. Probe pa-job-profiles for recs delivered
 *
 * Reports per-turn:
 *   - inbound event id
 *   - status:succeeded / coalesced / pending
 *   - resulting onboardingState
 *   - whether transition matches expectation
 *   - elapsed ms
 */
import { initializeApp, cert, getApps } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { readFileSync } from "node:fs"
import { assertProductionPaUserCreationAllowed } from "./lib/prod-test-user-guard.mjs"

const PROJECT = "wekruit-5f89b"

function initFirebase() {
  if (getApps().length > 0) return
  const credsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
  if (!credsPath) {
    throw new Error("GOOGLE_APPLICATION_CREDENTIALS missing")
  }
  const creds = JSON.parse(readFileSync(credsPath, "utf-8"))
  initializeApp({ credential: cert(creds), projectId: PROJECT })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const nowIso = () => new Date().toISOString()

async function sendInbound(db, { userId, phone, text, eventTag = "" }) {
  const eventId = `e2e_${eventTag}_${Math.random().toString(36).slice(2, 10)}`
  const doc = {
    id: eventId,
    status: "pending",
    idempotencyKey: `e2e:${userId}:${eventId}`,
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
      harness: { runner: "e2e-onboarding-sim", suppressOutbound: true },
    },
  }
  await db.collection("pa-inbound-events").doc(eventId).set(doc)
  return eventId
}

async function pollUserState(db, userId, ms = 30000) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    const u = await db.collection("pa-users").doc(userId).get()
    if (u.exists) return u.data()
    await sleep(1000)
  }
  return null
}

async function pollEventStatus(db, eventId, ms = 30000) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    const e = await db.collection("pa-inbound-events").doc(eventId).get()
    if (e.exists) {
      const x = e.data()
      if (x.status === "succeeded" || x.status === "coalesced" || x.status === "failed") {
        return x
      }
    }
    await sleep(1500)
  }
  return null
}

async function findUserByPhone(db, phone) {
  for (const field of ["phoneE164", "phone"]) {
    const snap = await db.collection("pa-users").where(field, "==", phone).limit(1).get()
    if (!snap.empty) return { id: snap.docs[0].id, data: snap.docs[0].data() }
  }
  return null
}

async function cleanup(db, userId, phone) {
  if (!userId) return
  const collections = [
    "pa-inbound-events",
    "pa-outbound",
    "pa-messages",
    "pa-turns",
    "parsedCandidateResumes",
  ]
  for (const c of collections) {
    const snap = await db.collection(c).where("userId", "==", userId).get()
    for (const d of snap.docs) await d.ref.delete()
  }
  await db.collection("pa-users").doc(userId).delete()
}

async function main() {
  initFirebase()
  const db = getFirestore()
  const phoneTail = Math.floor(1000000 + Math.random() * 9000000)
  const phone = `+1888${phoneTail}`
  assertProductionPaUserCreationAllowed({
    projectId: PROJECT,
    scriptName: "apps/functions/scripts/e2e-onboarding-sim.mjs",
    phoneE164: phone,
    reason: "legacy fresh-phone onboarding simulator creates a new pa-users row through broker processing",
  })
  console.log(`\n=== E2E onboarding sim — phone ${phone} ===\n`)

  let userId = null
  const startMs = Date.now()
  const turns = []

  function record(label, eventId, expectedState, elapsedMs, actualState, status, extra = {}) {
    const pass =
      expectedState === "*" ||
      (Array.isArray(expectedState) ? expectedState.includes(actualState) : actualState === expectedState)
    turns.push({ label, eventId, expectedState, actualState, status, elapsedMs, pass, ...extra })
    const emoji = pass ? "✅" : "❌"
    console.log(
      ` ${emoji} ${label.padEnd(28)} | event:${(eventId || "").slice(0, 16).padEnd(16)} | status:${(status || "").padEnd(10)} | state:${(actualState || "?").padEnd(20)} | want:${expectedState} | ${elapsedMs}ms`
    )
  }

  // ─── Turn 1: Hi ────────────────────────────────────────────────────
  let t0 = Date.now()
  let eventId = await sendInbound(db, { userId: phone, phone, text: "Hi", eventTag: "hi" })
  await sleep(20000) // let orchestrator process
  let user = await findUserByPhone(db, phone)
  if (!user) {
    console.log("FAIL: orchestrator did not create user record")
    process.exit(1)
  }
  userId = user.id
  let evt = await pollEventStatus(db, eventId)
  record("Hi", eventId, ["q_email_asked", "first_mes_sent"], Date.now() - t0, user.data.onboardingState, evt?.status)

  // ─── Turn 2: email (skip Mailgun roundtrip — manually stamp verified) ─
  t0 = Date.now()
  eventId = await sendInbound(db, { userId, phone, text: "test@example.com", eventTag: "email" })
  await sleep(20000)
  user = await findUserByPhone(db, phone)
  evt = await pollEventStatus(db, eventId)
  record("email", eventId, "*", Date.now() - t0, user.data.onboardingState, evt?.status)
  // If stuck at q_email_verifying, manually stamp verified to skip Mailgun
  if (user.data.onboardingState === "q_email_verifying") {
    await db.collection("pa-users").doc(userId).set({
      emailVerification: { verifiedAt: nowIso(), email: "test@example.com" },
      onboardingState: "q_tos_asked", // simulate code-verified advance
    }, { merge: true })
    console.log("    ↪ test mode: stamped emailVerification verified + advanced to q_tos_asked")
  }

  // ─── Turn 3: Agree ─────────────────────────────────────────────────
  t0 = Date.now()
  eventId = await sendInbound(db, { userId, phone, text: "Agree", eventTag: "agree" })
  await sleep(25000)
  user = await findUserByPhone(db, phone)
  evt = await pollEventStatus(db, eventId)
  record("Agree", eventId, "q_role_asked", Date.now() - t0, user.data.onboardingState, evt?.status, { tosAcceptance: !!user.data.tosAcceptance })

  // ─── Turn 4: Software Engineer ─────────────────────────────────────
  t0 = Date.now()
  eventId = await sendInbound(db, { userId, phone, text: "Software Engineer", eventTag: "role" })
  await sleep(20000)
  user = await findUserByPhone(db, phone)
  evt = await pollEventStatus(db, eventId)
  record("Software Engineer", eventId, "q_yoe_asked", Date.now() - t0, user.data.onboardingState, evt?.status, { targetRole: user.data.tags?.targetRole })

  // ─── Turn 5: 2 years ───────────────────────────────────────────────
  t0 = Date.now()
  eventId = await sendInbound(db, { userId, phone, text: "2 years", eventTag: "yoe" })
  await sleep(20000)
  user = await findUserByPhone(db, phone)
  evt = await pollEventStatus(db, eventId)
  record("2 years", eventId, "q_visa_asked", Date.now() - t0, user.data.onboardingState, evt?.status, { yoeRange: user.data.tags?.yoeRange })

  // ─── Turn 6: Need sponsorship ──────────────────────────────────────
  t0 = Date.now()
  eventId = await sendInbound(db, { userId, phone, text: "Need sponsorship", eventTag: "visa" })
  await sleep(20000)
  user = await findUserByPhone(db, phone)
  evt = await pollEventStatus(db, eventId)
  record("Need sponsorship", eventId, "q_startup_pref_asked", Date.now() - t0, user.data.onboardingState, evt?.status, { visaStatus: user.data.tags?.visaStatus })

  // ─── Turn 7: Either ────────────────────────────────────────────────
  t0 = Date.now()
  eventId = await sendInbound(db, { userId, phone, text: "Either", eventTag: "startup" })
  await sleep(20000)
  user = await findUserByPhone(db, phone)
  evt = await pollEventStatus(db, eventId)
  record("Either", eventId, "q_location_asked", Date.now() - t0, user.data.onboardingState, evt?.status, { prefersStartup: user.data.statedPreferences?.prefersStartup })

  // ─── Turn 8: Anywhere ──────────────────────────────────────────────
  t0 = Date.now()
  eventId = await sendInbound(db, { userId, phone, text: "Anywhere", eventTag: "location" })
  await sleep(20000)
  user = await findUserByPhone(db, phone)
  evt = await pollEventStatus(db, eventId)
  record("Anywhere", eventId, "q_resume_asked", Date.now() - t0, user.data.onboardingState, evt?.status, { targetLocations: user.data.tags?.targetLocations })

  // ─── Turn 9: simulate CV parsed (write parsedCandidateResume + synthetic trigger) ──
  t0 = Date.now()
  const resumeId = `e2e-resume-${userId.slice(0, 8)}`
  await db.collection("parsedCandidateResumes").doc(resumeId).set({
    userId,
    candidateProfile: { skills: ["python", "react", "kubernetes"] },
    workHistory: [{ title: "Software Engineer", company: "Test Co" }],
    topSkills: ["python", "react", "kubernetes", "docker", "aws"],
    industryTags: ["technology"],
    createdAt: new Date(),
  })
  console.log(`    ↪ seeded parsedCandidateResume ${resumeId}`)

  // Fire synthetic cvParsed trigger event (the new fix)
  const trigEventId = `cv-parsed-trigger-e2e-${userId.slice(0, 8)}`
  await db.collection("pa-inbound-events").doc(trigEventId).set({
    id: trigEventId,
    status: "pending",
    idempotencyKey: `cv-parsed:${userId}:${resumeId}`,
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
  await sleep(45000)
  user = await findUserByPhone(db, phone)
  evt = await pollEventStatus(db, trigEventId)
  record(
    "CV-parsed (synthetic trigger)",
    trigEventId,
    ["q_cv_analyzing", "complete"],
    Date.now() - t0,
    user.data.onboardingState,
    evt?.status,
    { resumeId: user.data.resumeId }
  )

  // ─── Verify job recs landed (pa-job-profiles ledger) ──────────────────
  const recs = await db.collection("pa-job-profiles").where("userId", "==", userId).get()
  console.log(`\n=== Job rec ledger: ${recs.size} entries ===`)
  recs.docs.forEach((d) => {
    const x = d.data()
    console.log(` - ${(x.jobTitle || "?").slice(0, 50)} @ ${x.companyName || "?"} | status:${x.status}`)
  })

  // ─── Summary ──────────────────────────────────────────────────────────
  const totalElapsed = ((Date.now() - startMs) / 1000).toFixed(1)
  const passCount = turns.filter((t) => t.pass).length
  console.log(`\n=== SUMMARY ===`)
  console.log(`Turns total:    ${turns.length}`)
  console.log(`Turns pass:     ${passCount}`)
  console.log(`Turns fail:     ${turns.length - passCount}`)
  console.log(`Final state:    ${user.data.onboardingState}`)
  console.log(`Job recs:       ${recs.size}`)
  console.log(`Total elapsed:  ${totalElapsed}s`)

  console.log(`\nCleaning up test user ${userId.slice(0, 12)}...`)
  await cleanup(db, userId, phone)
  console.log("Cleanup done.")

  process.exit(passCount === turns.length && recs.size > 0 ? 0 : 1)
}

main().catch((e) => {
  console.error("E2E ERROR:", e.message)
  console.error(e.stack)
  process.exit(1)
})
