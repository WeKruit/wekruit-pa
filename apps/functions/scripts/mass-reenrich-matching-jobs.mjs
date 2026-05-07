#!/usr/bin/env node
/**
 * P9 Mass Re-Enrich matching-jobs via @pa/job-tag-enricher
 *
 * Replaces ad-hoc regex backfill with unified LLM-enriched canonical tags.
 * Reads matching-jobs where status='active', calls enrichJobTags() per doc,
 * writes back canonical roleFunction/industrySector/relevantTags/skills/
 * seniorityLevel/jobType/locationBuckets.
 *
 * Concurrency: 4 parallel LLM calls (rate-limit-friendly).
 * Cache: in-memory by contentHash → reuse for duplicate JDs.
 * Batch: 400 Firestore writes per commit.
 * Diff-aware: only updates fields where new !== current AND new is non-null.
 *
 * Usage:
 *   node scripts/mass-reenrich-matching-jobs.mjs --dry-run --limit 5
 *   node scripts/mass-reenrich-matching-jobs.mjs --limit 100
 *   node scripts/mass-reenrich-matching-jobs.mjs --resume-from <jobId>
 *   node scripts/mass-reenrich-matching-jobs.mjs               # full
 *
 * Auth: GOOGLE_APPLICATION_CREDENTIALS=/tmp/firebase-creds.json
 *       OPENAI_API_KEY (or PA_OPENAI_AGENT_API_KEY) for primary tier
 *       ANTHROPIC_API_KEY (optional) for middle tier — graceful fallback
 *
 * REQ-IDs: REENRICH-01 (script) REENRICH-02 (Firestore cleanup)
 */

import { initializeApp, cert, getApps } from "firebase-admin/app"
import { getFirestore, FieldValue } from "firebase-admin/firestore"
import { readFileSync } from "node:fs"
import { enrichJobTags } from "@pa/job-tag-enricher"

// ─── CLI flags ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const DRY_RUN = argv.includes("--dry-run")
const LIMIT = (() => {
  const i = argv.indexOf("--limit")
  return i >= 0 ? parseInt(argv[i + 1], 10) : 10000
})()
const RESUME_FROM = (() => {
  const i = argv.indexOf("--resume-from")
  return i >= 0 ? argv[i + 1] : null
})()
const CONCURRENCY = (() => {
  const i = argv.indexOf("--concurrency")
  return i >= 0 ? parseInt(argv[i + 1], 10) : 8
})()
const STATUS = "active"
const PROJECT = "wekruit-5f89b"

// ─── Init Firebase ─────────────────────────────────────────────────────────────
function initFirebase() {
  if (getApps().length > 0) return
  const credsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
  if (credsPath) {
    const creds = JSON.parse(readFileSync(credsPath, "utf-8"))
    initializeApp({ credential: cert(creds), projectId: PROJECT })
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const creds = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
    initializeApp({ credential: cert(creds), projectId: PROJECT })
  } else {
    initializeApp({ projectId: PROJECT })
  }
}

initFirebase()
const db = getFirestore()

// ─── Diff helpers ──────────────────────────────────────────────────────────────
/**
 * Compose Firestore update: only include fields where new !== current AND new
 * is non-null. Don't overwrite already-good data with worse data — but if the
 * doc has the field unset OR has a wrong canonical value (e.g., 'technology'
 * generic default for industrySector), the LLM value wins.
 */
