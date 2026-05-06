#!/usr/bin/env node
/**
 * iter34 followup D.8 — pre-seed harness state with Adam's REAL CV +
 * statedPreferences for sim. The point: when the sim spits a job
 * recommendation, Adam himself can read it and judge "would I take
 * this?". A synthetic SWE persona (D.2 seed-match-correctness) does
 * NOT let that — only the real-Adam profile does.
 *
 * Privacy: this seed clones Adam's parsedCandidateResumes row under a
 * test userId. Original Adam doc + Adam's real pa-users entry are NOT
 * mutated. The clone lives under a deterministic doc id so re-runs are
 * idempotent. Test user `+19999990603` is the harness participant.
 *
 * Source data (already in Firestore):
 *   - parsedCandidateResumes/rQIqQEghvZLwVkMad2lJ — Adam Yang real CV
 *     (Tesla SWE Intern, AI Study founder, OFO Delivery co-founder, USC
 *     CS BS, ~1.9 yoe, parserVersion=v2)
 *
 * statedPreferences are INFERRED (Adam never filled them through PA).
 * Choices reflect what the CV / public bio implies:
 *   - preferredLang: zh (Adam mostly zh+en mixed; default zh per
 *     iMessage Apple ID directive)
 *   - targetRole: ["swe"] (CV is SWE-only)
 *   - yoeRange: [1, 2] (totalYearsExperience=1.9, recent grad)
 *   - visaStatus: "opt" (USC CS, expected grad May 2025 → OPT typical)
 *   - prefersStartup: null (Adam founded multiple, but also Tesla intern
 *     — leave neutral so sim recs both)
 *   - targetLocations: ["los_angeles", "austin", "remote"] (USC LA +
 *     Tesla Austin from CV)
 *   - contactEmail: synthetic test email, NOT Adam's real one
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=... \
 *     node tests/scenarios/seed-adam-real-cv.mjs +19999990603
 *
 * After this seed, run runner.mjs against
 *   tests/scenarios/eval-adam-real-cv-zh.yaml
 * to fire send_cv_analysis with Adam's real CV data and inspect the
 * resulting job recs for plausibility against Adam's actual background.
 */
import { readFileSync } from "node:fs"
import { initializeApp, cert, getApps } from "firebase-admin/app"
import { getFirestore, Timestamp } from "firebase-admin/firestore"
import { createHash, randomUUID } from "node:crypto"

const PARTICIPANT_RAW = process.argv[2] ?? "+19999990603"

function normalizeE164(p) {
  const d = p.replace(/\D/g, "")
  if (p.trim().startsWith("+")) return `+${d}`
  return d.length === 10 ? `+1${d}` : `+${d}`
}
const participant = normalizeE164(PARTICIPANT_RAW)

const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
if (!credPath) {
  console.error("GOOGLE_APPLICATION_CREDENTIALS env var required")
  process.exit(2)
}
const sa = JSON.parse(readFileSync(credPath, "utf8"))
if (!getApps().length) initializeApp({ credential: cert(sa), projectId: sa.project_id })
const db = getFirestore()

const KNOWN_VERIFICATION_CODE = "654321"
const codeHash = createHash("sha256").update(KNOWN_VERIFICATION_CODE).digest("hex")

// Adam's real CV doc id (latest parse, 2026-05-05). DO NOT mutate the
// source — we copy it.
const ADAM_SOURCE_CV_DOC_ID = "rQIqQEghvZLwVkMad2lJ"

async function findOrCreateUser() {
  const snap = await db.collection("pa-users").where("phoneE164", "==", participant).limit(1).get()
  if (!snap.empty) {
    return { id: snap.docs[0].id, existing: true }
  }
  const id = randomUUID()
  await db.collection("pa-users").doc(id).set({
    id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    phoneE164: participant,
    channels: { imessageHandle: participant },
    onboardingStatus: "provisional",
    testMode: true,
  })
  return { id, existing: false }
}

async function seedUserState(userId) {
  const nowIso = new Date().toISOString()
  // Inferred from Adam's CV — see file header for rationale.
  const statedPreferences = {
    preferredLang: "zh",
    contactEmail: "adam-harness-test@example.com",
    contactEmailVerifiedAt: nowIso,
    targetRole: ["swe"],
    yoeRange: [1, 2],
    visaStatus: "opt",
    prefersStartup: null,
    targetLocations: ["los_angeles", "austin", "remote"],
    tosAcceptedAt: nowIso,
  }
  await db.collection("pa-users").doc(userId).set(
    {
      onboardingStatus: "active",
      onboardingState: "q_resume_asked",
      statedPreferences,
      testMode: true,
      updatedAt: nowIso,
      emailVerification: {
        codeHash,
        email: statedPreferences.contactEmail,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        attempts: 0,
        sentAt: nowIso,
      },
    },
    { merge: true }
  )
}

async function seedCv(userId) {
  // Clone Adam's real CV under a deterministic test doc id, swapping
  // userId → harness userId so generateJobRecs / send_cv_analysis read
  // the right row when the dispatcher fires for the test participant.
  const targetDocId = `harness-adam-real-${userId}`
  const src = await db.collection("parsedCandidateResumes").doc(ADAM_SOURCE_CV_DOC_ID).get()
  if (!src.exists) {
    throw new Error(`source CV doc not found: ${ADAM_SOURCE_CV_DOC_ID}`)
  }
  const data = src.data()

  // Mutate copy: attach to harness userId; refresh createdAt; mark seed.
  // PRESERVE original candidateProfile / experiences / education /
  // industryTags / topSkills / embedding / parserVersion verbatim so
  // downstream readers see Adam's actual signal.
  data.userId = userId
  data.createdAt = Timestamp.now()
  data.ingestedAt = new Date().toISOString()
  data.ingestedVia = "harness-seed-adam-real"
  data.harnessSeed = true
  data.sourceDocId = ADAM_SOURCE_CV_DOC_ID
  data.note = "iter34 followup D.8 — Adam real CV cloned under test userId for sim"

  await db.collection("parsedCandidateResumes").doc(targetDocId).set(data, { merge: false })
  return targetDocId
}

async function main() {
  const { id, existing } = await findOrCreateUser()
  console.log(`user: ${id} (${existing ? "existing" : "created"}) for participant ${participant}`)
  await seedUserState(id)
  console.log(`seeded statedPreferences (Adam-inferred zh/swe/opt/LA-Austin-remote) + onboardingState=q_resume_asked`)
  const cvDocId = await seedCv(id)
  console.log(`seeded parsedCandidateResumes/${cvDocId} (cloned from ${ADAM_SOURCE_CV_DOC_ID})`)
  console.log(`OK — Adam-real-CV harness ready for runner`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
