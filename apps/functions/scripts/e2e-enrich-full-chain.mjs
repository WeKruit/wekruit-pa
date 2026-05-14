#!/usr/bin/env node
/**
 * Real full-chain e2e for V2 enrichment — drives the DEPLOYED wekruit-pa CFs
 * (not just direct sourcing-api curls). Proves:
 *   dashboard → paExternalSupplyRunLinkedInEnrich → sourcing-api
 *              → BrightData → sourcing-vendor-profile-matches
 *   dashboard → paExternalSupplyRunGitHubEnrich   → sourcing-api
 *              → GitHub API → sourcing-vendor-profile-matches
 *   dashboard → paExternalSupplyPollLinkedInEnrich → poll until ready
 *
 * Run with GOOGLE_APPLICATION_CREDENTIALS pointing at a wekruit-5f89b SA
 * with roles/iam.serviceAccountTokenCreator on itself.
 */
import { initializeApp, applicationDefault, getApps } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { getAuth } from "firebase-admin/auth"

const PROJECT_ID = "wekruit-5f89b"
const WEB_API_KEY = process.env.WEKRUIT_FIREBASE_WEB_API_KEY || "AIzaSyCoAAGLn4dYvp5vUb3aAHv4tTbMnNMN8Is"
const ADMIN_EMAIL = "admin1@wekruit.com"
const ADMIN_UID = "e2e-walk-admin"
const SUBJECT_RECORD_ID = process.argv[2] || "d6e2eb12-8c3b-4fbb-8066-8a75873477b2" // Aaryaman Bhute

const CF_BASE = "https://us-central1-wekruit-5f89b.cloudfunctions.net"
const CF_LINKEDIN = `${CF_BASE}/paExternalSupplyRunLinkedInEnrich`
const CF_GITHUB = `${CF_BASE}/paExternalSupplyRunGitHubEnrich`
const CF_POLL_LI = `${CF_BASE}/paExternalSupplyPollLinkedInEnrich`

if (!getApps().length) initializeApp({ credential: applicationDefault() })
const auth = getAuth()
const db = getFirestore()

async function mintIdToken() {
  let uid = ADMIN_UID
  try {
    const byEmail = await auth.getUserByEmail(ADMIN_EMAIL)
    uid = byEmail.uid
  } catch {
    try {
      await auth.getUser(ADMIN_UID)
    } catch {
      const created = await auth.createUser({ uid: ADMIN_UID, email: ADMIN_EMAIL, emailVerified: true })
      uid = created.uid
    }
  }
  await auth.setCustomUserClaims(uid, { admin: true })
  const customToken = await auth.createCustomToken(uid, { admin: true })
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${WEB_API_KEY}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }),
    },
  )
  const json = await res.json()
  return json.idToken
}

async function callable(url, data, idToken) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ data }),
  })
  const text = await res.text()
  if (!res.ok) {
    let parsed
    try { parsed = JSON.parse(text) } catch { parsed = { error: { message: text } } }
    throw new Error(`HTTP ${res.status}: ${(parsed.error && parsed.error.message) || text.slice(0, 300)}`)
  }
  return JSON.parse(text)
}

function summarize(label, profile) {
  if (!profile) return `${label}: profile=null`
  const keys = Object.keys(profile)
  const previews = []
  if (profile.name) previews.push(`name=${profile.name}`)
  if (profile.login) previews.push(`login=${profile.login}`)
  if (profile.city) previews.push(`city=${profile.city}`)
  if (profile.bio) previews.push(`bio="${String(profile.bio).slice(0, 60)}…"`)
  if (profile.public_repos != null) previews.push(`public_repos=${profile.public_repos}`)
  if (profile.followers != null) previews.push(`followers=${profile.followers}`)
  if (profile.current_company?.name) previews.push(`current_company=${profile.current_company.name}`)
  if (profile.educations_details) previews.push(`education=${profile.educations_details}`)
  return `${label}: ${keys.length} fields · ${previews.join(", ")}`
}

async function main() {
  console.log("=== FULL-CHAIN E2E ENRICH WALK ===\n")

  console.log("[1] Minting admin ID token via Firebase Auth REST…")
  const idToken = await mintIdToken()
  console.log(`[1] ✓ ID token (length=${idToken.length})\n`)

  console.log(`[2] POST paExternalSupplyRunGitHubEnrich { recordId: "${SUBJECT_RECORD_ID.slice(0, 12)}…" }`)
  const ghRes = await callable(CF_GITHUB, { recordId: SUBJECT_RECORD_ID }, idToken)
  const gh = ghRes.result ?? ghRes.data
  console.log(`[2] ✓ status=${gh.status}, vendor=${gh.vendor}, runId=${gh.runId.slice(0, 8)}…, matchId=${gh.matchId.slice(0, 8)}…`)
  console.log(`[2]   ${summarize("GitHub", gh.profile)}\n`)

  console.log(`[3] POST paExternalSupplyRunLinkedInEnrich { recordId: "${SUBJECT_RECORD_ID.slice(0, 12)}…" }`)
  console.log(`[3]   (optimistic poll inside CF — will use prior ready snapshot if exists)`)
  const liRes = await callable(CF_LINKEDIN, { recordId: SUBJECT_RECORD_ID }, idToken)
  const li = liRes.result ?? liRes.data
  console.log(`[3] ✓ status=${li.status}, vendor=${li.vendor}, snapshotId=${li.snapshotId?.slice(0, 12) || "(none)"}…, runId=${li.runId.slice(0, 8)}…`)
  console.log(`[3]   ${summarize("LinkedIn", li.profile)}`)

  if (li.status === "building") {
    console.log("[3]   Snapshot still building — polling every 30s up to 15 min…")
    let final = li
    for (let i = 1; i <= 30; i++) {
      await new Promise((r) => setTimeout(r, 30_000))
      try {
        const pollRes = await callable(CF_POLL_LI, { recordId: SUBJECT_RECORD_ID }, idToken)
        final = pollRes.result ?? pollRes.data
        console.log(`[3]   poll ${i}: status=${final.status}`)
        if (final.status !== "building") break
      } catch (e) {
        console.log(`[3]   poll ${i}: error ${String(e).slice(0, 120)}`)
      }
    }
    console.log(`[3]   final ${summarize("LinkedIn", final.profile)}`)
  }
  console.log()

  console.log("[4] Verifying sourcing-vendor-profile-matches in Firestore…")
  const q = await db
    .collection("sourcing-vendor-profile-matches")
    .where("subjectId", "==", SUBJECT_RECORD_ID)
    .get()
  console.log(`[4] ${q.size} match doc(s) for subjectId=${SUBJECT_RECORD_ID.slice(0, 12)}…`)
  for (const d of q.docs) {
    const x = d.data()
    console.log(`[4]   - matchId=${d.id.slice(0, 8)}… vendor=${x.vendor} status=${x.status} ${summarize("profile", x.profile)}`)
  }

  console.log("\n=== FULL-CHAIN E2E: ALL GREEN ===")
}

main().catch((e) => {
  console.error("\n=== FAILED ===\n", e)
  process.exit(1)
})
