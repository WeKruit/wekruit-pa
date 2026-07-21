/**
 * `paAdminCandidatePoolCounts` — admin-only TRUE aggregate counts for the
 * dashboard "Candidate pool" page header + STATE/SOURCE/IDENTITY breakdowns.
 *
 * Why this exists: the Candidate pool page loads only the most recent 500
 * `pa-users` (browse sample) and computed every header card / bucket over that
 * 500-row slice. With ~5k+ pa-users that is ~10% of the pool, so the numbers
 * read as "lagging". This callable scans the WHOLE pool server-side and returns
 * the same counts the page already renders — just true.
 *
 * Fidelity: it reuses the EXACT shared classifiers the page uses
 * (`deriveCandidateSource` + `classifyCandidateProfile` from `@pa/core-types`)
 * and replicates the page-local `deriveLifecycle` / `isValidE164Phone` /
 * `isDemoTestOrInternal` logic verbatim, so a card here equals the card the page
 * draws (apps/dashboard-web/src/pages/Candidates.tsx, the `counts` useMemo at
 * lines ~595-656). The demo/test/internal toggle is honored by returning BOTH
 * variants (`default` = hidden excluded, `includingHidden` = all) so the page's
 * live toggle stays instant with no refetch.
 *
 * Architecture mirrors `admin-ops-metrics.ts`: pure
 * `runAdminCandidatePoolCounts(deps)` (deps-injected, unit-testable without
 * firebase-admin) + a thin cached onCall shim. Auth via the shared
 * `authorizeAdminCallable` (Firebase Auth `admin` claim OR `PA_ADMIN_TOKEN`).
 */
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import { defineSecret } from "firebase-functions/params"
import { HttpsError, onCall } from "firebase-functions/v2/https"
import { logger } from "firebase-functions/v2"
import { z } from "zod"
import {
  PA_COLLECTIONS,
  classifyCandidateProfile,
  deriveCandidateSource,
  type CandidateClass,
  type CandidateListUserDoc,
  type CandidateProfileExternalSource,
} from "@pa/core-types"
import { authorizeAdminCallable } from "./promote-sandbox-tag.js"

const PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN")

// Per-collection scan ceiling. A hit flips `truncated` so the UI can warn
// rather than silently undercount. Generous vs. current sizes (~5k users).
const SCAN_CAP = 60_000

// Server-side result cache — the 4-collection scan is heavy, so repeat loads
// read one cached doc instead of re-scanning. 30-min freshness is fine here.
const POOL_COUNTS_CACHE_COLLECTION = "pa-candidate-pool-counts-cache"
const POOL_COUNTS_CACHE_TTL_MS = 30 * 60_000
// Bump when the computation changes so stale cached results aren't served.
const POOL_COUNTS_CACHE_VERSION = "v1"

// ---------------------------------------------------------------------------
// Schema + wire types
// ---------------------------------------------------------------------------

export const AdminCandidatePoolCountsInputSchema = z.object({
  /** Admin-token fallback for scripted callers. */
  adminToken: z.string().nullish(),
})
export type AdminCandidatePoolCountsInput = z.infer<typeof AdminCandidatePoolCountsInputSchema>

/** Toggle-dependent breakdowns (mirror the page's `byState`/`bySource`/`byIdentity`). */
export interface CandidatePoolVariant {
  /** "Real users" card = rows after the demo/test/internal filter for this variant. */
  realRows: number
  /** lifecycle → count (STATE chips). */
  byState: Record<string, number>
  /** SourceKind → count (SOURCE chips). */
  bySource: Record<string, number>
  /** IDENTITY chips. */
  byIdentity: {
    registered: number
    phone_ready: number
    phone_bound: number
    sendblue_eligible: number
  }
}

