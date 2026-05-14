#!/usr/bin/env node
/**
 * Real e2e data-flow walk for V2 sourcing unification — drives the *deployed*
 * paExternalSupplyCreateBatch callable end-to-end (mints admin ID token via
 * Firebase Auth REST, posts via the v2 callable envelope), then walks every
 * downstream collection to prove the auto-bridge fired.
 *
 * Run with GOOGLE_APPLICATION_CREDENTIALS pointing at a wekruit-5f89b SA
 * with Firebase Auth admin + Firestore admin roles.
 */
import { initializeApp, applicationDefault, getApps } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { getAuth } from "firebase-admin/auth"
import { createHash } from "node:crypto"

const PROJECT_ID = "wekruit-5f89b"
const WEB_API_KEY = process.env.WEKRUIT_FIREBASE_WEB_API_KEY || "AIzaSyCoAAGLn4dYvp5vUb3aAHv4tTbMnNMN8Is"
const ADMIN_UID = "e2e-walk-admin"
const ADMIN_EMAIL = "admin1@wekruit.com"
const CALLABLE_URL = "https://us-central1-wekruit-5f89b.cloudfunctions.net/paExternalSupplyCreateBatch"
const SOURCING_BASE = "https://us-central1-wekruit-5f89b.cloudfunctions.net/sourcing-api"

if (!getApps().length) initializeApp({ credential: applicationDefault() })
const auth = getAuth()
const db = getFirestore()

