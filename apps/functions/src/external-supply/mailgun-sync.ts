/**
 * v2.0 External Supply V1.1 — Mailgun email-delivery sync callable.
 *
 * Adam directive 2026-05-14 ("let's not use instantly for now on the
 * pipeline, mailgun if enough, we can switch it"): external-supply
 * outreach plans dispatch via the existing `sendMailgun` transport in
 * `apps/functions/src/email/mailgun.ts` rather than through Instantly's
 * lead/campaign API. Instantly code stays in place for an easy switch
 * back; this callable is the new default sync path.
 *
 * Same lifecycle, gates, and idempotency as the Instantly version:
 *   1. Admin auth via `requireExternalSupplyAdmin`.
 *   2. Load plan; reject unless `approvalStatus === "approved"`.
 *   3. Re-evaluate suppression at callable entry (defence in depth).
 *   4. Live-mode env gate (silent downgrade to dry_run unless
 *      `EXTERNAL_SUPPLY_LIVE_OUTREACH_ENABLED=true` AND `MAILGUN_API_KEY`,
 *      `MAILGUN_DOMAIN`, `MAILGUN_FROM` all set).
 *   5. dry_run: persist the exact RFC-2822 payload to
 *      `pa-mailgun-sync-records/{syncId}` and exit without network.
 *   6. live: POST to `sendMailgun`; on success persist `mailgunMessageId`
 *      and flip plan -> `sent`; on failure persist error + flip plan ->
 *      `failed` so the dashboard surfaces it.
 */

import { randomUUID } from "node:crypto"
import { HttpsError, onCall } from "firebase-functions/v2/https"
import { logger } from "firebase-functions/v2"
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import { defineSecret } from "firebase-functions/params"
import {
  MailgunSyncRecordSchema,
  OutreachPlanSchema,
  PA_COLLECTIONS,
  type CandidateProfile,
  type MailgunSyncRecord,
  type OutreachEvent,
  type OutreachPlan,
} from "@pa/core-types"
import { evaluateSuppression, type SuppressionInputs } from "@pa/external-supply"
import { sendMailgun, type MailgunConfig, type MailgunSendInput } from "../email/mailgun.js"
import { requireExternalSupplyAdmin } from "./resolve-identity.js"

// Reuse existing project-level Mailgun secrets (already provisioned per
// qa-evaluator-weekly + backfill-ats-urls-batch). No new secret to land.
const MAILGUN_API_KEY = defineSecret("MAILGUN_API_KEY")
const MAILGUN_DOMAIN = defineSecret("MAILGUN_DOMAIN")
const MAILGUN_FROM = defineSecret("MAILGUN_FROM")
const MAILGUN_REGION = defineSecret("MAILGUN_REGION")

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SyncPlanToMailgunInput {
  planId: string
  mode: "dry_run" | "live"
  /** Optional operator-pinned `from`. Defaults to `MAILGUN_FROM` secret. */
  fromOverride?: string
}

export interface SyncPlanToMailgunResult {
  ok: true
  syncId: string
  syncStatus: MailgunSyncRecord["syncStatus"]
  mode: "dry_run" | "live"
  mailgunMessageId?: string
  downgraded?: boolean
  downgradedReason?: string
}