export interface AdminCandidatePoolCountsResult {
  /** True size of the whole pool scanned (every pa-user). */
  totalPaUsers: number
  generatedAt: string
  truncated: {
    users: boolean
    auth: boolean
    handles: boolean
    sourceLinks: boolean
  }
  /**
   * candidateClass breakdown — counted over ALL rows (toggle-independent),
   * exactly like the page's second loop (Candidates.tsx:624-631).
   */
  classBreakdown: {
    accountCandidates: number
    externalProspects: number
    legacySmsProfiles: number
    demoPreviewProfiles: number
    syntheticTests: number
    internalProfiles: number
    identityArtifacts: number
  }
  /**
   * Header identity cards (Registered/Phone ready/Phone-bound/Sendblue) —
   * counted over ALL rows but always gated `!isDemoTestOrInternal`
   * (Candidates.tsx:632-637), so they do NOT follow the toggle.
   */
  identityCards: {
    registered: number
    phoneReady: number
    phoneBound: number
    sendblueEligible: number
  }
  /** demo/test/internal EXCLUDED (page default — toggle off). */
  default: CandidatePoolVariant
  /** demo/test/internal INCLUDED (toggle on). */
  includingHidden: CandidatePoolVariant
}

// ---------------------------------------------------------------------------
// Page-local logic replicated verbatim (kept in lock-step with Candidates.tsx)
// ---------------------------------------------------------------------------

/** Candidates.tsx:353-360 — derive the lifecycle/state bucket. */
function deriveLifecycle(data: Record<string, unknown>): string {
  const d = data as {
    candidateLifecycleState?: string
    outreach?: { status?: string }
    onboardingStatus?: string
    phoneE164?: string
    email?: string
  }
  if (d.candidateLifecycleState) return d.candidateLifecycleState
  if (d.outreach?.status === "opted_out") return "opted_out"
  if (d.onboardingStatus === "active") return "claimed"
  if (d.onboardingStatus === "provisional") return "profile_created"
  if (d.phoneE164 || d.email) return "reachable"
  return "prospect"
}

/** Candidates.helpers.ts:15-16 — valid E.164. */
function isValidE164Phone(value?: unknown): boolean {
  return typeof value === "string" && /^\+[1-9]\d{7,14}$/.test(value)
}

/** Candidates.tsx:455-459 — demo/preview, synthetic-test, internal-operator. */
function isDemoTestOrInternal(candidateClass: CandidateClass): boolean {
  return (
    candidateClass === "demo_preview_profile" ||
    candidateClass === "synthetic_test_profile" ||
    candidateClass === "internal_operator_profile"
  )
}

function addId(set: Set<string>, value: unknown): void {
  if (typeof value === "string" && value.trim()) set.add(value.trim())
}

// ---------------------------------------------------------------------------
// Generic scan — plain limit + .select(), NO orderBy.
//
// orderBy(field) silently EXCLUDES docs missing that field; the page loads the
// join collections (auth/handles/source-links) with a plain limit (no orderBy),
// so we match that to avoid undercounting registered/phone-bound. We want the
// whole collection, and counts don't depend on order.
// ---------------------------------------------------------------------------

interface ScannedDoc {
  id: string
  data: Record<string, unknown>
}

async function scanAll(
  db: Firestore,
  collection: string,
  fields: readonly string[],
  cap: number = SCAN_CAP,
): Promise<{ docs: ScannedDoc[]; truncated: boolean }> {
  let q = db.collection(collection).limit(cap)
  if (fields.length > 0) q = q.select(...fields)
  const snap = await q.get()
  const docs = snap.docs.map((d) => ({ id: d.id, data: d.data() as Record<string, unknown> }))
  return { docs, truncated: docs.length >= cap }
}

// ---------------------------------------------------------------------------
// Pure handler
// ---------------------------------------------------------------------------

export interface AdminCandidatePoolCountsDeps {
  db: Firestore
}

const USER_FIELDS = [
  "phoneE164",
  "email",
  "linkedinUrl",
  "signupSource",
  "source",
  "firstSignupEntry",
  "candidateLifecycleState",
  "onboardingStatus",
  "latestResumeArtifactId",
  "piiConsentAt",
  "mem0UserId",
  "testMode",
  "isDemo",
  "demoSourcePool",
  "outreach",
] as const

