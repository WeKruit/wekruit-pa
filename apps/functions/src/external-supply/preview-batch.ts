/**
 * v2.0 External Supply V2 — Wave B / Block C — `paExternalSupplyPreviewBatch`
 *
 * Read-only "dry run" that powers the drag-drop preview pane on
 * `/admin/external-supply/batches/new`. The operator drops a file; this
 * callable runs:
 *
 *   adapter detect  →  normalize  →  identity resolve (row-by-row)
 *                  →  legacy-tag forecast  →  optional deterministic
 *                  →  tier forecast (D-rubric)
 *
 * and returns the same counters the post-commit `runCreateBatch` /
 * `runResolveBatchIdentity` / `runEvaluation` paths would have produced —
 * without any Firestore writes.
 *
 * Dry-mode contract (L-C1):
 *   - The preview is read-only **by call-site avoidance**: no helper called
 *     inside `runPreviewBatch` performs a Firestore write. We did NOT
 *     plumb a `dryRun` flag through `mergeUserTags` /
 *     `dualWriteLegacyUserTagsFromExternal` / `runResolveBatchIdentity`.
 *     Instead the preview uses the pure `forecastTagWrites` helper,
 *     the pure `resolveExternalSupplyIdentity` resolver only with a
 *     read-only handles index, the pure `composeEvaluation`, and pure
 *     `coerceCandidateProfile` / `loadJobContext` / `loadCompanyContext`
 *     readers.
 *   - Tests prove zero writes by wrapping the Firestore fake in a
 *     `recordingDb` proxy that throws on any `.set/.update/.add/.delete/
 *     .create` or `batch().*` mutation.
 *
 * Lead resolutions (encoded here):
 *   - L-C2: cap `tagEnrichmentForecast.perCandidatePreview[]` at 25 rows
 *     using hashed `candidateKey` only — never raw PII.
 *   - L-C3: Zod hard cap on `base64Bytes.length <= 7_000_000`. Warn at 3 MB.
 *   - L-C4: `.xlsx` MIME / magic → emit `xlsx_not_yet_supported` warning.
 *     If a `columnMapping` is provided we still attempt `manual_csv`;
 *     otherwise `rowCount: 0` with the warning.
 *   - L-C5: `tierForecast` keys verbatim match `EvaluationTierSchema`
 *     enum values (`tier_3_general_email`, NOT the display alias).
 *   - L-C6: Auth gate = `requireExternalSupplyAdmin(req.auth)`.
 *   - L-C7: Wiring into `apps/functions/src/index.ts` is deferred to the
 *     lead merge-integration commit to avoid Wave-D / Wave-F conflicts.
 *
 * Adapter override:
 *   - `overrideSource` short-circuits detection. If absent we run
 *     `detectAdapter` and pick the highest-confidence candidate above the
 *     0.6 lock threshold; everything else falls back to `manual_csv`.
 */

import { createHash } from "node:crypto"
import { z } from "zod"
import { onCall, HttpsError } from "firebase-functions/v2/https"
import { logger } from "firebase-functions/v2"
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import {
  ExternalSourceSchema,
  EvaluationTierSchema,
  type EvaluationTier,
  type ExternalCandidateRecord,
  type ExternalSource,
} from "@pa/core-types"
import {
  composeEvaluation,
  dedupeWithinBatch,
  detectAdapter,
  type AdapterDetection,
  type CompanyContext,
  type JobContext,
} from "@pa/external-supply"
import { resolveExternalSupplyIdentity } from "@pa/pa-persistence"
import { requireExternalSupplyAdmin } from "./resolve-identity.js"
import { getRegistrySignatures } from "./adapters/registry.js"
import { dispatchAdapter, type AdapterResult } from "./import.js"
import { forecastTagWrites } from "./legacy-user-tags-bridge.js"
import { loadCompanyContext, loadJobContext, coerceCandidateProfile } from "./evaluate.js"
import type { ManualCsvColumnMapping } from "./adapters/manual-csv.js"

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

