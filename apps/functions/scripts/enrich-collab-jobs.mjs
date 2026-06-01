// Enrich + mirror WeKruit collab jobs (pa-jobs.wekruitCollaborationStatus=="collaborated")
// into matching-jobs/{paJobId} so the V16 matcher can match them. US-only locations.
// Reuses @pa/job-tag-enricher (same lib paMatchingJobsAutoEnrich uses).
//
// Idempotent: writes via set/merge on matching-jobs/{paJobId}. Re-running re-enriches.
// Run FROM apps/functions:
//   PA_ENV_PATH=/Users/adam/Desktop/WeKruit/wekruit-pa/.env node scripts/enrich-collab-jobs.mjs [--apply]
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
import { enrichJobTags } from "@pa/job-tag-enricher"

const APPLY = process.argv.includes("--apply")
const ENRICHER_VERSION = "v1.9.0-collab-script"

// Load OpenAI key + firebase creds from .env
const envText = readFileSync(process.env.PA_ENV_PATH, "utf8")
function envVal(name) {
  const m = envText.match(new RegExp("^" + name + "=(.*)$", "m"))
  if (!m) return ""
  let v = m[1].trim()
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) v = v.slice(1, -1)
  return v
}
if (!process.env.PA_OPENAI_AGENT_API_KEY) process.env.PA_OPENAI_AGENT_API_KEY = envVal("PA_OPENAI_AGENT_API_KEY") || envVal("OPENAI_API_KEY")

let raw = envVal("FIREBASE_SERVICE_ACCOUNT_JSON")
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()

const NOW = new Date().toISOString()

// US-only location resolver — collab jobs are WeKruit US partner roles.
// Maps locationRaw to a canonical US bucket; remote → remote_united_states.
function resolveUsLocationBuckets(locationRaw) {
  const s = (locationRaw || "").toLowerCase()
  if (/san francisco|sf bay|bay area|\bsf\b|, ca|california/.test(s)) return ["san_francisco_bay_area"]
  if (/new york|nyc|, ny|manhattan|brooklyn/.test(s)) return ["new_york_metro"]
  if (/seattle|, wa/.test(s)) return ["seattle_metro"]
  if (/austin|, tx/.test(s)) return ["austin_metro"]
  if (/boston|, ma/.test(s)) return ["boston_metro"]
  if (/los angeles|, la\b/.test(s)) return ["los_angeles_metro"]
  if (/denver|, co/.test(s)) return ["denver_metro"]
  if (/chicago|, il/.test(s)) return ["chicago_metro"]
  if (/remote/.test(s)) return ["remote_united_states"]
  // Unknown US collab → default to remote_united_states so it still passes US gate.
  return ["remote_united_states"]
}