function emptyVariant(): CandidatePoolVariant {
  return {
    realRows: 0,
    byState: {},
    bySource: {},
    byIdentity: { registered: 0, phone_ready: 0, phone_bound: 0, sendblue_eligible: 0 },
  }
}

function addToVariant(
  v: CandidatePoolVariant,
  lifecycle: string,
  source: string,
  flags: { registered: boolean; phoneReady: boolean; phoneBound: boolean; sendblueEligible: boolean },
): void {
  v.realRows += 1
  v.byState[lifecycle] = (v.byState[lifecycle] ?? 0) + 1
  v.bySource[source] = (v.bySource[source] ?? 0) + 1
  if (flags.registered) v.byIdentity.registered += 1
  if (flags.phoneReady) v.byIdentity.phone_ready += 1
  if (flags.phoneBound) v.byIdentity.phone_bound += 1
  if (flags.sendblueEligible) v.byIdentity.sendblue_eligible += 1
}

export async function runAdminCandidatePoolCounts(
  deps: AdminCandidatePoolCountsDeps,
): Promise<AdminCandidatePoolCountsResult> {
  const [usersScan, authScan, handlesScan, linksScan] = await Promise.all([
    scanAll(deps.db, PA_COLLECTIONS.users, USER_FIELDS),
    scanAll(deps.db, PA_COLLECTIONS.candidateAuth, ["candidateId", "userId", "uid"]),
    // Page filters kind=='phone'; we scan all handles + filter in-memory (no
    // composite index needed, mock-friendly).
    scanAll(deps.db, PA_COLLECTIONS.candidateHandles, ["kind", "candidateId", "userId", "uid"]),
    scanAll(deps.db, PA_COLLECTIONS.candidateSourceLinks, ["candidateId", "source"]),
  ])

  // registeredIds — every candidate id with a pa-candidate-auth mapping
  // (Candidates.tsx:417-423). phoneBoundIds — every id with a phone handle
  // (Candidates.tsx:425-433).
  const registeredIds = new Set<string>()
  for (const { data } of authScan.docs) {
    addId(registeredIds, data.candidateId)
    addId(registeredIds, data.userId)
    addId(registeredIds, data.uid)
  }
  const phoneBoundIds = new Set<string>()
  for (const { data } of handlesScan.docs) {
    if (data.kind !== "phone") continue
    addId(phoneBoundIds, data.candidateId)
    addId(phoneBoundIds, data.userId)
    addId(phoneBoundIds, data.uid)
  }
  // sourceMap — first-wins per candidateId (Candidates.tsx:393-408).
  const sourceMap = new Map<string, CandidateProfileExternalSource>()
  for (const { data } of linksScan.docs) {
    const cid = typeof data.candidateId === "string" ? data.candidateId : ""
    const src = data.source
    if (cid && src && !sourceMap.has(cid)) {
      sourceMap.set(cid, src as CandidateProfileExternalSource)
    }
  }

  const classBreakdown = {
    accountCandidates: 0,
    externalProspects: 0,
    legacySmsProfiles: 0,
    demoPreviewProfiles: 0,
    syntheticTests: 0,
    internalProfiles: 0,
    identityArtifacts: 0,
  }
  const identityCards = { registered: 0, phoneReady: 0, phoneBound: 0, sendblueEligible: 0 }
  const variantDefault = emptyVariant()
  const variantIncludingHidden = emptyVariant()

  for (const { id, data } of usersScan.docs) {
    // The classifier reads `doc.id`; inject the doc key so it can't throw.
    const doc = { ...data, id } as unknown as CandidateListUserDoc
    const source = deriveCandidateSource(doc, sourceMap.get(id))
    const candidateClass = classifyCandidateProfile(source, doc)
    const lifecycle = deriveLifecycle(data)
    const phoneReady = isValidE164Phone(data.phoneE164)
    const registered = registeredIds.has(id)
    const phoneBound = phoneBoundIds.has(id)
    const sendblueEligible = candidateClass === "candidate_account" && registered && phoneReady
    const flags = { registered, phoneReady, phoneBound, sendblueEligible }

    // class breakdown — ALL rows (Candidates.tsx:624-631).
    if (candidateClass === "candidate_account") classBreakdown.accountCandidates += 1
    else if (candidateClass === "external_supply_prospect") classBreakdown.externalProspects += 1
    else if (candidateClass === "legacy_sms_profile") classBreakdown.legacySmsProfiles += 1
    else if (candidateClass === "demo_preview_profile") classBreakdown.demoPreviewProfiles += 1
    else if (candidateClass === "synthetic_test_profile") classBreakdown.syntheticTests += 1
    else if (candidateClass === "internal_operator_profile") classBreakdown.internalProfiles += 1
    else classBreakdown.identityArtifacts += 1

    const hidden = isDemoTestOrInternal(candidateClass)

    // header identity cards — ALL rows, gated !isDemoTestOrInternal
    // (Candidates.tsx:632-637), independent of the toggle.
    if (!hidden) {
      if (registered) identityCards.registered += 1
      if (phoneReady) identityCards.phoneReady += 1
      if (phoneBound) identityCards.phoneBound += 1
      if (sendblueEligible) identityCards.sendblueEligible += 1
    }

    // toggle-dependent variants (Candidates.tsx:610-622).
    addToVariant(variantIncludingHidden, lifecycle, source, flags)
    if (!hidden) addToVariant(variantDefault, lifecycle, source, flags)
  }

  return {
    totalPaUsers: usersScan.docs.length,
    generatedAt: new Date().toISOString(),
    truncated: {
      users: usersScan.truncated,
      auth: authScan.truncated,
      handles: handlesScan.truncated,
      sourceLinks: linksScan.truncated,
    },
    classBreakdown,
    identityCards,
    default: variantDefault,
    includingHidden: variantIncludingHidden,
  }
}

