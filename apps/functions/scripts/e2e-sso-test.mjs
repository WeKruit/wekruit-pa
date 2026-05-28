/**
 * Live E2E test of cross-domain-sso handlers against real Firebase Identity Platform.
 *
 * Exercises:
 *   1. firebase-admin createCustomToken(uid) → mint customToken
 *   2. REST signInWithCustomToken → exchange for real idToken
 *   3. handleSsoLogin in-process with that idToken → verify it returns 204 + Set-Cookie
 *   4. Extract session cookie → handleSsoBootstrap with cookie → verify customToken response
 *   5. handleSsoLogout → verify clearing Set-Cookie
 *   6. handleSsoBootstrap with no cookie → verify 401 no_session
 *   7. handleSsoBootstrap with junk cookie → verify 401 invalid_session + clearing Set-Cookie
 *
 * Run from apps/functions/ with GOOGLE_APPLICATION_CREDENTIALS set and
 * VITE_FIREBASE_API_KEY (or PA_FIREBASE_WEB_API_KEY) for the REST exchange.
 */
import { initializeApp, applicationDefault, getApps } from "firebase-admin/app"
import { getAuth } from "firebase-admin/auth"
import {
  handleSsoLogin,
  handleSsoBootstrap,
  handleSsoLogout,
  SSO_COOKIE_NAME,
} from "../src/cross-domain-sso.ts"

const WEB_API_KEY =
  process.env.PA_FIREBASE_WEB_API_KEY ||
  process.env.VITE_FIREBASE_API_KEY ||
  process.env.FIREBASE_WEB_API_KEY
if (!WEB_API_KEY) {
  console.error("ERROR: set PA_FIREBASE_WEB_API_KEY or VITE_FIREBASE_API_KEY")
  process.exit(2)
}

if (!getApps().length) initializeApp({ credential: applicationDefault() })
const adminAuth = getAuth()

const TEST_UID = `sso-e2e-${Date.now()}`

function mockRes() {
  const r = {
    statusCode: 0,
    body: undefined,
    headers: {},
    setHeader(name, value) {
      r.headers[name] = value
    },
    status(code) {
      r.statusCode = code
      return r
    },
    send(body) {
      r.body = body ?? r.body
      return r
    },
    json(body) {
      r.body = body
      return r
    },
  }
  return r
}

function pass(label) {
  console.log(`  ✔ ${label}`)
}
function fail(label, detail) {
  console.log(`  ✖ ${label}`)
  if (detail) console.log(`    ${detail}`)
  process.exitCode = 1
}

console.log(`=== SSO E2E (uid=${TEST_UID}) ===`)

// Step 1 — mint custom token via admin
const customToken = await adminAuth.createCustomToken(TEST_UID)
pass(`admin.createCustomToken minted token (len=${customToken.length})`)

// Step 2 — exchange custom token for real idToken via Identity Toolkit REST
const exchangeRes = await fetch(
  `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${WEB_API_KEY}`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  },
)
if (!exchangeRes.ok) {
  const err = await exchangeRes.text()
  fail("REST signInWithCustomToken exchange", `HTTP ${exchangeRes.status}: ${err.slice(0, 200)}`)
  process.exit(1)
}
const { idToken } = await exchangeRes.json()
if (!idToken) {
  fail("REST exchange returned no idToken")
  process.exit(1)
}
pass(`REST exchange returned idToken (len=${idToken.length})`)

// Step 3 — handleSsoLogin with real idToken
const loginRes = mockRes()
await handleSsoLogin(
  {
    method: "POST",
    headers: { origin: "https://wekruit.com" },
    body: { idToken },
  },
  loginRes,
)
if (loginRes.statusCode !== 204) {
  fail(`handleSsoLogin expected 204 got ${loginRes.statusCode}`, JSON.stringify(loginRes.body))
  process.exit(1)
}
pass("handleSsoLogin → 204")

const setCookies = loginRes.headers["Set-Cookie"]
if (!Array.isArray(setCookies) || setCookies.length !== 1) {
  fail("Set-Cookie not present or malformed")
  process.exit(1)
}
const sessionCookieMatch = setCookies[0].match(new RegExp(`${SSO_COOKIE_NAME}=([^;]+);`))
if (!sessionCookieMatch) {
  fail("Set-Cookie did not contain wkr_session value")
  process.exit(1)
}
const sessionCookieValue = sessionCookieMatch[1]
pass(`Set-Cookie includes wkr_session (cookie len=${sessionCookieValue.length})`)

