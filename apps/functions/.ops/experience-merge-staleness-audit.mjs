/**
 * READ-ONLY audit — experience-merge staleness across pa-users.
 *
 * WHY: The current extraction grabs the (stale) résumé intern role and
 * undercounts YoE while the candidate's LinkedIn/Coresignal experiences
 * clearly show a fresher, more-senior current role. Nobody merged the two
 * sources and let an LLM determine the truth (Adam 2026-06-05). This script
 * QUANTIFIES the blast radius — how many candidates have an INCONSISTENT
 * current role between sources, so we know how big the backfill is.
 *
 * It does NOT classify text → enum and it does NOT write anything. It surfaces
 * a heuristic FLAG only (careerStage looks early but a freshest highlight reads
 * senior); the real determination is the LLM's job in the merge enrichment.
 *
 * Sources compared per candidate:
 *   (1) tags.recentRoleTitle / tags.careerStage / tags.yoeRange   ← what we wrote
 *   (2) experienceHighlights freshest entry                        ← LinkedIn/Coresignal
 *   (3) parsedCandidateResumes presence                            ← résumé side
 *
 * Freshest-highlight logic mirrors compose-pitch.ts buildPitchProfile EXACTLY:
 *   prefer currentRole===true, else latest Date.parse(startDate). No regex.
 *
 * Run:
 *   source ~/.zshrc && nvm use 24
 *   cd apps/functions
 *   PA_ENV_PATH=/Users/adam/Desktop/WeKruit/wekruit-pa/.env \
 *     node --import tsx .ops/experience-merge-staleness-audit.mjs
 *
 * NO writes. NO --apply. Pure read + report.
 */
import { readFileSync } from "node:fs"
import admin from "firebase-admin"

// ---- firebase-admin init (same pattern as sibling .ops probes) -------------
let raw = readFileSync(process.env.PA_ENV_PATH, "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) raw = raw.slice(1, -1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()

// ---- helpers ---------------------------------------------------------------
const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : "")

/** Normalize a title to compare for "same role text" (NO enum classification). */
function normTitle(v) {
  return str(v).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
}

/**
 * Freshest highlight from experienceHighlights, mirroring compose-pitch.ts:
 *  - among entries that have a parseable startDate, pick the latest;
 *  - currentRole===true is preferred when present (it usually IS the latest).
 * Returns { title, company, startDate, currentRole } | null.
 */
function freshestHighlight(highlights) {
  if (!Array.isArray(highlights) || highlights.length === 0) return null
  // currentRole flag first (matches the buildExperienceHighlightsFromRecord intent)
  const current = highlights.find((h) => h && h.currentRole === true && (h.title || h.company))
  const dated = highlights
    .filter((h) => h && (h.title || h.company))
    .map((h) => ({ h, ms: h.startDate ? Date.parse(h.startDate) : NaN }))
    .filter((x) => !Number.isNaN(x.ms))
    .sort((a, b) => b.ms - a.ms)
  const latestDated = dated[0]?.h ?? null
  // Prefer currentRole entry, but if the latest-dated is strictly newer, use it.
  if (current && latestDated) {
    const cms = current.startDate ? Date.parse(current.startDate) : NaN
    const lms = latestDated.startDate ? Date.parse(latestDated.startDate) : NaN
    if (!Number.isNaN(lms) && (Number.isNaN(cms) || lms > cms)) return latestDated
    return current
  }
  return current ?? latestDated ?? null
}

// Heuristic "looks early-career" tag set (FLAG only — never a write/classification).
const EARLY_STAGES = new Set(["intern", "entry_level", "junior"])
// Heuristic "reads senior" tokens for the freshest highlight title (FLAG only).
const SENIOR_TOKENS = ["senior", "staff", "principal", "lead", "head", "director", "vp", "vice president", "chief", "founder", "manager"]
// "stale-looking" recentRoleTitle markers (FLAG only).
const STALE_TITLE_TOKENS = ["intern", "internship", "co op", "co-op", "trainee", "apprentice"]

function titleHasAny(title, tokens) {
  const t = normTitle(title)
  return tokens.some((tok) => t.includes(normTitle(tok)))
}

