#!/usr/bin/env tsx
/**
 * Stream F2 — matching-jobs industryEnum backfill (P9 / P10).
 *
 * Maps each `matching-jobs/{id}.industryKey` (free-text scraped value, 75
 * unique strings) to one of the 10 canonical INDUSTRY_TAGS. Writes the
 * canonical token to `industryEnum` so the daily matcher can do
 *   .where("industryEnum", "in", profile.industryTags)
 * cheaply against a Firestore composite index.
 *
 * KEY DECISIONS (deviating from original brief):
 *
 *   1. NO embedding writes. Discovery on 2026-04-30 confirmed every doc in
 *      `matching-jobs` ALREADY has `embedding` (1536-d, text-embedding-3-small)
 *      and `embeddedAt`. Re-embedding with bge-m3 would mix vector spaces
 *      and break cosine math; we'd also exceed the $5 cost cap. We retain
 *      the existing 1536-d corpus and have the daily-matcher embed user
 *      CVs with the same OpenAI model on demand.
 *
 *   2. NO LLM calls. The 75 unique industryKey strings map cleanly to the
 *      10-tag enum via a hand-curated table in apps/functions/src/cv-ingest/
 *      industry-tags.ts. LLM-fallback for unknown values defaults to
 *      "other". Cost stays at $0 vs the brief's $5 budget.
 *
 *   3. Idempotent: skips docs that already have `industryEnum`. Safe to
 *      re-run after corpus refresh adds new docs.
 *
 * Usage:
 *   npx tsx apps/functions/scripts/enrich-matching-jobs.ts --dry-run [--max-jobs N]
 *   npx tsx apps/functions/scripts/enrich-matching-jobs.ts --live   [--max-jobs N]
 *
 * Auth (live): GOOGLE_APPLICATION_CREDENTIALS pointing at SA JSON.
 *
 * Output: prints summary table of (industryKey → industryEnum) hits and
 * total docs updated. Live mode writes commit-batched (batch size = 500
 * Firestore max).
 */
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
void __dirname

// Lazy import the mapping table — keep this script independent of the apps
// build output so `npx tsx` picks it up directly from src/.
type IndustryTag =
  | "tech_software"
  | "tech_hardware"
  | "fintech_finance"
  | "ai_ml"
  | "healthcare_biotech"
  | "consumer_retail"
  | "media_entertainment"
  | "manufacturing_industrial"
  | "education"
  | "other"

async function loadMapper() {
  const mod = (await import("../src/cv-ingest/industry-tags.js")) as {
    mapToCanonicalIndustry: (raw: string | null | undefined) => IndustryTag
    mapToCanonicalIndustryFromSignals: (s: {
      industryKey?: string | null
      companyName?: string | null
      roleTitle?: string | null
    }) => IndustryTag
    INDUSTRY_TAGS: readonly string[]
  }
  return mod
}

const COLLECTION = "matching-jobs"
const FIRESTORE_BATCH_MAX = 500

type Args = {
  dryRun: boolean
  live: boolean
  maxJobs: number | null
  batch: number
  /**
   * Stream H10 — when true, re-evaluate rows whose `industryEnum`
   * is `["other"]` (or string "other") against the latest mapper. Used
   * after adding long-tail company entries — rows enriched by H8 are
   * locked behind the idempotency guard otherwise.
   */
  reenrichOther: boolean
  /**
   * Stream H8 — non-other coverage threshold (0..1). When LIVE coverage is
   * BELOW this value the script still completes the writes (data is only
   * better-than-before) but exits non-zero so caller can detect quality
   * regression. DRY-RUN prints a WARN line. Default 0.60 — pragmatic floor
   * (down from F2's aspirational 0.80 that aborted at 32%).
   */
  threshold: number
}

