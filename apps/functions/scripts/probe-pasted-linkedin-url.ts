/**
 * READ-ONLY: take a REAL chat message carrying a REAL LinkedIn URL through the exact chain the new
 * cutover hook uses — extract → normalize → Coresignal search → collect. Writes NOTHING to Firestore.
 * The URL is read off a YC user who already has one on file, so it is a string we know Coresignal can
 * resolve; the point of the probe is that a message typed into iMessage gets there.
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
const apiKey = process.env.CORESIGNAL_API_KEY!

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "")
const isYc = (u: Record<string, unknown>) =>
  u.source === "yc_startup_school" || Boolean(u.ycEventEntryAt) || u.firstTouchCampaign === "yc-startup-school"

const snap = await db.collection("pa-users").get()
const withUrl = snap.docs.find((d: { data: () => Record<string, unknown> }) => {
  const u = d.data()
  return isYc(u) && str(u.linkedinUrl) && !str(u.linkedinUrl).includes("/oauth-linked/")
})
const realUrl = str(withUrl.data().linkedinUrl)

// As a person actually types it into iMessage.
const message = `sure, here's mine ${realUrl} let me know if that works`
const extracted = extractLinkedinProfileUrl(message)
console.log(`inbound message   ${message}`)
console.log(`extracted         ${extracted}`)
console.log(`normalized        ${normalizeTypedLinkedinUrl(extracted ?? "")}`)

const employeeId = await searchEmployeeIdByLinkedinUrl(extracted!, { apiKey })
console.log(`coresignal search employeeId=${employeeId}`)
if (employeeId !== null) {
  const employee = (await fetchEmployeeCollect(employeeId, { apiKey })) as Record<string, unknown>
  const exp = (employee.experience ?? employee.member_experience_collection ?? employee.experiences ?? []) as unknown[]
  console.log(`collect           name="${employee.full_name ?? employee.name}" experiences=${exp.length}`)
  console.log(`RESULT            pasted URL resolves end to end → ${exp.length > 0 ? "BACKGROUND AVAILABLE" : "no experiences"}`)
}

// The gate itself: an OAuth-linked-but-empty user must now REACH the search instead of early-returning
// `already_enriched`. In-memory doc double — nothing touches Firestore, and we stop before the network.
let reached: string | null = null
const memDb = {
  collection: () => ({
    doc: () => ({
      get: async () => ({
        exists: true,
        data: () => ({
          linkedinOauthLinked: true,
          linkedinOauthSub: "7RLX9e4Qjo",
          linkedinUrl: "https://www.linkedin.com/oauth-linked/7RLX9e4Qjo",
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
  rawUrl: extracted!,
  search: async (u: string) => {
    reached = u
    return null
  },
})
console.log(`gate probe        stranded user reached search with ${reached} → ${JSON.stringify(gate)}`)
process.exit(0)
