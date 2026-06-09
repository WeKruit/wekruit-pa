/**
 * v2.0 External Supply V1 — Wave B Block C1 — LinkedIn-first identity
 * resolution for external sourcing records.
 *
 * Wraps the existing handle index in `pa-candidate-handles` (linkedin +
 * email kinds) and routes each `ExternalCandidateRecord` to one of:
 *
 *   - `create_new`     — LinkedIn looks unseen; caller's upsert path will
 *                        mint a new `pa-users` profile.
 *   - `merge_existing` — LinkedIn handle resolves to an existing candidate
 *                        with no contradictory email-handle binding.
 *   - `needs_review`   — operator must adjudicate one of:
 *                        * `email_only_external_row` (V1 policy: email-only
 *                          rows never auto-create profiles — Adam directive)
 *                        * `linkedin_email_candidate_mismatch` (LinkedIn
 *                          handle points to candidate A while one of the
 *                          row's email handles points to candidate B)
 *                        * `external_fuzzy_match` (no canonical handles
 *                          available, but a `pa-users` row with the same
 *                          normalized name + currentCompany exists)
 *   - `blocked`        — no usable identity signal at all.
 *
 * Identity conflicts surface as `pa-candidate-identity-conflicts` docs so
 * the dashboard can show them in `/admin/external-supply/review`.
 *
 * Invariants:
 *  - Read-only on `pa-users`. The companion `external-supply-upsert.ts`
 *    owns all mutation. This module only inspects the existing handle index
 *    and (when warranted) writes conflict + identity-event audit rows.
 *  - All evidence carries `source: "external_sourcing"`, `confidence: 0.4`
 *    (per lead resolution C2). Stronger signals never come from this path.
 *  - Doc ids never contain raw PII. Lookups go through the existing
 *    `pa-candidate-handles/<kind>__<sha256>` index.
 *  - V1 fuzzy-match fallback: `pa-users` does not currently expose
 *    `profileNameNormalized` / `currentCompany` as queryable fields, so
 *    when fuzzy match is the only remaining path we conservatively return
 *    `blocked` rather than fake a match. Lead-approved (PLAN §11 C1).
 */

import { createHash } from "node:crypto"
import type { Firestore } from "firebase-admin/firestore"
import {
  CandidateHandleSchema,
  CandidateIdentityConflictSchema,
  PA_COLLECTIONS,
  createCandidateHandleId,
  type CandidateIdentityConflict,
  type ExternalCandidateRecord,
  type IdentityResolutionStatus,
  type MarketplaceEvidence,
} from "@pa/core-types"
import { recordIdentityConflict } from "./identity.js"

/** Default evidence confidence for any external-sourcing-derived signal. */
export const EXTERNAL_SUPPLY_EVIDENCE_CONFIDENCE = 0.4

/** Single-row resolution outcome returned by `resolveExternalSupplyIdentity`. */
export interface ResolveExternalSupplyIdentityResult {
  status: IdentityResolutionStatus
  candidateId?: string
  conflictId?: string
  reviewReasons: string[]
  evidence: MarketplaceEvidence[]
}

