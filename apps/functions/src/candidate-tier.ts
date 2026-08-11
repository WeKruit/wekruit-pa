/**
 * Global candidate TIER writer — the single point that stamps a candidate's
 * durable, role-independent tier on `pa-users.globalCandidateTier` (best-wins)
 * and appends a per-role record to `pa-candidate-tier-events`. Called by BOTH
 * the prescreen rejection flow and the recruiter-submission rejection flow so
 * the two share one tier (Adam 2026-06-16).
 *
 * Best-wins: any single tier_1 rejection makes the candidate globally tier_1 so
 * a strong-but-wrong-role person is surfaced for re-review on new roles. The
 * per-role record keeps the rejection's own tier + the AI suggestion.
 *
 * A genuine human override of the AI suggestion also writes a `pa-correction-
 * events` row (HITL → flywheel, per CLAUDE.md).
 *
 * Pure `applyGlobalCandidateTier(input, deps)` (deps-injected, testable without
 * firebase-admin). NOT a Cloud Function itself — the rejection CFs call it.
 */
import type { Firestore } from "firebase-admin/firestore"
import {
  PA_COLLECTIONS,
  isReusableTier,
  reconcileGlobalTier,
  bestTier,
  type CandidateTier,
  type CandidateTierSource,
  type GlobalCandidateTier,
} from "@pa/core-types"

export interface ApplyGlobalCandidateTierInput {
  candidateId: string
  /** The committed tier for THIS rejection. */
  tier: CandidateTier
  source: CandidateTierSource
  jobId?: string
  reason?: string
  /** The AI's suggested tier (for the override audit + ledger). */
  aiSuggestedTier?: CandidateTier | null
  /** True when a human confirmed/overrode; false when AI-only. */
  humanConfirmed?: boolean
  /** Actor identity for audit (operator email / uid / "system"). */
  actor?: string
}

export interface ApplyGlobalCandidateTierDeps {
  db: Firestore
  now?: () => string
  log?: (...args: unknown[]) => void
}

export interface ApplyGlobalCandidateTierResult {
  /** The candidate's global tier after reconciliation (best-wins). */
  globalTier: CandidateTier
  /** True if the global tier value changed from what was stored. */
  globalChanged: boolean
  /** True if a human override correction event was written. */
  wroteCorrection: boolean
}

function readGlobalTier(data: Record<string, unknown> | undefined): GlobalCandidateTier | undefined {
  const raw = data?.globalCandidateTier
  if (raw && typeof raw === "object") return raw as GlobalCandidateTier
  return undefined
}

export async function applyGlobalCandidateTier(
  input: ApplyGlobalCandidateTierInput,
  deps: ApplyGlobalCandidateTierDeps,
): Promise<ApplyGlobalCandidateTierResult> {
  const now = deps.now ? deps.now() : new Date().toISOString()
  const userRef = deps.db.collection(PA_COLLECTIONS.users).doc(input.candidateId)
  const snap = await userRef.get()
  const existing = readGlobalTier(snap.exists ? (snap.data() as Record<string, unknown>) : undefined)

  const globalTier = reconcileGlobalTier(existing?.tier, input.tier)
  const globalChanged = existing?.tier !== globalTier
  // Source follows the BEST tier: keep the existing source unless the incoming
  // tier wins (became the global tier and differs from the prior tier).
  const source: CandidateTierSource =
    !existing || globalTier === input.tier ? input.source : existing.source

  const globalRecord: GlobalCandidateTier = {
    tier: globalTier,
    source,
    reusable: isReusableTier(globalTier),
    updatedAt: now,
    // An operator marking someone "strong, keep them" is NOT a rejection. Counting it as one made
    // the browse row read "1 rejection" for a candidate nobody had ever rejected.
    rejectionCount: (existing?.rejectionCount ?? 0) + (input.source === "admin" ? 0 : 1),
    ...(input.jobId ? { lastJobId: input.jobId } : {}),
    ...(input.reason ? { lastReason: input.reason.slice(0, 500) } : {}),
    humanConfirmed: Boolean(input.humanConfirmed) || Boolean(existing?.humanConfirmed),
  }

  await userRef.set({ globalCandidateTier: globalRecord }, { merge: true })

  // Per-role ledger row (one per rejection) — the browse drawer reads these.
  await deps.db.collection(PA_COLLECTIONS.candidateTierEvents).add({
    candidateId: input.candidateId,
    tier: input.tier,
    source: input.source,
    ...(input.jobId ? { jobId: input.jobId } : {}),
    ...(input.reason ? { reason: input.reason.slice(0, 1000) } : {}),
    ...(input.aiSuggestedTier ? { aiSuggestedTier: input.aiSuggestedTier } : {}),
    humanConfirmed: Boolean(input.humanConfirmed),
    actor: input.actor ?? (input.humanConfirmed ? "operator" : "system"),
    globalTierAfter: globalTier,
    createdAt: now,
  })

  // Genuine human override of the AI suggestion → HITL correction (flywheel).
  let wroteCorrection = false
  if (
    input.humanConfirmed &&
    input.aiSuggestedTier &&
    input.aiSuggestedTier !== input.tier
  ) {
    await deps.db.collection(PA_COLLECTIONS.correctionEvents).add({
      eventId: `tier_override_${input.candidateId}_${now}`,
      targetType: "candidate_profile",
      targetId: input.candidateId,
      actor: "operator",
      candidateId: input.candidateId,
      ...(input.jobId ? { jobId: input.jobId } : {}),
      reason: `Tier override: AI suggested ${input.aiSuggestedTier}, operator set ${input.tier}`,
      beforeRedacted: { tier: input.aiSuggestedTier },
      afterRedacted: { tier: input.tier },
      evidence: [],
      createdAt: now,
    })
    wroteCorrection = true
  }

  deps.log?.("pa.candidate_tier.applied", {
    candidateId: input.candidateId,
    incoming: input.tier,
    globalTier,
    globalChanged,
    source,
  })

  return { globalTier, globalChanged, wroteCorrection }
}