export interface MailgunSyncDeps {
  db: Firestore
  now?: () => string
  newId?: () => string
  readEnv?: (key: string) => string | undefined
  /** Hook for tests: override the Mailgun transport. */
  sendMail?: typeof sendMailgun
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

export async function runSyncPlanToMailgun(
  data: unknown,
  auth: CallableAuth,
  deps: MailgunSyncDeps,
): Promise<SyncPlanToMailgunResult> {
  requireExternalSupplyAdmin(auth)
  const { db } = deps
  const now = deps.now ?? (() => new Date().toISOString())
  const newId = deps.newId ?? (() => randomUUID())
  const readEnv = deps.readEnv ?? ((key: string) => process.env[key])
  const sendMail = deps.sendMail ?? sendMailgun

  const input = parseInput(data)
  const plan = await loadPlan(db, input.planId)
  if (plan.approvalStatus !== "approved") {
    throw new HttpsError(
      "failed-precondition",
      `Plan ${input.planId} status=${plan.approvalStatus}; sync requires approved.`,
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
  const emailRecipient = await loadPrimaryEmailHandle(db, plan.candidateId)
  const hasValidEmail = emailRecipient !== null

  const suppression = evaluateSuppression({
    profile,
    recentOutreachEvents: recentEvents,
    targetJobId: plan.jobId,
    targetCompanyId: plan.companyId,
    tier: plan.tier,
    hasValidEmail,
    hasPersonalization: Boolean(plan.personalizedHook),
    now,
  } satisfies SuppressionInputs)

  // Suppressed → record + bail without touching Mailgun.
  if (!suppression.allow) {
    const syncId = newId()
    const createdAt = now()
    const suppressedDoc: MailgunSyncRecord = {
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
    if (input.fromOverride) suppressedDoc.fromOverride = input.fromOverride
    const validated = MailgunSyncRecordSchema.parse(suppressedDoc)
    await db
      .collection(PA_COLLECTIONS.mailgunSyncRecords)
      .doc(syncId)
      .set(validated, { merge: false })
    return {
      ok: true,
      syncId,
      syncStatus: "suppressed",
      mode: input.mode,
    }
  }

  // Live-mode env gate (silent downgrade).
  let effectiveMode = input.mode
  let downgraded = false
  let downgradedReason: string | undefined
  const apiKey = readEnv("MAILGUN_API_KEY")
  const domain = readEnv("MAILGUN_DOMAIN")
  const defaultFrom = readEnv("MAILGUN_FROM")
  const region: "us" | "eu" = (readEnv("MAILGUN_REGION") ?? "us") === "eu" ? "eu" : "us"
  if (input.mode === "live") {
    const liveEnabled = readEnv("EXTERNAL_SUPPLY_LIVE_OUTREACH_ENABLED") === "true"
    if (!liveEnabled) {
      effectiveMode = "dry_run"
      downgraded = true
      downgradedReason = "live_outreach_flag_disabled"
    } else if (!apiKey || !apiKey.trim()) {
      effectiveMode = "dry_run"
      downgraded = true
      downgradedReason = "mailgun_api_key_missing"
    } else if (!domain || !domain.trim()) {
      effectiveMode = "dry_run"
      downgraded = true
      downgradedReason = "mailgun_domain_missing"
    } else if (!defaultFrom || !defaultFrom.trim()) {
      effectiveMode = "dry_run"
      downgraded = true
      downgradedReason = "mailgun_from_missing"
    }
  }

  if (!emailRecipient) {
    // Should have been caught by suppression `invalid_email`, but defence
    // in depth — never POST to Mailgun without a recipient.
    throw new HttpsError(
      "failed-precondition",
      `Plan ${input.planId} has no resolvable email recipient on the candidate.`,
    )
  }

  const fromHeader = input.fromOverride ?? defaultFrom ?? "claire@mg.wekruit.com"
  const subject = plan.emailSubject ?? `Quick note re: ${plan.jobId}`
  const text = plan.emailBody ?? plan.personalizedHook ?? ""
  if (!text || text.length === 0) {
    throw new HttpsError(
      "failed-precondition",
      `Plan ${input.planId} has empty emailBody / personalizedHook; cannot send.`,
    )
  }

  const sendInput: MailgunSendInput = {
    from: fromHeader,
    to: emailRecipient,
    subject,
    text,
  }

  const syncId = newId()
  const createdAt = now()
  const baseDoc: MailgunSyncRecord = {
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
  if (input.fromOverride) baseDoc.fromOverride = input.fromOverride

  if (effectiveMode === "dry_run") {
    const finalDoc: MailgunSyncRecord = {
      ...baseDoc,
      syncStatus: "dry_run_planned",
      dryRunPayload: {
        from: sendInput.from!,
        to: sendInput.to,
        subject: sendInput.subject,
        text: sendInput.text,
      },
      lastEventAt: createdAt,
    }
    await db
      .collection(PA_COLLECTIONS.mailgunSyncRecords)
      .doc(syncId)
      .set(MailgunSyncRecordSchema.parse(finalDoc), { merge: false })
    return {
      ok: true,
      syncId,
      syncStatus: "dry_run_planned",
      mode: effectiveMode,
      ...(downgraded ? { downgraded, downgradedReason } : {}),
    }
  }

  // Live send.
  const mailgunConfig: MailgunConfig = {
    apiKey: apiKey!,
    domain: domain!,
    from: defaultFrom!,
    region,
  }
  try {
    const result = await sendMail(mailgunConfig, sendInput)
    if (!result.ok) {
      const errMsg = `mailgun_${result.status}:${(result.rawResponse ?? "").slice(0, 200)}`
      await persistFailure(db, baseDoc, errMsg)
      await flipPlan(db, plan, "failed", createdAt)
      return { ok: true, syncId, syncStatus: "sync_failed", mode: effectiveMode }
    }
    const liveDoc: MailgunSyncRecord = {
      ...baseDoc,
      syncStatus: "synced",
      mode: "live",
      mailgunMessageId: result.messageId,
      liveSyncedAt: createdAt,
      lastEventAt: createdAt,
    }
    await db
      .collection(PA_COLLECTIONS.mailgunSyncRecords)
      .doc(syncId)
      .set(MailgunSyncRecordSchema.parse(liveDoc), { merge: false })
    await flipPlan(db, plan, "sent", createdAt)
    return {
      ok: true,
      syncId,
      syncStatus: "synced",
      mode: "live",
      mailgunMessageId: result.messageId,
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    logger.error("external_supply.mailgun_sync.failed", {
      syncId,
      planId: plan.planId,
      mode: effectiveMode,
      err: errMsg,
    })
    await persistFailure(db, baseDoc, errMsg)
    await flipPlan(db, plan, "failed", createdAt)
    return { ok: true, syncId, syncStatus: "sync_failed", mode: effectiveMode }
  }
}

// ---------------------------------------------------------------------------
// Helpers (parallel to instantly-sync helpers; kept local to bound diff)
// ---------------------------------------------------------------------------

function parseInput(data: unknown): SyncPlanToMailgunInput {
  const obj = data && typeof data === "object" ? (data as Record<string, unknown>) : {}
  const planId = typeof obj.planId === "string" ? obj.planId.trim() : ""
  if (!planId) throw new HttpsError("invalid-argument", "planId is required")
  const modeRaw = obj.mode
  if (modeRaw !== "dry_run" && modeRaw !== "live") {
    throw new HttpsError("invalid-argument", `mode must be "dry_run" or "live"`)
  }
  const fromOverride =
    typeof obj.fromOverride === "string" && obj.fromOverride.trim().length > 0
      ? obj.fromOverride.trim()
      : undefined
  return { planId, mode: modeRaw, fromOverride }
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
  return snap.data() as CandidateProfile
}

async function loadRecentOutreachEvents(
  db: Firestore,
  candidateId: string,
  now: () => string,
): Promise<OutreachEvent[]> {
  const cutoff = new Date(Date.now() - RECENT_EVENT_WINDOW_DAYS * DAY_MS).toISOString()
  // For tests / fakes that pass a deterministic `now`, prefer that anchor.
  const anchor = (() => {
    try {
      const ts = Date.parse(now())
      if (Number.isFinite(ts)) {
        return new Date(ts - RECENT_EVENT_WINDOW_DAYS * DAY_MS).toISOString()
      }
    } catch {
      /* fall through to cutoff */
    }
    return cutoff
  })()
  const snap = await db
    .collection(PA_COLLECTIONS.outreachEvents)
    .where("candidateId", "==", candidateId)
    .where("occurredAt", ">=", anchor)
    .get()
    .catch(() => null)
  if (!snap) return []
  return snap.docs.map((d) => d.data() as OutreachEvent)
}

async function loadPrimaryEmailHandle(
  db: Firestore,
  candidateId: string,
): Promise<string | null> {
  const snap = await db
    .collection(PA_COLLECTIONS.candidateHandles)
    .where("candidateId", "==", candidateId)
    .where("kind", "==", "email")
    .limit(5)
    .get()
    .catch(() => null)
  if (!snap || snap.empty) return null
  // Prefer a verified handle; fall back to first.
  const verified = snap.docs.find((d) => Boolean((d.data() as { verifiedAt?: unknown }).verifiedAt))
  const chosen = verified ?? snap.docs[0]!
  const raw = chosen.data() as { normalizedValue?: string }
  return typeof raw.normalizedValue === "string" && raw.normalizedValue.length > 0
    ? raw.normalizedValue
    : null
}

async function persistFailure(
  db: Firestore,
  baseDoc: MailgunSyncRecord,
  errMsg: string,
): Promise<void> {
  const failDoc: MailgunSyncRecord = {
    ...baseDoc,
    syncStatus: "sync_failed",
    error: errMsg.slice(0, 4000),
    lastEventAt: baseDoc.createdAt,
  }
  await db
    .collection(PA_COLLECTIONS.mailgunSyncRecords)
    .doc(baseDoc.syncId)
    .set(MailgunSyncRecordSchema.parse(failDoc), { merge: false })
}

async function flipPlan(
  db: Firestore,
  plan: OutreachPlan,
  approvalStatus: OutreachPlan["approvalStatus"],
  ts: string,
): Promise<void> {
  const updated: OutreachPlan = { ...plan, approvalStatus, updatedAt: ts }
  await db
    .collection(PA_COLLECTIONS.outreachPlans)
    .doc(plan.planId)
    .set(OutreachPlanSchema.parse(updated), { merge: false })
}

// ---------------------------------------------------------------------------
// Cloud Function wiring
// ---------------------------------------------------------------------------

export const paExternalSupplySyncPlanToMailgun = onCall(
  {
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 60,
    secrets: [MAILGUN_API_KEY, MAILGUN_DOMAIN, MAILGUN_FROM, MAILGUN_REGION],
  },
  async (req): Promise<SyncPlanToMailgunResult> => {
    // Hydrate process.env from secrets so the handler's readEnv() default
    // sees the live values (defineSecret doesn't expose `.value()` on the
    // runtime env automatically).
    try { process.env.MAILGUN_API_KEY = MAILGUN_API_KEY.value() } catch { /* secret optional */ }
    try { process.env.MAILGUN_DOMAIN = MAILGUN_DOMAIN.value() } catch { /* optional */ }
    try { process.env.MAILGUN_FROM = MAILGUN_FROM.value() } catch { /* optional */ }
    try { process.env.MAILGUN_REGION = MAILGUN_REGION.value() } catch { /* optional */ }
    return runSyncPlanToMailgun(req.data, req.auth, { db: getFirestore() })
  },
)
