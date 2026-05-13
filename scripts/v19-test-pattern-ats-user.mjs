#!/usr/bin/env node
/**
 * v1.9 — TEST PATTERN B: ATS-sourced user onboarding
 *
 * Simulates: candidate applied via Handshake (ATS) → paAtsInboundWebhook
 * adapter parses payload → finds/creates pa-users by email → binds resume
 * → sends outbound invite SMS → candidate replies START → bound to internal
 * trigger → prescreen → PII → matching.
 *
 * Pre-fills:
 *   - pa-jobs-external-mapping/{source}_{externalJobId} = {jobIdInternal}
 *   - pa-users with mock parsed resume tags (skills, yoe, location)
 *
 * Run:  node scripts/v19-test-pattern-ats-user.mjs [jobId]
 */
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { randomUUID } from "node:crypto"

const internalJobId = process.argv[2] ?? "hs-11005382-invoko-product-designer"
const externalJobId = "hs_ext_11005382" // Handshake external job id
const cfg = JSON.parse(readFileSync(`${homedir()}/.config/configstore/firebase-tools.json`, "utf8"))
const tokRes = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_id: "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com",
    client_secret: "j9iVZfS8kkCEFUPaAeJV0sAi",
    refresh_token: cfg.tokens.refresh_token,
    grant_type: "refresh_token",
  }),
})
const { access_token } = await tokRes.json()

function v(val) {
  if (val === null) return { nullValue: null }
  if (typeof val === "boolean") return { booleanValue: val }
  if (typeof val === "string") return { stringValue: val }
  if (typeof val === "number") {
    return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val }
  }
  if (Array.isArray(val)) return { arrayValue: { values: val.map(v) } }
  if (typeof val === "object") {
    const out = {}
    for (const [k, vv] of Object.entries(val)) out[k] = v(vv)
    return { mapValue: { fields: out } }
  }
}

async function patch(path, fields) {
  const r = await fetch(
    `https://firestore.googleapis.com/v1/projects/wekruit-5f89b/databases/(default)/documents/${path}`,
    {
      method: "PATCH",
      headers: { authorization: `Bearer ${access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ fields: v(fields).mapValue.fields }),
    }
  )
  if (!r.ok) {
    console.error(`PATCH ${path} ${r.status}: ${await r.text()}`)
    process.exit(1)
  }
}

console.log(`\n=== PATTERN B: ATS-sourced user — internalJobId=${internalJobId} ===`)

// 1. Stamp pa-jobs-external-mapping so ATS adapter can resolve external→internal
const mappingKey = `handshake_${externalJobId}`
await patch(`pa-jobs-external-mapping/${mappingKey}`, {
  source: "handshake",
  jobIdExternal: externalJobId,
  jobIdInternal: internalJobId,
  curatedBy: "v19-test-pattern-ats-user",
  createdAt: new Date().toISOString(),
})
console.log(`✓ pa-jobs-external-mapping/${mappingKey} → ${internalJobId}`)

// 2. Simulate an ATS applicant payload as if Handshake POSTed it
const applicantEmail = `pattern-b-test-${Date.now()}@example.com`
const applicantName = "Jordan Test-Applicant"
const fakePayload = {
  event: "application.submitted",
  data: {
    applicant_id: `hs_app_${Date.now()}`,
    job_id: externalJobId,
    candidate: {
      first_name: "Jordan",
      last_name: "Test-Applicant",
      email: applicantEmail,
      phone: "+14155557777",
    },
    resume_url: "https://example.com/fake-resume.pdf",
  },
  ts: new Date().toISOString(),
}

// 3. Pre-seed pa-users with mock parsed resume tags (this is what
//    cv-ingest would write after parsing the resume from resume_url)
const userId = randomUUID()
await patch(`pa-users/${userId}`, {
  email: applicantEmail,
  emailLower: applicantEmail,
  legalName: applicantName,
  phone: "+14155557777",
  signupSource: "ats:handshake",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  tags: {
    yoeRange: { lowYears: 2, highYears: 4 },
    careerStage: "junior_to_mid",
    visaStatus: "sponsor_needed",
    targetLocations: ["san_francisco_bay_area"],
    targetRoleFunction: ["product_design", "ui_ux_design"],
    industrySector: ["artificial_intelligence_and_machine_learning"],
    skills: ["figma", "user_research", "prototyping", "design_systems"],
  },
})
console.log(`✓ pa-users/${userId} pre-seeded (Jordan, 2-4yr designer, SF, sponsor needed)`)

// 4. Run prescreen simulator (this assumes ATS invite SMS already sent +
//    candidate has replied — we replay the prescreen pipeline directly)
console.log(`\nReplaying prescreen pipeline with strong-design replies…`)
const replies = [
  "I led product design at a Series A consumer fintech for 3 years — shipped onboarding redesign that lifted activation 22%, owned design system end-to-end",
  "Figma daily, Framer for landing+marketing flows, v0 / Cursor for fast interactive prototypes. Last week I shipped 3 prototypes in 5 days using AI tooling",
].join("|")
const r = spawnSync("node", ["scripts/v19-simulate-prescreen.mjs", internalJobId, replies], {
  stdio: "inherit",
})

console.log(`\n=== PATTERN B summary ===`)
console.log(`ATS payload (would POST to paAtsInboundWebhook):`)
console.log(JSON.stringify(fakePayload, null, 2))
console.log(`\nCanonical applicant flow:`)
console.log(`  1. paAtsInboundWebhook parses payload`)
console.log(`  2. find-or-create pa-users by email "${applicantEmail}"`)
console.log(`  3. bind resume from resume_url via cv-ingest`)
console.log(`  4. send outbound invite SMS w/ pre-filled trigger`)
console.log(`  5. candidate replies → coalescer → prescreen → PII → recs`)
console.log(`\nSimulator exit code: ${r.status}`)
console.log(
  r.status === 0
    ? "✓ Prescreen pipeline reaches PASS terminal"
    : "✗ Prescreen pipeline did NOT reach PASS — investigate"
)
process.exit(r.status ?? 0)