function composeUpdate(current, enriched) {
  const update = {}
  const diffs = []

  // roleFunction — always overwrite if enriched is non-empty
  if (enriched.roleFunction?.length > 0) {
    const cur = Array.isArray(current.roleFunction) ? current.roleFunction : []
    if (!arrEq(cur, enriched.roleFunction)) {
      update.roleFunction = enriched.roleFunction
      diffs.push(`roleFunction: ${JSON.stringify(cur)} → ${JSON.stringify(enriched.roleFunction)}`)
    }
  }

  // industrySector — overwrite if current is empty/missing OR generic 'technology' default
  if (enriched.industrySector?.length > 0) {
    const cur = Array.isArray(current.industrySector) ? current.industrySector : []
    const isGenericDefault = cur.length === 1 && cur[0] === "technology"
    const shouldOverwrite =
      cur.length === 0 ||
      isGenericDefault ||
      !arrEq(cur, enriched.industrySector)
    if (shouldOverwrite) {
      update.industrySector = enriched.industrySector
      diffs.push(`industrySector: ${JSON.stringify(cur)} → ${JSON.stringify(enriched.industrySector)}`)
    }
  }

  // relevantTags — overwrite if missing or different
  if (Array.isArray(enriched.relevantTags)) {
    const cur = Array.isArray(current.relevantTags) ? current.relevantTags : []
    if (!arrEq(cur, enriched.relevantTags)) {
      update.relevantTags = enriched.relevantTags
      diffs.push(`relevantTags: ${cur.length} → ${enriched.relevantTags.length} tags`)
    }
  }

  // skills — overwrite if missing or different
  if (Array.isArray(enriched.skills)) {
    const cur = Array.isArray(current.requiredSkills) ? current.requiredSkills : []
    const newSkillNames = enriched.skills.map((s) => s.name).sort()
    const curSkillNames = cur.map((s) => (typeof s === "string" ? s : s.name)).sort()
    if (!arrEq(curSkillNames, newSkillNames)) {
      update.requiredSkills = enriched.skills
      // requiredSkillsIndex (lowercase name array, used for fast `where` filter)
      update.requiredSkillsIndex = newSkillNames
      diffs.push(`skills: ${cur.length} → ${enriched.skills.length}`)
    }
  }

  // seniorityLevel — overwrite if different (canonical 13-stage enum)
  if (enriched.seniorityLevel && enriched.seniorityLevel !== current.seniorityLevel) {
    update.seniorityLevel = enriched.seniorityLevel
    diffs.push(`seniorityLevel: ${current.seniorityLevel} → ${enriched.seniorityLevel}`)
  }

  // jobType — overwrite if current is empty/missing/'other' default
  if (enriched.jobType) {
    const cur = current.jobType
    const isDefault = !cur || cur === "other" || cur === "unknown"
    if (isDefault || cur !== enriched.jobType) {
      update.jobType = enriched.jobType
      diffs.push(`jobType: ${cur} → ${enriched.jobType}`)
    }
  }

  // locationBuckets — overwrite if missing/empty/['united_states'] generic default
  if (Array.isArray(enriched.locationBuckets) && enriched.locationBuckets.length > 0) {
    const cur = Array.isArray(current.locationBuckets) ? current.locationBuckets : []
    const isGenericDefault = cur.length === 1 && cur[0] === "united_states"
    const shouldOverwrite = cur.length === 0 || isGenericDefault || !arrEq(cur, enriched.locationBuckets)
    if (shouldOverwrite) {
      update.locationBuckets = enriched.locationBuckets
      diffs.push(`locationBuckets: ${JSON.stringify(cur)} → ${JSON.stringify(enriched.locationBuckets)}`)
    }
  }

  // sponsorshipHint — only set if LLM was confident (not null)
  if (enriched.sponsorshipHint !== null && enriched.sponsorshipHint !== undefined) {
    if (current.sponsorship !== enriched.sponsorshipHint) {
      update.sponsorship = enriched.sponsorshipHint
      diffs.push(`sponsorship: ${current.sponsorship} → ${enriched.sponsorshipHint}`)
    }
  }

  // Audit field
  if (Object.keys(update).length > 0) {
    update.reenrichedAt = FieldValue.serverTimestamp()
    update.reenrichVersion = "p9_mass_v1"
  }

  return { update, diffs }
}

function arrEq(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  if (a.length !== b.length) return false
  const sa = [...a].sort()
  const sb = [...b].sort()
  return sa.every((v, i) => v === sb[i])
}

// ─── Concurrency runner ────────────────────────────────────────────────────────
async function runConcurrent(items, concurrency, worker) {
  const results = []
  let idx = 0
  let inflight = 0
  return new Promise((resolve) => {
    const next = () => {
      while (inflight < concurrency && idx < items.length) {
        const myIdx = idx++
        inflight++
        Promise.resolve(worker(items[myIdx], myIdx))
          .then((r) => {
            results[myIdx] = r
          })
          .catch((e) => {
            results[myIdx] = { error: e?.message ?? String(e) }
          })
          .finally(() => {
            inflight--
            if (idx >= items.length && inflight === 0) resolve(results)
            else next()
          })
      }
    }
    if (items.length === 0) return resolve(results)
    next()
  })
}

// ─── JD content composer ───────────────────────────────────────────────────────
/**
 * Build a synthesized JD from the doc's stored fields. matching-jobs stores
 * jobDescription (string) + coreResponsibilities/qualifications/benefits
 * (arrays). Concatenate them so LLM has all signal.
 */
