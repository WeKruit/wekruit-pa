#!/usr/bin/env node
/**
 * iter34 sprint C.16 — pre-seed harness state for eval-match-correctness-{zh,en}.yaml.
 *
 * Idempotent. Seeds:
 *   1. pa-users/{id} for the harness participant — with full
 *      statedPreferences (lang/role/visa/loc/email-verified) + onboardingState
 *      pre-staged at q_resume_asked so the runner's first turn triggers the
 *      send_cv_analysis edge (cvParsed=true → ack + analysis + match push +
 *      tag-summary).
 *   2. parsedCandidateResumes/{harness-userId} (copied from a known-good
 *      source CV doc, mutated to attach to the harness userId). This is
 *      what `getUserCvParsed` reads for the cvParsed signal AND what
 *      `generateJobRecs` reads for topSkills/industryTags.
 *
 * Why pre-stage past q_email_verifying: the runner cannot inject the
 * Mailgun-issued verification code (real Mailgun fires for live users on
 * email accept). Without the actual code, q_email_verifying loops
 * forever. Bypassing q_lang→q_email_verify→q_tos lets us focus the
 * scenario on the iter34 sprint match-correctness assertions: ATS URL,
 * blacklist title filter, "为啥推:" reason lines.
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=... \
 *     node tests/scenarios/seed-match-correctness.mjs <participant> <lang>
 *
 * Example:
 *   node tests/scenarios/seed-match-correctness.mjs +19999990601 zh
 *   node tests/scenarios/seed-match-correctness.mjs +19999990602 en
 */
import { readFileSync } from "node:fs"
import { initializeApp, cert, getApps } from "firebase-admin/app"
import { getFirestore, Timestamp } from "firebase-admin/firestore"
import { createHash, randomUUID } from "node:crypto"

const PARTICIPANT_RAW = process.argv[2]
const LANG = process.argv[3] ?? "zh"
if (!PARTICIPANT_RAW) {
  console.error("usage: seed-match-correctness.mjs <participant E.164> <lang zh|en>")
  process.exit(2)
}
if (LANG !== "zh" && LANG !== "en") {
  console.error("lang must be zh or en")
  process.exit(2)
}

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

const SOURCE_CV_DOC_ID = "zLSRbpWz8edA7tAhRadA" // Adam's CV — used by H2 sim
const KNOWN_VERIFICATION_CODE = "654321"
const codeHash = createHash("sha256").update(KNOWN_VERIFICATION_CODE).digest("hex")

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
  // statedPreferences canonical-shape — matches what the deterministic
  // onAccepted hooks would have written. Match-correctness tests SWE 2yo
  // OPT either-startup remote profile.
  const statedPreferences = {
    preferredLang: LANG,
    contactEmail: LANG === "zh" ? "alex.swe@gmail.com" : "alex.swe@gmail.com",
    contactEmailVerifiedAt: nowIso,
    targetRole: ["swe"],
    yoeRange: [2, 2],
    visaStatus: "opt",
    prefersStartup: null, // either
    targetLocations: ["remote"],
    tosAcceptedAt: nowIso,
  }
  await db.collection("pa-users").doc(userId).set(
    {
      onboardingStatus: "active",
      onboardingState: "q_resume_asked",
      statedPreferences,
      testMode: true,
      updatedAt: nowIso,
      // Pre-stage emailVerification too in case something downstream
      // re-checks. Not strictly required when state already past it.
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
  // Always write a fresh CV row — the deterministic q_resume gate reads
  // any row matching userId. ID is deterministic so re-runs are idempotent.
  const targetDocId = `harness-match-correctness-${userId}`

  // Try to clone from the known-good source CV first (preserves topSkills
  // + industryTags shape exactly as cv-ingest produces). If source isn't
  // available, fall back to a hand-rolled minimal SWE doc with the fields
  // generateJobRecs reads.
  let data
  try {
    const src = await db.collection("parsedCandidateResumes").doc(SOURCE_CV_DOC_ID).get()
    if (src.exists) {
      data = src.data()
    }
  } catch (err) {
    // fall through to fallback
  }

  if (!data) {
    // Fallback minimal CV: SWE with Node/React/Tesla-flavored signals.
    data = {
      candidateProfile: {
        name: "Alex SWE",
        skills: ["Node.js", "React", "TypeScript", "Python", "AWS"],
        workHistory: [
          { company: "Tesla", title: "Software Engineer", years: 2, current: false },
          { company: "Acme Inc.", title: "Junior Software Engineer", years: 1 },
        ],
      },
      topSkills: ["Node.js", "React", "TypeScript", "Python", "AWS"],
      industryTags: ["tech_software"],
    }
  }

  data.userId = userId
  data.createdAt = Timestamp.now()
  data.ingestedAt = new Date().toISOString()
  data.harnessSeed = true
  data.note = "iter34 sprint C.16 match-correctness harness seed"
  data.sourceDocId = SOURCE_CV_DOC_ID

  await db.collection("parsedCandidateResumes").doc(targetDocId).set(data, { merge: true })
  return targetDocId
}

async function main() {
  const { id, existing } = await findOrCreateUser()
  console.log(`user: ${id} (${existing ? "existing" : "created"}) for participant ${participant}`)
  await seedUserState(id)
  console.log(`seeded statedPreferences (${LANG}) + onboardingState=q_resume_asked + emailVerification`)
  const cvDocId = await seedCv(id)
  console.log(`seeded parsedCandidateResumes/${cvDocId}`)
  console.log(`OK — harness ready for runner`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