export interface ResolveExternalSupplyIdentityOptions {
  /** Inject a clock for deterministic tests. Default = `Date.now()` ISO. */
  now?: () => string
  /**
   * Allow a LinkedIn-only row to be treated as `create_new` (the V1
   * default). Reserved for future opt-out toggles — currently always true.
   */
  allowAutoCreateOnLinkedinOnly?: boolean
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function deterministicConflictId(parts: Array<string | undefined>): string {
  const material = parts.filter((p): p is string => Boolean(p)).join("|")
  return `identity_conflict_${sha256Hex(material).slice(0, 32)}`
}

function externalSourcingEvidence(
  record: ExternalCandidateRecord,
  detail: string
): MarketplaceEvidence {
  return {
    source: "external_sourcing",
    summary: `${detail} (source=${record.source}, batchId=${record.batchId}, recordId=${record.recordId})`,
    confidence: EXTERNAL_SUPPLY_EVIDENCE_CONFIDENCE,
    refId: record.recordId,
  }
}

async function lookupHandleCandidateId(
  db: Firestore,
  kind: "linkedin" | "email",
  hash: string
): Promise<{ candidateId: string } | null> {
  const handleId = createCandidateHandleId(kind, hash)
  const snap = await db.collection(PA_COLLECTIONS.candidateHandles).doc(handleId).get()
  if (!snap.exists) return null
  const parsed = CandidateHandleSchema.safeParse(snap.data())
  if (!parsed.success) return null
  return { candidateId: parsed.data.candidateId }
}

export async function resolveExternalSupplyIdentity(
  db: Firestore,
  record: ExternalCandidateRecord,
  opts: ResolveExternalSupplyIdentityOptions = {}
): Promise<ResolveExternalSupplyIdentityResult> {
  const now = opts.now ?? (() => new Date().toISOString())

  // ---------------------------------------------------------------------------
  // Path 1 — LinkedIn-first lookup.
  // ---------------------------------------------------------------------------
  if (record.canonicalLinkedInUrl && record.linkedinProfileHash) {
    const linkedinHit = await lookupHandleCandidateId(
      db,
      "linkedin",
      record.linkedinProfileHash
    )
    if (linkedinHit) {
      // LinkedIn handle resolves to an existing candidate. Verify that no
      // email handle on the same row points to a *different* candidate.
      const emailMismatch = await findFirstConflictingEmail(
        db,
        record,
        linkedinHit.candidateId
      )
      if (emailMismatch) {
        const conflict = CandidateIdentityConflictSchema.parse({
          // Commutative id: sort the candidate pair so the same conflict
          // detected with flipped handle ownership maps to the SAME doc.
          conflictId: deterministicConflictId([
            "linkedin_email_candidate_mismatch",
            record.linkedinProfileHash,
            emailMismatch.emailHash,
            ...[linkedinHit.candidateId, emailMismatch.candidateId].sort(),
          ]),
          kind: "linkedin_email_candidate_mismatch",
          primaryCandidateId: linkedinHit.candidateId,
          competingCandidateId: emailMismatch.candidateId,
          handleKind: "linkedin",
          handleHash: record.linkedinProfileHash,
          evidence: [
            externalSourcingEvidence(
              record,
              "LinkedIn maps to one candidate while email maps to a different candidate"
            ),
          ],
          payloadRedacted: {
            recordId: record.recordId,
            batchId: record.batchId,
            source: record.source,
            linkedinCandidateId: linkedinHit.candidateId,
            emailCandidateId: emailMismatch.candidateId,
          },
          createdAt: now(),
        })
        await recordIdentityConflict(db, conflict)
        return {
          status: "needs_review",
          conflictId: conflict.conflictId,
          reviewReasons: ["linkedin_email_candidate_mismatch"],
          evidence: conflict.evidence,
        }
      }
      return {
        status: "merge_existing",
        candidateId: linkedinHit.candidateId,
        reviewReasons: [],
        evidence: [
          externalSourcingEvidence(
            record,
            "LinkedIn handle hash matched existing candidate"
          ),
        ],
      }
    }

    // LinkedIn handle is novel. Default V1 policy = auto-create downstream.
    return {
      status: "create_new",
      reviewReasons: [],
      evidence: [
        externalSourcingEvidence(
          record,
          "Novel LinkedIn handle — caller will mint a new prospect profile"
        ),
      ],
    }
  }

  // ---------------------------------------------------------------------------
  // Path 2 — No LinkedIn. V1 policy: email-only rows always need review.
  // ---------------------------------------------------------------------------
  if (record.emails.length > 0) {
    return {
      status: "needs_review",
      reviewReasons: ["email_only_external_row"],
      evidence: [
        externalSourcingEvidence(
          record,
          "Email-only row — V1 policy holds for operator review (no LinkedIn)"
        ),
      ],
    }
  }

  // ---------------------------------------------------------------------------
  // Path 3 — No LinkedIn AND no email. V1 fallback = block.
  //
  // The spec allows a fuzzy match on (normalizedName + currentCompany), but
  // pa-users currently doesn't index those fields, so any "match" would be
  // a fabrication. Lead-approved fallback: emit `blocked` with the
  // fuzzy-match attempt noted in reviewReasons so the operator surface can
  // explain why no candidate was inferred.
  // ---------------------------------------------------------------------------
  const reviewReasons = ["no_identity_signal"]
  if (record.name && record.currentCompany) {
    reviewReasons.push("fuzzy_match_unavailable_v1")
  }
  return {
    status: "blocked",
    reviewReasons,
    evidence: [
      externalSourcingEvidence(
        record,
        "No LinkedIn, no email — V1 cannot disambiguate (fuzzy match deferred)"
      ),
    ],
  }
}

async function findFirstConflictingEmail(
  db: Firestore,
  record: ExternalCandidateRecord,
  linkedinCandidateId: string
): Promise<{ emailHash: string; candidateId: string } | null> {
  for (const email of record.emails) {
    const emailHit = await lookupHandleCandidateId(db, "email", email.hash)
    if (emailHit && emailHit.candidateId !== linkedinCandidateId) {
      return { emailHash: email.hash, candidateId: emailHit.candidateId }
    }
  }
  return null
}

export type { CandidateIdentityConflict }
