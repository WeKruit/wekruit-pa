// One-off, idempotent, audited identity fix for "Yogesh Savirigana".
// DRY-RUN BY DEFAULT. Run from apps/functions so @pa/pa-persistence resolves.
//
//   PA_ENV_PATH=../../.env node ../../.ops/fix-yogesh-savirigana-identity.mjs            (DRY-RUN: plan only, 0 writes)
//   PA_ENV_PATH=../../.env node ../../.ops/fix-yogesh-savirigana-identity.mjs --apply    (APPLY — a human runs this)
//
// Context (production incident 2026-05-29):
//   Candidate signed up TWICE 2 min apart with two different emails but the
//   SAME phone +18303265553:
//     KEEP   = Uu3ZeLnEMyyIMBFHV3uM  yogeshsavirigana@gmail.com   createdAt 17:44:22Z (older → canonical)
//     ORPHAN = ECyfCDNOCg2SEH8CzlRQ  yogi.savirigana1996@gmail.com createdAt 17:46:11Z
//   He then texted the opener `Hello, WeKruit! Uu3ZeLnEMyyIMBFHV3uM` from a
//   DIFFERENT phone +18137978737 (on neither profile). The inbound event
//   inb_c858f8ecc38c1c494e80cbc59911b30839231b53 got stuck status=running.
//
// Policy (Adam 2026-05-29 — PHONE = UNIQUE IDENTITY KEY):
//   1. SAME phone (+18303265553) on two profiles → SAME entity → MERGE
//      ECyf into Uu3Ze (oldest canonical). Keep BOTH emails + BOTH userIds.
//      Reuses the SAME production helper `mergeCandidatesByPhone` that the
//      live resolve layer now calls — no parallel merge path.
//   2. DIFFERENT phone (+18137978737) = a DIFFERENT entity → DO NOT bind it
//      to Yogesh's +18303265553 profile. This script never touches that phone
//      or any handle for it.
//   3. NEVER silent-drop → mark the stuck inbound event terminal (status=failed,
//      errorCode=IDENTITY_CONFLICT) so it is observable and no longer `running`.
//      It is left in a clean, re-processable state for the normal pipeline.
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
import { mergeCandidatesByPhone } from "@pa/pa-persistence"

const APPLY = process.argv.includes("--apply")

const SHARED_PHONE = "+18303265553"
const KEEP_ID = "Uu3ZeLnEMyyIMBFHV3uM" // older → canonical
const ORPHAN_ID = "ECyfCDNOCg2SEH8CzlRQ" // newer → folded
const OTHER_PHONE = "+18137978737" // DIFFERENT entity — never bound here
const STUCK_EVENT_ID = "inb_c858f8ecc38c1c494e80cbc59911b30839231b53"

// ---------- bootstrap (mirrors .ops/dedup-dev-phone.mjs) ----------
const txt = readFileSync(process.env.PA_ENV_PATH, "utf8")
const m = txt.match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)
if (!m) throw new Error("no FIREBASE_SERVICE_ACCOUNT_JSON (set PA_ENV_PATH to a .env with it)")
let raw = m[1].trim()
if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) raw = raw.slice(1, -1)
if (admin.apps.length === 0) {
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
}
const db = admin.firestore()
const j = (v) => JSON.stringify(v)

console.log(`=== fix-yogesh-savirigana-identity  mode=${APPLY ? "APPLY" : "DRY-RUN"} ===`)
console.log(`shared_phone=${SHARED_PHONE}  KEEP=${KEEP_ID}  ORPHAN=${ORPHAN_ID}`)
console.log(`other_phone=${OTHER_PHONE} (different entity — NOT bound)  stuck_event=${STUCK_EVENT_ID}`)

function summarizeUser(id, data) {
  if (!data) return `${id}: (missing)`
  return [
    `${id}:`,
    `  email=${data.email ?? "?"} altEmails=${j(data.altEmails ?? null)}`,
    `  phoneE164=${data.phoneE164 ?? "?"}  createdAt=${data.createdAt ?? "?"}`,
    `  mergedInto=${data.mergedInto ?? "(none)"}  runtimeMode=${data.runtimeMode ?? "(none)"}`,
    `  aliasUserIds=${j(data.aliasUserIds ?? null)}  tags.skills=${j(data.tags?.skills ?? null)}`,
  ].join("\n")
}

