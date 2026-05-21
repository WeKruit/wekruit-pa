import { createHash, randomUUID } from "node:crypto"
import type { Firestore } from "firebase-admin/firestore"
import {
  CandidateAuthMappingSchema,
  CandidateHandleSchema,
  CandidateIdentityConflictSchema,
  CandidateIdentityEventSchema,
  CandidateSelfProfileSchema,
  PA_COLLECTIONS,
  candidateHandleHashMaterial,
  createCandidateHandleId,
  normalizeCandidateHandleValue,
  type CandidateAuthMapping,
  type CandidateHandle,
  type CandidateHandleKind,
  type CandidateHandleSource,
  type CandidateIdentityConflict,
  type CandidateIdentityEvent,
  type CandidateIdentityResolution,
  type CandidateProfileMarketplaceFields,
  type CandidateSelfProfile,
  type MarketplaceEvidence,
} from "@pa/core-types"
import { applyCandidateLifecycleEvent } from "./marketplace.js"

const AUDIT_COLLECTION = PA_COLLECTIONS.auditEvents

function nowIso(): string {
  return new Date().toISOString()
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function deterministicId(prefix: string, parts: Array<string | undefined | null>): string {
  const material = parts.filter((part): part is string => !!part).join("|")
  return `${prefix}_${sha256Hex(material).slice(0, 32)}`
}

export function hashCandidateHandle(kind: CandidateHandleKind, value: string): {
  normalizedValue: string
  handleHash: string
  handleId: string
} {
  const normalizedValue = normalizeCandidateHandleValue(kind, value)
  const handleHash = sha256Hex(candidateHandleHashMaterial(kind, normalizedValue))
  return {
    normalizedValue,
    handleHash,
    handleId: createCandidateHandleId(kind, handleHash),
  }
}

function maskEmail(email: string): string {
  const [localRaw, domainRaw] = email.split("@")
  const local = localRaw ?? ""
  const domain = domainRaw ?? ""
  if (!local || !domain) return "***"
  return `${local[0]}***@${domain}`
}

function maskPhone(phone: string): string {
  return phone.length <= 5 ? "***" : `${phone.slice(0, 3)}***${phone.slice(-2)}`
}

async function writeAppendOnlyDoc<T>(
  db: Firestore,
  collectionName: string,
  docId: string,
  payload: T
): Promise<{ doc: T; created: boolean }> {
  const ref = db.collection(collectionName).doc(docId)
  const existing = await ref.get()
  if (existing.exists) {
    const data = existing.data() as T
    if (stableJson(data) !== stableJson(payload)) {
      throw new Error(`conflicting_duplicate_identity_doc:${collectionName}/${docId}`)
    }
    return { doc: data, created: false }
  }
  await ref.set(payload as Record<string, unknown>)
  return { doc: payload, created: true }
}

async function writeIdentityEvent(
  db: Firestore,
  rawEvent: CandidateIdentityEvent
): Promise<{ event: CandidateIdentityEvent; created: boolean }> {
  const event = CandidateIdentityEventSchema.parse(rawEvent)
  const result = await writeAppendOnlyDoc(
    db,
    PA_COLLECTIONS.candidateIdentityEvents,
    event.eventId,
    event
  )
  if (result.created) {
    await db.collection(AUDIT_COLLECTION).doc(`identity_${event.eventId}`).set({
      id: `identity_${event.eventId}`,
      action: `marketplace.identity.${event.type}`,
      eventId: event.eventId,
      candidateId: event.candidateId ?? null,
      relatedCandidateId: event.relatedCandidateId ?? null,
      firebaseUid: event.firebaseUid ?? null,
      handleKind: event.handleKind ?? null,
      actor: event.actor,
      createdAt: event.createdAt,
    })
  }
  return { event: result.doc, created: result.created }
}

export async function recordIdentityConflict(
  db: Firestore,
  rawConflict: CandidateIdentityConflict
): Promise<{ conflict: CandidateIdentityConflict; created: boolean }> {
  const conflict = CandidateIdentityConflictSchema.parse(rawConflict)
  const result = await writeAppendOnlyDoc(
    db,
    PA_COLLECTIONS.candidateIdentityConflicts,
    conflict.conflictId,
    conflict
  )
  if (result.created) {
    await writeIdentityEvent(db, {
      eventId: deterministicId("ident", ["identity_conflict_recorded", conflict.conflictId]),
      type: "identity_conflict_recorded",
      actor: "system",
      candidateId: conflict.primaryCandidateId,
      relatedCandidateId: conflict.competingCandidateId,
      firebaseUid: conflict.firebaseUid,
      handleId: conflict.handleId,
      handleKind: conflict.handleKind,
      handleHash: conflict.handleHash,
      conflictId: conflict.conflictId,
      source: "system",
      evidence: conflict.evidence,
      payloadRedacted: {
        kind: conflict.kind,
        status: conflict.status,
      },
      createdAt: conflict.createdAt,
    })
  }
  return { conflict: result.doc, created: result.created }
}

export interface LinkCandidateHandleInput {
  candidateId: string
  kind: CandidateHandleKind
  value: string
  source: CandidateHandleSource
  verified?: boolean
  deliverable?: boolean
  now?: string
  evidence?: MarketplaceEvidence[]
}

export async function linkCandidateHandle(
  db: Firestore,
  input: LinkCandidateHandleInput
): Promise<{ handle: CandidateHandle; created: boolean }> {
  const ts = input.now ?? nowIso()
  const hashed = hashCandidateHandle(input.kind, input.value)
  const ref = db.collection(PA_COLLECTIONS.candidateHandles).doc(hashed.handleId)
  const existing = await ref.get()
  if (existing.exists) {
    const data = CandidateHandleSchema.parse(existing.data())
    if (data.candidateId !== input.candidateId) {
      const conflict = CandidateIdentityConflictSchema.parse({
        conflictId: deterministicId("identity_conflict", [
          "handle_candidate_mismatch",
          hashed.handleId,
          data.candidateId,
          input.candidateId,
        ]),
        kind: "handle_candidate_mismatch",
        primaryCandidateId: data.candidateId,
        competingCandidateId: input.candidateId,
        handleKind: input.kind,
        handleId: hashed.handleId,
        handleHash: hashed.handleHash,
        evidence: input.evidence ?? [],
        payloadRedacted: {
          existingSource: data.source,
          attemptedSource: input.source,
        },
        createdAt: ts,
      })
      await recordIdentityConflict(db, conflict)
      throw new Error(`identity_conflict:${conflict.conflictId}`)
    }
    const shouldPromoteVerification = input.verified && !data.verifiedAt
    const shouldPromoteDeliverable = input.deliverable === true && data.deliverable !== true
    if (shouldPromoteVerification || shouldPromoteDeliverable) {
      const next = CandidateHandleSchema.parse({
        ...data,
        verifiedAt: shouldPromoteVerification ? ts : data.verifiedAt,
        deliverable: shouldPromoteDeliverable ? true : data.deliverable,
        updatedAt: ts,
      })
      await ref.set(next, { merge: true })
      return { handle: next, created: false }
    }
    return { handle: data, created: false }
  }

  const handle = CandidateHandleSchema.parse({
    handleId: hashed.handleId,
    candidateId: input.candidateId,
    kind: input.kind,
    handleHash: hashed.handleHash,
    normalizedValue: hashed.normalizedValue,
    source: input.source,
    verifiedAt: input.verified ? ts : null,
    deliverable: input.deliverable,
    createdAt: ts,
  })
  await ref.set(handle)
  await writeIdentityEvent(db, {
    eventId: deterministicId("ident", ["handle_linked", handle.handleId, input.candidateId]),
    type: "handle_linked",
    actor: "system",
    candidateId: input.candidateId,
    handleId: handle.handleId,
    handleKind: handle.kind,
    handleHash: handle.handleHash,
    source: input.source,
    evidence: input.evidence ?? [],
    payloadRedacted: {
      verified: Boolean(input.verified),
      deliverable: Boolean(input.deliverable),
    },
    createdAt: ts,
  })
  return { handle, created: true }
}

export interface ResolveCandidateIdentityInput {
  extractedEmail?: string | null
  employerEmailHint?: string | null
  phoneE164?: string | null
  browserUid?: string | null
  atsApplicantId?: string | null
  source: CandidateHandleSource
  candidateIdHint?: string | null
  useCandidateIdHint?: boolean
  now?: string
  evidence?: MarketplaceEvidence[]
  /**
   * Identity hardening 2026-05-21 — gate on creating new pa-users from
   * unknown handles. Default `"create_or_resolve"` keeps every existing
   * caller (cv-ingest, bulk-resume-intake, ATS inbound, etc.) creating
   * pa-users for first-time handles, which is the v2.0 candidate-supply
   * inflow contract. `"resolve_only"` is used by magic-link email-link
   * sign-in: email alone is not an L1 entry, so claim must hit an
   * existing handle (created previously via resume/Gmail OAuth/LinkedIn
   * OAuth). On miss, the resolver returns `{outcome: "not_found"}` and
   * the caller surfaces a `requires_l1_signup` error.
   */
  mode?: "create_or_resolve" | "resolve_only"
}

function firstHandleInput(input: ResolveCandidateIdentityInput): {
  kind: CandidateHandleKind
  value: string
  verified: boolean
  deliverable: boolean
} | null {
  if (input.extractedEmail) {
    return { kind: "email", value: input.extractedEmail, verified: false, deliverable: true }
  }
  if (input.employerEmailHint) {
    return { kind: "email", value: input.employerEmailHint, verified: false, deliverable: true }
  }
  if (input.phoneE164) {
    return { kind: "phone", value: input.phoneE164, verified: false, deliverable: true }
  }
  if (input.browserUid) {
    return { kind: "browser_uid", value: input.browserUid, verified: false, deliverable: false }
  }
  if (input.atsApplicantId) {
    return { kind: "ats_applicant", value: input.atsApplicantId, verified: false, deliverable: false }
  }
  return null
}

export async function resolveCandidateIdentity(
  db: Firestore,
  input: ResolveCandidateIdentityInput
): Promise<CandidateIdentityResolution> {
  const ts = input.now ?? nowIso()
  if (input.extractedEmail && input.employerEmailHint) {
    const extracted = hashCandidateHandle("email", input.extractedEmail)
    const employer = hashCandidateHandle("email", input.employerEmailHint)
    if (extracted.handleHash !== employer.handleHash) {
      const conflict = CandidateIdentityConflictSchema.parse({
        conflictId: deterministicId("identity_conflict", [
          "pdf_email_employer_email_mismatch",
          extracted.handleHash,
          employer.handleHash,
        ]),
        kind: "pdf_email_employer_email_mismatch",
        pdfEmailHash: extracted.handleHash,
        employerEmailHash: employer.handleHash,
        evidence: input.evidence ?? [
          { source: "resume_parse", summary: "PDF email differs from employer-provided email hint" },
        ],
        payloadRedacted: {
          source: input.source,
        },
        createdAt: ts,
      })
      await recordIdentityConflict(db, conflict)
      return { outcome: "identity_conflict", conflict }
    }
  }

  const primary = firstHandleInput(input)
  if (!primary) {
    const conflict = CandidateIdentityConflictSchema.parse({
      conflictId: deterministicId("identity_conflict", [
        "duplicate_suspicion",
        input.candidateIdHint ?? "missing_identity_signal",
      ]),
      kind: "duplicate_suspicion",
      primaryCandidateId: input.candidateIdHint ?? undefined,
      evidence: input.evidence ?? [{ source: "system", summary: "No identity handle was available" }],
      payloadRedacted: { source: input.source },
      createdAt: ts,
    })
    await recordIdentityConflict(db, conflict)
    return { outcome: "identity_conflict", conflict }
  }

  const hashed = hashCandidateHandle(primary.kind, primary.value)
  const handleSnap = await db.collection(PA_COLLECTIONS.candidateHandles).doc(hashed.handleId).get()
  if (handleSnap.exists) {
    const handle = CandidateHandleSchema.parse(handleSnap.data())
    return { outcome: "resolved_existing", candidateId: handle.candidateId, handle }
  }

  // Identity hardening 2026-05-21 — caller (magic-link email-link) asked
  // to RESOLVE only; not creating a new candidate row. Surfaces upward so
  // the CF can return `requires_l1_signup` to the client.
  if (input.mode === "resolve_only") {
    return { outcome: "not_found" }
  }

  const candidateId =
    input.useCandidateIdHint && input.candidateIdHint
      ? input.candidateIdHint
      : db.collection(PA_COLLECTIONS.users).doc().id || randomUUID()
  await db.collection(PA_COLLECTIONS.users).doc(candidateId).set(
    {
      id: candidateId,
      candidateLifecycleState: "profile_created",
      lifecycleUpdatedAt: ts,
      lifecycleReason: "identity_profile_created",
      signupSource: `identity:${input.source}`,
      createdAt: ts,
      updatedAt: ts,
    },
    { merge: true }
  )
  const linked = await linkCandidateHandle(db, {
    candidateId,
    kind: primary.kind,
    value: primary.value,
    source: input.source,
    verified: primary.verified,
    deliverable: primary.deliverable,
    now: ts,
    evidence: input.evidence,
  })
  await writeIdentityEvent(db, {
    eventId: deterministicId("ident", ["canonical_candidate_selected", linked.handle.handleId, candidateId]),
    type: "canonical_candidate_selected",
    actor: "system",
    candidateId,
    handleId: linked.handle.handleId,
    handleKind: linked.handle.kind,
    handleHash: linked.handle.handleHash,
    source: input.source,
    evidence: input.evidence ?? [],
    payloadRedacted: {
      created: true,
      candidateIdHintUsed: Boolean(input.useCandidateIdHint && input.candidateIdHint),
    },
    createdAt: ts,
  })

  if (input.browserUid && primary.kind !== "browser_uid") {
    await linkCandidateHandle(db, {
      candidateId,
      kind: "browser_uid",
      value: input.browserUid,
      source: "candidate",
      now: ts,
      evidence: input.evidence,
    }).catch(() => undefined)
  }
  if (input.phoneE164 && primary.kind !== "phone") {
    await linkCandidateHandle(db, {
      candidateId,
      kind: "phone",
      value: input.phoneE164,
      source: input.source,
      deliverable: true,
      now: ts,
      evidence: input.evidence,
    }).catch(() => undefined)
  }
  if (input.atsApplicantId && primary.kind !== "ats_applicant") {
    await linkCandidateHandle(db, {
      candidateId,
      kind: "ats_applicant",
      value: input.atsApplicantId,
      source: "ats",
      now: ts,
      evidence: input.evidence,
    }).catch(() => undefined)
  }

  return { outcome: "created", candidateId, handle: linked.handle }
}

export interface WriteCandidateSelfProfileInput {
  candidateId: string
  email?: string | null
  phoneE164?: string | null
  displayName?: string | null
  marketplaceFields?: CandidateProfileMarketplaceFields
  handles?: Array<Pick<CandidateHandle, "kind" | "verifiedAt" | "source">>
  profileSummary?: string | null
  now?: string
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T
}

export async function writeCandidateSelfProfile(
  db: Firestore,
  input: WriteCandidateSelfProfileInput
): Promise<CandidateSelfProfile> {
  const ts = input.now ?? nowIso()
  const profile = CandidateSelfProfileSchema.parse({
    candidateId: input.candidateId,
    lifecycleState: input.marketplaceFields?.candidateLifecycleState ?? "prospect",
    displayName: input.displayName || undefined,
    emailMasked: input.email ? maskEmail(input.email.trim().toLowerCase()) : undefined,
    phoneMasked: input.phoneE164 ? maskPhone(input.phoneE164) : undefined,
    handles: input.handles ?? [],
    latestResumeArtifactId: input.marketplaceFields?.latestResumeArtifactId,
    profileSummary: input.profileSummary || undefined,
    globalTags: input.marketplaceFields?.globalTags,
    linkedinUrl: input.marketplaceFields?.linkedinUrl,
    createdAt: ts,
    updatedAt: ts,
  })
  await db
    .collection(PA_COLLECTIONS.candidateSelfProfiles)
    .doc(input.candidateId)
    .set(stripUndefined(profile as unknown as Record<string, unknown>), { merge: true })
  return profile
}

export interface ClaimCandidateProfileInput {
  firebaseUid: string
  email: string
  browserUid?: string | null
  displayName?: string | null
  now?: string
  /**
   * Identity hardening 2026-05-21 — when `false`, an email that does
   * not yet have a registered handle will NOT spin up a brand-new
   * pa-users row. Used by the magic-link email-link path: email alone
   * is not an L1 entry point (those are resume upload / Gmail OAuth /
   * LinkedIn OAuth), so the claim must hit an existing handle or get
   * rejected with `requires_l1_signup`. Defaults to `true` to preserve
   * back-compat for OAuth-driven callers that legitimately create
   * candidates on first sign-in.
   */
  allowCreate?: boolean
}

export async function claimCandidateProfile(
  db: Firestore,
  input: ClaimCandidateProfileInput
): Promise<{
  candidateId: string
  authMapping: CandidateAuthMapping
  selfProfile: CandidateSelfProfile
  emailHandle: CandidateHandle
  claimedEventId: string
  idempotent: boolean
}> {
  const ts = input.now ?? nowIso()
  const allowCreate = input.allowCreate !== false
  const resolved = await resolveCandidateIdentity(db, {
    extractedEmail: input.email,
    browserUid: input.browserUid,
    source: "candidate",
    now: ts,
    evidence: [{ source: "system", summary: "Candidate email-link auth claim" }],
    mode: allowCreate ? "create_or_resolve" : "resolve_only",
  })
  if (resolved.outcome === "identity_conflict") {
    throw new Error(`identity_conflict:${resolved.conflict.conflictId}`)
  }
  if (resolved.outcome === "not_found") {
    throw new Error("requires_l1_signup:no_existing_handle")
  }
  const candidateId = resolved.candidateId
  const emailHandle = await linkCandidateHandle(db, {
    candidateId,
    kind: "email",
    value: input.email,
    source: "candidate",
    verified: true,
    deliverable: true,
    now: ts,
    evidence: [{ source: "system", summary: "Firebase email-link claim verified email" }],
  }).catch(async (err) => {
    if (err instanceof Error && err.message.startsWith("identity_conflict:")) throw err
    const hashed = hashCandidateHandle("email", input.email)
    const snap = await db.collection(PA_COLLECTIONS.candidateHandles).doc(hashed.handleId).get()
    return { handle: CandidateHandleSchema.parse(snap.data()), created: false }
  })
  const authRef = db.collection(PA_COLLECTIONS.candidateAuth).doc(input.firebaseUid)
  const existingAuth = await authRef.get()
  let idempotent = false
  if (existingAuth.exists) {
    const existing = CandidateAuthMappingSchema.parse(existingAuth.data())
    if (existing.candidateId !== candidateId) {
      const conflict = CandidateIdentityConflictSchema.parse({
        conflictId: deterministicId("identity_conflict", [
          "auth_candidate_mismatch",
          input.firebaseUid,
          existing.candidateId,
          candidateId,
        ]),
        kind: "auth_candidate_mismatch",
        primaryCandidateId: existing.candidateId,
        competingCandidateId: candidateId,
        firebaseUid: input.firebaseUid,
        handleKind: "email",
        handleId: emailHandle.handle.handleId,
        handleHash: emailHandle.handle.handleHash,
        evidence: [{ source: "system", summary: "Firebase uid was already mapped to another candidate" }],
        createdAt: ts,
      })
      await recordIdentityConflict(db, conflict)
      throw new Error(`identity_conflict:${conflict.conflictId}`)
    }
    idempotent = true
  }

  const authMapping = CandidateAuthMappingSchema.parse({
    firebaseUid: input.firebaseUid,
    candidateId,
    emailHandleId: emailHandle.handle.handleId,
    emailHandleHash: emailHandle.handle.handleHash,
    createdAt: existingAuth.exists ? CandidateAuthMappingSchema.parse(existingAuth.data()).createdAt : ts,
    updatedAt: ts,
    lastClaimedAt: ts,
  })
  await authRef.set(authMapping, { merge: true })

  await applyCandidateLifecycleEvent(db, {
    eventId: deterministicId("claim_lifecycle", ["profile_created", candidateId]),
    candidateId,
    actor: "system",
    occurredAt: ts,
    evidence: [{ source: "system", summary: "Candidate profile exists for claim" }],
    type: "profile_created",
  })
  await applyCandidateLifecycleEvent(db, {
    eventId: deterministicId("claim_lifecycle", ["handle_linked", candidateId, emailHandle.handle.handleId]),
    candidateId,
    actor: "system",
    occurredAt: ts,
    evidence: [{ source: "system", summary: "Verified email handle linked through claim" }],
    type: "handle_linked",
    handleKind: "email",
    verified: true,
    deliverable: true,
  })
  await applyCandidateLifecycleEvent(db, {
    eventId: deterministicId("claim_lifecycle", ["candidate_claimed", input.firebaseUid, candidateId]),
    candidateId,
    actor: "candidate",
    occurredAt: ts,
    evidence: [{ source: "system", summary: "Email magic-link claim completed" }],
    type: "candidate_claimed",
  })

  const userSnap = await db.collection(PA_COLLECTIONS.users).doc(candidateId).get()
  const user = (userSnap.data() ?? {}) as Record<string, unknown>
  const candidateUserPatch: Record<string, unknown> = {
    email: input.email.trim().toLowerCase(),
    updatedAt: ts,
  }
  const displayName =
    input.displayName ??
    (typeof user.displayName === "string" ? user.displayName : null) ??
    (typeof user.legalName === "string" ? user.legalName : null)
  if (displayName) {
    candidateUserPatch.displayName = displayName
  }
  await db.collection(PA_COLLECTIONS.users).doc(candidateId).set(candidateUserPatch, { merge: true })

  const selfProfile = await writeCandidateSelfProfile(db, {
    candidateId,
    email: input.email,
    phoneE164: typeof user.phoneE164 === "string" ? user.phoneE164 : null,
    displayName,
    marketplaceFields: user as CandidateProfileMarketplaceFields,
    handles: [{ kind: "email", verifiedAt: ts, source: "candidate" }],
    now: ts,
  })
  const claimedEventId = deterministicId("ident", ["candidate_claimed", input.firebaseUid, candidateId])
  if (!idempotent) {
    await writeIdentityEvent(db, {
      eventId: claimedEventId,
      type: "candidate_claimed",
      actor: "candidate",
      candidateId,
      firebaseUid: input.firebaseUid,
      handleId: emailHandle.handle.handleId,
      handleKind: "email",
      handleHash: emailHandle.handle.handleHash,
      source: "auth",
      evidence: [{ source: "system", summary: "Email magic-link claim completed" }],
      payloadRedacted: { provider: "email_link" },
      createdAt: ts,
    })
  }

  return {
    candidateId,
    authMapping,
    selfProfile,
    emailHandle: emailHandle.handle,
    claimedEventId,
    idempotent,
  }
}