const MAX_BASE64_BYTES = 7_000_000 // ~5 MB raw — see L-C3
const BASE64_WARN_THRESHOLD = 3_000_000
const ROW_COUNT_WARN_THRESHOLD = 1000
const PER_CANDIDATE_PREVIEW_CAP = 25 // L-C2

// ---------------------------------------------------------------------------
// Payload + response schemas
// ---------------------------------------------------------------------------

const PreviewBatchInputSchema = z.object({
  filename: z.string().min(1),
  mime: z.string().min(1),
  base64Bytes: z
    .string()
    .min(1)
    .refine((s) => s.length <= MAX_BASE64_BYTES, {
      message: `base64Bytes_too_large_max_${MAX_BASE64_BYTES}`,
    }),
  overrideSource: ExternalSourceSchema.optional(),
  forecastEvaluationFor: z
    .object({
      companyId: z.string().min(1),
      jobId: z.string().min(1),
    })
    .optional(),
  columnMapping: z
    .object({
      linkedinUrl: z.string().optional(),
      email: z.string().optional(),
      phone: z.string().optional(),
      name: z.string().optional(),
      currentTitle: z.string().optional(),
      currentCompany: z.string().optional(),
      location: z.string().optional(),
      skills: z.string().optional(),
    })
    .optional(),
})

export type PreviewBatchInput = z.infer<typeof PreviewBatchInputSchema>

const TierForecastSchema = z.object({
  tier_1_personal_linkedin_and_email: z.number().int().nonnegative(),
  tier_2_personal_email: z.number().int().nonnegative(),
  tier_3_general_email: z.number().int().nonnegative(),
  retain_only: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
})

const PreviewBatchResponseSchema = z.object({
  detection: z.array(z.unknown()), // serialized AdapterDetection (top-level array of candidate ranks)
  chosenSource: ExternalSourceSchema,
  rowCount: z.number().int().nonnegative(),
  validLinkedInCount: z.number().int().nonnegative(),
  validEmailCount: z.number().int().nonnegative(),
  withinBatchDuplicates: z.number().int().nonnegative(),
  identityForecast: z.object({
    createNew: z.number().int().nonnegative(),
    mergeExisting: z.number().int().nonnegative(),
    needsReview: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    perReviewReason: z.record(z.string(), z.number().int().nonnegative()),
  }),
  tagEnrichmentForecast: z.object({
    perFieldFillCount: z.record(z.string(), z.number().int().nonnegative()),
    perFieldPreservedCount: z.record(z.string(), z.number().int().nonnegative()),
    perCandidatePreview: z.array(
      z.object({
        candidateKey: z.string(),
        willFill: z.array(z.string()),
        willPreserve: z.array(z.string()),
      }),
    ),
  }),
  tierForecast: TierForecastSchema.optional(),
  warnings: z.array(z.string()),
})

export type PreviewBatchResult = z.infer<typeof PreviewBatchResponseSchema>

// ---------------------------------------------------------------------------
// Deps + handler
// ---------------------------------------------------------------------------

export interface PreviewBatchDeps {
  db: Firestore
  /** Inject for deterministic tests; defaults to `Date.now()` ISO. */
  now?: () => string
  /**
   * Adapter dispatch — defaults to {@link dispatchAdapter} from `import.ts`.
   * Tests pass an injected version to assert call-site stability or to
   * simulate a failing adapter.
   */
  dispatchAdapter?: (
    source: ExternalSource,
    raw: Buffer,
    columnMapping: ManualCsvColumnMapping | undefined,
  ) => AdapterResult
}

type CallableAuth = Parameters<typeof requireExternalSupplyAdmin>[0]

const ZERO_TIER_BREAKDOWN: Record<EvaluationTier, number> = {
  tier_1_personal_linkedin_and_email: 0,
  tier_2_personal_email: 0,
  tier_3_general_email: 0,
  retain_only: 0,
  blocked: 0,
}

/**
 * Pure-ish handler — deps-injectable for unit tests. The only "impure" work
 * is `db.collection(...).doc(...).get()` reads. We never call `.set` /
 * `.update` / `.add` / `.delete` / `.batch()` / `.runTransaction()`.
 */
