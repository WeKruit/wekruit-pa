import { createHash, randomUUID } from "node:crypto"
import { FieldValue, type Firestore } from "firebase-admin/firestore"
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
import { applyCandidateLifecycleEvent, writeCorrectionEvent } from "./marketplace.js"

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

function normalizeOptionalUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`
  try {
    const parsed = new URL(withProtocol)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined
    return parsed.toString()
  } catch {
    return undefined
  }
}

function isLinkedinOAuthMarker(value: unknown): boolean {
  if (typeof value !== "string") return false
  return value.includes("/oauth-linked/")
}

function normalizeLinkedinProfileUrl(value: unknown): string | undefined {
  if (isLinkedinOAuthMarker(value)) return undefined
  return normalizeOptionalUrl(value)
}

function normalizeExperienceHighlights(value: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(value)) return undefined
  const out: Array<Record<string, unknown>> = []
  for (const item of value) {
    if (!item || typeof item !== "object") continue
    const raw = item as Record<string, unknown>
    const title = typeof raw.title === "string" ? raw.title.trim() : ""
    const company = typeof raw.company === "string" ? raw.company.trim() : ""
    if (!title || !company) continue
    const location = typeof raw.location === "string" ? raw.location.trim() : ""
    const description = typeof raw.description === "string" ? raw.description.trim() : ""
    const startDate = typeof raw.startDate === "string" ? raw.startDate.trim() : ""
    const endDate = typeof raw.endDate === "string" ? raw.endDate.trim() : ""
    const department = typeof raw.department === "string" ? raw.department.trim() : ""
    const managementLevel = typeof raw.managementLevel === "string" ? raw.managementLevel.trim() : ""
    const companyIndustry = typeof raw.companyIndustry === "string" ? raw.companyIndustry.trim() : ""
    const companySizeRange = typeof raw.companySizeRange === "string" ? raw.companySizeRange.trim() : ""
    const companyHqCity = typeof raw.companyHqCity === "string" ? raw.companyHqCity.trim() : ""
    const companyHqCountry = typeof raw.companyHqCountry === "string" ? raw.companyHqCountry.trim() : ""
    const source = typeof raw.source === "string" ? raw.source.trim() : ""
    const sourceLabel = typeof raw.sourceLabel === "string" ? raw.sourceLabel.trim() : ""
    const durationMonths =
      typeof raw.durationMonths === "number" && Number.isFinite(raw.durationMonths) && raw.durationMonths >= 0
        ? raw.durationMonths
        : undefined
    const companyId =
      typeof raw.companyId === "number" && Number.isInteger(raw.companyId) && raw.companyId > 0
        ? raw.companyId
        : undefined
    out.push(stripUndefined({
      title: title.slice(0, 200),
      company: company.slice(0, 200),
      location: location ? location.slice(0, 200) : undefined,
      description: description ? description.slice(0, 4_000) : undefined,
      startDate: startDate ? startDate.slice(0, 64) : undefined,
      endDate: endDate ? endDate.slice(0, 64) : undefined,
      durationMonths,
      currentRole: raw.currentRole === true ? true : undefined,
      department: department ? department.slice(0, 120) : undefined,
      managementLevel: managementLevel ? managementLevel.slice(0, 120) : undefined,
      companyId,
      companyIndustry: companyIndustry ? companyIndustry.slice(0, 200) : undefined,
      companySizeRange: companySizeRange ? companySizeRange.slice(0, 120) : undefined,
      companyWebsite: normalizeOptionalUrl(raw.companyWebsite),
      companyLinkedinUrl: normalizeOptionalUrl(raw.companyLinkedinUrl),
      companyHqCity: companyHqCity ? companyHqCity.slice(0, 120) : undefined,
      companyHqCountry: companyHqCountry ? companyHqCountry.slice(0, 120) : undefined,
      companyLogoUrl: normalizeOptionalUrl(raw.companyLogoUrl),
      source: source ? source.slice(0, 80) : undefined,
      sourceLabel: sourceLabel ? sourceLabel.slice(0, 120) : undefined,
    }))
    if (out.length >= 12) break
  }
  return out.length > 0 ? out : undefined
}

function legacyLinkedinOauthProfile(
  marketplaceFields: CandidateProfileMarketplaceFields | undefined,
  ts: string
): Record<string, unknown> | undefined {
  if (marketplaceFields?.linkedinOauthProfile) return marketplaceFields.linkedinOauthProfile
  const raw = (marketplaceFields ?? {}) as Record<string, unknown>
  if (raw.linkedinOauthLinked !== true) return undefined
  const email = typeof raw.linkedinOauthEmail === "string" ? raw.linkedinOauthEmail : undefined
  return stripUndefined({
    connectedAt: typeof raw.linkedinOauthConnectedAt === "string" ? raw.linkedinOauthConnectedAt : ts,
    name: typeof raw.linkedinOauthName === "string" ? raw.linkedinOauthName : undefined,
    pictureUrl: normalizeOptionalUrl(raw.linkedinOauthPicture),
    emailMasked: email ? maskEmail(email.trim().toLowerCase()) : undefined,
  })
}

function githubLoginFromUrl(value: unknown): string | undefined {
  const url = normalizeOptionalUrl(value)
  if (!url) return undefined
  try {
    const parsed = new URL(url)
    if (!/github\.com$/i.test(parsed.hostname)) return undefined
    const login = parsed.pathname.split("/").filter(Boolean)[0]
    return login || undefined
  } catch {
    return undefined
  }
}

function legacyGithubOauthProfile(
  marketplaceFields: CandidateProfileMarketplaceFields | undefined,
  ts: string
): Record<string, unknown> | undefined {
  if (marketplaceFields?.githubOauthProfile) return marketplaceFields.githubOauthProfile
  const raw = (marketplaceFields ?? {}) as Record<string, unknown>
  if (raw.githubOauthLinked !== true && !raw.githubHandle && !raw.githubUrl) return undefined
  const email = typeof raw.githubOauthEmail === "string" ? raw.githubOauthEmail : undefined
  return stripUndefined({
    connectedAt: typeof raw.githubOauthConnectedAt === "string" ? raw.githubOauthConnectedAt : ts,
    login:
      typeof raw.githubHandle === "string" && raw.githubHandle.trim()
        ? raw.githubHandle.trim()
        : githubLoginFromUrl(raw.githubUrl),
    name: typeof raw.githubOauthName === "string" ? raw.githubOauthName : undefined,
    url: normalizeOptionalUrl(raw.githubUrl),
    avatarUrl: normalizeOptionalUrl(raw.githubOauthAvatar),
    emailMasked: email ? maskEmail(email.trim().toLowerCase()) : undefined,
  })
}

function githubPublicReposFromMarketplace(
  marketplaceFields: CandidateProfileMarketplaceFields | undefined
): unknown {
  if (marketplaceFields?.githubPublicRepos?.length) return marketplaceFields.githubPublicRepos
  const raw = (marketplaceFields ?? {}) as Record<string, unknown>
  return Array.isArray(raw.githubPublicRepos) ? raw.githubPublicRepos : undefined
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
      await ref.set(stripUndefined(next as unknown as Record<string, unknown>), { merge: true })
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
  const identityEvent = CandidateIdentityEventSchema.parse({
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
  await ref.set(stripUndefined(handle as unknown as Record<string, unknown>))
  await writeIdentityEvent(db, identityEvent)
  return { handle, created: true }
}

/**
 * candidateHasLinkedinBind — TRUE iff this candidate ALREADY has a LinkedIn
 * identity bound. Two independent signals, OR'd:
 *   1. a durable `pa-candidate-handles` row {candidateId, kind:"linkedin"}
 *      (written by linkCandidateHandle on OAuth login OR paste-URL submit), OR
 *   2. the binary `pa-users/{candidateId}.linkedinOauthLinked === true` flag
 *      (set on a successful OAuth connect — covers a brand-new bind whose
 *      handle write is in-flight, and the OAuth path that may only flag the
 *      user doc).
 *
 * Used to suppress the onboarding "connect your LinkedIn" OFFER for an already-
 * bound phone WITHOUT regressing the first-time (unbound) offer.
 *
 * DEFENSIVE / FAIL-SOFT: any read error → `false` (never throws). A transient
 * read failure must NOT make us claim "already bound" and wrongly mute the
 * offer; defaulting to `false` keeps the first-time offer intact (the worst
 * case is one extra optional, idempotent offer — never a dead end).
 *
 * Query idiom mirrors loadCandidateSelfProfileHandles: a single
 * `where("candidateId")` + in-memory `kind` filter (no composite index needed).
 */
export async function candidateHasLinkedinBind(
  db: Firestore,
  candidateId: string
): Promise<boolean> {
  try {
    const snap = await db
      .collection(PA_COLLECTIONS.candidateHandles)
      .where("candidateId", "==", candidateId)
      .limit(50)
      .get()
    if (snap.docs.some((doc) => (doc.data() as { kind?: unknown }).kind === "linkedin")) {
      return true
    }
  } catch {
    return false
  }
  try {
    const userSnap = await db.collection(PA_COLLECTIONS.users).doc(candidateId).get()
    return (userSnap.data() as { linkedinOauthLinked?: unknown } | undefined)?.linkedinOauthLinked === true
  } catch {
    return false
  }
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
    linkedinUrl: normalizeLinkedinProfileUrl(input.marketplaceFields?.linkedinUrl),
    linkedinOauthProfile: legacyLinkedinOauthProfile(input.marketplaceFields, ts),
    githubUrl: normalizeOptionalUrl(input.marketplaceFields?.githubUrl),
    githubOauthProfile: legacyGithubOauthProfile(input.marketplaceFields, ts),
    githubPublicRepos: githubPublicReposFromMarketplace(input.marketplaceFields),
    calcomUrl: normalizeOptionalUrl(input.marketplaceFields?.calcomUrl),
    experienceHighlights: normalizeExperienceHighlights(
      (input.marketplaceFields as Record<string, unknown> | undefined)?.experienceHighlights,
    ),
    createdAt: ts,
    updatedAt: ts,
  })
  const persisted = stripUndefined(profile as unknown as Record<string, unknown>)
  if (!profile.linkedinUrl) {
    persisted.linkedinUrl = FieldValue.delete()
  }
  await db
    .collection(PA_COLLECTIONS.candidateSelfProfiles)
    .doc(input.candidateId)
    .set(persisted, { merge: true })
  return profile
}

async function loadCandidateSelfProfileHandles(
  db: Firestore,
  candidateId: string
): Promise<Array<Pick<CandidateHandle, "kind" | "verifiedAt" | "source">>> {
  const snap = await db
    .collection(PA_COLLECTIONS.candidateHandles)
    .where("candidateId", "==", candidateId)
    .limit(100)
    .get()
  const byKind = new Map<CandidateHandleKind, Pick<CandidateHandle, "kind" | "verifiedAt" | "source">>()
  for (const doc of snap.docs) {
    const handle = CandidateHandleSchema.parse(doc.data())
    byKind.set(handle.kind, {
      kind: handle.kind,
      verifiedAt: handle.verifiedAt,
      source: handle.source,
    })
  }
  const order: CandidateHandleKind[] = [
    "email",
    "phone",
    "linkedin",
    "github",
    "calcom",
    "browser_uid",
    "ats_applicant",
    "sendblue_thread",
    "imessage",
  ]
  return order.flatMap((kind) => {
    const handle = byKind.get(kind)
    return handle ? [handle] : []
  })
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
    handles: await loadCandidateSelfProfileHandles(db, candidateId),
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

// ---------------------------------------------------------------------------
// Same-phone duplicate-profile MERGE (Adam policy 2026-05-29)
//
// "Same phone = same person → MERGE, even when emails differ. If they already
//  own the phone number, it's the same one even if the emails differ."
//
// Two pa-users that share a deliverable phone are the same human who signed up
// twice (e.g. yogeshsavirigana@gmail.com and yogi.savirigana1996@gmail.com both
// with +18303265553, 2 min apart). We fold the younger duplicate INTO the
// oldest-createdAt canonical profile: tags union, résumé / job / prescreen rows
// re-pointed, emails preserved as alt-emails, handles re-linked. The duplicate
// is tombstoned (phone reassigned to a sentinel, runtimeMode=paused, mergedInto
// set) so the resolver only ever finds the canonical. Every merge writes a
// `merge_decision_recorded` identity event AND a candidate_profile correction
// event so the human/data fix becomes flywheel data (v2.0 rule D9).
//
// Idempotent: a duplicate already carrying `mergedInto === canonicalId` is
// skipped; re-running is a no-op.
// ---------------------------------------------------------------------------

/** User-scoped collections whose rows are keyed by (or carry) `userId`. */
const USER_SCOPED_FOLD_COLLECTIONS = [
  "parsedCandidateResumes",
  "pa-job-profiles",
  "pa-job-rec-explanations",
  "pa-prescreen-sessions",
  PA_COLLECTIONS.candidateJobStates,
  PA_COLLECTIONS.candidateJobMatches,
  PA_COLLECTIONS.resumeArtifacts,
] as const

/** Tag array fields safe to ADDITIVELY union duplicate → canonical (soft signal). */
const MERGE_TAG_ARRAY_FIELDS = [
  "skills",
  "relevantTags",
  "relevantIndustry",
  "industrySector",
  "targetRoleFunction",
  "targetLocations",
  "targetJobType",
] as const

function timestampToMs(value: unknown): number {
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  if (value && typeof value === "object") {
    const c = value as { toDate?: () => Date; _seconds?: number; seconds?: number }
    if (typeof c.toDate === "function") return c.toDate().getTime()
    if (typeof c._seconds === "number") return c._seconds * 1000
    if (typeof c.seconds === "number") return c.seconds * 1000
  }
  return 0
}

/**
 * Pick the canonical (KEEP) doc among duplicates: oldest `createdAt` ascending
 * (immutable → stable), then most-recent `updatedAt`, then doc-id. Mirrors
 * `choosePhoneMatchDeterministic` / `pickDeterministicUserDoc` so the merge
 * keeps the SAME doc the resolver already resolves to live.
 */
function pickCanonicalUser(
  docs: Array<{ id: string; data: Record<string, unknown> }>,
): { id: string; data: Record<string, unknown> } {
  return [...docs].sort((a, b) => {
    const aCreated = timestampToMs(a.data.createdAt) || Number.POSITIVE_INFINITY
    const bCreated = timestampToMs(b.data.createdAt) || Number.POSITIVE_INFINITY
    if (aCreated !== bCreated) return aCreated - bCreated
    const aUpdated = timestampToMs(a.data.updatedAt)
    const bUpdated = timestampToMs(b.data.updatedAt)
    if (bUpdated !== aUpdated) return bUpdated - aUpdated
    return a.id.localeCompare(b.id)
  })[0]!
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function maskEmailSafe(value: unknown): string {
  return typeof value === "string" && value.includes("@") ? maskEmail(value.trim().toLowerCase()) : "***"
}

export interface MergeCandidatesByPhoneInput {
  phoneE164: string
  /** Explicit canonical pin (skips the createdAt tiebreak). For ops scripts. */
  canonicalCandidateIdHint?: string
  actor?: "system" | "operator"
  reason?: string
  now?: string
  /** When true, computes the plan and returns it WITHOUT any Firestore writes. */
  dryRun?: boolean
}

export interface MergeFoldedDuplicate {
  duplicateId: string
  alreadyMerged: boolean
  emailsFolded: string[]
  tagFieldsUnioned: string[]
  reLinkedHandleCount: number
  repointedRowsByCollection: Record<string, number>
}

export interface MergeCandidatesByPhoneResult {
  merged: boolean
  dryRun: boolean
  canonicalCandidateId: string | null
  duplicateCandidateIds: string[]
  folded: MergeFoldedDuplicate[]
}

/**
 * Merge every pa-users that shares `phoneE164` into a single canonical profile.
 * No-op (merged:false) when 0 or 1 docs hold the phone. Idempotent + audited.
 */
export async function mergeCandidatesByPhone(
  db: Firestore,
  input: MergeCandidatesByPhoneInput,
): Promise<MergeCandidatesByPhoneResult> {
  const ts = input.now ?? nowIso()
  const actor = input.actor ?? "system"
  const reason = input.reason ?? `Same-phone duplicate merge (${input.phoneE164.slice(-4)})`

  // 1. Find all pa-users that currently hold this exact phone. Bounded read.
  const snap = await db
    .collection(PA_COLLECTIONS.users)
    .where("phoneE164", "==", input.phoneE164)
    .limit(25)
    .get()
  const docs = snap.docs.map((d) => ({ id: d.id, data: (d.data() ?? {}) as Record<string, unknown> }))
  if (docs.length <= 1) {
    return {
      merged: false,
      dryRun: input.dryRun === true,
      canonicalCandidateId: docs[0]?.id ?? null,
      duplicateCandidateIds: [],
      folded: [],
    }
  }

  // 2. Choose canonical (KEEP). Honor an explicit pin if it's actually one of
  //    the phone-holders; otherwise oldest-createdAt wins.
  const pinned = input.canonicalCandidateIdHint
    ? docs.find((d) => d.id === input.canonicalCandidateIdHint)
    : undefined
  const canonical = pinned ?? pickCanonicalUser(docs)
  const duplicates = docs.filter((d) => d.id !== canonical.id)

  const folded: MergeFoldedDuplicate[] = []
  for (const dup of duplicates) {
    folded.push(
      await foldDuplicateIntoCanonical(db, {
        canonical,
        dup,
        phoneE164: input.phoneE164,
        ts,
        actor,
        reason,
        dryRun: input.dryRun === true,
      }),
    )
  }

  return {
    merged: true,
    dryRun: input.dryRun === true,
    canonicalCandidateId: canonical.id,
    duplicateCandidateIds: duplicates.map((d) => d.id),
    folded,
  }
}

async function foldDuplicateIntoCanonical(
  db: Firestore,
  args: {
    canonical: { id: string; data: Record<string, unknown> }
    dup: { id: string; data: Record<string, unknown> }
    phoneE164: string
    ts: string
    actor: "system" | "operator"
    reason: string
    dryRun: boolean
  },
): Promise<MergeFoldedDuplicate> {
  const { canonical, dup, phoneE164, ts, actor, reason, dryRun } = args
  const canonicalRef = db.collection(PA_COLLECTIONS.users).doc(canonical.id)
  const dupRef = db.collection(PA_COLLECTIONS.users).doc(dup.id)

  // Idempotent guard — if already tombstoned into this canonical, no-op.
  if (dup.data.mergedInto === canonical.id) {
    return {
      duplicateId: dup.id,
      alreadyMerged: true,
      emailsFolded: [],
      tagFieldsUnioned: [],
      reLinkedHandleCount: 0,
      repointedRowsByCollection: {},
    }
  }

  // ---- compute the tag union (additive) ----
  const canonicalTags = (canonical.data.tags ?? {}) as Record<string, unknown>
  const dupTags = (dup.data.tags ?? {}) as Record<string, unknown>
  const tagUpdates: Record<string, unknown> = {}
  const tagFieldsUnioned: string[] = []
  for (const field of MERGE_TAG_ARRAY_FIELDS) {
    const dupVal = dupTags[field]
    if (!Array.isArray(dupVal) || dupVal.length === 0) continue
    const merged = Array.from(new Set([...asArray(canonicalTags[field]), ...dupVal]))
    const added = dupVal.filter((x) => !asArray(canonicalTags[field]).includes(x))
    if (added.length > 0) {
      tagUpdates[field] = merged
      tagFieldsUnioned.push(field)
    }
  }

  // ---- collect emails to preserve as alt-emails ----
  const canonicalEmail = typeof canonical.data.email === "string" ? canonical.data.email.trim().toLowerCase() : null
  const canonicalAlt = asArray(canonical.data.altEmails).filter((x): x is string => typeof x === "string")
  const dupEmail = typeof dup.data.email === "string" ? dup.data.email.trim().toLowerCase() : null
  const dupContact = typeof dup.data.contactEmail === "string" ? dup.data.contactEmail.trim().toLowerCase() : null
  const emailsFolded = Array.from(
    new Set(
      [dupEmail, dupContact, ...canonicalAlt].filter(
        (e): e is string => !!e && e !== canonicalEmail,
      ),
    ),
  )

  // ---- re-point user-scoped rows (résumé / job / prescreen) ----
  const repointedRowsByCollection: Record<string, number> = {}
  let reLinkedHandleCount = 0

  if (!dryRun) {
    for (const collection of USER_SCOPED_FOLD_COLLECTIONS) {
      repointedRowsByCollection[collection] = await repointUserScopedRows(
        db,
        collection,
        dup.id,
        canonical.id,
        ts,
      )
    }

    // ---- re-link ALL of the duplicate's contact handles → canonical. Phone is
    //      the unique entity key; both emails / phone / other handles now live
    //      on the single canonical entity. ----
    reLinkedHandleCount = await reassignDuplicateHandles(db, dup.id, canonical.id, ts)

    // ---- write the canonical merge patch (tags union + alt-emails + the
    //      duplicate's userId kept as an alias) ----
    const canonicalPatch: Record<string, unknown> = {
      updatedAt: ts,
      dedupMergedFrom: Array.from(
        new Set([...asArray(canonical.data.dedupMergedFrom).filter((x): x is string => typeof x === "string"), dup.id]),
      ),
      dedupMergedAt: ts,
      // Phone = unique key: keep BOTH userIds as aliases on the canonical entity
      // so a stale opener / link pointing at the folded id still resolves here.
      aliasUserIds: Array.from(
        new Set([...asArray(canonical.data.aliasUserIds).filter((x): x is string => typeof x === "string"), dup.id]),
      ),
    }
    if (Object.keys(tagUpdates).length > 0) {
      canonicalPatch.tags = { ...canonicalTags, ...tagUpdates }
    }
    if (emailsFolded.length > 0) {
      canonicalPatch.altEmails = Array.from(new Set([...canonicalAlt, ...emailsFolded]))
    }
    // If canonical has no displayName but the duplicate does, adopt it.
    if (!canonical.data.displayName && typeof dup.data.displayName === "string") {
      canonicalPatch.displayName = dup.data.displayName
    }
    await canonicalRef.set(canonicalPatch, { merge: true })

    // ---- tombstone the duplicate so the resolver never finds it again ----
    await dupRef.set(
      {
        phoneE164: `${phoneE164}__merged_${dup.id}`,
        phoneE164Source: "dedup_merged_same_phone",
        mergedInto: canonical.id,
        mergedAt: ts,
        runtimeMode: "paused",
        runtimeModeAt: ts,
        runtimeModeSetBy: `mergeCandidatesByPhone(${actor})`,
        runtimeModeReason: reason,
        updatedAt: ts,
      },
      { merge: true },
    )

    // ---- audit: identity merge event + flywheel correction event ----
    await writeIdentityEvent(db, {
      eventId: deterministicId("ident", ["merge_decision_recorded", canonical.id, dup.id]),
      type: "merge_decision_recorded",
      actor,
      candidateId: canonical.id,
      relatedCandidateId: dup.id,
      source: "system",
      evidence: [
        {
          source: "system",
          summary: `Same phone (…${phoneE164.slice(-4)}) on two pa-users → merged ${dup.id} into ${canonical.id}`,
        },
      ],
      payloadRedacted: {
        reason,
        tagFieldsUnioned,
        emailsFoldedCount: emailsFolded.length,
        canonicalEmailMasked: maskEmailSafe(canonical.data.email),
        duplicateEmailMasked: maskEmailSafe(dup.data.email),
        reLinkedHandleCount,
        repointedRowsByCollection,
      },
      createdAt: ts,
    }).catch(() => undefined)

    await writeCorrectionEvent(db, {
      eventId: deterministicId("correction", ["candidate_profile_merge", canonical.id, dup.id]),
      targetType: "candidate_profile",
      targetId: canonical.id,
      actor,
      candidateId: canonical.id,
      reason,
      beforeRedacted: {
        duplicateId: dup.id,
        duplicateEmailMasked: maskEmailSafe(dup.data.email),
        sharedPhoneTail: phoneE164.slice(-4),
      },
      afterRedacted: {
        canonicalId: canonical.id,
        tagFieldsUnioned,
        emailsFoldedCount: emailsFolded.length,
        reLinkedHandleCount,
        repointedRowsByCollection,
      },
      evidence: [{ source: "system", summary: "Duplicate same-phone profile folded into canonical" }],
      createdAt: ts,
    }).catch(() => undefined)
  }

  return {
    duplicateId: dup.id,
    alreadyMerged: false,
    emailsFolded,
    tagFieldsUnioned,
    reLinkedHandleCount,
    repointedRowsByCollection,
  }
}

/**
 * Re-point a user-scoped collection's rows from `fromUserId` → `toUserId`.
 * Handles both the `where userId == X` shape and the doc-id-is-userId shape.
 * Preserves the row by writing a copy under the canonical key and dropping the
 * duplicate-keyed row, or simply patching `userId` on a query-shaped row.
 */
async function repointUserScopedRows(
  db: Firestore,
  collection: string,
  fromUserId: string,
  toUserId: string,
  ts: string,
): Promise<number> {
  let count = 0
  // (a) query shape: rows carry a userId field. Re-derive the doc ref by id so
  //     this works against both real Firestore and the test fake (whose query
  //     result rows do not expose `.ref`).
  const byUser = await db.collection(collection).where("userId", "==", fromUserId).limit(500).get()
  for (const d of byUser.docs) {
    await db
      .collection(collection)
      .doc(d.id)
      .set({ userId: toUserId, dedupRepointedFrom: fromUserId, updatedAt: ts }, { merge: true })
    count++
  }
  // (b) doc-id-is-userId shape (e.g. parsedCandidateResumes/{userId}). Copy the
  //     duplicate's row under the canonical id ONLY when canonical has none, so
  //     we never clobber the canonical's own richer data; then tombstone the
  //     duplicate-keyed row by stamping mergedInto.
  const byId = await db.collection(collection).doc(fromUserId).get()
  if (byId.exists) {
    const canonicalDoc = await db.collection(collection).doc(toUserId).get()
    if (!canonicalDoc.exists) {
      await db
        .collection(collection)
        .doc(toUserId)
        .set({ ...(byId.data() ?? {}), userId: toUserId, dedupRepointedFrom: fromUserId, updatedAt: ts }, { merge: true })
      count++
    }
    await db
      .collection(collection)
      .doc(fromUserId)
      .set({ mergedInto: toUserId, mergedAt: ts }, { merge: true })
  }
  return count
}

/**
 * Re-link the duplicate's `pa-candidate-handles` rows to the canonical
 * candidateId (direct overwrite — these handles really are the same person,
 * so ALL contact handles — both emails, the phone, browser/ats ids — live on
 * the canonical entity). Phone = unique key: the duplicate only ever appears
 * here because it shared the canonical's phone.
 */
async function reassignDuplicateHandles(
  db: Firestore,
  fromUserId: string,
  toUserId: string,
  ts: string,
): Promise<number> {
  const snap = await db
    .collection(PA_COLLECTIONS.candidateHandles)
    .where("candidateId", "==", fromUserId)
    .limit(100)
    .get()
  let count = 0
  for (const d of snap.docs) {
    await db
      .collection(PA_COLLECTIONS.candidateHandles)
      .doc(d.id)
      .set({ candidateId: toUserId, dedupRepointedFrom: fromUserId, updatedAt: ts }, { merge: true })
    count++
  }
  return count
}