function buildJobDescription(d) {
  const parts = []
  if (typeof d.jobDescription === "string" && d.jobDescription.trim()) {
    parts.push(d.jobDescription.trim())
  }
  if (Array.isArray(d.coreResponsibilities) && d.coreResponsibilities.length > 0) {
    parts.push(`Responsibilities:\n- ${d.coreResponsibilities.join("\n- ")}`)
  }
  if (Array.isArray(d.qualifications) && d.qualifications.length > 0) {
    parts.push(`Qualifications:\n- ${d.qualifications.join("\n- ")}`)
  }
  if (Array.isArray(d.benefits) && d.benefits.length > 0) {
    parts.push(`Benefits:\n- ${d.benefits.join("\n- ")}`)
  }
  return parts.length > 0 ? parts.join("\n\n") : null
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now()

  console.log("[mass-reenrich] config:", {
    DRY_RUN,
    LIMIT,
    RESUME_FROM,
    CONCURRENCY,
    STATUS,
  })

  // Sanity check
  if (!process.env.OPENAI_API_KEY && !process.env.PA_OPENAI_AGENT_API_KEY) {
    console.error("[mass-reenrich] FATAL: no OPENAI_API_KEY or PA_OPENAI_AGENT_API_KEY")
    process.exit(1)
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("[mass-reenrich] note: ANTHROPIC_API_KEY not set — middle tier will fall through (graceful)")
  }

  // Paginated fetch — `where status==active` + orderBy __name__ + DocumentSnapshot
  // cursor (not string ID). 500 per page. Avoids reading inactive-doc churn
  // around the cursor and still uses native default index.
  console.log("[mass-reenrich] paginated fetch (where status==active, page=500)...")
  const PAGE_SIZE = 500
  let cursorDoc = null // DocumentSnapshot, not string

  // If --resume-from provided, fetch the doc ref to use as DocumentSnapshot cursor
  if (RESUME_FROM) {
    const refSnap = await db.collection("matching-jobs").doc(RESUME_FROM).get()
    if (!refSnap.exists) {
      console.error(`[mass-reenrich] FATAL: --resume-from doc ${RESUME_FROM} not found`)
      process.exit(1)
    }
    cursorDoc = refSnap
    console.log(`[mass-reenrich] resume cursor doc loaded: ${RESUME_FROM.slice(0, 12)} status=${refSnap.data().status}`)
  }

  const allDocs = []

  while (allDocs.length < LIMIT) {
    let q = db
      .collection("matching-jobs")
      .where("status", "==", STATUS)
      .orderBy("__name__")
      .limit(PAGE_SIZE)
    if (cursorDoc) q = q.startAfter(cursorDoc)
    const pageT0 = Date.now()
    const pageSnap = await q.get()
    const ms = Date.now() - pageT0
    if (pageSnap.size === 0) break
    allDocs.push(...pageSnap.docs)
    cursorDoc = pageSnap.docs[pageSnap.docs.length - 1]
    console.log(
      `[mass-reenrich] page ${pageSnap.size} (total ${allDocs.length}/${LIMIT}) in ${ms}ms cursor=${cursorDoc.id.slice(0, 8)}`,
    )
    if (pageSnap.size < PAGE_SIZE) break // exhausted
  }

  // Trim to LIMIT
  const docs = allDocs.slice(0, LIMIT).map((d) => ({ id: d.id, ref: d.ref, data: d.data() }))
  console.log(`[mass-reenrich] total active docs to process: ${docs.length}`)

  if (docs.length === 0) {
    console.log("[mass-reenrich] nothing to do")
    process.exit(0)
  }

  // Cache by contentHash → enriched tags (avoid re-LLM duplicates)
  const cache = new Map()
  let cacheHits = 0
  let llmCalls = 0
  let llmErrors = 0
  let updatedCount = 0
  let skippedNoChange = 0
  let totalInputTokens = 0
  let totalOutputTokens = 0

  // Sample diffs (first 5 with non-empty diffs)
  const sampleDiffs = []

  // Pending Firestore writes (flush at 100 to limit work-loss on interrupt)
  let pendingWrites = []
  const FLUSH_AT = 100

  async function flushBatch() {
    if (pendingWrites.length === 0) return
    if (DRY_RUN) {
      console.log(`[mass-reenrich] DRY: would write ${pendingWrites.length} updates`)
      pendingWrites = []
      return
    }
    const batch = db.batch()
    for (const { ref, update } of pendingWrites) {
      batch.update(ref, update)
    }
    await batch.commit()
    console.log(`[mass-reenrich] committed ${pendingWrites.length} updates`)
    pendingWrites = []
  }

  // Worker function
  async function processDoc(doc, idx) {
    const x = doc.data
    // Skip if already reenriched in this run version (idempotent resume)
    if (x.reenrichVersion === "p9_mass_v1") {
      skippedNoChange++
      return { id: doc.id, alreadyReenriched: true }
    }
    const title = (x.roleTitle || x.role_title || "").trim()
    if (!title) {
      return { skipped: "no-title", id: doc.id }
    }

    const contentHash = x.contentHash || `${title}|${x.companyName || ""}`
    if (cache.has(contentHash)) {
      cacheHits++
      const cached = cache.get(contentHash)
      return processEnriched(doc, cached, true)
    }

    // Call enricher
    let enrichedResult
    try {
      enrichedResult = await enrichJobTags({
        title,
        companyName: x.companyName ?? null,
        jobDescription: buildJobDescription(x),
        locationRaw: x.locationRaw ?? null,
        sourceRepo: x.sourceRepo ?? null,
      })
      llmCalls++
      if (enrichedResult.usage) {
        totalInputTokens += enrichedResult.usage.input_tokens || 0
        totalOutputTokens += enrichedResult.usage.output_tokens || 0
      }
    } catch (e) {
      llmErrors++
      const msg = e?.message ?? String(e)
      console.warn(`[mass-reenrich] enrich failed ${doc.id} title="${title.slice(0, 50)}": ${msg.slice(0, 200)}`)
      return { error: msg, id: doc.id }
    }

    cache.set(contentHash, enrichedResult.tags)
    return processEnriched(doc, enrichedResult.tags, false)
  }

  function processEnriched(doc, enrichedTags, fromCache) {
    const { update, diffs } = composeUpdate(doc.data, enrichedTags)

    if (Object.keys(update).length === 0) {
      skippedNoChange++
      return { id: doc.id, fromCache, noChange: true }
    }

    pendingWrites.push({ ref: doc.ref, update })
    updatedCount++

    if (sampleDiffs.length < 5 && diffs.length > 0) {
      sampleDiffs.push({
        id: doc.id,
        title: doc.data.roleTitle,
        company: doc.data.companyName,
        diffs,
      })
    }

    return { id: doc.id, fromCache, diffs }
  }

  // Drive in chunks of CONCURRENCY × 50 (so we can flush periodically and log progress)
  const CHUNK = 50
  for (let start = 0; start < docs.length; start += CHUNK) {
    const chunk = docs.slice(start, start + CHUNK)
    await runConcurrent(chunk, CONCURRENCY, processDoc)

    // Flush if pending writes ≥ FLUSH_AT
    if (pendingWrites.length >= FLUSH_AT) {
      await flushBatch()
    }

    if ((start + CHUNK) % 50 === 0 || start + CHUNK >= docs.length) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
      console.log(
        `[mass-reenrich] progress ${Math.min(start + CHUNK, docs.length)}/${docs.length} ` +
          `(updated=${updatedCount} cache_hits=${cacheHits} llm=${llmCalls} err=${llmErrors} ` +
          `nochange=${skippedNoChange}) elapsed=${elapsed}s`,
      )
    }
  }

  // Final flush
  await flushBatch()

  // Cost estimate
  // gpt-5.4-nano (approx): $0.0001/1K input, $0.0004/1K output (estimate from gpt-4.1-nano tier)
  const estCostUSD =
    (totalInputTokens / 1000) * 0.0001 + (totalOutputTokens / 1000) * 0.0004
  const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1)

  console.log("\n=== SUMMARY ===")
  console.log(JSON.stringify({
    total: docs.length,
    updatedCount,
    skippedNoChange,
    cacheHits,
    llmCalls,
    llmErrors,
    totalInputTokens,
    totalOutputTokens,
    estCostUSD: estCostUSD.toFixed(4),
    elapsedSec,
    DRY_RUN,
    lastDocId: docs.length > 0 ? docs[docs.length - 1].id : null,
  }, null, 2))

  if (sampleDiffs.length > 0) {
    console.log("\n=== SAMPLE DIFFS (first 5) ===")
    for (const s of sampleDiffs) {
      console.log(`\n[${s.id}] ${s.title} @ ${s.company}`)
      for (const d of s.diffs) console.log(`  ${d}`)
    }
  }

  process.exit(0)
}

main().catch((e) => {
  console.error("[mass-reenrich] FATAL:", e)
  process.exit(1)
})