export async function runPreviewBatch(
  rawInput: unknown,
  auth: CallableAuth | undefined,
  deps: PreviewBatchDeps,
): Promise<PreviewBatchResult> {
  // 1. Auth gate.
  requireExternalSupplyAdmin(auth)

  // 2. Validate payload.
  const parsed = PreviewBatchInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new HttpsError("invalid-argument", parsed.error.message)
  }
  const input = parsed.data

  const warnings: string[] = []
  if (input.base64Bytes.length > BASE64_WARN_THRESHOLD) {
    warnings.push("base64_size_warning_over_3mb")
  }

  // 3. Decode bytes.
  let raw: Buffer
  try {
    raw = Buffer.from(input.base64Bytes, "base64")
  } catch {
    throw new HttpsError("invalid-argument", "base64_decode_failed")
  }

  // 4. Detect adapter (always — even with override — so the UI can show
  //    "I picked X, you forced Y" alongside the full ranking).
  const detection: AdapterDetection = detectAdapter({
    rawBytes: raw,
    filename: input.filename,
    mime: input.mime,
    registry: getRegistrySignatures(),
  })
  warnings.push(...detection.warnings)

  // 5. Choose source: explicit override > detection.top.source (when
  //    confidence above lock threshold) > manual_csv fallback.
  const chosenSource: ExternalSource = pickChosenSource(input.overrideSource, detection)

  // 6. xlsx fallback: if shape is xlsx and operator did not provide a
  //    columnMapping (and chose / was routed to a CSV/JSON adapter), we
  //    can't parse. Return empty preview with the warning.
  const isXlsxNoMapping =
    detection.shapeHint === "xlsx" && !input.columnMapping
  if (isXlsxNoMapping) {
    return makeEmptyPreview({
      detection,
      chosenSource: "manual_csv",
      warnings,
    })
  }

  // 7. Adapter dispatch — drafts.
  const dispatch = deps.dispatchAdapter ?? dispatchAdapter
  let drafts: AdapterResult["drafts"]
  try {
    drafts = dispatch(chosenSource, raw, input.columnMapping).drafts
  } catch (err) {
    // Specific manual_csv-without-mapping error or other adapter parse
    // failure — surface a deterministic preview with an empty count + the
    // error string in `warnings` so the UI can show the operator.
    warnings.push(
      `adapter_dispatch_failed:${err instanceof Error ? err.message : String(err)}`,
    )
    return makeEmptyPreview({
      detection,
      chosenSource,
      warnings,
    })
  }

  // 8. Dedupe within batch (same logic as runCreateBatch — counter parity).
  const dedupe = dedupeWithinBatch(drafts)
  const rowCount = drafts.length

  if (rowCount > ROW_COUNT_WARN_THRESHOLD) {
    warnings.push("row_count_warning_over_1000")
  }

  const validLinkedInCount = dedupe.kept.filter((r) => Boolean(r.canonicalLinkedInUrl)).length
  const validEmailCount = dedupe.kept.filter((r) => r.emails.length > 0).length

  // 9. Promote drafts to full ExternalCandidateRecord shape — identity
  //    resolver wants `recordId` / `batchId` / `createdAt` set. These
  //    values are ephemeral (never persisted by preview).
  const createdAt = (deps.now ?? (() => new Date().toISOString()))()
  const batchId = `preview-${createdAt}`
  const records: ExternalCandidateRecord[] = dedupe.kept.map((draft, idx) => ({
    recordId: `preview-rec-${idx + 1}`,
    batchId,
    createdAt,
    ...draft,
  }))

  // 10. Identity forecast — call read-only resolver per row.
  const identityForecast = {
    createNew: 0,
    mergeExisting: 0,
    needsReview: 0,
    blocked: 0,
    perReviewReason: {} as Record<string, number>,
  }
  const candidateIdsForTier = new Map<string, string>() // recordIndex → candidateId
  const recordReviewReasons: Array<string[] | null> = []

  for (let i = 0; i < records.length; i += 1) {
    const rec = records[i]!
    const resolution = await resolveExternalSupplyIdentity(deps.db, rec, {
      now: () => createdAt,
    })
    switch (resolution.status) {
      case "create_new":
        identityForecast.createNew += 1
        recordReviewReasons.push(null)
        break
      case "merge_existing":
        identityForecast.mergeExisting += 1
        if (resolution.candidateId) {
          candidateIdsForTier.set(rec.recordId, resolution.candidateId)
        }
        recordReviewReasons.push(null)
        break
      case "needs_review":
        identityForecast.needsReview += 1
        for (const reason of resolution.reviewReasons) {
          identityForecast.perReviewReason[reason] =
            (identityForecast.perReviewReason[reason] ?? 0) + 1
        }
        recordReviewReasons.push(resolution.reviewReasons)
        break
      case "blocked":
        identityForecast.blocked += 1
        recordReviewReasons.push(null)
        break
    }
  }

  // 11. Tag enrichment forecast — for every record where identity resolves
  //     to a candidate (merge_existing), read that candidate's existing
  //     tags and compute the weak-fill delta. For create_new records there
  //     is no existing doc; we forecast against an empty tags object.
  const perFieldFillCount: Record<string, number> = {}
  const perFieldPreservedCount: Record<string, number> = {}
  const perCandidatePreview: PreviewBatchResult["tagEnrichmentForecast"]["perCandidatePreview"] = []

  for (let i = 0; i < records.length; i += 1) {
    const rec = records[i]!
    const candidateId = candidateIdsForTier.get(rec.recordId) ?? null
    let existing: Record<string, unknown> = {}
    if (candidateId) {
      const snap = await deps.db.collection("pa-users").doc(candidateId).get()
      if (snap.exists) {
        existing = ((snap.data() as Record<string, unknown>)?.tags ?? {}) as Record<string, unknown>
      }
    }
    const forecast = forecastTagWrites(existing, rec)
    for (const k of forecast.willFill) {
      perFieldFillCount[k] = (perFieldFillCount[k] ?? 0) + 1
    }
    for (const k of forecast.willPreserve) {
      perFieldPreservedCount[k] = (perFieldPreservedCount[k] ?? 0) + 1
    }
    if (perCandidatePreview.length < PER_CANDIDATE_PREVIEW_CAP) {
      perCandidatePreview.push({
        candidateKey: hashCandidateKey(rec, candidateId),
        willFill: forecast.willFill,
        willPreserve: forecast.willPreserve,
      })
    }
  }

  // 12. Optional tier forecast (only when companyId + jobId supplied).
  let tierForecast: Record<EvaluationTier, number> | undefined
  if (input.forecastEvaluationFor) {
    const tierBreakdown: Record<EvaluationTier, number> = { ...ZERO_TIER_BREAKDOWN }
    const job: JobContext = await loadJobContext(deps.db, input.forecastEvaluationFor.jobId)
    const company: CompanyContext = await loadCompanyContext(
      deps.db,
      input.forecastEvaluationFor.companyId,
    )
    for (let i = 0; i < records.length; i += 1) {
      const rec = records[i]!
      const candidateId = candidateIdsForTier.get(rec.recordId)
      // For records that would result in create_new, we don't have a
      // pa-users doc yet — synthesize a minimal "prospect" profile from
      // the record itself so the rubric can still score.
      const profile = candidateId
        ? await loadOptionalProfileForPreview(deps.db, candidateId)
        : coerceCandidateProfile(`preview-prospect-${i + 1}`, {})
      if (!profile) {
        tierBreakdown.blocked += 1
        continue
      }
      try {
        const draft = composeEvaluation(
          { profile, record: rec, company, job },
          { nowIso: createdAt },
        )
        tierBreakdown[draft.proposedTier] += 1
      } catch (err) {
        logger.warn("external_supply.preview.tier_forecast_failed", {
          recordId: rec.recordId,
          err: err instanceof Error ? err.message : String(err),
        })
        tierBreakdown.blocked += 1
      }
    }
    tierForecast = tierBreakdown
  }

  const response: PreviewBatchResult = {
    detection: serializeDetection(detection),
    chosenSource,
    rowCount,
    validLinkedInCount,
    validEmailCount,
    withinBatchDuplicates: dedupe.duplicateCount,
    identityForecast,
    tagEnrichmentForecast: {
      perFieldFillCount,
      perFieldPreservedCount,
      perCandidatePreview,
    },
    ...(tierForecast ? { tierForecast } : {}),
    warnings,
  }

  // Validate before returning — defence-in-depth against drift.
  return PreviewBatchResponseSchema.parse(response)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LOCK_CONFIDENCE_THRESHOLD = 0.6

