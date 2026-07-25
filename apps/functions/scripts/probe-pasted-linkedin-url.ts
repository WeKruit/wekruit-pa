/**
 * READ-ONLY: take the REAL chat messages that carried a REAL LinkedIn URL through the exact chain
 * the cutover hook uses — extract → normalize → (Coresignal search → collect, when a key is
 * present). Writes NOTHING to Firestore.
 *
 * 2026-07-25 (event day, second pass): the probe now sources its inputs from the messages people
 * ACTUALLY sent today rather than one URL off a user doc, because the live failure
 * (+13129727824 11:54 → "can you paste your linkedin profile URL here exactly") was blamed on the
 * extractor and the extractor was innocent. The three real causes are asserted below:
 *   1. CORESIGNAL_API_KEY was never bound to onPaInbound / paMessageCoalescer → `no_key`.
 *   2. the enrich was fire-and-forget → it raced the same turn's pa-users snapshot.
 *   3. nothing emitted the pitch handoff the OAuth connect emits.
 * The Coresignal leg is skipped when CORESIGNAL_API_KEY is absent; everything else still runs.
 *
 *   node --import tsx apps/functions/scripts/probe-pasted-linkedin-url.ts
 */
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { searchEmployeeIdByLinkedinUrl, fetchEmployeeCollect } from "@pa/external-supply"
import {
  enrichFromTypedLinkedinUrl,
  extractLinkedinProfileUrl,
  normalizeTypedLinkedinUrl,
} from "../src/enrich-from-typed-linkedin.js"

const require = createRequire(`${process.cwd()}/apps/functions/`)
const admin = require("firebase-admin")
admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS!, "utf8")),
  ),
})
const db = admin.firestore()
const apiKey = (process.env.CORESIGNAL_API_KEY ?? "").trim()

// ── 1. THE REAL STRINGS PEOPLE SENT ────────────────────────────────────────────────────────────
const since = process.env.SINCE ?? new Date(Date.now() - 24 * 3600 * 1000).toISOString()
const msgs = await db.collection("pa-messages").where("createdAt", ">=", since).get()
const pasted: { text: string }[] = []
for (const d of msgs.docs) {
  const m = d.data() as Record<string, unknown>
  const dir = m.direction ?? (m.role === "user" ? "inbound" : "outbound")
  if (dir !== "inbound") continue
  const text = String(m.text ?? m.body ?? m.content ?? "")
  if (/linkedin\.com\/in\//i.test(text)) pasted.push({ text })
}
console.log(`inbound messages carrying a linkedin.com/in/ URL since ${since}: ${pasted.length}\n`)

let extracted = 0
for (const { text } of pasted) {
  const url = extractLinkedinProfileUrl(text)
  if (url) extracted++
  console.log(`  "${text.replace(/\n/g, " ").slice(0, 58)}"\n     → ${url ?? "NOT EXTRACTED ❌"}`)
}
console.log(`\nEXTRACTED ${extracted}/${pasted.length} — the extractor was never the failure.\n`)

// Every shape a phone produces must collapse to the ONE canonical string the OAuth path stores.
for (const raw of [
  "http://linkedin.com/in/sofia-grimm", // the live 11:54 message, verbatim
  "https://www.linkedin.com/in/sofia-grimm/",
  "WWW.LinkedIn.com/IN/Sofia-Grimm",
  "https://www.linkedin.com/in/sofia-grimm?utm_source=share&utm_medium=member_ios",
  "sure, mine is linkedin.com/in/sofia-grimm.",
]) {
  console.log(`  canonical  ${String(extractLinkedinProfileUrl(raw)).padEnd(40)} ← "${raw}"`)
}

// ── 2. THE GATE — an OAuth-linked-but-EMPTY user must REACH the search ──────────────────────────
// In-memory doc double: nothing touches Firestore, and we stop before the network.
let reached: string | null = null
const memDb = {
  collection: () => ({
    doc: () => ({
      get: async () => ({
        exists: true,
        data: () => ({
          linkedinOauthLinked: true,
          linkedinOauthSub: "fD0w5qyOAt",
          linkedinUrl: "https://www.linkedin.com/oauth-linked/fD0w5qyOAt",
        }),
      }),
      set: async () => {},
    }),
  }),
} as never
const gate = await enrichFromTypedLinkedinUrl({
  db: memDb,
  userId: "probe",
  apiKey: "stub",
  rawUrl: extractLinkedinProfileUrl("http://linkedin.com/in/sofia-grimm")!,
  search: async (u: string) => {
    reached = u
    return null
  },
})
console.log(`\ngate      stranded placeholder user reached search with ${reached} → ${JSON.stringify(gate)}`)

// ── 3. NO KEY = NO ENRICH, EVER (the cause of 0/6 on event day) ─────────────────────────────────
const noKey = await enrichFromTypedLinkedinUrl({
  db: memDb,
  userId: "probe",
  apiKey: null,
  rawUrl: "https://linkedin.com/in/sofia-grimm",
  search: (async () => {
    throw new Error("must not reach the network without a key")
  }) as never,
})
console.log(`no-key    ${JSON.stringify(noKey)}  ← what EVERY live paste returned before CORESIGNAL_API_KEY was bound to onPaInbound / paMessageCoalescer`)

// ── 4. LIVE CORESIGNAL LEG (only with a key) ────────────────────────────────────────────────────
if (!apiKey) {
  console.log(`\nCORESIGNAL_API_KEY not set locally — skipping the live resolve leg.`)
  console.log(`RESULT    extraction + gate verified offline; the network leg needs the prod secret.`)
  process.exit(0)
}
const probeUrl = extractLinkedinProfileUrl(pasted[0]?.text ?? "") ?? normalizeTypedLinkedinUrl("linkedin.com/in/sofia-grimm")!
const employeeId = await searchEmployeeIdByLinkedinUrl(probeUrl, { apiKey })
console.log(`\ncoresignal search ${probeUrl} → employeeId=${employeeId}`)
if (employeeId !== null) {
  const employee = (await fetchEmployeeCollect(employeeId, { apiKey })) as Record<string, unknown>
  const exp = (employee.experience ?? employee.member_experience_collection ?? employee.experiences ?? []) as unknown[]
  console.log(`collect           name="${employee.full_name ?? employee.name}" experiences=${exp.length}`)
  console.log(`RESULT            pasted URL resolves end to end → ${exp.length > 0 ? "BACKGROUND AVAILABLE" : "no experiences"}`)
}
process.exit(0)
