// Enable the thin-Claire @openai/agents canary for the dev phone +14243201960 ONLY.
// Sets pa-feature-flags/paThinClaireEnabled (perUser, default value=false) with the dev-phone
// uid(s) in allowlist, so ONLY those uids route to runClaireTurn; everyone else stays legacy.
//
//   PA_ENV_PATH=.env node .ops/enable-thin-claire-canary.mjs            (DRY-RUN: read + print plan)
//   PA_ENV_PATH=.env node .ops/enable-thin-claire-canary.mjs --apply    (APPLY the allowlist)
//   PA_ENV_PATH=.env node .ops/enable-thin-claire-canary.mjs disable --apply   (remove uids → off)
//
// Run from apps/functions (so firebase-admin resolves): cp here then run, or `node ../../.ops/...`.
import { readFileSync } from "node:fs"
import admin from "firebase-admin"

const APPLY = process.argv.includes("--apply")
const DISABLE = process.argv.includes("disable")
const KEY = "paThinClaireEnabled"
const PHONE = "+14243201960"
const setBy = `claude (thin-claire canary ${DISABLE ? "disable" : "enable"} for ${PHONE})`

const txt = readFileSync(process.env.PA_ENV_PATH, "utf8")
const m = txt.match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)
if (!m) throw new Error("no FIREBASE_SERVICE_ACCOUNT_JSON (set PA_ENV_PATH)")
let raw = m[1].trim()
if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) raw = raw.slice(1, -1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const FieldValue = admin.firestore.FieldValue
const now = new Date().toISOString()

console.log(`=== enable-thin-claire-canary  mode=${APPLY ? "APPLY" : "DRY-RUN"}  ${DISABLE ? "DISABLE" : "ENABLE"} ===`)

// 1. resolve dev-phone pa-users docs
const snap = await db.collection("pa-users").where("phoneE164", "==", PHONE).get()
const ids = snap.docs.map((d) => d.id)
console.log(`\npa-users with phoneE164==${PHONE}: ${ids.length}`)
snap.docs.forEach((d) => {
  const x = d.data() || {}
  console.log(`  ${d.id}  name=${x.name ?? x.displayName ?? "?"}  onboardingState=${x.onboardingState ?? "?"}  targetRoleFunction=${JSON.stringify(x.tags?.targetRoleFunction ?? null)}`)
})
if (ids.length === 0) { console.log("NO doc found — aborting (check phone format)"); process.exit(1) }

// 2. read current flag doc
const ref = db.collection("pa-feature-flags").doc(KEY)
const cur = await ref.get()
console.log(`\nCURRENT ${KEY}: ${cur.exists ? JSON.stringify(cur.data()) : "(does not exist)"}`)

// 3. compute desired allowlist
const curData = cur.exists ? cur.data() : {}
const curAllow = Array.isArray(curData.allowlist) ? curData.allowlist : []
const desiredAllow = DISABLE
  ? curAllow.filter((u) => !ids.includes(u))
  : Array.from(new Set([...curAllow, ...ids]))
console.log(`\nPLAN: allowlist ${JSON.stringify(curAllow)} -> ${JSON.stringify(desiredAllow)}`)
console.log(`      (value stays false; perUser; only these uids resolve true)`)

if (!APPLY) { console.log("\nDRY-RUN — 0 writes. Re-run with --apply to set."); process.exit(0) }

// 4. apply
await ref.set(
  {
    key: KEY,
    value: false,
    type: "bool",
    scope: "perUser",
    allowlist: desiredAllow,
    blocklist: Array.isArray(curData.blocklist) ? curData.blocklist : [],
    updatedAt: now,
    updatedBy: setBy,
  },
  { merge: true },
)
const after = (await ref.get()).data()
console.log(`\nAPPLIED. ${KEY} now: ${JSON.stringify(after)}`)
console.log(`enabled uids: ${JSON.stringify(after.allowlist)}`)