// ---- scan ------------------------------------------------------------------
async function main() {
  console.log("READ-ONLY experience-merge staleness audit — NO writes\n")

  let total = 0
  let withHighlights = 0
  let withResumeDoc = 0
  let withBothSources = 0
  let recentTitleMismatch = 0
  let careerStageLooksStaleButHighlightSenior = 0
  let yoeUndercountFlag = 0

  const examples = [] // { uid, staleTag, freshTitle }
  const stageExamples = []

  // Cache parsedCandidateResumes presence by userId/candidateId (one pass).
  // pa-users can be large; page through it.
  const PAGE = 400
  let last = null
  for (;;) {
    let q = db.collection("pa-users").orderBy("__name__").limit(PAGE)
    if (last) q = q.startAfter(last)
    const snap = await q.get()
    if (snap.empty) break
    for (const doc of snap.docs) {
      total += 1
      last = doc.id
      const d = doc.data() ?? {}
      const tags = d.tags ?? {}
      const highlights = Array.isArray(d.experienceHighlights)
        ? d.experienceHighlights
        : Array.isArray(tags.experienceHighlights)
          ? tags.experienceHighlights
          : []
      const hasHighlights = highlights.length > 0
      if (hasHighlights) withHighlights += 1

      // résumé doc presence — query is cheap but N round-trips; only check when
      // it can change the BOTH-sources count (i.e. the candidate has highlights).
      let hasResumeDoc = false
      if (hasHighlights) {
        const rs1 = await db.collection("parsedCandidateResumes").where("userId", "==", doc.id).limit(1).get()
        if (!rs1.empty) hasResumeDoc = true
        else {
          const rs2 = await db.collection("parsedCandidateResumes").where("candidateId", "==", doc.id).limit(1).get()
          if (!rs2.empty) hasResumeDoc = true
        }
      }
      if (hasResumeDoc) withResumeDoc += 1
      const bothSources = hasHighlights && hasResumeDoc
      if (bothSources) withBothSources += 1

      // freshest highlight vs the written recentRoleTitle
      const fresh = freshestHighlight(highlights)
      const recentTitle = str(tags.recentRoleTitle)
      if (fresh && recentTitle) {
        const freshTitle = str(fresh.title)
        if (freshTitle && normTitle(freshTitle) !== normTitle(recentTitle)) {
          recentTitleMismatch += 1
          if (examples.length < 15) {
            examples.push({ uid: doc.id, staleTag: recentTitle, freshTitle })
          }
        }
      }

      // careerStage-looks-stale-but-highlight-senior  (HEURISTIC FLAG ONLY)
      const stage = str(tags.careerStage)
      const staleByStage = EARLY_STAGES.has(stage)
      const staleByTitle = titleHasAny(recentTitle, STALE_TITLE_TOKENS)
      const freshReadsSenior = fresh && titleHasAny(fresh.title, SENIOR_TOKENS)
      if ((staleByStage || staleByTitle) && freshReadsSenior) {
        careerStageLooksStaleButHighlightSenior += 1
        if (stageExamples.length < 15) {
          stageExamples.push({
            uid: doc.id,
            stage: stage || "(none)",
            staleTag: recentTitle || "(none)",
            freshTitle: str(fresh.title),
          })
        }
      }

      // yoe-undercount FLAG: low yoeRange ceiling but the highlights span more
      // dated months than that ceiling would imply. Pure arithmetic heuristic,
      // NOT a classification — surfaces "the LLM should recompute YoE".
      const yoeRange = Array.isArray(tags.yoeRange) ? tags.yoeRange : null
      const yoeCeil = yoeRange && typeof yoeRange[1] === "number" ? yoeRange[1] : null
      if (yoeCeil !== null && hasHighlights) {
        const months = highlights
          .filter((h) => h && typeof h.durationMonths === "number" && !titleHasAny(h.title, STALE_TITLE_TOKENS))
          .reduce((s, h) => s + h.durationMonths, 0)
        if (months >= (yoeCeil + 1) * 12) yoeUndercountFlag += 1
      }
    }
    if (snap.size < PAGE) break
  }

  // ---- report --------------------------------------------------------------
  console.log("============ RESULTS ============")
  console.log(`total pa-users scanned                                  : ${total}`)
  console.log(`  with experienceHighlights                             : ${withHighlights}`)
  console.log(`  with a parsedCandidateResumes doc (among highlighted) : ${withResumeDoc}`)
  console.log(`  with BOTH sources (highlights AND résumé doc)         : ${withBothSources}`)
  console.log(`  recentRoleTitle != freshest-highlight-title           : ${recentTitleMismatch}`)
  console.log(`  careerStage looks stale BUT highlight reads senior*   : ${careerStageLooksStaleButHighlightSenior}`)
  console.log(`  yoeRange ceiling undercounts dated highlight months*  : ${yoeUndercountFlag}`)
  console.log(`  (* = heuristic FLAG only — NO enum classification, NO write)\n`)

  console.log(`---- first ${examples.length} recentRoleTitle mismatches (staleTag -> freshTitle) ----`)
  for (const e of examples) {
    console.log(`  ${e.uid}: ${JSON.stringify(e.staleTag)} -> ${JSON.stringify(e.freshTitle)}`)
  }

  if (stageExamples.length) {
    console.log(`\n---- first ${stageExamples.length} careerStage-stale-but-senior flags ----`)
    for (const e of stageExamples) {
      console.log(`  ${e.uid}: stage=${e.stage} staleTag=${JSON.stringify(e.staleTag)} -> freshTitle=${JSON.stringify(e.freshTitle)}`)
    }
  }
  console.log("\nDONE — read-only, nothing written.")
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("AUDIT ERROR:", err)
  process.exit(1)
})