// ---------- 1. BEFORE snapshot ----------
const beforeKeep = (await db.collection("pa-users").doc(KEEP_ID).get()).data()
const beforeOrphan = (await db.collection("pa-users").doc(ORPHAN_ID).get()).data()
const beforeEvent = (await db.collection("pa-inbound-events").doc(STUCK_EVENT_ID).get()).data()
console.log("\n--- BEFORE ---")
console.log(summarizeUser(KEEP_ID, beforeKeep))
console.log(summarizeUser(ORPHAN_ID, beforeOrphan))
console.log(`event ${STUCK_EVENT_ID}: status=${beforeEvent?.status ?? "(missing)"} claimedAt=${beforeEvent?.claimedAt ?? "?"} routedTo=${beforeEvent?.routedTo ?? "(none)"}`)

if (!beforeKeep) console.warn(`WARN: KEEP ${KEEP_ID} not found.`)
if (!beforeOrphan) console.warn(`WARN: ORPHAN ${ORPHAN_ID} not found (already merged?).`)

// ---------- 2. PLAN / APPLY the same-phone merge (reuses production helper) ----------
console.log("\n=== MERGE PLAN (same phone → same entity; reuses mergeCandidatesByPhone) ===")
const mergeResult = await mergeCandidatesByPhone(db, {
  phoneE164: SHARED_PHONE,
  canonicalCandidateIdHint: KEEP_ID,
  actor: "operator",
  reason: "Yogesh Savirigana double-signup same-phone merge (production incident 2026-05-29)",
  dryRun: !APPLY,
})
console.log(j(mergeResult, null, 2))

// ---------- 3. mark the stuck inbound event terminal (never silent-drop) ----------
console.log("\n=== STUCK EVENT TERMINALIZE ===")
if (!beforeEvent) {
  console.log(`event ${STUCK_EVENT_ID} not found — nothing to terminalize.`)
} else if (beforeEvent.status && beforeEvent.status !== "running") {
  console.log(`event already terminal-ish (status=${beforeEvent.status}) — idempotent no-op.`)
} else {
  console.log(`event status=${beforeEvent.status} → will set status=failed, errorCode=IDENTITY_CONFLICT, leaseUntil=null, claimedBy=null`)
  if (APPLY) {
    const isoNow = new Date().toISOString()
    await db.collection("pa-inbound-events").doc(STUCK_EVENT_ID).set(
      {
        status: "failed",
        errorCode: "IDENTITY_CONFLICT",
        lastError: "identity_conflict:opener_from_different_phone_than_named_profile",
        routedTo: "identity_conflict",
        completedAt: isoNow,
        updatedAt: isoNow,
        leaseUntil: null,
        claimedBy: null,
        manualFixBy: "fix-yogesh-savirigana-identity.mjs",
      },
      { merge: true },
    )
    console.log("event terminalized.")
  }
}

if (!APPLY) {
  console.log("\n=== DRY-RUN COMPLETE — 0 Firestore writes. Re-run with --apply to perform. ===")
  process.exit(0)
}

// ---------- 4. AFTER snapshot (apply path) ----------
const afterKeep = (await db.collection("pa-users").doc(KEEP_ID).get()).data()
const afterOrphan = (await db.collection("pa-users").doc(ORPHAN_ID).get()).data()
const afterEvent = (await db.collection("pa-inbound-events").doc(STUCK_EVENT_ID).get()).data()
console.log("\n--- AFTER ---")
console.log(summarizeUser(KEEP_ID, afterKeep))
console.log(summarizeUser(ORPHAN_ID, afterOrphan))
console.log(`event ${STUCK_EVENT_ID}: status=${afterEvent?.status ?? "(missing)"} errorCode=${afterEvent?.errorCode ?? "(none)"} routedTo=${afterEvent?.routedTo ?? "(none)"}`)

// ---------- 5. invariant checks ----------
console.log("\n=== INVARIANT CHECKS ===")
const ok = []
ok.push([`ORPHAN tombstoned (mergedInto=${KEEP_ID})`, afterOrphan?.mergedInto === KEEP_ID])
ok.push([`ORPHAN phone tombstoned (not ${SHARED_PHONE})`, afterOrphan?.phoneE164 !== SHARED_PHONE])
ok.push([`KEEP keeps shared phone`, afterKeep?.phoneE164 === SHARED_PHONE])
ok.push([`KEEP did NOT bind the OTHER phone ${OTHER_PHONE}`, afterKeep?.phoneE164 !== OTHER_PHONE])
ok.push([`KEEP has ORPHAN as alias userId`, Array.isArray(afterKeep?.aliasUserIds) && afterKeep.aliasUserIds.includes(ORPHAN_ID)])
ok.push([`event no longer running`, afterEvent && afterEvent.status !== "running"])
for (const [label, pass] of ok) console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}`)
const allPass = ok.every(([, p]) => p)
console.log(`\n=== APPLY COMPLETE — ${allPass ? "ALL INVARIANTS PASS" : "SOME INVARIANTS FAILED (review above)"} ===`)
process.exit(allPass ? 0 : 1)