async function main() {
  const snap = await db.collection("pa-jobs").where("wekruitCollaborationStatus", "==", "collaborated").get()
  console.log(`Collab jobs: ${snap.size}. apply=${APPLY}\n`)

  let enriched = 0, skippedExisting = 0, failed = 0
  const results = []

  for (const doc of snap.docs) {
    const id = doc.id
    const d = doc.data()
    const title = d.title || d.roleTitle || d.jobTitle || ""
    const company = d.companyName || d.company || ""
    const jd = d.descriptionMd || d.jobDescription || d.description || ""
    const locationRaw = d.location || d.locationRaw || d.rawLocation || ""

    // Apply URL: prefer a real ATS/source URL; else fall back to the public
    // candidate page on the APEX forward-facing domain (wekruit.com — Adam 2026-05-30,
    // NOT candidate.wekruit.com; same SPA, apex is the brand surface candidates see).
    // Must be present or the V16 atsApplyUrl hard filter drops the job.
    let applyUrl = d.atsApplyUrl || d.applyUrl || d.sourceUrl || ""
    if (!applyUrl && d.publicId) applyUrl = `https://wekruit.com/j/${d.publicId}`
    if (!applyUrl) applyUrl = `https://wekruit.com/j/${id}`

    // Already enriched in matching-jobs (roleFunction+requiredSkills present)?
    const existing = await db.collection("matching-jobs").doc(id).get()
    if (existing.exists) {
      const m = existing.data()
      const ok = Array.isArray(m.roleFunction) && m.roleFunction.length > 0 && Array.isArray(m.requiredSkills) && m.requiredSkills.length > 0
      if (ok) {
        skippedExisting++
        results.push({ id, status: "already-enriched", roleFunction: m.roleFunction })
        console.log(`SKIP (already enriched): ${id}`)
        continue
      }
    }

    if (!title || !jd) {
      failed++
      results.push({ id, status: "no-jd-or-title", titleLen: title.length, jdLen: jd.length })
      console.log(`FAIL (no jd/title): ${id} titleLen=${title.length} jdLen=${jd.length}`)
      continue
    }

    try {
      const result = await enrichJobTags({
        title, companyName: company || null, jobDescription: jd, locationRaw: locationRaw || null,
        sourceRepo: "wekruit_collab_script",
      })
      const t = result.tags
      // skills come back as bucketed Skill[] objects; projectMatchingJobRow
      // handles both, but mirror auto-enrich's behavior: write t.skills as-is.
      const requiredSkills = Array.isArray(t.skills) ? t.skills : []

      // US-only location override (do NOT trust LLM foreign buckets for collab).
      const locationBuckets = resolveUsLocationBuckets(locationRaw)

      // Seniority: prefer pa-jobs explicit value, else LLM.
      const seniorityLevel = (d.seniorityLevel && d.seniorityLevel !== "mid_level")
        ? d.seniorityLevel
        : (t.seniorityLevel || d.seniorityLevel || "mid_level")

      const update = {
        status: "active",
        dead: false,
        roleFunction: t.roleFunction ?? [],
        industrySector: t.industrySector ?? [],
        relevantTags: t.relevantTags ?? [],
        requiredSkills,
        seniorityLevel,
        jobType: t.jobType ?? d.jobType ?? "full_time",
        locationBuckets,
        locationRaw: locationRaw || null,
        roleTitle: title,
        jobTitle: title,
        companyName: company || null,
        atsApplyUrl: applyUrl,
        primaryUrl: applyUrl,
        jobDescription: jd,
        firstSeenAt: NOW,
        lastSeenAt: NOW,
        sourceRepo: "wekruit_collab_script",
        wekruitCollaborationStatus: "collaborated",
        // Salary passthrough if present.
        ...(typeof d.salaryMin === "number" ? { salaryMin: d.salaryMin } : {}),
        ...(typeof d.salaryMax === "number" ? { salaryMax: d.salaryMax } : {}),
        // Sponsorship: only write if explicitly known on pa-jobs (never infer false).
        ...(typeof d.sponsorship === "boolean" ? { sponsorship: d.sponsorship } : {}),
        // Stamp enricher version so paMatchingJobsAutoEnrich's needsEnrichment()
        // gate (version+contentHash) does not immediately re-clobber on write.
        enricherVersion: ENRICHER_VERSION,
        enricherContentHash: null,
        enricherEnrichedAt: NOW,
        enricherModelUsed: result.modelUsed ?? null,
        collabEnrichedBy: "enrich-collab-jobs.mjs",
        collabEnrichedAt: NOW,
      }

      results.push({ id, status: "enriched", roleFunction: update.roleFunction, requiredSkillsCount: requiredSkills.length, locationBuckets, atsApplyUrl: applyUrl, seniorityLevel })
      console.log(`ENRICH: ${id}`)
      console.log(`   roleFunction=${JSON.stringify(update.roleFunction)} seniority=${seniorityLevel} jobType=${update.jobType}`)
      console.log(`   loc=${JSON.stringify(locationBuckets)} skills=${requiredSkills.length} applyUrl=${applyUrl}`)

      if (APPLY) {
        await db.collection("matching-jobs").doc(id).set(update, { merge: true })
        console.log(`   -> WRITTEN to matching-jobs/${id}`)
      }
      enriched++
    } catch (err) {
      failed++
      results.push({ id, status: "error", error: err?.message || String(err) })
      console.log(`FAIL (enrich error): ${id} ${err?.message || err}`)
    }
  }

  console.log(`\n=== ${APPLY ? "APPLIED" : "DRY-RUN"}: enriched=${enriched} skippedAlready=${skippedExisting} failed=${failed} total=${snap.size} ===`)
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
