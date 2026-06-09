// Headless E2E: recruiter invite → name+code claim → data access → cleanup.
// Synthetic fixtures only; deletes everything it creates. Mirrors prior-session E2E pattern.
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
const EMAIL = `claude-e2e-recruiter-${STAMP}@wekruit-e2e.invalid.example.com`.toLowerCase()
const NAME = "Claude E2E Recruiter"

const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
let suffix = ""
const bytes = randomBytes(8)
for (let i = 0; i < 8; i++) suffix += alphabet[bytes[i] % alphabet.length]
const CODE = `WK-${suffix.slice(0, 4)}-${suffix.slice(4)}`
const HASH = createHash("sha256").update(CODE).digest("hex")

const cleanup = []
const fail = (msg) => { console.error("FAIL:", msg); process.exitCode = 1 }

try {
  // 1. invite doc (same shape buildRecruiterInviteCodeDoc writes; sendEmail=false path)
  const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString()
  await db.collection("pa-recruiter-invite-codes").doc(HASH).set({
    inviteCodeId: HASH,
    inviteCode: CODE,
    active: true,
    label: "claude-e2e-verify (auto-cleanup)",
    recruiterEmail: EMAIL,
    codePreview: `${CODE.slice(0, 5)}••••${CODE.slice(-2)}`,
    maxUses: 1,
    usedCount: 0,
    expiresAt,
    inviteEmailStatus: "not_requested",
    createdByEmail: "claude-e2e@wekruit.com",
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  })
  cleanup.push(() => db.collection("pa-recruiter-invite-codes").doc(HASH).delete())
  console.log("1. invite doc written:", CODE)

  // 2. synthetic recruiter auth user + ID token via custom-token exchange
  const user = await auth.createUser({ email: EMAIL, emailVerified: true, displayName: NAME })
  cleanup.push(() => auth.deleteUser(user.uid))
  const customToken = await auth.createCustomToken(user.uid)
  const exch = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${API_KEY}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  }).then((r) => r.json())
  if (!exch.idToken) throw new Error("token exchange failed: " + JSON.stringify(exch).slice(0, 200))
  const ID_TOKEN = exch.idToken
  console.log("2. recruiter auth user:", user.uid, EMAIL)
  cleanup.push(() => db.collection("pa-recruiter-users").doc(user.uid).delete())

  // 3. claim: name + code (the production endpoint the recruiter site calls)
  const claim = await fetch(`${BASE}/paRecruiterAccess`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ID_TOKEN}` },
    body: JSON.stringify({ name: NAME, email: EMAIL, inviteCode: CODE }),
  }).then((r) => r.json())
  console.log("3. claim response:", JSON.stringify(claim).slice(0, 300))
  if (!claim.ok) fail("claim rejected")
  if (claim.recruiter?.name !== NAME) fail(`typed name not stored: ${claim.recruiter?.name}`)

  // 4. verify persisted docs
  const profile = (await db.collection("pa-recruiter-users").doc(user.uid).get()).data()
  const invite = (await db.collection("pa-recruiter-invite-codes").doc(HASH).get()).data()
  console.log("4. profile.name:", profile?.name, "| status:", profile?.status, "| inviteCodeId match:", profile?.inviteCodeId === HASH)
  console.log("   invite.usedCount:", invite?.usedCount, "| lastUsedByEmail:", invite?.lastUsedByEmail)
  if (profile?.name !== NAME) fail("pa-recruiter-users.name mismatch")
  if (invite?.usedCount !== 1) fail("usedCount not incremented")

  // 5. data access as recruiter
  const me = await fetch(`${BASE}/paRecruiterMe`, { headers: { Authorization: `Bearer ${ID_TOKEN}` } }).then((r) => r.json())
  console.log("5. paRecruiterMe ok:", me.ok === true, "| name:", me.recruiter?.name)
  if (!me.ok) fail("paRecruiterMe unauthorized after claim")
  const jobs = await fetch(`${BASE}/paCollabJobsList`, { headers: { Authorization: `Bearer ${ID_TOKEN}` } }).then((r) => r.json())
  const jobCount = Array.isArray(jobs.jobs) ? jobs.jobs.length : Array.isArray(jobs.roles) ? jobs.roles.length : -1
  console.log("   paCollabJobsList ok:", jobs.ok !== false, "| jobs:", jobCount, "| first:", JSON.stringify((jobs.jobs ?? jobs.roles ?? [])[0]?.title ?? (jobs.jobs ?? jobs.roles ?? [])[0]?.jobId ?? null))
  if (jobCount < 1) fail("recruiter sees no collab jobs")

  // 6. negative: second claim by a DIFFERENT user on the used code must fail
  const user2 = await auth.createUser({ email: `claude-e2e-recruiter2-${STAMP}@wekruit-e2e.invalid.example.com`, emailVerified: true })
  cleanup.push(() => auth.deleteUser(user2.uid))
  cleanup.push(() => db.collection("pa-recruiter-users").doc(user2.uid).delete())
  const ct2 = await auth.createCustomToken(user2.uid)
  const exch2 = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${API_KEY}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: ct2, returnSecureToken: true }),
  }).then((r) => r.json())
  const reclaim = await fetch(`${BASE}/paRecruiterAccess`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${exch2.idToken}` },
    body: JSON.stringify({ name: "Mallory", email: `claude-e2e-recruiter2-${STAMP}@wekruit-e2e.invalid.example.com`, inviteCode: CODE }),
  }).then((r) => ({ status: r.status, body: r }))
  const reclaimJson = await reclaimJsonSafe(reclaim.body)
  console.log("6. reuse-by-other-user rejected:", reclaim.status !== 200 || reclaimJson.ok === false, `(status=${reclaim.status})`)
  if (reclaim.status === 200 && reclaimJson.ok !== false) fail("used code reusable by different user!")
} finally {
  console.log("--- cleanup ---")
  for (const fn of cleanup.reverse()) {
    try { await fn() } catch (e) { console.log("cleanup skip:", String(e).slice(0, 80)) }
  }
  // verify zero residue
  const residueUsers = await db.collection("pa-recruiter-users").where("email", ">=", "claude-e2e-recruiter").where("email", "<", "claude-e2e-recruites").get()
  const residueInvite = await db.collection("pa-recruiter-invite-codes").doc(HASH).get()
  console.log("residue: recruiter-users:", residueUsers.size, "| invite doc exists:", residueInvite.exists)
}

async function reclaimJsonSafe(r) { try { return await r.json() } catch { return {} } }
console.log(process.exitCode ? "E2E: FAIL" : "E2E: PASS")
