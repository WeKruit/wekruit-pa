/**
 * One-off backfill: repair historical `pa-messages` assistant rows whose `body` is the RAW agent
 * envelope `{"messages":["..."]}` instead of the delivered prose.
 *
 * The WRITE-side cause is already fixed (`addItems` in packages/agent-runtime/src/firestore-session.ts
 * parses before persisting) and `getItems` unwraps legacy rows at read time, so the MODEL is already
 * clean. This script exists for everything that reads Firestore directly and never goes through
 * `getItems`: transcript exports, the dashboard, and eval datasets.
 *
 * Classification is NOT re-derived here — it imports the very same `structuredOutputText` the runtime
 * uses, so a row is repaired if and only if the runtime would have unwrapped it. Re-implementing the
 * predicate is how a backfill and its runtime drift apart.
 *
 *   dry run   PA_ENV_PATH=/path/to/.env node .ops/backfill-envelope-rows.mjs [hours]
 *   apply     PA_ENV_PATH=/path/to/.env node .ops/backfill-envelope-rows.mjs [hours] --apply
 *
 * Verify with the existing probe (expects 0 envelope rows in the window afterwards):
 *   PA_ENV_PATH=/path/to/.env node .ops/raw-envelope-rows.mjs 720
 */
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
import { structuredOutputText } from "../packages/agent-runtime/dist/firestore-session.js"

let raw = readFileSync(process.env.PA_ENV_PATH, "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) raw = raw.slice(1, -1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()

const args = process.argv.slice(2)
const apply = args.includes("--apply")
const hours = Number(args.find((a) => !a.startsWith("--")) ?? 720)
const since = new Date(Date.now() - hours * 3600 * 1000).toISOString()
const nowIso = new Date().toISOString()

const snap = await db.collection("pa-messages").where("createdAt", ">=", since).get()

const repair = [] // envelope carried real prose → rewrite body
const blank = [] // `{"messages":[]}` → the turn delivered via a tool and said nothing
let assistant = 0

for (const d of snap.docs) {
  const m = d.data()
  // ASSISTANT ONLY. A user who happens to paste JSON is sending us their real message; rewriting
  // that would destroy their words. Same guard the runtime's unwrapStructuredOutputRow applies.
  if (m.role !== "assistant") continue
  assistant++
  const text = structuredOutputText(m.body)
  if (text === null) continue // not an envelope — ordinary prose, leave alone
  ;(text === "" ? blank : repair).push({ id: d.id, before: String(m.body), after: text, createdAt: m.createdAt })
}

console.log(`window=${hours}h since=${since}`)
console.log(`assistant rows scanned: ${assistant}`)
console.log(`  envelope WITH prose  → rewrite body : ${repair.length}`)
console.log(`  envelope EMPTY       → mark skipped : ${blank.length}`)
console.log(`mode: ${apply ? "APPLY" : "DRY RUN"}`)

console.log(`\n--- sample rewrites ---`)
for (const r of repair.slice(0, 5)) {
  console.log(`  ${r.createdAt}`)
  console.log(`    before: ${r.before.slice(0, 110)}`)
  console.log(`    after : ${r.after.replace(/\n+/g, " ⏎ ").slice(0, 110)}`)
}
if (blank.length) {
  console.log(`\n--- sample empty envelopes (tool-delivered turns that said nothing) ---`)
  for (const b of blank.slice(0, 3)) console.log(`  ${b.createdAt} ${b.before.slice(0, 60)}`)
}

if (!apply) {
  console.log(`\nDRY RUN — nothing written. Re-run with --apply.`)
  process.exit(0)
}

// SOFT, NOT DESTRUCTIVE. Empty envelopes are blanked and marked, never deleted: `getItems` already
// drops empty-body assistant rows, so a blank body matches runtime behaviour exactly, and the
// original stays on the doc so this is reversible.
let written = 0
const all = [
  ...repair.map((r) => ({ ...r, kind: "rewritten" })),
  ...blank.map((r) => ({ ...r, kind: "emptied" })),
]
for (let i = 0; i < all.length; i += 400) {
  const batch = db.batch()
  for (const r of all.slice(i, i + 400)) {
    batch.set(
      db.collection("pa-messages").doc(r.id),
      {
        body: r.after,
        envelopeBackfill: { at: nowIso, kind: r.kind, originalBody: r.before.slice(0, 4000) },
      },
      { merge: true },
    )
    written++
  }
  await batch.commit()
  console.log(`  committed ${Math.min(i + 400, all.length)}/${all.length}`)
}
console.log(`\nDONE — ${written} rows repaired (${repair.length} rewritten, ${blank.length} emptied)`)
process.exit(0)