// ---------------------------------------------------------------------------
// Production CF — thin cached shim.
// ---------------------------------------------------------------------------

export const paAdminCandidatePoolCounts = onCall(
  {
    region: "us-central1",
    // Scans 4 collections over the whole pool. .select() trims the footprint;
    // 1GiB matches admin-ops-metrics and gives ample headroom past 5k users.
    memory: "1GiB",
    timeoutSeconds: 120,
    secrets: [PA_ADMIN_TOKEN],
  },
  async (req): Promise<AdminCandidatePoolCountsResult> => {
    authorizeAdminCallable(req as { auth?: { token?: { admin?: unknown } }; data?: unknown })
    const parsed = AdminCandidatePoolCountsInputSchema.safeParse(req.data ?? {})
    if (!parsed.success) {
      throw new HttpsError("invalid-argument", parsed.error.message)
    }
    const db = getFirestore()
    const cacheRef = db.collection(POOL_COUNTS_CACHE_COLLECTION).doc(POOL_COUNTS_CACHE_VERSION)
    // Serve a fresh cached result (the 4-collection scan is heavy) — repeat
    // loads are a single doc read. Recompute past the TTL.
    try {
      const snap = await cacheRef.get()
      const cached = snap.exists
        ? (snap.data() as { cachedAtMs?: number; result?: AdminCandidatePoolCountsResult })
        : undefined
      if (
        cached?.result &&
        typeof cached.cachedAtMs === "number" &&
        Date.now() - cached.cachedAtMs < POOL_COUNTS_CACHE_TTL_MS
      ) {
        return cached.result
      }
    } catch {
      /* cache read failure → recompute */
    }
    try {
      const result = await runAdminCandidatePoolCounts({ db })
      void cacheRef.set({ cachedAtMs: Date.now(), result }).catch(() => {})
      return result
    } catch (err) {
      logger.error("[admin-candidate-pool-counts] failed", err)
      throw new HttpsError("internal", "candidate pool counts aggregation failed")
    }
  },
)