// Verify cookie format flags
const cookieStr = setCookies[0]
for (const flag of ["Domain=.wekruit.com", "Path=/", "HttpOnly", "Secure", "SameSite=Lax", "Max-Age=432000"]) {
  if (!cookieStr.includes(flag)) fail(`cookie missing flag: ${flag}`)
  else pass(`cookie carries ${flag}`)
}

// Step 4 — handleSsoBootstrap with real cookie
const bootRes = mockRes()
await handleSsoBootstrap(
  {
    method: "GET",
    headers: {
      origin: "https://wekruit.com",
      cookie: `other=foo; ${SSO_COOKIE_NAME}=${sessionCookieValue}; trailing=bar`,
    },
  },
  bootRes,
)
if (bootRes.statusCode !== 200) {
  fail(`handleSsoBootstrap expected 200 got ${bootRes.statusCode}`, JSON.stringify(bootRes.body))
  process.exit(1)
}
const bootBody = bootRes.body
if (!bootBody || typeof bootBody !== "object" || !("customToken" in bootBody)) {
  fail("handleSsoBootstrap response missing customToken")
  process.exit(1)
}
pass(`handleSsoBootstrap returned customToken (len=${bootBody.customToken.length})`)

// Step 5 — that new customToken should also be exchangeable (i.e. signInWithCustomToken works on other origin)
const finalExchange = await fetch(
  `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${WEB_API_KEY}`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: bootBody.customToken, returnSecureToken: true }),
  },
)
if (!finalExchange.ok) {
  const err = await finalExchange.text()
  fail("post-bootstrap REST exchange", `HTTP ${finalExchange.status}: ${err.slice(0, 200)}`)
  process.exit(1)
}
const finalBody = await finalExchange.json()
// Some Identity Platform responses use `localId`; some return uid via the
// decoded idToken. Cross-check both: decode the idToken via admin and compare.
let observedUid = finalBody.localId
if (!observedUid && finalBody.idToken) {
  const decoded = await adminAuth.verifyIdToken(finalBody.idToken)
  observedUid = decoded.uid
}
if (observedUid !== TEST_UID) {
  fail(
    `post-bootstrap uid mismatch: expected=${TEST_UID} got=${observedUid}`,
    `body keys: ${Object.keys(finalBody).join(",")}`,
  )
  process.exit(1)
}
pass(`post-bootstrap exchange yields same uid=${TEST_UID} → cross-domain SSO works end-to-end`)

// Step 6 — no-cookie bootstrap
const emptyRes = mockRes()
await handleSsoBootstrap(
  { method: "GET", headers: { origin: "https://wekruit.com", cookie: "other=foo" } },
  emptyRes,
)
if (emptyRes.statusCode === 401 && emptyRes.body?.error === "no_session") {
  pass("no cookie → 401 no_session")
} else {
  fail(`no-cookie bootstrap expected 401 no_session got ${emptyRes.statusCode} ${JSON.stringify(emptyRes.body)}`)
}

// Step 7 — junk cookie
const junkRes = mockRes()
await handleSsoBootstrap(
  {
    method: "GET",
    headers: { origin: "https://wekruit.com", cookie: `${SSO_COOKIE_NAME}=junk-not-a-real-cookie` },
  },
  junkRes,
)
if (junkRes.statusCode === 401 && junkRes.body?.error === "invalid_session") {
  pass("junk cookie → 401 invalid_session")
  const clearCookies = junkRes.headers["Set-Cookie"]
  if (Array.isArray(clearCookies) && clearCookies[0].includes("Max-Age=0")) {
    pass("junk cookie response clears the bad cookie")
  } else {
    fail("junk cookie response did not clear cookie")
  }
} else {
  fail(`junk cookie bootstrap expected 401 got ${junkRes.statusCode} ${JSON.stringify(junkRes.body)}`)
}

// Step 8 — logout
const logoutRes = mockRes()
await handleSsoLogout(
  { method: "POST", headers: { origin: "https://wekruit.com" } },
  logoutRes,
)
if (logoutRes.statusCode === 204) {
  const lc = logoutRes.headers["Set-Cookie"]
  if (Array.isArray(lc) && lc[0].includes("Max-Age=0")) pass("logout → 204 + clearing cookie")
  else fail("logout response did not clear cookie")
} else {
  fail(`logout expected 204 got ${logoutRes.statusCode}`)
}

// Cleanup: delete the test user so we don't leak fake accounts
try {
  await adminAuth.deleteUser(TEST_UID)
  pass(`cleanup: deleted test user ${TEST_UID}`)
} catch (e) {
  console.log(`  ! cleanup failed (non-fatal): ${e.message}`)
}

if (process.exitCode === 1) {
  console.log("\n=== E2E FAILED ===")
} else {
  console.log("\n=== E2E PASS — cross-domain SSO works against real Firebase ===")
}
