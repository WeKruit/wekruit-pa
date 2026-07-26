/**
 * Seed `matching-jobs/photon-backend-engineer-high-concurrency`.
 *
 * The role is live in pa-jobs (active, publicVisible, collaborated, recruiterBoard.active) but has
 * no matching-jobs row, unlike BOTH sibling Photon roles — so find_match / V16 / rediscover can
 * never surface it. This writes the missing row.
 *
 * Field set is MIRRORED from `wekruit-37429d02-photon-macos-devops` (the sibling that works) rather
 * than invented, including the object-shaped `requiredSkills` the enricher actually produces —
 * pa-jobs stores those as plain strings, and writing strings here would not match the live schema.
 *
 * Apply URL is the real public candidate page (publicVisible=true), because V16 hard-filters on
 * `atsApplyUrl` being present.
 *
 * Dry run by default; `--apply` to write.
 */
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env", "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) raw = raw.slice(1, -1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()

const ID = "photon-backend-engineer-high-concurrency"
const apply = process.argv.includes("--apply")
const pa = (await db.collection("pa-jobs").doc(ID).get()).data()
const now = new Date().toISOString()
const url = `https://candidate.wekruit.com/j/${ID}`

// pa-jobs holds requiredSkills as strings; matching-jobs holds the enricher's object form.
const LANG = new Set(["rust", "swift", "typescript", "node.js"])
const skill = (s) => ({
  name: s.toLowerCase(),
  bucket: LANG.has(s.toLowerCase()) ? "programming_languages" : "domain_specific",
  proficiency: "advanced",
  evidenceCount: 2,
  baseWeight: 0.9,
})

const doc = {
  jobId: ID,
  companyId: pa.companyId,
  companyName: pa.companyName,
  title: pa.title,
  roleTitle: pa.title,
  description: pa.descriptionMd,
  jobDescription: pa.descriptionMd,
  status: "active",
  dead: false,
  jobType: pa.jobType,
  seniorityLevel: pa.seniorityLevel,
  salaryMin: pa.salaryMin,
  salaryMax: pa.salaryMax,
  salaryRange: pa.salaryRange,
  sponsorship: pa.sponsorship,
  sponsorshipSource: "jd_explicit",
  sponsorshipConfidence: 1,
  sponsorshipReasoning: "JD states 'Visa sponsorship available' and 'Photon can sponsor visas'.",
  locationRaw: pa.rawLocation,
  locationBuckets: pa.locationBuckets,
  roleFunction: pa.roleFunction,
  industrySector: pa.industrySector,
  industry: "AI agent infrastructure",
  industryKey: "ai_ml",
  industryEnum: ["ai_ml", "tech_software"],
  requiredSkills: pa.requiredSkills.map(skill),
  relevantTags: pa.relevantTags,
  primaryUrl: url,
  applyUrl: url,
  atsApplyUrl: url,
  sourceUrl: url,
  source: "wekruit_collab",
  sourcePlatform: "wekruit",
  sourceRepo: "wekruit_seed_photon",
  contentHash: `${ID}:${pa.publicId}`,
  firstSeenAt: now,
  lastSeenAt: now,
  updatedAt: now,
}

console.log(JSON.stringify(doc, null, 1).slice(0, 2000))
if (!apply) { console.log("\nDRY RUN — pass --apply"); process.exit(0) }
await db.collection("matching-jobs").doc(ID).set(doc, { merge: true })
const back = (await db.collection("matching-jobs").doc(ID).get()).data()
console.log(`\nWROTE. status=${back.status} atsApplyUrl=${back.atsApplyUrl} skills=${back.requiredSkills.length}`)
process.exit(0)
