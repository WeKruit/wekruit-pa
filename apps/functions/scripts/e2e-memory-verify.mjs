#!/usr/bin/env node
/**
 * Memory persistence probe — after onboarding + post-complete chat,
 * verify Mem0/Firestore writes happen across turns.
 */
import { initializeApp, cert, getApps } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { readFileSync } from "node:fs"

function init() {
  if (getApps().length > 0) return
  const c = JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf-8"))
  initializeApp({ credential: cert(c), projectId: "wekruit-5f89b" })
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const nowIso = () => new Date().toISOString()

async function send(db, { userId, phone, text, tag, suppress = true }) {
  const id = `e2em_${tag}_${Math.random().toString(36).slice(2, 10)}`
  await db.collection("pa-inbound-events").doc(id).set({
    id, status: "pending",
    idempotencyKey: `e2em:${userId ?? phone}:${id}`,
    createdAt: nowIso(),
    attemptCount: 0, maxAttempts: 1,
    channel: "imessage",
    rawPayload: {
      kind: "imessage",
      source: "e2e-memory",
      participant: phone, chatId: `iMessage;${phone}`,
      messageRowId: Date.now(), text,
      messageHandle: `e2em-${id}`,
      service: "iMessage",
      harness: suppress ? { runner: "e2e-memory", suppressOutbound: true } : { runner: "e2e-memory" },
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

async function snapshotMemory(db, userId) {
  const collections = ["pa-memory-facts", "pa-memory-actions", "pa-memory-events", "pa-tags-events"]
  const snap = {}
  for (const c of collections) {
    try {
      const s = await db.collection(c).where("userId", "==", userId).count().get()
      snap[c] = s.data().count
    } catch {
      snap[c] = "(no-index)"
    }
  }
  return snap
}

async function main() {
  init()
  const db = getFirestore()
  const phoneTail = String(Math.floor(2000000 + Math.random() * 7000000))
  const phone = `+1888${phoneTail}`
  console.log(`Phone ${phone}`)

  // Walk full onboarding (suppressed)
  await send(db, { phone, text: "Hi", tag: "hi", suppress: true })
  await sleep(15000)
  let user = await findUser(db, phone)
  const userId = user.id
  console.log(`userId=${userId.slice(0, 12)}`)

  for (const t of [
    { text: "English", tag: "lang", w: 14 },
    { text: `e2em${phoneTail}@test.com`, tag: "email", w: 12 },
    { text: "STAMP", tag: "stamp" },
    { text: "Agree", tag: "agree", w: 18 },
    { text: "Software Engineer", tag: "role", w: 13 },
    { text: "2 years", tag: "yoe", w: 13 },
    { text: "Need sponsorship", tag: "visa", w: 13 },
    { text: "Either", tag: "startup", w: 13 },
    { text: "Anywhere", tag: "loc", w: 13 },
  ]) {
    if (t.text === "STAMP") {
      const u = await findUser(db, phone)
      if (u.data.onboardingState === "q_email_verifying") {
        await db.collection("pa-users").doc(userId).set({
          emailVerification: { verifiedAt: nowIso(), email: `e2em${phoneTail}@test.com` },
          onboardingState: "q_tos_asked",
        }, { merge: true })
      }
      await sleep(2000)
      continue
    }
    await send(db, { userId, phone, text: t.text, tag: t.tag, suppress: true })
    await sleep(t.w * 1000)
  }

  // Snapshot memory pre-CV
  const memPreCv = await snapshotMemory(db, userId)
  console.log(`\nMemory before CV-trigger:`, JSON.stringify(memPreCv))

  // CV trigger
  const resumeId = `e2em-resume-${userId.slice(0, 8)}`
  await db.collection("parsedCandidateResumes").doc(resumeId).set({
    userId,
    candidateProfile: { skills: ["python", "react"] },
    workHistory: [{ title: "Software Engineer", company: "Tesla" }],
    topSkills: ["python", "react", "kubernetes", "docker"],
    industryTags: ["technology"],
    createdAt: new Date(),
  })
  const trigId = `cv-trigger-mem-${userId.slice(0, 8)}-${Date.now()}`
  await db.collection("pa-inbound-events").doc(trigId).set({
    id: trigId, status: "pending",
    idempotencyKey: `cv-mem:${userId}:${resumeId}`,
    createdAt: nowIso(), attemptCount: 0, maxAttempts: 1,
    channel: "imessage", userId,
    rawPayload: {
      kind: "imessage", source: "cv-parsed-synthetic",
      participant: phone, chatId: `iMessage;-;${phone}`,
      messageHandle: `cv-${resumeId}`,
      text: "[cv-parsed]",
      cvParsedTrigger: true, triggerResumeId: resumeId,
    },
  })
  await sleep(40000)

  // Snapshot memory post-CV
  const memPostCv = await snapshotMemory(db, userId)
  console.log(`Memory after CV-trigger:`, JSON.stringify(memPostCv))

  // Send 3 follow-ups (suppress=false to fire agent runtime)
  for (const t of [
    { text: "I love distributed systems and ML inference", tag: "fu1" },
    { text: "find me senior backend roles", tag: "fu2" },
    { text: "I prefer remote-first companies", tag: "fu3" },
  ]) {
    await send(db, { userId, phone, text: t.text, tag: t.tag, suppress: false })
    await sleep(20000)
  }

  // Final memory snapshot
  const memFinal = await snapshotMemory(db, userId)
  console.log(`Memory final:`, JSON.stringify(memFinal))

  // Probe pa-memory-facts content
  for (const c of ["pa-memory-facts", "pa-memory-actions", "pa-memory-events", "pa-tags-events"]) {
    try {
      const s = await db.collection(c).where("userId", "==", userId).limit(5).get()
      if (!s.empty) {
        console.log(`\n[${c}] ${s.size} entries (showing 3):`)
        s.docs.slice(0, 3).forEach((d) => {
          const x = d.data()
          console.log(`  ${d.id.slice(0, 20)}: ${JSON.stringify(x).slice(0, 200)}`)
        })
      }
    } catch {}
  }

  // Cleanup
  console.log(`\nCleanup ${userId.slice(0, 12)}...`)
  for (const c of ["pa-outbound", "pa-messages", "pa-turns", "parsedCandidateResumes", "pa-inbound-events", "pa-memory-facts", "pa-memory-actions", "pa-memory-events", "pa-tags-events"]) {
    try {
      const s = await db.collection(c).where("userId", "==", userId).get()
      for (const d of s.docs) await d.ref.delete()
    } catch {}
  }
  await db.collection("pa-users").doc(userId).delete()

  process.exit(0)
}

main().catch((e) => {
  console.error("FATAL:", e.message, e.stack)
  process.exit(1)
})