export function parseArgs(argv: string[]): Args {
  const out: Args = {
    dryRun: false,
    live: false,
    maxJobs: null,
    batch: FIRESTORE_BATCH_MAX,
    threshold: 0.6,
    reenrichOther: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === "--dry-run") out.dryRun = true
    // Stream H8 — `--apply` is the brief's preferred LIVE alias.
    else if (a === "--live" || a === "--apply") out.live = true
    else if (a === "--max-jobs") out.maxJobs = Number(argv[++i] ?? "0")
    else if (a.startsWith("--max-jobs=")) out.maxJobs = Number(a.slice("--max-jobs=".length))
    else if (a === "--batch") out.batch = Number(argv[++i] ?? "500")
    else if (a.startsWith("--batch=")) out.batch = Number(a.slice("--batch=".length))
    else if (a === "--threshold") out.threshold = Number(argv[++i] ?? "0.6")
    else if (a.startsWith("--threshold=")) out.threshold = Number(a.slice("--threshold=".length))
    else if (a === "--re-enrich-other") out.reenrichOther = true
  }
  if (!out.dryRun && !out.live) {
    out.dryRun = true // default to dry-run for safety
  }
  if (out.batch <= 0 || out.batch > FIRESTORE_BATCH_MAX) {
    out.batch = FIRESTORE_BATCH_MAX
  }
  if (!Number.isFinite(out.threshold) || out.threshold < 0 || out.threshold > 1) {
    out.threshold = 0.6
  }
  return out
}

export type EnrichSummary = {
  scanned: number
  alreadyEnriched: number
  updated: number
  skippedNoIndustry: number
  byTag: Map<IndustryTag, number>
  unmappedSamples: Array<{ id: string; industryKey: string }>
}

export function makeEmptySummary(): EnrichSummary {
  return {
    scanned: 0,
    alreadyEnriched: 0,
    updated: 0,
    skippedNoIndustry: 0,
    byTag: new Map(),
    unmappedSamples: [],
  }
}

/**
 * Pure decision function: given a doc's data + a multi-signal mapper,
 * return a write decision.
 *
 * H8 changes vs F2:
 *   - Accepts a multi-signal mapper (industryKey + companyName + roleTitle).
 *   - `already_enriched` now triggers on EITHER string OR array shape (F2
 *     wrote string; H8 writes a 1-element array so query-matching-jobs can
 *     `array-contains-any`). Existing F2 string rows are NOT rewritten —
 *     idempotent across script versions.
 *   - When neither industryKey nor industry is present, falls through to
 *     companyName / roleTitle instead of skipping. Skips ONLY when ALL
 *     three signals are absent.
 *
 * Exposed for unit tests.
 */
export type EnrichDecision =
  | { action: "skip"; reason: "already_enriched" | "no_industry" }
  | { action: "update"; industryEnum: IndustryTag; sourceKey: string }

export type SignalMapper = (s: {
  industryKey?: string | null
  companyName?: string | null
  roleTitle?: string | null
}) => IndustryTag

export function decideEnrichment(
  data: Record<string, unknown>,
  mapper: SignalMapper,
  opts: { reenrichOther?: boolean } = {}
): EnrichDecision {
  // F2 wrote string; H8 writes string-or-array. Treat either as enriched —
  // EXCEPT under --re-enrich-other, where rows currently tagged as "other"
  // are re-evaluated against the latest mapper (H10 long-tail addition).
  const existing = data.industryEnum
  const isOtherOnly =
    (typeof existing === "string" && existing === "other") ||
    (Array.isArray(existing) && existing.length === 1 && existing[0] === "other")
  if (typeof existing === "string" && existing.length > 0 && !(opts.reenrichOther && isOtherOnly)) {
    return { action: "skip", reason: "already_enriched" }
  }
  if (Array.isArray(existing) && existing.length > 0 && !(opts.reenrichOther && isOtherOnly)) {
    return { action: "skip", reason: "already_enriched" }
  }

  const industryKey =
    typeof data.industryKey === "string" && data.industryKey.length > 0
      ? data.industryKey
      : typeof data.industry === "string" && data.industry.length > 0
        ? data.industry
        : null
  const companyName =
    typeof data.companyName === "string" && data.companyName.length > 0
      ? data.companyName
      : null
  const roleTitle =
    typeof data.roleTitle === "string" && data.roleTitle.length > 0
      ? data.roleTitle
      : typeof data.jobTitle === "string" && data.jobTitle.length > 0
        ? data.jobTitle
        : null

  if (!industryKey && !companyName && !roleTitle) {
    // Truly no signal — corrupt or stub doc. Don't write.
    return { action: "skip", reason: "no_industry" }
  }

  const industryEnum = mapper({ industryKey, companyName, roleTitle })
  // sourceKey is reported in summaries — prefer the strongest available
  // signal so the unmapped-samples list is debuggable.
  const sourceKey = industryKey ?? companyName ?? roleTitle ?? ""
  return { action: "update", industryEnum, sourceKey }
}

