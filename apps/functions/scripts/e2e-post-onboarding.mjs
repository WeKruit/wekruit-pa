#!/usr/bin/env node
/**
 * Post-onboarding chat probe — after state=complete, send follow-up
 * messages and verify agent runtime responds (not stuck on deterministic
 * onboarding flow).
 *
 * Tests Adam's full spec: onboarding → recs → memory update → 真聊简历
 */
import { initializeApp, cert, getApps } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { readFileSync } from "node:fs"
import { assertProductionPaUserCreationAllowed } from "./lib/prod-test-user-guard.mjs"

const PROJECT = "wekruit-5f89b"

function init() {
  if (getApps().length > 0) return
  const c = JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf-8"))
  initializeApp({ credential: cert(c), projectId: "wekruit-5f89b" })
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const nowIso = () => new Date().toISOString()

async function send(db, { userId, phone, text, tag, suppress = true }) {
  const id = `e2e4_${tag}_${Math.random().toString(36).slice(2, 10)}`
  const harness = suppress
    ? { runner: "e2e-post-onboarding", suppressOutbound: true }
    : { runner: "e2e-post-onboarding" }
  await db.collection("pa-inbound-events").doc(id).set({
    id, status: "pending",
    idempotencyKey: `e2e4:${userId ?? phone}:${id}`,
    createdAt: nowIso(),
    attemptCount: 0, maxAttempts: 1,
    channel: "imessage",
    rawPayload: {
      kind: "imessage",
      source: "e2e-post",
      participant: phone, chatId: `iMessage;${phone}`,
      messageRowId: Date.now(), text,
      messageHandle: `e2e4-${id}`,
      service: "iMessage",
      harness,
    },
  })
  return id
}

async function findUser(db, phone) {
  for (const f of ["phoneE164", "phone"]) {
    const s = await db.collection("pa-users").where(f, "==", phone).limit(1).get()
    if (!s.empty) return { id: s.docs[0].id, data: s.docs[0].data() }
  }
  return null
}

async function main() {
  init()
  const db = getFirestore()
  const phoneTail = String(Math.floor(2000000 + Math.random() * 7000000))
  const phone = `+1888${phoneTail}`
  assertProductionPaUserCreationAllowed({
    projectId: PROJECT,
    scriptName: "apps/functions/scripts/e2e-post-onboarding.mjs",
    phoneE164: phone,
    reason: "legacy fresh-phone post-onboarding probe creates a new pa-users row through broker processing",
  })
  console.log(`Phone ${phone}`)

  // ── Walk full onboarding (abbreviated)
  await send(db, { phone, text: "Hi", tag: "hi" })
  await sleep(15000)
  let user = await findUser(db, phone)
  const userId = user.id
  console.log(`userId=${userId.slice(0, 12)}`)

  for (const t of [
    { text: "English", tag: "lang", w: 14 },
    { text: `e2e4${phoneTail}@test.com`, tag: "email", w: 12 },
    { text: "STAMP-EMAIL", tag: "stamp" },
    { text: "Agree", tag: "agree", w: 18 },
    { text: "Software Engineer", tag: "role", w: 13 },
    { text: "2 years", tag: "yoe", w: 13 },
    { text: "Need sponsorship", tag: "visa", w: 13 },
    { text: "Either", tag: "startup", w: 13 },
    { text: "Anywhere", tag: "loc", w: 13 },
  ]) {
    if (t.text === "STAMP-EMAIL") {
      const u = await findUser(db, phone)
      if (u.data.onboardingState === "q_email_verifying") {
        await db.collection("pa-users").doc(userId).set({
          emailVerification: { verifiedAt: nowIso(), email: `e2e4${phoneTail}@test.com` },
          onboardingState: "q_tos_asked",
        }, { merge: true })
      }
      await sleep(2000)
      continue
    }
    await send(db, { userId, phone, text: t.text, tag: t.tag })
    await sleep(t.w * 1000)
  }

  // ── CV synthetic trigger
  const resumeId = `e2e4-resume-${userId.slice(0, 8)}`
  await db.collection("parsedCandidateResumes").doc(resumeId).set({
    userId,
    candidateProfile: { skills: ["python", "react"] },
    workHistory: [{ title: "Software Engineer", company: "Test Co" }],
    topSkills: ["python", "react", "kubernetes"],
    industryTags: ["technology"],
    createdAt: new Date(),
  })
  const trigId = `cv-parsed-trigger-post-${userId.slice(0, 8)}-${Date.now()}`
  await db.collection("pa-inbound-events").doc(trigId).set({
    id: trigId, status: "pending",
    idempotencyKey: `cv-parsed:${userId}:${resumeId}-${Date.now()}`,
    createdAt: nowIso(),
    attemptCount: 0, maxAttempts: 1,
    channel: "imessage", userId,
    rawPayload: {
      kind: "imessage", source: "cv-parsed-synthetic",
      participant: phone, chatId: `iMessage;-;${phone}`,
      messageHandle: `cv-parsed-${resumeId}`,
      text: "[cv-parsed]",
      cvParsedTrigger: true, triggerResumeId: resumeId,
    },
  })
  await sleep(40000)
  user = await findUser(db, phone)
  const completeOk = user.data.onboardingState === "complete"
  console.log(`onboarding state=${user.data.onboardingState} ${completeOk ? "✅" : "❌"}`)

  // ── POST-COMPLETE: send follow-ups, verify agent responds
  console.log(`\n=== POST-COMPLETE FOLLOW-UPS ===`)
  const outbeforeCount = (await db.collection("pa-outbound").where("userId", "==", userId).get()).size
  console.log(`outbound before follow-ups: ${outbeforeCount}`)

  const followUps = [
    { text: "What's interesting about my Tesla experience?", tag: "fu1" },
    { text: "找 senior 岗 in San Francisco bay area", tag: "fu2" },
    { text: "Thanks!", tag: "fu3" },
  ]
  const followUpResults = []
  for (const fu of followUps) {
    const beforeOut = (await db.collection("pa-outbound").where("userId", "==", userId).get()).size
    // suppress=false so agent runtime's enqueueOutbound fires + we can verify
    // body content. Real Sendblue API call fails on test phone (status=failed)
    // but body field will be populated, which is what we measure.
    await send(db, { userId, phone, text: fu.text, tag: fu.tag, suppress: false })
    await sleep(20000)
    const afterOut = (await db.collection("pa-outbound").where("userId", "==", userId).get()).size
    const delta = afterOut - beforeOut
    followUpResults.push({ text: fu.text, deltaOutbound: delta })
    console.log(`  "${fu.text}" → +${delta} outbound`)
  }

  // Last 3 outbounds (the agent's responses)
  const out = await db.collection("pa-outbound").where("userId", "==", userId).get()
  out.docs.sort((a, b) => (b.data().createdAt || "").localeCompare(a.data().createdAt || ""))
  console.log(`\n=== Last 5 outbound bodies ===`)
  out.docs.slice(0, 5).forEach((d, i) => {
    const x = d.data()
    console.log(`[${i}] ${(x.createdAt || "").slice(11, 19)} | ${(x.body || "").slice(0, 200)}`)
  })

  // Memory check (Mem0 facts via Firestore mirror or memoryFacts collection)
  const memFacts = await db.collection("memory-facts").where("userId", "==", userId).limit(10).get()
  console.log(`\nmemory-facts entries: ${memFacts.size}`)

  console.log(`\n=== SUMMARY ===`)
  console.log(`onboarding complete:   ${completeOk}`)
  console.log(`follow-up responses:   ${followUpResults.filter((f) => f.deltaOutbound > 0).length}/${followUps.length}`)
  console.log(`memory-facts populated: ${memFacts.size > 0}`)

  // Cleanup
  console.log(`\nCleaning up ${userId.slice(0, 12)}...`)
  for (const c of ["pa-outbound", "pa-messages", "pa-turns", "parsedCandidateResumes", "pa-inbound-events"]) {
    const s = await db.collection(c).where("userId", "==", userId).get()
    for (const d of s.docs) await d.ref.delete()
  }
  await db.collection("pa-users").doc(userId).delete()
  process.exit(completeOk && followUpResults.every((f) => f.deltaOutbound > 0) ? 0 : 1)
}

main().catch((e) => {
  console.error("FATAL:", e.message, e.stack)
  process.exit(1)
})
