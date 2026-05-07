#!/usr/bin/env node
/**
 * v3 onboarding sim — adds PA_RESET prefix per iter.
 *
 * Each iter:
 *   0. Pre-seed user with FULL state (tags + tosAcceptance + voiceStyle +
 *      onboardedAt + emailVerification + skills) to simulate "user from
 *      prior session"
 *   1. Send __PA_RESET__ via real inbound event (production code path,
 *      hits maybeHandleResetCommand → admin.ts clearUserMemory)
 *   2. Verify reset wipe: tags=undefined, tosAcceptance=undefined,
 *      voiceStylePreference=undefined, emailVerification=null,
 *      onboardedAt=undefined, parsedCandidateResumes=0
 *   3. Send Hi → English → email → Agree → role → yoe → visa → startup
 *      → location → CV synthetic trigger
 *   4. Verify final state=complete + outbound has ack + 2 job recs
 *
 * Mixes 1/4 iters with INVALID first reply at role/yoe/visa to test
 * graceful re-ask.
 */
import { initializeApp, cert, getApps } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { readFileSync } from "node:fs"

const PROJECT = "wekruit-5f89b"
const ITER = parseInt(process.env.E2E_ITER ?? "20", 10)

function init() {
  if (getApps().length > 0) return
  const c = JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf-8"))
  initializeApp({ credential: cert(c), projectId: PROJECT })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const nowIso = () => new Date().toISOString()

async function send(db, { userId, phone, text, tag, testMode = true }) {
  const id = `e2e3_${tag}_${Math.random().toString(36).slice(2, 10)}`
  const doc = {
    id,
    status: "pending",
    idempotencyKey: `e2e3:${userId ?? phone}:${id}`,
    createdAt: nowIso(),
    attemptCount: 0,
    maxAttempts: 1,
    channel: "imessage",
    rawPayload: {
      kind: "imessage",
      source: "e2e-v3",
      participant: phone,
      chatId: `iMessage;${phone}`,
      messageRowId: Date.now(),
      text,
      messageHandle: `e2e3-${id}`,
      service: "iMessage",
      harness: { runner: "e2e-20iter-v3", suppressOutbound: true },
    },
  }
  if (testMode) doc.testMode = true
  await db.collection("pa-inbound-events").doc(id).set(doc)
  return id
}

async function findUser(db, phone) {
  for (const f of ["phoneE164", "phone"]) {
    const s = await db.collection("pa-users").where(f, "==", phone).limit(1).get()
    if (!s.empty) return { id: s.docs[0].id, data: s.docs[0].data() }
  }
  return null
}

async function cleanup(db, userId, phone) {
  if (!userId) return
  const cols = ["pa-inbound-events", "pa-outbound", "pa-messages", "pa-turns", "parsedCandidateResumes", "pa-job-profiles"]
  for (const c of cols) {
    const s = await db.collection(c).where("userId", "==", userId).get()
    for (const d of s.docs) await d.ref.delete()
  }
  await db.collection("pa-users").doc(userId).delete()
}

async function runIter(db, idx) {
  const phoneTail = String(Math.floor(2000000 + Math.random() * 7000000))
  const phone = `+1888${phoneTail}`
  const r = {
    iter: idx,
    phone,
    pass: false,
    error: null,
    resetPass: false,
    onboardingPass: false,
    recsCount: 0,
    finalState: null,
  }

  try {
    // ── Step 0: Hi (orchestrator creates user)
    await send(db, { phone, text: "Hi", tag: "hi-pre" })
    await sleep(15000)
    let user = await findUser(db, phone)
    if (!user) throw new Error("user not created after Hi")
    const userId = user.id
    r.userId = userId

    // Pre-seed full state to simulate "prior session"
    await db.collection("pa-users").doc(userId).set({
      tags: {
        schemaVersion: 1,
        preferredLang: "zh",
        targetRoleFunction: ["software_engineering"],
        visaStatus: "sponsor_needed",
        skills: [{ name: "react", bucket: "frameworks_and_libraries", proficiency: "expert", evidenceCount: 1, baseWeight: 0.9 }],
      },
      onboardedAt: "2026-05-01T00:00:00Z",
      onboardingStatus: "active",
      tosAcceptance: { channel: "imessage_sms", version: "v1.0", acceptedAt: "2026-05-01T00:00:00Z" },
      voiceStylePreference: { user_id: userId, emoji_tolerance: "none", zh_en_mix: "balanced" },
      emailVerification: { code: "999999", verifiedAt: "2026-05-01T00:00:00Z" },
      coalesceTurnSeq: 99,
      resumeParseCount: 5,
      preferredLang: "zh",
    }, { merge: true })
    // also seed a parsedCandidateResume
    await db.collection("parsedCandidateResumes").add({ userId, createdAt: new Date(), candidateProfile: { skills: ["react"] } })

    // ── Step 1: PA_RESET (testMode=true for bypass admin check)
    // The orchestrator's maybeHandleResetCommand requires testMode=true
    // OR userId in PA_ADMIN_USER_IDS. Test users are testMode=true.
    await db.collection("pa-users").doc(userId).set({ testMode: true }, { merge: true })
    await send(db, { userId, phone, text: "__PA_RESET__", tag: "reset" })
    await sleep(15000)
    user = await findUser(db, phone)

    // Verify wipe: critical fields should be undefined
    const d = user.data
    const wipeChecks = {
      tags: d.tags === undefined,
      tosAcceptance: d.tosAcceptance === undefined,
      voiceStylePreference: d.voiceStylePreference === undefined,
      emailVerification: d.emailVerification === undefined || d.emailVerification === null,
      onboardedAt: d.onboardedAt === undefined,
      coalesceTurnSeq: d.coalesceTurnSeq === undefined,
      resumeParseCount: d.resumeParseCount === undefined,
    }
    const cvCount = (await db.collection("parsedCandidateResumes").where("userId", "==", userId).get()).size
    wipeChecks.parsedCandidateResumes = cvCount === 0
    r.resetPass = Object.values(wipeChecks).every(Boolean)
    r.wipeChecks = wipeChecks

    if (!r.resetPass) {
      r.error = "RESET incomplete: " + JSON.stringify(wipeChecks)
      return r
    }

    // ── Step 2: walk onboarding
    const invalidStep = idx % 4
    const turns = [
      { tag: "lang", text: "English", wait: 15 },
      { tag: "email", text: `e2e3${phoneTail}@test.com`, wait: 12 },
      { tag: "stamp" },
      { tag: "agree", text: "Agree", wait: 18 },
      ...(invalidStep === 1 ? [{ tag: "role-bad", text: "Coffee", wait: 12 }] : []),
      { tag: "role", text: "Software Engineer", wait: 13 },
      ...(invalidStep === 2 ? [{ tag: "yoe-bad", text: "purple", wait: 12 }] : []),
      { tag: "yoe", text: "2 years", wait: 13 },
      ...(invalidStep === 3 ? [{ tag: "visa-bad", text: "🤷", wait: 12 }] : []),
      { tag: "visa", text: "Need sponsorship", wait: 13 },
      { tag: "startup", text: "Either", wait: 13 },
      { tag: "loc", text: "Anywhere", wait: 13 },
    ]

    for (const t of turns) {
      if (t.tag === "stamp") {
        const u2 = await findUser(db, phone)
        if (u2.data.onboardingState === "q_email_verifying") {
          await db.collection("pa-users").doc(userId).set({
            emailVerification: { verifiedAt: nowIso(), email: `e2e3${phoneTail}@test.com` },
            onboardingState: "q_tos_asked",
          }, { merge: true })
        }
        await sleep(2000)
        continue
      }
      await send(db, { userId, phone, text: t.text, tag: t.tag })
      await sleep(t.wait * 1000)
    }

    // ── Step 3: synthetic CV-parsed trigger
    const resumeId = `e2e3-resume-${userId.slice(0, 8)}`
    await db.collection("parsedCandidateResumes").doc(resumeId).set({
      userId,
      candidateProfile: { skills: ["python", "react"] },
      workHistory: [{ title: "Software Engineer", company: "Test Co" }],
      topSkills: ["python", "react", "kubernetes", "docker", "aws"],
      industryTags: ["technology"],
      createdAt: new Date(),
    })
    const trigId = `cv-parsed-trigger-v3-${userId.slice(0, 8)}-${Date.now()}`
    await db.collection("pa-inbound-events").doc(trigId).set({
      id: trigId,
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

    user = await findUser(db, phone)
    r.finalState = user.data.onboardingState

    // Verify outbound has ack + recs
    const out = await db.collection("pa-outbound").where("userId", "==", userId).get()
    const recs = out.docs.filter((d) => {
      const b = d.data().body || ""
      return b.includes("two roles") || b.includes("对得上的岗位")
    })
    const acks = out.docs.filter((d) => {
      const b = d.data().body || ""
      return b.includes("give me a sec") || b.includes("让我看一下你简历")
    })
    r.recsCount = recs.length
    r.ackCount = acks.length
    r.outboundCount = out.size
    r.onboardingPass = r.finalState === "complete" && recs.length >= 1 && acks.length >= 1
    if (recs.length > 0) r.recBody = recs[0].data().body.slice(0, 160)

    r.pass = r.resetPass && r.onboardingPass
  } catch (err) {
    r.error = err.message
  }

  try { await cleanup(db, r.userId, phone) } catch {}
  return r
}

async function main() {
  init()
  const db = getFirestore()
  console.log(`\n=== v3 PA_RESET + onboarding integration test (${ITER} iters) ===\n`)
  const results = []
  for (let i = 1; i <= ITER; i++) {
    const t0 = Date.now()
    console.log(`──── Iter ${i}/${ITER} ────`)
    const r = await runIter(db, i)
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
    const emoji = r.pass ? "✅" : "❌"
    console.log(
      ` ${emoji} iter${String(i).padStart(2)} | ${elapsed}s | reset=${r.resetPass ? "OK" : "FAIL"} | onboard=${r.onboardingPass ? "OK" : "FAIL"} | state=${r.finalState} | outbound=${r.outboundCount} (ack=${r.ackCount} recs=${r.recsCount}) | err=${r.error || "-"}`
    )
    if (!r.resetPass && r.wipeChecks) {
      console.log(`     wipe gaps: ${Object.entries(r.wipeChecks).filter(([, v]) => !v).map(([k]) => k).join(", ")}`)
    }
    results.push({ ...r, elapsedSec: elapsed })
  }

  const passCount = results.filter((r) => r.pass).length
  const resetPass = results.filter((r) => r.resetPass).length
  const onboardingPass = results.filter((r) => r.onboardingPass).length
  console.log(`\n=== AGGREGATE ===`)
  console.log(`Reset pass:      ${resetPass}/${ITER}`)
  console.log(`Onboarding pass: ${onboardingPass}/${ITER}`)
  console.log(`Combined pass:   ${passCount}/${ITER}`)
  console.log(`Avg time:        ${(results.reduce((a, r) => a + parseFloat(r.elapsedSec), 0) / results.length).toFixed(1)}s`)

  if (passCount < ITER) {
    console.log(`\n=== Failures ===`)
    results.filter((r) => !r.pass).forEach((r) => {
      console.log(` - iter${r.iter} | resetPass=${r.resetPass} onboardingPass=${r.onboardingPass} err=${r.error || "n/a"}`)
    })
  }

  process.exit(passCount === ITER ? 0 : 1)
}

main().catch((e) => {
  console.error("FATAL:", e.message, e.stack)
  process.exit(1)
})
