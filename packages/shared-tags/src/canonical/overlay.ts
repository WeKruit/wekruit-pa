/**
 * Phase 52 — Firestore overlay schema + resolver. [TAG-11]
 *
 * Industry vocab is **add-able by admin** without code change (D16).
 * Sandbox `proposedTags` (open) → review → admin promote-to-canonical.
 * Stored in Firestore overlay collection `pa-canonical-tags`.
 *
 * Doc shape:
 *   { vocab, token, status, proposedBy, proposedAt, evidence,
 *     promotedAt, promotedBy, count }
 *
 * Resolver merges static enum (compile-time) + promoted overlay tokens
 * (runtime). Used by mergeUserTags + JD enrichment + match query consumers.
 *
 * No `firebase-admin` import here — caller passes `db` parameter (compatible
 * with `firebase-admin` Firestore but not coupled to it for testability).
 */

import { z } from "zod"

// ─── Schema ──────────────────────────────────────────────────────

export const OverlayStatusSchema = z.enum([
  "sandbox",
  "promoted",
  "rejected",
])
export type OverlayStatus = z.infer<typeof OverlayStatusSchema>

export const OverlayEvidenceSchema = z.object({
  rawText: z.string().min(1).max(500),
  source: z.string().min(1).max(200),
  sourceDocId: z.string().min(1).max(200),
})
export type OverlayEvidence = z.infer<typeof OverlayEvidenceSchema>

export const CanonicalTagOverlaySchema = z.object({
  /** Vocab name (e.g., `"industry-sector"`). */
  vocab: z.string().min(1).max(100),
  /** Token (e.g., `"developer_tools"`). */
  token: z.string().regex(/^[a-z][a-z0-9_]*$/, "lowercase + underscore"),
  status: OverlayStatusSchema,
  proposedBy: z.string().min(1).max(200),
  proposedAt: z.string(),
  evidence: z.array(OverlayEvidenceSchema).default([]),
  promotedAt: z.string().nullable().default(null),
  promotedBy: z.string().nullable().default(null),
  /** Count of times this token was proposed across the corpus. */
  count: z.number().int().nonnegative().default(1),
})
export type CanonicalTagOverlay = z.infer<typeof CanonicalTagOverlaySchema>

/** Firestore collection name (single source of truth). */
export const CANONICAL_OVERLAY_COLLECTION = "pa-canonical-tags"

// ─── Resolver ────────────────────────────────────────────────────

/**
 * Minimal Firestore-shape interface. Compatible with `firebase-admin`
 * Firestore but not coupled to it — keeps this package
 * `firebase-admin`-optional (peerDependency).
 */
export interface OverlayQuerySnapshot {
  docs: { data(): unknown }[]
}

export interface OverlayQuery {
  get(): Promise<OverlayQuerySnapshot>
}

export interface OverlayChainedQuery extends OverlayQuery {
  where(field: string, op: string, value: string): OverlayChainedQuery
}

export interface OverlayCollectionRef {
  where(field: string, op: string, value: string): OverlayChainedQuery
}

export interface OverlayDb {
  collection(name: string): OverlayCollectionRef
}

/** Vocab names that support runtime overlay (D16). */
export const OVERLAY_SUPPORTED_VOCABS = ["industry-sector"] as const
export type OverlaySupportedVocab = (typeof OVERLAY_SUPPORTED_VOCABS)[number]

/**
 * Resolve canonical vocab — merge static enum with promoted overlay tokens.
 *
 * @param vocab        Vocab name (must be in `OVERLAY_SUPPORTED_VOCABS`).
 * @param staticVocab  Compile-time enum (e.g., `INDUSTRY_SECTOR_VOCAB`).
 * @param db           Optional Firestore-like db. If omitted, returns
 *                     `staticVocab` only.
 * @returns            De-duplicated array of all valid tokens (static +
 *                     promoted), preserving the static order first.
 */
export async function resolveCanonicalVocab(
  vocab: OverlaySupportedVocab,
  staticVocab: readonly string[],
  db?: OverlayDb,
): Promise<string[]> {
  const merged: string[] = []
  const seen = new Set<string>()
  for (const token of staticVocab) {
    if (!seen.has(token)) {
      seen.add(token)
      merged.push(token)
    }
  }
  if (!db) return merged

  const snapshot = await db
    .collection(CANONICAL_OVERLAY_COLLECTION)
    .where("vocab", "==", vocab)
    .where("status", "==", "promoted")
    .get()

  for (const doc of snapshot.docs) {
    const parsed = CanonicalTagOverlaySchema.safeParse(doc.data())
    if (!parsed.success) continue
    const t = parsed.data.token
    if (!seen.has(t)) {
      seen.add(t)
      merged.push(t)
    }
  }
  return merged
}

/**
 * Build the Firestore document path for a single overlay token.
 * Convention: `pa-canonical-tags/{vocab}__{token}`.
 *
 * Uses double-underscore separator because Firestore doc IDs cannot
 * contain `/`, and we want one flat collection (no subcollections).
 */
export function overlayDocId(
  vocab: OverlaySupportedVocab,
  token: string,
): string {
  return `${vocab}__${token}`
}