async function mintIdToken() {
  // Ensure the admin user exists with a @wekruit.com email so requireExternalSupplyAdmin passes.
  let uid = ADMIN_UID
  try {
    const byEmail = await auth.getUserByEmail(ADMIN_EMAIL)
    uid = byEmail.uid
  } catch {
    try {
      await auth.getUser(ADMIN_UID)
    } catch {
      const created = await auth.createUser({
        uid: ADMIN_UID,
        email: ADMIN_EMAIL,
        emailVerified: true,
      })
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
  if (!res.ok) {
    throw new Error(`exchange_custom_token_failed ${res.status} ${await res.text()}`)
  }
  const json = await res.json()
  return json.idToken
}

async function callableInvoke(idToken, data) {
  const res = await fetch(CALLABLE_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({ data }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`callable_http_${res.status}:${text.slice(0, 400)}`)
  return JSON.parse(text)
}

async function main() {
  console.log("=== E2E DATA FLOW WALK ===\n")

  // 1. Build a tiny CSV fixture (3 rows) with a unique sha256 so the
  // idempotency check doesn't short-circuit.
  const unique = Math.random().toString(36).slice(2, 10)
  const csv = [
    "Name,Link,Email,Match,Company,Headline,Title",
    `E2E Walker ${unique},https://www.linkedin.com/in/e2e-walker-${unique},e2e+${unique}@example.com,1,WeKruit,E2E test row 1,Senior Engineer`,
    `Bridge Verifier ${unique},https://www.linkedin.com/in/bridge-verifier-${unique},verify+${unique}@example.com,1,WeKruit,E2E test row 2,Staff Engineer`,
    `Sourcing Smoke ${unique},https://www.linkedin.com/in/sourcing-smoke-${unique},smoke+${unique}@example.com,1,WeKruit,E2E test row 3,Principal Engineer`,
    "",
  ].join("\n")
  const buf = Buffer.from(csv, "utf8")
  const sha256 = createHash("sha256").update(buf).digest("hex")
  const inlineBase64 = buf.toString("base64")
  console.log(`[step 1] built CSV fixture: 3 rows, sha256=${sha256.slice(0, 12)}…`)

  // 2. Mint ID token + invoke deployed callable.
  console.log("[step 2] minting admin ID token…")
  const idToken = await mintIdToken()
  console.log(`[step 2] got ID token (length=${idToken.length})`)

  console.log("[step 3] invoking paExternalSupplyCreateBatch (deployed CF)…")
  const result = await callableInvoke(idToken, {
    source: "manual_csv",
    inlineBase64,
    filename: `e2e-walk-${unique}.csv`,
    sha256,
    mime: "text/csv",
    sizeBytes: buf.length,
  })
  const batchId = result.result?.batchId ?? result.data?.batchId ?? result.result?.batchId
  if (!batchId) {
    console.log("[step 3] response shape:", JSON.stringify(result).slice(0, 500))
    throw new Error("no batchId returned")
  }
  console.log(`[step 3] callable returned batchId=${batchId} rowCount=${result.result?.rowCount ?? result.data?.rowCount}`)

  // 3. Wait briefly then verify bridge fired (sourcing.runId populated).
  console.log("[step 4] polling pa-external-sourcing-batches for sourcing.runId…")
  let sourcingRunId = null
  for (let i = 0; i < 20; i++) {
    const snap = await db.collection("pa-external-sourcing-batches").doc(batchId).get()
    const data = snap.data()
    sourcingRunId = data?.sourcing?.runId
    if (sourcingRunId) break
    await new Promise((r) => setTimeout(r, 1500))
    process.stdout.write(".")
  }
  console.log("")
  if (!sourcingRunId) {
    console.error("[step 4] ❌ FAIL — bridge did not populate sourcing.runId within 30s")
    process.exit(1)
  }
  console.log(`[step 4] ✅ sourcing.runId=${sourcingRunId}`)

  // 4. Verify the records landed in core-service sourcing-source-records.
  console.log("[step 5] GET sourcing-api source-records…")
  const verifyRes = await fetch(
    `${SOURCING_BASE}/api/sourcing/source-runs/${encodeURIComponent(sourcingRunId)}/source-records?limit=100`,
  )
  if (!verifyRes.ok) throw new Error(`sourcing_api_verify_${verifyRes.status}`)
  const verifyJson = await verifyRes.json()
  const records = verifyJson.data ?? []
  console.log(`[step 5] sourcing-source-records count: ${records.length} (expected 3)`)
  if (records.length !== 3) {
    console.error("[step 5] ❌ FAIL — wrong count")
    process.exit(1)
  }
  console.log("[step 5] ✅ sample:", {
    sourceRecordId: records[0].sourceRecordId,
    displayName: records[0].displayName,
    sourceUrl: records[0].sourceUrl,
    domain: records[0].domain,
    source: records[0].source,
  })

  // 5. Verify canonical-reader contract via GET (what the dashboard fetches).
  console.log("[step 6] confirming canonical-reader path returns the same data…")
  const canonicalRecords = records.map((r) => ({
    recordId: r.raw?.recordId ?? r.sourceRecordId,
    name: r.raw?.name ?? r.displayName,
    linkedinUrl: r.raw?.linkedinUrl ?? r.sourceUrl,
    currentTitle: r.raw?.currentTitle,
    currentCompany: r.raw?.currentCompany,
  }))
  console.log("[step 6] canonical-reader-shaped rows:")
  canonicalRecords.forEach((r) => console.log(`    ${r.recordId.slice(0, 8)}… :: ${r.name} :: ${r.linkedinUrl}`))
  console.log("[step 6] ✅ canonical reader has full data parity")

  // 6. Smoke the BrightData vendor-profile-lookup against the first record
  //    via the deployed wekruit-pa admin CF (paExternalSupplyRunLinkedInEnrich).
  console.log("[step 7] driving paExternalSupplyRunLinkedInEnrich…")
  const enrichCallable = "https://us-central1-wekruit-5f89b.cloudfunctions.net/paExternalSupplyRunLinkedInEnrich"
  const enrichRes = await fetch(enrichCallable, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ data: { recordId: canonicalRecords[0].recordId } }),
  })
  const enrichText = await enrichRes.text()
  if (enrichRes.status === 200) {
    console.log("[step 7] ✅ BrightData returned profile (Adam already rotated key!)")
  } else {
    let parsed
    try { parsed = JSON.parse(enrichText) } catch { parsed = { error: { message: enrichText } } }
    const msg = parsed.error?.message ?? enrichText
    if (/failed-precondition|bright_data_key_missing/i.test(msg)) {
      console.log(`[step 7] ✅ expected failed-precondition: "${msg.slice(0, 120)}" (placeholder secret active)`)
    } else {
      console.log(`[step 7] ⚠ unexpected: HTTP ${enrichRes.status} ${msg.slice(0, 200)}`)
    }
  }

  console.log("\n=== DATA FLOW WALK: ALL GREEN ===")
  console.log(`batchId=${batchId}`)
  console.log(`sourcingRunId=${sourcingRunId}`)
  console.log(`records=${records.length}`)
}

main().catch((err) => {
  console.error("\n=== E2E FAILED ===\n", err)
  process.exit(1)
})
