/**
 * v2.0 External Supply V1 — Wave B Block C2 — Upsert path that turns an
 * identity resolution outcome into concrete writes on:
 *
 *   - `pa-users` (only for `create_new`; never overwrites stronger facts)
 *   - `pa-candidate-handles` (LinkedIn + email handles attached to the
 *     resolved candidate; written *directly* — see comment on
 *     `writeExternalHandleDirect` for why we bypass `linkCandidateHandle`)
 *   - `pa-candidate-source-links` (always — including pending/blocked rows
 *     so the operator review queue can pull the row back up)
 *   - `pa-candidate-identity-events` (audit trail for the import)
 *
 * Three core branches mirror the resolution status:
 *   - `create_new`     → mint `pa-users/{uuid}` (prospect), link LinkedIn,
 *                        link any deliverable=false emails, merge weak
 *                        global tags, write source-link, emit
 *                        `external_candidate_imported`.
 *   - `merge_existing` → no `pa-users` overwrite, link LinkedIn handle if
 *                        not already attached, link emails, merge weak
 *                        global tags (never overwriting stronger fields),
 *                        write source-link, emit `external_source_linked`.
 *   - `needs_review` / `blocked` → write a pending source-link with no
 *                        candidateId; do NOT touch `pa-users` or handles.
 *
 * Idempotence guarantees (PLAN §15):
 *  - Source-link doc id is deterministic on
 *    `(batchId, recordId, candidateId?)` so re-running the upsert never
 *    duplicates the row.
 *  - Identity events use deterministic ids on (type, recordId, candidateId
 *    or pending marker) so a retry surfaces `created: false`.
 *  - LinkedIn handle write short-circuits when the handle already maps to
 *    the same candidate.
 *  - Weak-tag merge is additive-only: an existing populated tag is left
 *    intact; only the `relevantTags` slot accepts the union of the
 *    external signal and any prior tokens.
 *
 * Mutations on `pa-users.linkedinUrl`:
 *  - On `create_new` we set `linkedinUrl` to `record.canonicalLinkedInUrl`.
 *  - On `merge_existing` we leave a populated `linkedinUrl` alone. When it
 *    differs from the record's canonical url we keep the existing value
 *    and write `linkedin_url_mismatch_with_profile` into the identity
 *    event's `payloadRedacted` for HITL follow-up.
 */

import { createHash, randomUUID } from "node:crypto"
import type { Firestore } from "firebase-admin/firestore"
import {
  CandidateGlobalTagsSchema,
  CandidateHandleSchema,
  CandidateIdentityEventSchema,
  CandidateProfileMarketplaceFieldsSchema,
  CandidateSourceLinkSchema,
  PA_COLLECTIONS,
  createCandidateHandleId,
  normalizeCandidateHandleValue,
  type CandidateGlobalTags,
  type CandidateHandle,
  type CandidateHandleKind,
  type CandidateIdentityEvent,
  type CandidateProfileMarketplaceFields,
  type CandidateSourceLink,
  type ExternalCandidateRecord,
  type MarketplaceEvidence,
} from "@pa/core-types"
import {
  EXTERNAL_SUPPLY_EVIDENCE_CONFIDENCE,
  type ResolveExternalSupplyIdentityResult,
} from "./external-supply-identity.js"

/** Status produced by `upsertCandidateFromExternalRecord`. */
export type CandidateProfileUpsertStatus =
  | "created"
  | "merged"
  | "pending_review"
  | "blocked"

export interface CandidateProfileUpsertResult {
  recordId: string
  status: CandidateProfileUpsertStatus
  candidateId?: string
  sourceLinkId: string
  identityEventId?: string
}

