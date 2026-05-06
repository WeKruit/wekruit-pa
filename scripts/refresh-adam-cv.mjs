#!/usr/bin/env node
/**
 * iter34 followup G.1/D.10 — refresh Adam's parsedCandidateResumes doc with:
 *   - industryTags = ["tech_software", "ai_ml"] (LLM mis-classified as "other")
 *   - topSkills = top 12 dedupe'd lowercase skills from candidateProfile.skills + workHistory[].skills
 *   - embedding = 1536-d text-embedding-3-small over CV summary text
 *
 * Idempotent: overrides existing fields. Re-runs are safe.
 *
 * Auth: GOOGLE_APPLICATION_CREDENTIALS must point to a Firebase service account JSON.
 *       OPENAI_API_KEY must be set for embedding generation.
 *
 * Usage:
 *   export GOOGLE_APPLICATION_CREDENTIALS=$(mktemp)
 *   grep -E "^FIREBASE_SERVICE_ACCOUNT_JSON=" .env | sed 's/^FIREBASE_SERVICE_ACCOUNT_JSON=//' > "$GOOGLE_APPLICATION_CREDENTIALS"
 *   node scripts/refresh-adam-cv.mjs
 */

import { readFileSync } from "node:fs"
import { cert, getApps, initializeApp } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import OpenAI from "openai"

// --- Auth ---
const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
if (!credPath) {
  console.error("ERROR: GOOGLE_APPLICATION_CREDENTIALS must be set.")
  process.exit(1)
}
if (!process.env.OPENAI_API_KEY) {
  console.error("ERROR: OPENAI_API_KEY must be set.")
  process.exit(1)
}
const serviceAccount = JSON.parse(readFileSync(credPath, "utf8"))
if (!getApps().length) {
  initializeApp({ credential: cert(serviceAccount), projectId: serviceAccount.project_id })
}
const db = getFirestore()
const oai = new OpenAI()

// --- Target ---
const DOC_ID = "rQIqQEghvZLwVkMad2lJ" // Adam's parsedCandidateResumes doc
const ref = db.collection("parsedCandidateResumes").doc(DOC_ID)

const snap = await ref.get()
if (!snap.exists) {
  console.error(`ERROR: doc ${DOC_ID} not found in parsedCandidateResumes.`)
  process.exit(1)
}
const cur = snap.data() || {}

console.log("BEFORE:")
console.log("  industryTags:", cur.industryTags)
console.log("  topSkills:", Array.isArray(cur.topSkills) ? `${cur.topSkills.length} items` : cur.topSkills)
console.log("  embedding:", Array.isArray(cur.embedding) ? `${cur.embedding.length} dim` : cur.embedding)

// --- 1. topSkills: source from candidateProfile.skills + workHistory[].skills (lowercase, dedupe, cap 12) ---
const allSkills = [
  ...(Array.isArray(cur.candidateProfile?.skills) ? cur.candidateProfile.skills : []),
  ...(Array.isArray(cur.workHistory) ? cur.workHistory.flatMap((w) => (Array.isArray(w?.skills) ? w.skills : [])) : []),
]
const counts = new Map()
const order = []
for (const raw of allSkills) {
  const s = String(raw || "").toLowerCase().trim()
  if (!s) continue
  if (!counts.has(s)) order.push(s)
  counts.set(s, (counts.get(s) || 0) + 1)
}
// Sort by count desc, ties broken by first-seen order (stable)
const topSkills = order
  .map((s) => ({ s, c: counts.get(s) || 0, i: order.indexOf(s) }))
  .sort((a, b) => (b.c - a.c) || (a.i - b.i))
  .slice(0, 12)
  .map(({ s }) => s)

// --- 2. industryTags: hardcoded for Adam (LLM mis-classified as "other") ---
const industryTags = ["tech_software", "ai_ml"]

// --- 3. embedding from CV summary text ---
const expSource = Array.isArray(cur.experiences) && cur.experiences.length > 0
  ? cur.experiences
  : Array.isArray(cur.workHistory) ? cur.workHistory : []

const expLines = expSource.slice(0, 5).map((e) => {
  const title = e?.title || e?.role || ""
  const company = e?.company || ""
  let desc = ""
  if (typeof e?.description === "string" && e.description.trim()) {
    desc = e.description.trim()
  } else if (Array.isArray(e?.bullets) && e.bullets.length) {
    desc = e.bullets.slice(0, 3).map((b) => String(b)).join(" ")
  }
  return `${title} @ ${company}: ${desc}`.trim()
})

// Also pull bullets from workHistory if experiences lacked them (more SWE signal)
let bulletLines = []
if (Array.isArray(cur.workHistory)) {
  bulletLines = cur.workHistory.slice(0, 5).flatMap((w) => {
    const head = `${w?.title || ""} @ ${w?.company || ""}`
    const bullets = Array.isArray(w?.bullets) ? w.bullets.slice(0, 3).map((b) => `- ${String(b)}`) : []
    return bullets.length ? [head, ...bullets] : []
  })
}

const summaryText = [
  cur.candidateProfile?.name || "",
  ...expLines,
  ...bulletLines,
  topSkills.join(", "),
].filter((line) => line && String(line).trim().length > 0).join("\n").slice(0, 8000)

console.log("\nSummary text (first 400 chars):")
console.log("  " + summaryText.slice(0, 400).replace(/\n/g, "\n  "))
console.log(`  [length: ${summaryText.length}]`)

console.log("\nComputing embedding (text-embedding-3-small)...")
const embResp = await oai.embeddings.create({
  model: "text-embedding-3-small",
  input: summaryText,
})
const vector = embResp.data[0].embedding
if (!Array.isArray(vector) || vector.length !== 1536) {
  console.error(`ERROR: unexpected embedding shape — got length ${Array.isArray(vector) ? vector.length : typeof vector}, expected 1536.`)
  process.exit(1)
}

// --- Write ---
const nowIso = new Date().toISOString()
await ref.update({
  topSkills,
  industryTags,
  embedding: vector,
  embeddingModel: "text-embedding-3-small",
  embeddingDim: 1536,
  embeddingComputedAt: nowIso,
  refreshedBy: "iter34-G1-admin-script",
  refreshedAt: nowIso,
})

// --- Verify ---
const verifySnap = await ref.get()
const after = verifySnap.data() || {}

console.log("\nAFTER update:")
console.log("  industryTags:", after.industryTags)
console.log("  topSkills (first 8):", Array.isArray(after.topSkills) ? after.topSkills.slice(0, 8) : after.topSkills)
console.log("  topSkills.length:", Array.isArray(after.topSkills) ? after.topSkills.length : null)
console.log("  embedding dim:", Array.isArray(after.embedding) ? after.embedding.length : null)
console.log("  embeddingModel:", after.embeddingModel)
console.log("  refreshedAt:", after.refreshedAt)

// Acceptance gates
const ok =
  Array.isArray(after.industryTags) &&
  after.industryTags.length === 2 &&
  after.industryTags.includes("tech_software") &&
  after.industryTags.includes("ai_ml") &&
  Array.isArray(after.topSkills) &&
  after.topSkills.length >= 8 &&
  Array.isArray(after.embedding) &&
  after.embedding.length === 1536

if (!ok) {
  console.error("\nFAIL: acceptance gates not met.")
  process.exit(1)
}
console.log("\nOK: all acceptance gates met (industryTags + topSkills>=8 + embedding=1536d).")
process.exit(0)
