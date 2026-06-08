/**
 * backfill-8few-merge.ts — one-off, SCOPED to dev phone uid 8fEwIduUrzxZsblHHsNz (+14243201960,
 * standing dev-test authorization). Fixes the stale extraction Adam hit live: pa-users.tags says
 * recentRoleTitle="Software Engineer Intern" / careerStage="junior" / yoeRange=[0,1] while LinkedIn
 * clearly shows "Senior Software Engineer" currentRole=true. Runs the SAME real merge+determine fn the
 * deployed seam runs (mergeAndDetermineProfile) over BOTH sources and writes the SAME shape seam-a writes
 * (mergedToHighlights + the 4 tag facts, sibling tags preserved by read+clone+overlay).
 *
 * DRY by default — prints the merge result. Pass --apply to write (dev phone only; hardcoded uid).
 *   USAGE (from apps/functions):
 *     node --import tsx .ops/backfill-8few-merge.ts            # DRY
 *     node --import tsx .ops/backfill-8few-merge.ts --apply    # write to 8fEw
 */
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
import {
  mergeAndDetermineProfile,
  toSourceFromLinkedin,
  toSourceFromResume,
  type SourceExperience,
  type MergeAndDetermineResult,
} from "../src/external-supply/merge-experience-profile.js"

const UID = "8fEwIduUrzxZsblHHsNz" // dev phone +14243201960 — hardcoded, no broad backfill.
const APPLY = process.argv.includes("--apply")

// --- env: SA creds + OpenAI key, by assignment only (never echo) ---
const ENV_PATH = process.env.PA_ENV_PATH || "/Users/adam/Desktop/WeKruit/wekruit-pa/.env"
const envText = readFileSync(ENV_PATH, "utf8")
function envVal(name: string): string | undefined {
  const m = envText.match(new RegExp("^" + name + "=(.*)$", "m"))
  if (!m) return undefined
  let v = m[1].trim()
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) v = v.slice(1, -1)
  return v
}
for (const k of ["PA_OPENAI_AGENT_API_KEY", "OPENAI_API_KEY", "PA_OPENAI_AGENT_BASE_URL", "OPENAI_BASE_URL"]) {
  const v = envVal(k)
  if (v && !process.env[k]) process.env[k] = v
}
const saRaw = envVal("FIREBASE_SERVICE_ACCOUNT_JSON")
if (!saRaw) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON missing from .env")
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(saRaw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()

function stripUndefined<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k]
  return o
}
function mergedToHighlights(merged: MergeAndDetermineResult): Array<Record<string, unknown>> {
  return merged.mergedExperiences.slice(0, 10).map((e) =>
    stripUndefined({
      title: e.title,
      company: e.company,
      description: e.description ?? undefined,
      startDate: e.startDate ?? undefined,
      endDate: e.endDate ?? undefined,
      currentRole: e.isCurrent === true ? true : undefined,
      source: "merged_linkedin_resume",
      sourceLabel: "LinkedIn+Résumé",
    }),
  )
}

