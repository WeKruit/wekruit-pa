/**
 * v2.0 External Supply V1 — Wave C Block F2 — Instantly sync callable.
 *
 * `paExternalSupplySyncPlanToInstantly({ planId, mode, campaignId?, listId? })`
 *
 *  1. Admin auth gate.
 *  2. Load plan; require `approvalStatus === "approved"`.
 *  3. Re-evaluate suppression at callable entry against fresh state
 *     (profile.outreach + last 90d events). If blocked, write the sync
 *     record with `syncStatus: "suppressed"` and return.
 *  4. Live-mode env gate: when `mode === "live"` but
 *     `EXTERNAL_SUPPLY_LIVE_OUTREACH_ENABLED !== "true"` OR
 *     `INSTANTLY_API_KEY` missing — force mode to `dry_run`. We do NOT
 *     throw; this is so an operator's intent gets logged and the dry-run
 *     payload still gets stored.
 *  5. Call `createInstantlyClient.addLeadToList(...)`.
 *  6. Write `pa-instantly-sync-records/{syncId}` with the outcome.
 *  7. Bump plan to `approvalStatus: "sent"` on live success.
 *
 * Per F's lead resolutions (EXECUTOR-PLANS.md F):
 *  - Live env gate is the central safety lever. Even if operator presses
 *    "Sync live", we silently downgrade rather than throwing — important
 *    so the audit row still lands and the dashboard can show "downgraded
 *    to dry-run, supply env to enable live".
 *  - Suppression is re-evaluated AT CALLABLE ENTRY (not just at draft time)
 *    so a fresh opt-out / bounce / decline can still gate the plan.
 *  - V1 does NOT advance the v1.9 reducer; external-supply outreach is
 *    a separate track (F Q4 lead resolution).
 */

import { randomUUID } from "node:crypto"
import { HttpsError, onCall } from "firebase-functions/v2/https"
import { logger } from "firebase-functions/v2"
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import {
  InstantlySyncRecordSchema,
  OutreachPlanSchema,
  PA_COLLECTIONS,
  type CandidateProfile,
  type InstantlySyncRecord,
  type OutreachEvent,
  type OutreachPlan,
} from "@pa/core-types"
import {
  createInstantlyClient,
  evaluateSuppression,
  type SuppressionInputs,
} from "@pa/external-supply"
import { requireExternalSupplyAdmin } from "./resolve-identity.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SyncPlanToInstantlyInput {
  planId: string
  mode: "dry_run" | "live"
  campaignId?: string
  listId?: string
}

export interface SyncPlanToInstantlyResult {
  ok: true
  syncId: string
  syncStatus: InstantlySyncRecord["syncStatus"]
  mode: "dry_run" | "live"
  instantlyLeadId?: string
  downgraded?: boolean
  downgradedReason?: string
}

export interface SyncDeps {
  db: Firestore
  now?: () => string
  newId?: () => string
  readEnv?: (key: string) => string | undefined
  /** Hook for tests: override the Instantly client factory. */
  makeClient?: typeof createInstantlyClient
}