function pickChosenSource(
  override: ExternalSource | undefined,
  detection: AdapterDetection,
): ExternalSource {
  if (override) return override
  const topSource = detection.top.source
  const topConfidence = detection.top.confidence
  if (topConfidence >= LOCK_CONFIDENCE_THRESHOLD && isKnownSource(topSource)) {
    return topSource
  }
  return "manual_csv"
}

function isKnownSource(s: string): s is ExternalSource {
  return ExternalSourceSchema.safeParse(s).success
}

function serializeDetection(detection: AdapterDetection): PreviewBatchResult["detection"] {
  // Return the full ranked candidate list so the dashboard can render
  // "we considered juicebox=0.85, coresignal=0.30, ..." chips.
  return detection.candidates.map((c) => ({
    source: c.source,
    confidence: c.confidence,
    requiredMatched: c.requiredMatched,
    requiredCount: c.requiredCount,
    bonusMatched: c.bonusMatched,
    reasons: c.reasons,
  }))
}

function makeEmptyPreview(args: {
  detection: AdapterDetection
  chosenSource: ExternalSource
  warnings: string[]
}): PreviewBatchResult {
  return {
    detection: serializeDetection(args.detection),
    chosenSource: args.chosenSource,
    rowCount: 0,
    validLinkedInCount: 0,
    validEmailCount: 0,
    withinBatchDuplicates: 0,
    identityForecast: {
      createNew: 0,
      mergeExisting: 0,
      needsReview: 0,
      blocked: 0,
      perReviewReason: {},
    },
    tagEnrichmentForecast: {
      perFieldFillCount: {},
      perFieldPreservedCount: {},
      perCandidatePreview: [],
    },
    warnings: args.warnings,
  }
}

