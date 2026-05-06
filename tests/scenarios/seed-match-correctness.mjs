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

const KNOWN_VERIFICATION_CODE = "654321"
const codeHash = createHash("sha256").update(KNOWN_VERIFICATION_CODE).digest("hex")

// SWE persona definitions — purpose-built so match-correctness scenarios
// actually exercise the SWE/Tesla/Node+React path (NOT the source-CV
// "Mike"/NEUROVAInc/SQL+Python signals we used to clone). Both personas
// are SWE 2yo OPT remote candidates aligned with the seeded
// statedPreferences.targetRole=["swe"].
const PERSONAS = {
  zh: {
    candidateProfile: {
      name: "Alex Chen",
      email: "alex.chen@example.com",
      phone: null,
      linkedIn: null,
      location: "Remote",
      skills: ["Node.js", "React", "TypeScript", "AWS", "PostgreSQL", "Docker", "Kubernetes"],
    },
    topSkills: ["node.js", "react", "typescript", "aws", "postgresql", "docker", "kubernetes"],
    experiences: [
      {
        company: "Tesla",
        title: "Software Engineer",
        startDate: "2023-06",
        endDate: null,
        location: "Austin, TX",
        description:
          "Built V&C routing system for 300+ stores using Node.js + React. Migrated backend to Azure. Set up CI/CD with Kubernetes/Docker.",
      },
      {
        company: "Self-employed",
        title: "Founder / Engineer",
        startDate: "2022-01",
        endDate: "2023-05",
        location: "Austin, TX",
        description:
          "Built education platform with Flask/React/React Native + 阿里云. Integrated LangChain for LLM APIs.",
      },
    ],
    education: [
      {
        school: "UT Austin",
        degree: "BS",
        field: "Computer Science",
        startDate: "2018-08",
        endDate: "2022-05",
      },
    ],
    industryTags: ["tech_software", "ai_ml"],
    originalFileName: "alex-chen-resume.pdf",
  },
  en: {
    candidateProfile: {
      name: "Sam Patel",
      email: "sam.patel@example.com",
      phone: null,
      linkedIn: null,
      location: "Remote",
      skills: ["Go", "Kubernetes", "gRPC", "PostgreSQL", "Terraform", "AWS"],
    },
    topSkills: ["go", "kubernetes", "grpc", "postgresql", "terraform", "aws"],
    experiences: [
      {
        company: "Stripe",
        title: "Backend Engineer",
        startDate: "2024-01",
        endDate: null,
        location: "San Francisco, CA",
        description:
          "Built payment infrastructure on Go + gRPC. Scaled K8s deployments globally.",
      },
      {
        company: "Cloudflare",
        title: "Software Engineer Intern",
        startDate: "2022-06",
        endDate: "2022-09",
        location: "Remote",
        description: "Edge worker runtime in Rust + V8 isolates.",
      },
    ],
    education: [
      {
        school: "MIT",
        degree: "BS",
        field: "Computer Science",
        startDate: "2020-08",
        endDate: "2024-05",
      },
    ],
    industryTags: ["tech_software", "fintech_finance"],
    originalFileName: "sam-patel-resume.pdf",
  },
}

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

  // iter34 followup D.2: build SWE persona doc from scratch (NOT clone
  // from source CV — that pulled "Mike"/NEUROVAInc/SQL+Python signals
  // unrelated to the SWE path the scenario claims to test). Persona is
  // selected by LANG so zh and en runs exercise distinct, fully-formed
  // SWE candidates. Both populate every field generateJobRecs +
  // send_cv_analysis read: candidateProfile, topSkills, experiences,
  // workHistory (v2 path), education, industryTags, plus a mock
  // 1536-d embedding so cosineSimilarity-based scoring exercises too.
  const persona = PERSONAS[LANG]
  const nowIso = new Date().toISOString()
  const data = {
    userId,
    candidateProfile: persona.candidateProfile,
    experiences: persona.experiences,
    workHistory: persona.experiences, // v2 path uses same shape
    topSkills: persona.topSkills,
    education: persona.education,
    industryTags: persona.industryTags,
    parserVersion: "v1",
    ingestedAt: nowIso,
    ingestedVia: "harness-seed",
    originalFileName: persona.originalFileName,
    fileType: "application/pdf",
    studentFrom: null,
    sessionId: null,
    mediaUrl: "https://example.com/seed-resume.pdf",
    createdAt: Timestamp.now(),
    // Mock 1536-d embedding (text-embedding-3-small dim) so the embedding
    // path doesn't crash cosineSimilarity. Uniform 0.01 vector — not a
    // semantic match against any real job, but exercises the code path.
    embedding: new Array(1536).fill(0.01),
    embeddingModel: "text-embedding-3-small",
    embeddingDim: 1536,
    embeddingComputedAt: nowIso,
    harnessSeed: true,
    note: "iter34 followup D.2 — SWE persona (no source-CV clone)",
  }

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