export interface UpsertCandidateFromExternalRecordArgs {
  record: ExternalCandidateRecord
  resolution: ResolveExternalSupplyIdentityResult
  /** Operator firebase uid (or "system") for audit attribution. */
  operatorUid: string
  /** Inject a clock for deterministic tests. */
  now?: () => string
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function deterministicId(prefix: string, parts: Array<string | undefined>): string {
  const material = parts.filter((p): p is string => Boolean(p)).join("|")
  return `${prefix}_${sha256Hex(material).slice(0, 32)}`
}

function externalEvidence(
  record: ExternalCandidateRecord,
  summary: string
): MarketplaceEvidence {
  return {
    source: "external_sourcing",
    summary: `${summary} (source=${record.source}, batchId=${record.batchId}, recordId=${record.recordId})`,
    confidence: EXTERNAL_SUPPLY_EVIDENCE_CONFIDENCE,
    refId: record.recordId,
  }
}

/**
 * Build a *weak* `CandidateGlobalTags` delta from the record. External
 * sourcing rarely carries canonical tags directly — most useful signal is
 * the `sourceTags` bag — so we route any non-empty raw tags into
 * `relevantTags` (open vocabulary) after a defensive normalize.
 *
 * The downstream `RelevantTagsListSchema` enforces a strict canonical
 * token shape (`^[a-z][a-z0-9_]{1,79}$`) and rejects a curated set of
 * common abbreviations. To avoid corrupting `pa-users.globalTags` with
 * arbitrary raw tags from third-party sources we (a) slugify, (b) cap at
 * 12 tokens, (c) drop tokens shorter than 3 chars, and (d) drop common
 * abbreviations. The shared-tags package owns the authoritative list; we
 * mirror a small subset here to avoid a runtime dep from pa-persistence
 * → shared-tags. Anything that slips past lands in the schema
 * `safeParse` check at write time and gets dropped (see
 * `writeWeakGlobalTags`).
 */
const CANONICAL_TAG_TOKEN_RE = /^[a-z][a-z0-9_]{1,79}$/

const COMMON_ABBREVIATION_TOKENS = new Set<string>([
  "swe", "pm", "tpm", "epm", "sde", "qa", "sre", "ds", "fe", "be",
  "sf", "nyc", "la", "dc", "uk", "us", "usa", "eu",
  "js", "ts", "py", "k8s", "ml", "ai", "ux", "ui", "oss",
])

function normalizeWeakTagToken(raw: string): string | null {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
  if (!slug) return null
  if (!CANONICAL_TAG_TOKEN_RE.test(slug)) return null
  if (slug.length < 3) return null
  if (COMMON_ABBREVIATION_TOKENS.has(slug)) return null
  return slug
}

function buildWeakGlobalTagsDelta(record: ExternalCandidateRecord): Partial<CandidateGlobalTags> {
  const seen = new Set<string>()
  const relevantTags: string[] = []
  for (const raw of record.sourceTags) {
    const normalized = normalizeWeakTagToken(raw)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    relevantTags.push(normalized)
    if (relevantTags.length >= 12) break
  }
  const delta: Partial<CandidateGlobalTags> = {}
  if (relevantTags.length > 0) {
    delta.relevantTags = relevantTags
  }
  return delta
}

/**
 * Merge the external weak signal onto an existing `pa-users.globalTags`
 * snapshot. Weak-only semantics:
 *   - Scalar fields are never overwritten — `delta` only carries
 *     `relevantTags` today.
 *   - `relevantTags` is unioned (not replaced).
 *   - When the user has no `globalTags` yet, a minimal one is created
 *     carrying only the external tokens.
 */
function mergeWeakGlobalTags(
  current: CandidateGlobalTags | undefined,
  delta: Partial<CandidateGlobalTags>,
  now: string
): CandidateGlobalTags | undefined {
  if (!delta.relevantTags || delta.relevantTags.length === 0) {
    return current
  }
  if (!current) {
    return {
      roleFunction: [],
      skills: [],
      industrySector: [],
      targetLocations: [],
      targetJobType: [],
      relevantTags: delta.relevantTags,
      companySizePreference: [],
      companyStage: [],
      updatedAt: now,
    }
  }
  const existingRelevant = Array.isArray(current.relevantTags) ? current.relevantTags : []
  const merged = Array.from(new Set([...existingRelevant, ...delta.relevantTags]))
  if (merged.length === existingRelevant.length) {
    return current
  }
  return { ...current, relevantTags: merged, updatedAt: now }
}

async function readCandidateProfile(
  db: Firestore,
  candidateId: string
): Promise<{
  exists: boolean
  raw: Record<string, unknown>
  marketplace: CandidateProfileMarketplaceFields
}> {
  const ref = db.collection(PA_COLLECTIONS.users).doc(candidateId)
  const snap = await ref.get()
  if (!snap.exists) {
    return {
      exists: false,
      raw: {},
      marketplace: CandidateProfileMarketplaceFieldsSchema.parse({}),
    }
  }
  const raw = (snap.data() ?? {}) as Record<string, unknown>
  const marketplace = CandidateProfileMarketplaceFieldsSchema.parse(raw)
  return { exists: true, raw, marketplace }
}

async function writeWeakGlobalTags(
  db: Firestore,
  candidateId: string,
  record: ExternalCandidateRecord,
  ts: string
): Promise<{ wrote: boolean; relevantTags: string[] }> {
  const delta = buildWeakGlobalTagsDelta(record)
  if (!delta.relevantTags || delta.relevantTags.length === 0) {
    return { wrote: false, relevantTags: [] }
  }
  const { marketplace } = await readCandidateProfile(db, candidateId)
  const nextTags = mergeWeakGlobalTags(marketplace.globalTags, delta, ts)
  if (!nextTags) {
    return { wrote: false, relevantTags: [] }
  }
  if (
    marketplace.globalTags &&
    Array.isArray(marketplace.globalTags.relevantTags) &&
    nextTags.relevantTags.length === marketplace.globalTags.relevantTags.length
  ) {
    return { wrote: false, relevantTags: marketplace.globalTags.relevantTags }
  }
  // Validate against the strict schema before writing — silently drops any
  // token that slips past our pre-filter (e.g. a hidden abbreviation our
  // inline list doesn't cover). If even that fails, skip the write rather
  // than corrupt `pa-users.globalTags`.
  const parsed = CandidateGlobalTagsSchema.safeParse(nextTags)
  if (!parsed.success) {
    return { wrote: false, relevantTags: [] }
  }
  await db
    .collection(PA_COLLECTIONS.users)
    .doc(candidateId)
    .set({ globalTags: parsed.data, updatedAt: ts }, { merge: true })
  return { wrote: true, relevantTags: parsed.data.relevantTags ?? [] }
}

async function writeSourceLink(
  db: Firestore,
  link: CandidateSourceLink
): Promise<{ link: CandidateSourceLink; created: boolean }> {
  const parsed = CandidateSourceLinkSchema.parse(link)
  const ref = db.collection(PA_COLLECTIONS.candidateSourceLinks).doc(parsed.sourceLinkId)
  const existing = await ref.get()
  if (existing.exists) {
    return { link: CandidateSourceLinkSchema.parse(existing.data()), created: false }
  }
  await ref.set(parsed)
  return { link: parsed, created: true }
}

async function writeIdentityEvent(
  db: Firestore,
  event: CandidateIdentityEvent
): Promise<{ created: boolean }> {
  const parsed = CandidateIdentityEventSchema.parse(event)
  const ref = db.collection(PA_COLLECTIONS.candidateIdentityEvents).doc(parsed.eventId)
  const existing = await ref.get()
  if (existing.exists) {
    return { created: false }
  }
  await ref.set(parsed)
  await db
    .collection(PA_COLLECTIONS.auditEvents)
    .doc(`identity_${parsed.eventId}`)
    .set({
      id: `identity_${parsed.eventId}`,
      action: `marketplace.identity.${parsed.type}`,
      eventId: parsed.eventId,
      candidateId: parsed.candidateId ?? null,
      relatedCandidateId: parsed.relatedCandidateId ?? null,
      firebaseUid: parsed.firebaseUid ?? null,
      handleKind: parsed.handleKind ?? null,
      actor: parsed.actor,
      createdAt: parsed.createdAt,
    })
  return { created: true }
}

/**
 * Write a handle row directly. We bypass `linkCandidateHandle` (from
 * identity.ts) for external-supply writes because that path emits a
 * `handle_linked` audit event tagged with the input source — and the
 * `CandidateIdentityEventSchema.source` enum does NOT include
 * `"external_sourcing"`. Adding it there would require a marketplace.ts
 * edit owned by Executor A. For V1 we keep marketplace.ts churn minimal:
 * the handle doc itself carries `source: "external_sourcing"` (S2 already
 * added that value to `CandidateHandleSourceSchema`), and the per-batch
 * upsert surfaces one consolidated
 * `external_candidate_imported`/`external_source_linked` audit event
 * instead of per-handle events.
 */
async function writeExternalHandleDirect(
  db: Firestore,
  args: {
    candidateId: string
    kind: CandidateHandleKind
    rawValue: string
    handleHash: string
    now: string
    deliverable?: boolean
  }
): Promise<{ wrote: boolean; mismatchedCandidateId?: string }> {
  const handleId = createCandidateHandleId(args.kind, args.handleHash)
  const ref = db.collection(PA_COLLECTIONS.candidateHandles).doc(handleId)
  const existing = await ref.get()
  if (existing.exists) {
    const parsed = CandidateHandleSchema.safeParse(existing.data())
    if (!parsed.success) {
      // Malformed existing doc — skip and let HITL clean up later.
      return { wrote: false }
    }
    if (parsed.data.candidateId === args.candidateId) {
      return { wrote: false }
    }
    return { wrote: false, mismatchedCandidateId: parsed.data.candidateId }
  }
  let normalizedValue: string
  try {
    normalizedValue = normalizeCandidateHandleValue(args.kind, args.rawValue)
  } catch {
    // Best-effort fallback — record raw lowercased value rather than fail
    // the whole upsert if normalization happens to throw.
    normalizedValue = args.rawValue.trim().toLowerCase()
  }
  const handle: CandidateHandle = CandidateHandleSchema.parse({
    handleId,
    candidateId: args.candidateId,
    kind: args.kind,
    handleHash: args.handleHash,
    normalizedValue,
    source: "external_sourcing",
    verifiedAt: null,
    deliverable: args.deliverable === true,
    createdAt: args.now,
  })
  await ref.set(handle)
  return { wrote: true }
}

async function ensureLinkedInHandle(
  db: Firestore,
  args: {
    candidateId: string
    canonicalUrl: string
    linkedinProfileHash: string
    now: string
  }
): Promise<{ wrote: boolean; mismatchedCandidateId?: string }> {
  return writeExternalHandleDirect(db, {
    candidateId: args.candidateId,
    kind: "linkedin",
    rawValue: args.canonicalUrl,
    handleHash: args.linkedinProfileHash,
    now: args.now,
    deliverable: false,
  })
}

async function attachEmailHandlesIfAvailable(
  db: Firestore,
  args: {
    candidateId: string
    record: ExternalCandidateRecord
    now: string
  }
): Promise<void> {
  for (const email of args.record.emails) {
    if (!email.value) continue
    await writeExternalHandleDirect(db, {
      candidateId: args.candidateId,
      kind: "email",
      rawValue: email.value,
      handleHash: email.hash,
      now: args.now,
      deliverable: false,
    })
  }
}

export async function upsertCandidateFromExternalRecord(
  db: Firestore,
  args: UpsertCandidateFromExternalRecordArgs
): Promise<CandidateProfileUpsertResult> {
  const { record, resolution, operatorUid } = args
  const now = (args.now ?? (() => new Date().toISOString()))()

  // -- Pending / blocked branches ---------------------------------------
  if (resolution.status === "needs_review" || resolution.status === "blocked") {
    const sourceLinkId = deterministicId("sl", [
      record.batchId,
      record.recordId,
      resolution.status,
    ])
    const status: CandidateSourceLink["status"] =
      resolution.status === "blocked" ? "blocked" : "pending_review"
    const { link } = await writeSourceLink(db, {
      sourceLinkId,
      candidateId: undefined,
      status,
      pendingRecordId: record.recordId,
      source: record.source,
      batchId: record.batchId,
      recordId: record.recordId,
      canonicalLinkedInUrl: record.canonicalLinkedInUrl,
      linkedinProfileHash: record.linkedinProfileHash,
      emailHashes: record.emails.map((e) => e.hash),
      confidence: EXTERNAL_SUPPLY_EVIDENCE_CONFIDENCE,
      evidence: resolution.evidence,
      createdAt: now,
      createdBy: operatorUid || "system",
    })
    return {
      recordId: record.recordId,
      status: resolution.status === "blocked" ? "blocked" : "pending_review",
      sourceLinkId: link.sourceLinkId,
    }
  }

  // -- create_new / merge_existing both require a candidateId -----------
  const isCreate = resolution.status === "create_new"
  const candidateId = isCreate
    ? randomUUID()
    : resolution.candidateId
  if (!candidateId) {
    throw new Error(
      `external_supply_upsert_missing_candidate_id:${record.recordId}:${resolution.status}`
    )
  }
  if (!record.canonicalLinkedInUrl || !record.linkedinProfileHash) {
    // Only LinkedIn-anchored rows reach create_new / merge_existing per the
    // resolver. Defensive guard — surfaces logic regressions early.
    throw new Error(
      `external_supply_upsert_requires_linkedin:${record.recordId}:${resolution.status}`
    )
  }

  if (isCreate) {
    // Mint a fresh prospect profile. Use `setDoc(..., { merge: false })`
    // semantics so a colliding id surfaces as a hard error rather than
    // silently merging onto an unrelated user row.
    const userRef = db.collection(PA_COLLECTIONS.users).doc(candidateId)
    const existing = await userRef.get()
    if (existing.exists) {
      throw new Error(
        `external_supply_upsert_uuid_collision:${candidateId}:${record.recordId}`
      )
    }
    const profile: CandidateProfileMarketplaceFields = CandidateProfileMarketplaceFieldsSchema.parse({
      candidateLifecycleState: "prospect",
      lifecycleUpdatedAt: now,
      lifecycleReason: "external_supply_imported",
      linkedinUrl: record.canonicalLinkedInUrl,
    })
    await userRef.set(
      {
        id: candidateId,
        ...profile,
        signupSource: `external_sourcing:${record.source}`,
        createdAt: now,
        updatedAt: now,
      },
      { merge: false }
    )
  }

  const linkedinResult = await ensureLinkedInHandle(db, {
    candidateId,
    canonicalUrl: record.canonicalLinkedInUrl,
    linkedinProfileHash: record.linkedinProfileHash,
    now,
  })

  await attachEmailHandlesIfAvailable(db, { candidateId, record, now })

  const weakTagsResult = await writeWeakGlobalTags(db, candidateId, record, now)

  // For merge_existing, surface a LinkedIn-URL mismatch on the existing
  // profile so the audit trail explains why we didn't overwrite.
  let linkedinUrlMismatch = false
  if (!isCreate) {
    const { marketplace } = await readCandidateProfile(db, candidateId)
    if (
      typeof marketplace.linkedinUrl === "string" &&
      marketplace.linkedinUrl.length > 0 &&
      marketplace.linkedinUrl !== record.canonicalLinkedInUrl
    ) {
      linkedinUrlMismatch = true
    }
  }

  const sourceLinkId = deterministicId("sl", [
    record.batchId,
    record.recordId,
    candidateId,
  ])
  const { link } = await writeSourceLink(db, {
    sourceLinkId,
    candidateId,
    status: "linked",
    source: record.source,
    batchId: record.batchId,
    recordId: record.recordId,
    canonicalLinkedInUrl: record.canonicalLinkedInUrl,
    linkedinProfileHash: record.linkedinProfileHash,
    emailHashes: record.emails.map((e) => e.hash),
    confidence: EXTERNAL_SUPPLY_EVIDENCE_CONFIDENCE,
    evidence: [
      externalEvidence(
        record,
        isCreate
          ? "Created prospect profile from external sourcing record"
          : "Linked external sourcing record to existing candidate"
      ),
    ],
    createdAt: now,
    createdBy: operatorUid || "system",
  })

  const eventType = isCreate ? "external_candidate_imported" : "external_source_linked"
  const eventId = deterministicId("ident", [
    eventType,
    record.recordId,
    candidateId,
  ])
  await writeIdentityEvent(db, {
    eventId,
    type: eventType,
    actor: "system",
    candidateId,
    handleKind: "linkedin",
    handleHash: record.linkedinProfileHash,
    source: "system",
    evidence: [
      externalEvidence(
        record,
        isCreate
          ? "External sourcing batch produced a new candidate profile"
          : "External sourcing batch linked to existing candidate"
      ),
    ],
    payloadRedacted: {
      batchId: record.batchId,
      recordId: record.recordId,
      source: record.source,
      linkedinHandleWritten: linkedinResult.wrote,
      linkedinHandleMismatchCandidateId: linkedinResult.mismatchedCandidateId ?? null,
      weakTagsWritten: weakTagsResult.wrote,
      weakTagsRelevantTagCount: weakTagsResult.relevantTags.length,
      linkedinUrlMismatchWithProfile: linkedinUrlMismatch,
    },
    createdAt: now,
  })

  return {
    recordId: record.recordId,
    status: isCreate ? "created" : "merged",
    candidateId,
    sourceLinkId: link.sourceLinkId,
    identityEventId: eventId,
  }
}
