import { initializeApp, cert, getApps } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { readFileSync } from "node:fs"
import { assertProductionPaUserCreationAllowed } from "./lib/prod-test-user-guard.mjs"

const PROJECT = "wekruit-5f89b"

function init() {
  if (getApps().length > 0) return
  const creds = JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf-8"))
  initializeApp({ credential: cert(creds), projectId: PROJECT })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const nowIso = () => new Date().toISOString()

async function send(db, { userId, phone, text, tag }) {
  const id = `e2enc_${tag}_${Math.random().toString(36).slice(2, 10)}`
  await db.collection("pa-inbound-events").doc(id).set({
    id, status: "pending",
    idempotencyKey: `e2enc:${userId ?? phone}:${id}`,
    createdAt: nowIso(),
    attemptCount: 0, maxAttempts: 1,
    channel: "imessage",
    rawPayload: {
      kind: "imessage",
      source: "e2e-no-cleanup",
      participant: phone, chatId: `iMessage;${phone}`,
      messageRowId: Date.now(), text,
      messageHandle: `e2enc-${id}`,
      service: "iMessage",
      harness: { runner: "e2e-nc", suppressOutbound: true },
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
    scriptName: "apps/functions/scripts/e2e-single-no-cleanup.mjs",
    phoneE164: phone,
    reason: "legacy fresh-phone onboarding probe creates a new pa-users row through broker processing",
  })
  console.log(`Phone: ${phone}\n`)

  // Walk turns
  const steps = [
    { tag: "hi", text: "Hi", wait: 15 },
    { tag: "lang", text: "English", wait: 15 },
    { tag: "email", text: `e2e${phoneTail}@test.com`, wait: 12 },
    // stamp email verified
    { tag: "stamp", action: "stamp-email-verified", wait: 2 },
    { tag: "agree", text: "Agree", wait: 20 },
    { tag: "role", text: "Software Engineer", wait: 15 },
    { tag: "yoe", text: "2 years", wait: 15 },
    { tag: "visa", text: "Need sponsorship", wait: 15 },
    { tag: "startup", text: "Either", wait: 15 },
    { tag: "loc", text: "Anywhere", wait: 15 },
  ]

  let userId = null
  let user = null
  for (const s of steps) {
    if (s.action === "stamp-email-verified") {
      if (user?.data?.onboardingState === "q_email_verifying") {
        await db.collection("pa-users").doc(userId).set({
          emailVerification: { verifiedAt: nowIso(), email: `e2e${phoneTail}@test.com` },
          onboardingState: "q_tos_asked",
        }, { merge: true })
        console.log(`  [stamped email verified + advanced to q_tos_asked]`)
      }
      await sleep(s.wait * 1000)
      continue
    }
    await send(db, { userId, phone, text: s.text, tag: s.tag })
    await sleep(s.wait * 1000)
    user = await findUser(db, phone)
    if (user && !userId) userId = user.id
    console.log(`  [${s.tag}] state=${user?.data?.onboardingState}`)
  }

  // CV parsed + synthetic trigger
  const resumeId = `e2enc-resume-${userId.slice(0, 8)}`
  await db.collection("parsedCandidateResumes").doc(resumeId).set({
    userId,
    candidateProfile: { skills: ["python", "react"] },
    workHistory: [{ title: "Software Engineer", company: "Test Co" }],
    topSkills: ["python", "react", "kubernetes", "docker", "aws"],
    industryTags: ["technology"],
    createdAt: new Date(),
  })
  const trigId = `cv-parsed-trigger-nc-${userId.slice(0, 8)}-${Date.now()}`
  await db.collection("pa-inbound-events").doc(trigId).set({
    id: trigId, status: "pending",
    idempotencyKey: `cv-parsed:${userId}:${resumeId}`,
    createdAt: nowIso(),
    attemptCount: 0, maxAttempts: 1,
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
  await sleep(40 * 1000)
  user = await findUser(db, phone)
  console.log(`\n[CV-parsed] state=${user?.data?.onboardingState}`)

  // Probe pa-outbound for the rec message
  const out = await db.collection("pa-outbound").where("userId", "==", userId).limit(20).get()
  console.log(`\n=== pa-outbound for user (${out.size}) ===`)
  out.docs.sort((a, b) => (b.data().createdAt || "").localeCompare(a.data().createdAt || ""))
  out.docs.forEach((d) => {
    const x = d.data()
    console.log(`  ${(x.createdAt || "").slice(11, 19)} | status=${x.status} | text="${(x.text || "").slice(0, 100)}"`)
  })

  // Probe Adam tags
  console.log(`\n=== Final user tags ===`)
  console.log(JSON.stringify(user.data.tags, null, 2).slice(0, 1500))

  console.log(`\nUser kept for inspection: ${userId}`)
  console.log(`Phone: ${phone}`)

  process.exit(0)
}

main().catch((e) => {
  console.error("ERR:", e.message, e.stack)
  process.exit(1)
})
