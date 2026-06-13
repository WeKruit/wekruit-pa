// Headless PROD E2E: recruiter claim → REAL submission through the deployed
// paRecruiterSubmission, with NO candidateConsent field in the payload.
// Proves the candidate_consent_required gate is gone in production.
// Synthetic recruiter + test candidate; deletes everything it creates.
import { initializeApp, cert } from "firebase-admin/app"
import { getFirestore, Timestamp } from "firebase-admin/firestore"
import { getAuth } from "firebase-admin/auth"
import { createHash, randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"

const API_KEY = process.env.WEB_API_KEY
const app = initializeApp({ credential: cert(JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8"))) })
const db = getFirestore(app)
const auth = getAuth(app)
const BASE = "https://us-central1-wekruit-5f89b.cloudfunctions.net"

const STAMP = Date.now().toString(36)
const EMAIL = `claude-e2e-submit-${STAMP}@wekruit-e2e.invalid.example.com`.toLowerCase()
const NAME = "Claude E2E Recruiter"
const CAND_EMAIL = `claude-e2e-candidate-${STAMP}@wekruit-e2e.invalid.example.com`.toLowerCase()

const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
let suffix = ""
const bytes = randomBytes(8)
for (let i = 0; i < 8; i++) suffix += alphabet[bytes[i] % alphabet.length]
const CODE = `WK-${suffix.slice(0, 4)}-${suffix.slice(4)}`
const HASH = createHash("sha256").update(CODE).digest("hex")

const cleanup = []
let failed = false
const fail = (m) => { console.error("FAIL:", m); failed = true }

try {
  // 1. invite + synthetic recruiter auth user → ID token
  await db.collection("pa-recruiter-invite-codes").doc(HASH).set({
    inviteCodeId: HASH, inviteCode: CODE, active: true, label: "claude-e2e-submit (auto-cleanup)",
    recruiterEmail: EMAIL, codePreview: `${CODE.slice(0, 5)}••••${CODE.slice(-2)}`,
    maxUses: 1, usedCount: 0, expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    inviteEmailStatus: "not_requested", createdByEmail: "claude-e2e@wekruit.com",
    createdAt: Timestamp.now(), updatedAt: Timestamp.now(),
  })
  cleanup.push(() => db.collection("pa-recruiter-invite-codes").doc(HASH).delete())

  const user = await auth.createUser({ email: EMAIL, emailVerified: true, displayName: NAME })
  cleanup.push(() => auth.deleteUser(user.uid))
  cleanup.push(() => db.collection("pa-recruiter-users").doc(user.uid).delete())
  const customToken = await auth.createCustomToken(user.uid)
  const exch = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${API_KEY}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  }).then((r) => r.json())
  if (!exch.idToken) throw new Error("token exchange failed: " + JSON.stringify(exch).slice(0, 200))
  const ID_TOKEN = exch.idToken
  const H = { "Content-Type": "application/json", Authorization: `Bearer ${ID_TOKEN}` }
  console.log("1. recruiter auth user:", user.uid, EMAIL)

  // 2. claim recruiter access (production endpoint)
  const claim = await fetch(`${BASE}/paRecruiterAccess`, { method: "POST", headers: H, body: JSON.stringify({ name: NAME, email: EMAIL, inviteCode: CODE }) }).then((r) => r.json())
  console.log("2. claim ok:", claim.ok === true)
  if (!claim.ok) { fail("claim rejected: " + JSON.stringify(claim).slice(0, 200)); throw new Error("cannot continue without claim") }

  // 3. pick a real collab job the recruiter can see
  const jobsResp = await fetch(`${BASE}/paCollabJobsList`, { headers: H }).then((r) => r.json())
  const jobs = jobsResp.jobs ?? jobsResp.roles ?? []
  if (!jobs.length) { fail("recruiter sees no collab jobs"); throw new Error("no jobs") }
  const job = jobs[0]
  const jobId = job.jobId ?? job.id
  console.log("3. target job:", jobId, "|", job.title)

  // read required submitFields from the job doc and satisfy them
  const jobDoc = (await db.collection("pa-jobs").doc(jobId).get()).data() || {}
  const submitFields = jobDoc.recruiterBoard?.submitFields ?? []
  const extraFields = {}
  for (const f of submitFields) if (f.required) extraFields[f.id] = "https://example.com/e2e-portfolio"
  console.log("   required submitFields filled:", JSON.stringify(extraFields))

  // 4. THE TEST — submit WITHOUT candidateConsent
  const payload = {
    jobId,
    submitter: { name: NAME, email: EMAIL },
    candidate: { name: "Loi E2E Tran", email: CAND_EMAIL, link: "https://linkedin.com/in/loi-e2e-tran" },
    checklist: {},
    candidateLinkedinUrl: "https://linkedin.com/in/loi-e2e-tran",
    candidateResumeUrl: "https://example.com/resume-e2e.pdf",
    ...(Object.keys(extraFields).length ? { extraFields } : {}),
    // *** intentionally NO candidateConsent field ***
  }
  console.log("4. submitting WITHOUT candidateConsent field. payload keys:", Object.keys(payload).join(","))
  const sub = await fetch(`${BASE}/paRecruiterSubmission`, { method: "POST", headers: H, body: JSON.stringify(payload) }).then((r) => r.json())
  console.log("   RESPONSE:", JSON.stringify(sub).slice(0, 400))

  if (sub.reason === "candidate_consent_required") fail("STILL gated on consent — fix not live!")
  if (sub.ok !== true) fail("submission not ok: " + JSON.stringify(sub).slice(0, 200))
  else console.log("   ✅ submission ok=true, submissionId:", sub.submissionId)

  // 5. confirm the stored doc + recruiter_asserted consent, then clean up
  if (sub.submissionId) {
    cleanup.push(() => db.collection("pa-recruiter-submissions").doc(sub.submissionId).delete())
    const doc = (await db.collection("pa-recruiter-submissions").doc(sub.submissionId).get()).data() || {}
    console.log("5. stored doc — status:", doc.status, "| candidateConsentStatus:", doc.candidateConsentStatus, "| candidate.email:", doc.candidate?.email)
    if (doc.candidateConsentStatus !== "recruiter_asserted") fail("consent status not recruiter_asserted: " + doc.candidateConsentStatus)
  }
  if (sub.sourcedCandidateId) cleanup.push(() => db.collection("pa-recruiter-sourced-candidates").doc(sub.sourcedCandidateId).delete())
} finally {
  console.log("--- cleanup ---")
  for (const fn of cleanup.reverse()) { try { await fn() } catch (e) { console.log("cleanup skip:", String(e).slice(0, 80)) } }
}
console.log(failed ? "E2E: FAIL" : "E2E: PASS")
process.exit(failed ? 1 : 0)