type CallableAuth = Parameters<typeof requireExternalSupplyAdmin>[0]

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RECENT_EVENT_WINDOW_DAYS = 90
const DAY_MS = 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function runSyncPlanToInstantly(
  data: unknown,
  auth: CallableAuth,
  deps: SyncDeps,
): Promise<SyncPlanToInstantlyResult> {
  requireExternalSupplyAdmin(auth)
  const { db } = deps
  const now = deps.now ?? (() => new Date().toISOString())
  const newId = deps.newId ?? (() => randomUUID())
  const readEnv = deps.readEnv ?? ((key: string) => process.env[key])
  const makeClient = deps.makeClient ?? createInstantlyClient

  const input = parseSyncInput(data)
  const plan = await loadPlan(db, input.planId)
  if (plan.approvalStatus !== "approved") {
    throw new HttpsError(
      "failed-precondition",
      `Plan ${input.planId} status=${plan.approvalStatus}; live sync requires approved.`,
    )
  }

  const profile = await loadCandidateProfile(db, plan.candidateId)
  if (!profile) {
    throw new HttpsError(
      "not-found",
      `Candidate profile not found for plan ${input.planId}: ${plan.candidateId}`,
    )
  }

  const recentEvents = await loadRecentOutreachEvents(db, plan.candidateId, now)
  const emailRecord = await loadPrimaryEmailHandle(db, plan.candidateId)
  const hasValidEmail = emailRecord !== null

  const suppressionInputs: SuppressionInputs = {
    profile,
    recentOutreachEvents: recentEvents,
    targetJobId: plan.jobId,
    targetCompanyId: plan.companyId,
    tier: plan.tier,
    hasValidEmail,
    hasPersonalization: Boolean(plan.personalizedHook),
    now,
  }
  const suppression = evaluateSuppression(suppressionInputs)

  if (!suppression.allow) {
    // Persist a suppressed sync record + bail without touching Instantly.
    const syncId = newId()
    const createdAt = now()
    const syncDoc: InstantlySyncRecord = {
      syncId,
      planId: plan.planId,
      candidateId: plan.candidateId,
      jobId: plan.jobId,
      companyId: plan.companyId,
      syncStatus: "suppressed",
      mode: input.mode,
      createdAt,
      updatedAt: createdAt,
      lastEventAt: createdAt,
      error: `suppressed:${suppression.blockedReasons.join(",")}`,
    }
    if (input.campaignId) syncDoc.campaignId = input.campaignId
    if (input.listId) syncDoc.listId = input.listId
    const validated = InstantlySyncRecordSchema.parse(syncDoc)
    await db
      .collection(PA_COLLECTIONS.instantlySyncRecords)
      .doc(syncId)
      .set(validated, { merge: false })
    return {
      ok: true,
      syncId,
      syncStatus: "suppressed",
      mode: input.mode,
    }
  }

  // Live-mode env gate (silent downgrade per F Q5 + spec).
  let effectiveMode = input.mode
  let downgraded = false
  let downgradedReason: string | undefined
  if (input.mode === "live") {
    const liveEnabled = readEnv("EXTERNAL_SUPPLY_LIVE_OUTREACH_ENABLED") === "true"
    const apiKey = readEnv("INSTANTLY_API_KEY")
    if (!liveEnabled) {
      effectiveMode = "dry_run"
      downgraded = true
      downgradedReason = "live_outreach_flag_disabled"
    } else if (!apiKey || apiKey.trim().length === 0) {
      effectiveMode = "dry_run"
      downgraded = true
      downgradedReason = "instantly_api_key_missing"
    }
  }

  const syncId = newId()
  const createdAt = now()
  const baseDoc: InstantlySyncRecord = {
    syncId,
    planId: plan.planId,
    candidateId: plan.candidateId,
    jobId: plan.jobId,
    companyId: plan.companyId,
    syncStatus: effectiveMode === "live" ? "queued" : "dry_run_planned",
    mode: effectiveMode,
    createdAt,
    updatedAt: createdAt,
  }
  if (input.campaignId) baseDoc.campaignId = input.campaignId
  if (input.listId) baseDoc.listId = input.listId

  const client = makeClient({ apiKey: readEnv("INSTANTLY_API_KEY") ?? "" })
  const addLeadPayload = {
    listId: input.listId ?? "",
    campaignId: input.campaignId,
    email: emailRecord ?? "",
    firstName: candidateFirstName(profile),
    customFields: {
      jobId: plan.jobId,
      companyId: plan.companyId,
      tier: plan.tier,
    },
  }

  let instantlyLeadId: string | undefined
  try {
    const result = await client.addLeadToList(addLeadPayload, { mode: effectiveMode })
    if (effectiveMode === "dry_run") {
      const finalDoc: InstantlySyncRecord = {
        ...baseDoc,
        syncStatus: "dry_run_planned",
        dryRunPayload: { ...result.payload },
        lastEventAt: createdAt,
      }
      await db
        .collection(PA_COLLECTIONS.instantlySyncRecords)
        .doc(syncId)
        .set(InstantlySyncRecordSchema.parse(finalDoc), { merge: false })
      return {
        ok: true,
        syncId,
        syncStatus: "dry_run_planned",
        mode: effectiveMode,
        ...(downgraded ? { downgraded, downgradedReason } : {}),
      }
    }
    // Live success path.
    instantlyLeadId = result.result?.instantlyLeadId
    const liveDoc: InstantlySyncRecord = {
      ...baseDoc,
      syncStatus: "synced",
      mode: "live",
      instantlyLeadId,
      liveSyncedAt: createdAt,
      lastEventAt: createdAt,
    }
    await db
      .collection(PA_COLLECTIONS.instantlySyncRecords)
      .doc(syncId)
      .set(InstantlySyncRecordSchema.parse(liveDoc), { merge: false })
    // Bump plan to `sent` on live success.
    const updatedPlan: OutreachPlan = {
      ...plan,
      approvalStatus: "sent",
      updatedAt: createdAt,
    }
    await db
      .collection(PA_COLLECTIONS.outreachPlans)
      .doc(plan.planId)
      .set(OutreachPlanSchema.parse(updatedPlan), { merge: false })
    return {
      ok: true,
      syncId,
      syncStatus: "synced",
      mode: "live",
      instantlyLeadId,
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    logger.error("external_supply.instantly_sync.failed", {
      syncId,
      planId: plan.planId,
      mode: effectiveMode,
      err: errMsg,
    })
    const failDoc: InstantlySyncRecord = {
      ...baseDoc,
      syncStatus: "sync_failed",
      error: errMsg.slice(0, 4000),
      lastEventAt: createdAt,
    }
    await db
      .collection(PA_COLLECTIONS.instantlySyncRecords)
      .doc(syncId)
      .set(InstantlySyncRecordSchema.parse(failDoc), { merge: false })
    // Bump plan to failed so dashboard surfaces it.
    const failedPlan: OutreachPlan = {
      ...plan,
      approvalStatus: "failed",
      updatedAt: createdAt,
    }
    await db
      .collection(PA_COLLECTIONS.outreachPlans)
      .doc(plan.planId)
      .set(OutreachPlanSchema.parse(failedPlan), { merge: false })
    return {
      ok: true,
      syncId,
      syncStatus: "sync_failed",
      mode: effectiveMode,
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseSyncInput(data: unknown): SyncPlanToInstantlyInput {
  const obj = data && typeof data === "object" ? (data as Record<string, unknown>) : {}
  const planId = typeof obj.planId === "string" ? obj.planId.trim() : ""
  if (!planId) throw new HttpsError("invalid-argument", "planId is required")
  const modeRaw = obj.mode
  if (modeRaw !== "dry_run" && modeRaw !== "live") {
    throw new HttpsError("invalid-argument", `mode must be "dry_run" or "live"`)
  }
  const campaignId =
    typeof obj.campaignId === "string" && obj.campaignId.trim().length > 0
      ? obj.campaignId.trim()
      : undefined
  const listId =
    typeof obj.listId === "string" && obj.listId.trim().length > 0
      ? obj.listId.trim()
      : undefined
  return { planId, mode: modeRaw, campaignId, listId }
}

async function loadPlan(db: Firestore, planId: string): Promise<OutreachPlan> {
  const snap = await db.collection(PA_COLLECTIONS.outreachPlans).doc(planId).get()
  if (!snap.exists) {
    throw new HttpsError("not-found", `Plan ${planId} not found.`)
  }
  const parsed = OutreachPlanSchema.safeParse(snap.data())
  if (!parsed.success) {
    throw new HttpsError(
      "failed-precondition",
      `Plan ${planId} schema invalid: ${parsed.error.message.slice(0, 200)}`,
    )
  }
  return parsed.data
}

async function loadCandidateProfile(
  db: Firestore,
  candidateId: string,
): Promise<CandidateProfile | null> {
  const snap = await db.collection(PA_COLLECTIONS.users).doc(candidateId).get()
  if (!snap.exists) return null
  const raw = snap.data() as Record<string, unknown> | undefined
  if (!raw) return null
  return {
    candidateId,
    candidateLifecycleState:
      (raw.candidateLifecycleState as CandidateProfile["candidateLifecycleState"]) ??
      "prospect",
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : undefined,
    globalTags: (raw.globalTags as CandidateProfile["globalTags"]) ?? undefined,
    latestResumeArtifactId:
      typeof raw.latestResumeArtifactId === "string"
        ? raw.latestResumeArtifactId
        : undefined,
    linkedinUrl: typeof raw.linkedinUrl === "string" ? raw.linkedinUrl : undefined,
    outreach: (raw.outreach as CandidateProfile["outreach"]) ?? undefined,
  }
}

async function loadRecentOutreachEvents(
  db: Firestore,
  candidateId: string,
  now: () => string,
): Promise<OutreachEvent[]> {
  try {
    const snap = await db
      .collection(PA_COLLECTIONS.outreachEvents)
      .where("candidateId", "==", candidateId)
      .get()
    const cutoff = Date.parse(now()) - RECENT_EVENT_WINDOW_DAYS * DAY_MS
    const out: OutreachEvent[] = []
    for (const doc of snap.docs) {
      const data = doc.data() as OutreachEvent
      const occurred = Date.parse(data.occurredAt ?? "")
      if (Number.isNaN(occurred) || occurred >= cutoff) {
        out.push(data)
      }
    }
    return out
  } catch {
    return []
  }
}

async function loadPrimaryEmailHandle(
  db: Firestore,
  candidateId: string,
): Promise<string | null> {
  try {
    const snap = await db
      .collection(PA_COLLECTIONS.candidateHandles)
      .where("candidateId", "==", candidateId)
      .get()
    for (const doc of snap.docs) {
      const data = doc.data() as Record<string, unknown>
      if (data.kind === "email" && typeof data.normalizedValue === "string") {
        return data.normalizedValue
      }
    }
    return null
  } catch {
    return null
  }
}

function candidateFirstName(profile: CandidateProfile): string | undefined {
  const raw = (profile as unknown as { displayName?: string }).displayName
  if (typeof raw === "string" && raw.trim().length > 0) {
    const first = raw.trim().split(/\s+/)[0]
    if (first) return first
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Production CF wrapper
// ---------------------------------------------------------------------------

export const paExternalSupplySyncPlanToInstantly = onCall(
  {
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 120,
  },
  async (req): Promise<SyncPlanToInstantlyResult> => {
    return runSyncPlanToInstantly(req.data, req.auth, { db: getFirestore() })
  },
)