;(async () => {
  // 1. LinkedIn sources = pa-users.experienceHighlights
  const userSnap = await db.collection("pa-users").doc(UID).get()
  if (!userSnap.exists) throw new Error(`pa-users/${UID} not found`)
  const userData = userSnap.data() as Record<string, unknown>
  const tags = (userData.tags as Record<string, unknown>) ?? {}
  const highlightsRaw = Array.isArray(userData.experienceHighlights) ? userData.experienceHighlights : []
  const linkedinExperiences: SourceExperience[] = highlightsRaw.map((r) =>
    toSourceFromLinkedin(r as Record<string, unknown>),
  )

  // 2. Résumé sources = parsedCandidateResumes(userId==UID, non-coresignal).experiences|workHistory
  const resumeSnap = await db.collection("parsedCandidateResumes").where("userId", "==", UID).get()
  const resumeExperiences: SourceExperience[] = []
  let resumeDocsUsed = 0
  for (const d of resumeSnap.docs) {
    const data = d.data() as Record<string, unknown>
    if (data.source === "coresignal_collect_v2") continue
    const rows = (Array.isArray(data.workHistory) && data.workHistory.length
      ? data.workHistory
      : Array.isArray(data.experiences)
        ? data.experiences
        : []) as Array<Record<string, unknown>>
    if (!rows.length) continue
    resumeDocsUsed++
    for (const row of rows) {
      const src = toSourceFromResume(row)
      if (src.title || src.company) resumeExperiences.push(src)
    }
  }

  console.log(`\n=== SOURCES for ${UID} ===`)
  console.log(`current tags: recentRoleTitle=${JSON.stringify(tags.recentRoleTitle)} careerStage=${JSON.stringify(tags.careerStage)} yoeRange=${JSON.stringify(tags.yoeRange)}`)
  console.log(`linkedin/highlights rows: ${linkedinExperiences.length}  | résumé docs used: ${resumeDocsUsed}, résumé rows: ${resumeExperiences.length}`)

  // 3. the REAL merge+determine call
  const merged = await mergeAndDetermineProfile({ linkedinExperiences, resumeExperiences })
  if (!merged) {
    console.log("\nmergeAndDetermineProfile returned null (fail-open) — NO write. Check OpenAI key / sources.")
    process.exit(1)
  }

  console.log(`\n=== MERGE RESULT ===`)
  console.log(`recentRoleTitle = ${JSON.stringify(merged.recentRoleTitle)}`)
  console.log(`recentCompany   = ${JSON.stringify(merged.recentCompany)}`)
  console.log(`careerStage     = ${JSON.stringify(merged.careerStage)}`)
  console.log(`yoeRange        = ${JSON.stringify(merged.yoeRange)}`)
  console.log(`mergedExperiences (${merged.mergedExperiences.length}):`)
  for (const e of merged.mergedExperiences) {
    console.log(`  - ${e.title} @ ${e.company}${e.isCurrent ? " [current]" : ""}  ${e.startDate ?? "?"}–${e.endDate ?? "?"}`)
    if (e.description) console.log(`      ${e.description.slice(0, 120)}${e.description.length > 120 ? "…" : ""}`)
  }

  if (!APPLY) {
    console.log("\nDRY — pass --apply to write to 8fEw (dev phone). No write performed.")
    process.exit(0)
  }

  // 4. write — reproduce seam-a shape: clone tags, overlay ONLY the 4 facts + experienceHighlights
  const nowIso = new Date().toISOString()
  const nextTags: Record<string, unknown> = { ...tags }
  if (merged.recentRoleTitle) nextTags.recentRoleTitle = merged.recentRoleTitle
  if (merged.recentCompany) nextTags.recentCompany = merged.recentCompany
  if (merged.careerStage) nextTags.careerStage = merged.careerStage
  if (merged.yoeRange) nextTags.yoeRange = merged.yoeRange
  nextTags.lastUpdatedFromMergedExperience = nowIso

  await db.collection("pa-users").doc(UID).set(
    { tags: nextTags, experienceHighlights: mergedToHighlights(merged) },
    { merge: true },
  )
  console.log(`\nWROTE pa-users/${UID}: tags facts + ${merged.mergedExperiences.length} merged highlights.`)

  // 5. verify read-back
  const after = (await db.collection("pa-users").doc(UID).get()).data() as Record<string, unknown>
  const at = (after.tags as Record<string, unknown>) ?? {}
  console.log(`VERIFY tags: recentRoleTitle=${JSON.stringify(at.recentRoleTitle)} careerStage=${JSON.stringify(at.careerStage)} yoeRange=${JSON.stringify(at.yoeRange)}`)
  process.exit(0)
})().catch((e) => {
  console.error("FATAL", e)
  process.exit(1)
})