/**
 * Hash a stable per-record key for the perCandidatePreview rows. Uses the
 * candidate's LinkedIn / first email hash when available; otherwise hashes
 * the recordId. NEVER includes raw PII — `candidateKey` is opaque.
 */
function hashCandidateKey(
  record: ExternalCandidateRecord,
  resolvedCandidateId: string | null,
): string {
  if (resolvedCandidateId) {
    // Hash so the wire payload is still opaque even if the candidateId is
    // an internal handle. Truncate to 16 chars for UI compactness.
    return createHash("sha256").update(`cand:${resolvedCandidateId}`).digest("hex").slice(0, 16)
  }
  const material =
    record.linkedinProfileHash ??
    (record.emails[0]?.hash ?? null) ??
    record.recordId
  return createHash("sha256").update(`rec:${material}`).digest("hex").slice(0, 16)
}

async function loadOptionalProfileForPreview(
  db: Firestore,
  candidateId: string,
): Promise<ReturnType<typeof coerceCandidateProfile> | null> {
  const snap = await db.collection("pa-users").doc(candidateId).get()
  if (!snap.exists) return null
  const data = snap.data() as Record<string, unknown> | undefined
  if (!data) return null
  return coerceCandidateProfile(candidateId, data)
}

// ---------------------------------------------------------------------------
// Production CF wrapper
// ---------------------------------------------------------------------------

/**
 * Operator-only Cloud Function. Wired into `apps/functions/src/index.ts` by
 * the lead's merge-integration commit (deferred per L-C7 to avoid Wave-D /
 * Wave-F conflicts).
 */
export const paExternalSupplyPreviewBatch = onCall(
  {
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 60,
  },
  async (req): Promise<PreviewBatchResult> => {
    return runPreviewBatch(req.data, req.auth, { db: getFirestore() })
  },
)