// ---------------------------------------------------------------------------
// Re-evaluate "for new roles" — recompute the AI-suggested global tier from the
// candidate's existing per-role tier evidence (the AI verdicts already produced
// at each rejection). Best-of across everything we know about the candidate.
// ---------------------------------------------------------------------------

export interface ReevaluateCandidateTierResult {
  candidateId: string
  currentGlobalTier: CandidateTier | null
  /** AI-derived suggestion = best across all known per-role tiers + AI suggestions. */
  suggestedTier: CandidateTier | null
  eventsConsidered: number
  basis: Array<{ tier: CandidateTier; aiSuggestedTier?: CandidateTier; jobId?: string; source?: string; createdAt?: string }>
}

export async function reevaluateCandidateTier(
  candidateId: string,
  deps: { db: Firestore },
): Promise<ReevaluateCandidateTierResult> {
  const userSnap = await deps.db.collection(PA_COLLECTIONS.users).doc(candidateId).get()
  const current = readGlobalTier(userSnap.exists ? (userSnap.data() as Record<string, unknown>) : undefined)

  const evSnap = await deps.db
    .collection(PA_COLLECTIONS.candidateTierEvents)
    .where("candidateId", "==", candidateId)
    .limit(200)
    .get()

  const basis: ReevaluateCandidateTierResult["basis"] = []
  let suggested: CandidateTier | null = null
  for (const doc of evSnap.docs) {
    const d = doc.data() as Record<string, unknown>
    const tier = d.tier as CandidateTier | undefined
    if (!tier) continue
    const aiSuggestedTier = d.aiSuggestedTier as CandidateTier | undefined
    // Best-of the committed tier and the AI suggestion for that rejection.
    const eventBest = aiSuggestedTier ? bestTier(tier, aiSuggestedTier) : tier
    suggested = suggested ? bestTier(suggested, eventBest) : eventBest
    basis.push({
      tier,
      ...(aiSuggestedTier ? { aiSuggestedTier } : {}),
      ...(typeof d.jobId === "string" ? { jobId: d.jobId } : {}),
      ...(typeof d.source === "string" ? { source: d.source } : {}),
      ...(typeof d.createdAt === "string" ? { createdAt: d.createdAt } : {}),
    })
  }

  return {
    candidateId,
    currentGlobalTier: current?.tier ?? null,
    suggestedTier: suggested,
    eventsConsidered: evSnap.size,
    basis,
  }
}

/**
 * Operator/re-eval direct set of the global tier (human authority OVERRIDES
 * best-wins). Does NOT bump rejectionCount or add a rejection ledger row; writes
 * a correction event when the value changes.
 */
export async function setGlobalCandidateTierManual(
  input: { candidateId: string; tier: CandidateTier; actor: string; reason?: string },
  deps: ApplyGlobalCandidateTierDeps,
): Promise<{ changed: boolean }> {
  const now = deps.now ? deps.now() : new Date().toISOString()
  const userRef = deps.db.collection(PA_COLLECTIONS.users).doc(input.candidateId)
  const snap = await userRef.get()
  const existing = readGlobalTier(snap.exists ? (snap.data() as Record<string, unknown>) : undefined)
  const changed = existing?.tier !== input.tier

  const record: GlobalCandidateTier = {
    tier: input.tier,
    source: existing?.source ?? "recruiter",
    reusable: isReusableTier(input.tier),
    updatedAt: now,
    rejectionCount: existing?.rejectionCount ?? 0,
    ...(existing?.lastJobId ? { lastJobId: existing.lastJobId } : {}),
    ...(input.reason ? { lastReason: input.reason.slice(0, 500) } : existing?.lastReason ? { lastReason: existing.lastReason } : {}),
    humanConfirmed: true,
  }
  await userRef.set({ globalCandidateTier: record }, { merge: true })

  if (changed) {
    await deps.db.collection(PA_COLLECTIONS.correctionEvents).add({
      eventId: `tier_reeval_${input.candidateId}_${now}`,
      targetType: "candidate_profile",
      targetId: input.candidateId,
      actor: "operator",
      candidateId: input.candidateId,
      reason: input.reason ?? `Re-evaluated global tier → ${input.tier}`,
      beforeRedacted: { tier: existing?.tier ?? null },
      afterRedacted: { tier: input.tier },
      evidence: [],
      createdAt: now,
    })
  }
  return { changed }
}
