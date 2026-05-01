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
}

export function parseArgs(argv: string[]): Args {
  const out: Args = {
    dryRun: false,
    live: false,
    maxJobs: null,
    batch: FIRESTORE_BATCH_MAX,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === "--dry-run") out.dryRun = true
    else if (a === "--live") out.live = true
    else if (a === "--max-jobs") out.maxJobs = Number(argv[++i] ?? "0")
    else if (a.startsWith("--max-jobs=")) out.maxJobs = Number(a.slice("--max-jobs=".length))
    else if (a === "--batch") out.batch = Number(argv[++i] ?? "500")
    else if (a.startsWith("--batch=")) out.batch = Number(a.slice("--batch=".length))
  }
  if (!out.dryRun && !out.live) {
    out.dryRun = true // default to dry-run for safety
  }
  if (out.batch <= 0 || out.batch > FIRESTORE_BATCH_MAX) {
    out.batch = FIRESTORE_BATCH_MAX
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
 * Pure decision function: given a doc's data + the mapper, return a write
 * decision. Exposed for unit tests.
 */
export type EnrichDecision =
  | { action: "skip"; reason: "already_enriched" | "no_industry" }
  | { action: "update"; industryEnum: IndustryTag; sourceKey: string }

export function decideEnrichment(
  data: Record<string, unknown>,
  mapper: (raw: string | null | undefined) => IndustryTag
): EnrichDecision {
  if (typeof data.industryEnum === "string") {
    return { action: "skip", reason: "already_enriched" }
  }
  const sourceKey =
    typeof data.industryKey === "string" && data.industryKey.length > 0
      ? data.industryKey
      : typeof data.industry === "string" && data.industry.length > 0
        ? data.industry
        : ""
  if (!sourceKey) {
    // Safest behavior: still tag as "other" so downstream queries can match.
    // BUT: skip writes when the doc has nothing to map at all — these rows
    // are typically corrupted; tag them on next refresh instead.
    return { action: "skip", reason: "no_industry" }
  }
  const industryEnum = mapper(sourceKey)
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
      `Unmapped samples (industryKey → "other") — first ${summary.unmappedSamples.length}:`
    )
    for (const s of summary.unmappedSamples) {
      lines.push(`  ${s.id}  industryKey="${s.industryKey}"`)
    }
  }
  lines.push("=".repeat(70))
  return lines.join("\n")
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const { mapToCanonicalIndustry } = await loadMapper()

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
        .select("industryKey", "industry", "industryEnum")
        .orderBy("__name__")
        .limit(Math.min(2000, cap - summary.scanned))
      if (last) q = q.startAfter(last)
      const snap = await q.get()
      if (snap.empty) break
      for (const d of snap.docs) {
        summary.scanned++
        const decision = decideEnrichment(d.data() as Record<string, unknown>, mapToCanonicalIndustry)
        summarizeDecision(decision, d.id, summary)
      }
      last = snap.docs[snap.docs.length - 1] ?? null
      if (snap.size < 2000) break
    }
    console.log(formatSummary(summary, args))
    console.log(`(dry-run: NO writes performed)`)
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
      .select("industryKey", "industry", "industryEnum")
      .orderBy("__name__")
      .limit(Math.min(2000, cap - summary.scanned))
    if (last) q = q.startAfter(last)
    const snap = await q.get()
    if (snap.empty) break
    let writeBatch = db.batch()
    let writesPending = 0
    for (const d of snap.docs) {
      summary.scanned++
      const decision = decideEnrichment(d.data() as Record<string, unknown>, mapToCanonicalIndustry)
      summarizeDecision(decision, d.id, summary)
      if (decision.action === "update") {
        writeBatch.update(d.ref, {
          industryEnum: decision.industryEnum,
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