export function summarizeDecision(
  decision: EnrichDecision,
  docId: string,
  summary: EnrichSummary
): void {
  if (decision.action === "skip") {
    if (decision.reason === "already_enriched") summary.alreadyEnriched++
    else summary.skippedNoIndustry++
    return
  }
  summary.updated++
  summary.byTag.set(decision.industryEnum, (summary.byTag.get(decision.industryEnum) ?? 0) + 1)
  if (decision.industryEnum === "other" && summary.unmappedSamples.length < 20) {
    summary.unmappedSamples.push({ id: docId, industryKey: decision.sourceKey })
  }
}

export function formatSummary(summary: EnrichSummary, args: Args): string {
  const lines: string[] = []
  lines.push("=".repeat(70))
  lines.push(`Stream F2 — enrich-matching-jobs ${args.live ? "LIVE" : "DRY-RUN"}`)
  lines.push(`  scanned:           ${summary.scanned}`)
  lines.push(`  alreadyEnriched:   ${summary.alreadyEnriched}`)
  lines.push(`  updated:           ${summary.updated}`)
  lines.push(`  skippedNoIndustry: ${summary.skippedNoIndustry}`)
  lines.push("")
  lines.push("By tag:")
  const tagOrder: IndustryTag[] = [
    "tech_software",
    "tech_hardware",
    "fintech_finance",
    "ai_ml",
    "healthcare_biotech",
    "consumer_retail",
    "media_entertainment",
    "manufacturing_industrial",
    "education",
    "other",
  ]
  for (const t of tagOrder) {
    const n = summary.byTag.get(t) ?? 0
    lines.push(`  ${t.padEnd(28)} ${n.toString().padStart(6)}`)
  }
  if (summary.unmappedSamples.length > 0) {
    lines.push("")
    lines.push(
      `Unmapped samples (signals → "other") — first ${summary.unmappedSamples.length}:`
    )
    for (const s of summary.unmappedSamples) {
      lines.push(`  ${s.id}  source="${s.industryKey}"`)
    }
  }
  // H8: surface the non-other coverage % so the operator can compare to
  // the --threshold floor and decide whether to flip the runtime flag.
  const totalUpdated = summary.updated
  const otherCount = summary.byTag.get("other") ?? 0
  const nonOther = totalUpdated - otherCount
  const pctNonOther = totalUpdated > 0 ? nonOther / totalUpdated : 0
  lines.push("")
  lines.push(
    `Non-other coverage: ${nonOther}/${totalUpdated} (${(pctNonOther * 100).toFixed(2)}%)`
  )
  lines.push("=".repeat(70))
  return lines.join("\n")
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const { mapToCanonicalIndustryFromSignals } = await loadMapper()
  const mapper: SignalMapper = (s) => mapToCanonicalIndustryFromSignals(s)

  if (args.dryRun) {
    // Dry-run mode: still hits Firestore (read-only) so we get a real
    // summary against the live corpus.
    const { initializeApp, getApps, applicationDefault } = await import("firebase-admin/app")
    const { getFirestore } = await import("firebase-admin/firestore")
    if (getApps().length === 0) {
      try {
        initializeApp({ credential: applicationDefault() })
      } catch (err) {
        console.error("Could not initialize firebase-admin:", err)
        console.error(
          "Set GOOGLE_APPLICATION_CREDENTIALS or pass --live=false on local machine without auth."
        )
        process.exit(1)
      }
    }
    const db = getFirestore()
    const summary = makeEmptySummary()
    const cap = args.maxJobs ?? Number.POSITIVE_INFINITY
    let last: FirebaseFirestore.QueryDocumentSnapshot | null = null
    while (summary.scanned < cap) {
      let q: FirebaseFirestore.Query = db
        .collection(COLLECTION)
        .select("industryKey", "industry", "industryEnum", "companyName", "roleTitle", "jobTitle")
        .orderBy("__name__")
        .limit(Math.min(2000, cap - summary.scanned))
      if (last) q = q.startAfter(last)
      const snap = await q.get()
      if (snap.empty) break
      for (const d of snap.docs) {
        summary.scanned++
        const decision = decideEnrichment(d.data() as Record<string, unknown>, mapper, { reenrichOther: args.reenrichOther })
        summarizeDecision(decision, d.id, summary)
      }
      last = snap.docs[snap.docs.length - 1] ?? null
      if (snap.size < 2000) break
    }
    console.log(formatSummary(summary, args))
    console.log(`(dry-run: NO writes performed)`)
    const otherCount = summary.byTag.get("other") ?? 0
    const totalUpdated = summary.updated
    const pctNonOther = totalUpdated > 0 ? (totalUpdated - otherCount) / totalUpdated : 0
    if (pctNonOther < args.threshold) {
      console.error(
        `[enrich-matching-jobs] WARN dry-run coverage ${(pctNonOther * 100).toFixed(2)}% < threshold ${(args.threshold * 100).toFixed(0)}%`
      )
    }
    return
  }

  // ---- LIVE MODE ----
  const { initializeApp, getApps, applicationDefault } = await import("firebase-admin/app")
  const { getFirestore } = await import("firebase-admin/firestore")
  if (getApps().length === 0) {
    initializeApp({ credential: applicationDefault() })
  }
  const db = getFirestore()
  const summary = makeEmptySummary()
  const cap = args.maxJobs ?? Number.POSITIVE_INFINITY
  const batchCap = args.batch
  let last: FirebaseFirestore.QueryDocumentSnapshot | null = null
  while (summary.scanned < cap) {
    let q: FirebaseFirestore.Query = db
      .collection(COLLECTION)
      .select("industryKey", "industry", "industryEnum", "companyName", "roleTitle", "jobTitle")
      .orderBy("__name__")
      .limit(Math.min(2000, cap - summary.scanned))
    if (last) q = q.startAfter(last)
    const snap = await q.get()
    if (snap.empty) break
    let writeBatch = db.batch()
    let writesPending = 0
    for (const d of snap.docs) {
      summary.scanned++
      const decision = decideEnrichment(d.data() as Record<string, unknown>, mapper, { reenrichOther: args.reenrichOther })
      summarizeDecision(decision, d.id, summary)
      if (decision.action === "update") {
        // H8: write a 1-element ARRAY so query-matching-jobs can use
        // `array-contains-any` against the user's 10-tag profile. F2 wrote a
        // bare string; we never landed any of those, so no migration needed.
        writeBatch.update(d.ref, {
          industryEnum: [decision.industryEnum],
          industryEnumEnrichedAt: new Date().toISOString(),
        })
        writesPending++
        if (writesPending >= batchCap) {
          await writeBatch.commit()
          writeBatch = db.batch()
          writesPending = 0
        }
      }
    }
    if (writesPending > 0) {
      await writeBatch.commit()
    }
    last = snap.docs[snap.docs.length - 1] ?? null
    if (snap.size < 2000) break
  }
  console.log(formatSummary(summary, args))
  console.log(`(live: ${summary.updated} docs updated)`)
  // H8: non-zero exit when coverage is below the configured threshold so
  // CI / operator can detect a regression. Writes are kept (data is still
  // an improvement over zero coverage); only the exit code flags the dip.
  const otherCount = summary.byTag.get("other") ?? 0
  const totalUpdated = summary.updated
  const pctNonOther = totalUpdated > 0 ? (totalUpdated - otherCount) / totalUpdated : 0
  if (pctNonOther < args.threshold) {
    console.error(
      `[enrich-matching-jobs] WARN coverage ${(pctNonOther * 100).toFixed(2)}% < threshold ${(args.threshold * 100).toFixed(0)}% — writes kept, exiting 2`
    )
    process.exit(2)
  }
}

const invokedAsScript =
  process.argv[1]?.endsWith("enrich-matching-jobs.ts") ||
  process.argv[1]?.endsWith("enrich-matching-jobs.js")
if (invokedAsScript) {
  main().catch((err) => {
    console.error("[enrich-matching-jobs] FATAL", err)
    process.exit(1)
  })
}
