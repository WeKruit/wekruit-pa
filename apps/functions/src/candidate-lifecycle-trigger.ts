import { createHash } from "node:crypto"
import { onCall, HttpsError } from "firebase-functions/v2/https"
import { defineSecret } from "firebase-functions/params"
import { logger } from "firebase-functions/v2"
import { getFirestore } from "firebase-admin/firestore"
import { z } from "zod"
import { enqueueOutbound as defaultEnqueueOutbound } from "@pa/pa-broker"
import { authorizeAdminCallable } from "./promote-sandbox-tag.js"

const PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN")

export const CANDIDATE_LIFECYCLE_EVENT_COLLECTION = "pa-candidate-lifecycle-events"

const LAYOFF_SOURCE = "WeKruit_Laid_Off"
const GLOBAL_OUTBOUND_COOLDOWN_DAYS = 7

export const LifecycleTriggerEventTypeSchema = z.enum([
  "laid_off_checkin",
  "match_notification",
  "profile_freshness_nudge",
  "status_followup",
])
export type LifecycleTriggerEventType = z.infer<typeof LifecycleTriggerEventTypeSchema>

export const CandidateLifecycleTriggerInputSchema = z.object({
  candidateId: z.string().trim().min(1),
  eventType: LifecycleTriggerEventTypeSchema,
  eventReason: z.string().trim().min(3).max(500),
  dryRun: z.boolean().optional().default(true),
  job: z
    .object({
      jobId: z.string().trim().min(1),
      jobTitle: z.string().trim().min(1),
      companyName: z.string().trim().optional(),
      jobUrl: z.string().trim().url(),
      requirements: z.array(z.string().trim().min(1)).min(1),
      matchReason: z.string().trim().optional(),
      matchId: z.string().trim().optional(),
    })
    .optional(),
  adminToken: z.string().optional(),
})
export type CandidateLifecycleTriggerInput = z.infer<typeof CandidateLifecycleTriggerInputSchema>

export type CandidateLifecycleSnapshot = {
  candidateId: string
  displayName?: string
  source?: string
  phoneE164?: string
  imessageChatId?: string
  doNotContact?: boolean
  outreachPaused?: boolean
  candidateLifecycleState?: string
  outreach?: {
    status?: string
    lastOutboundAt?: string
    cooldownUntil?: string
  }
  lifecycle?: {
    cooldowns?: Record<string, { until?: string; count?: number; lastSentAt?: string }>
  }
  workSession?: {
    kind?: string
    status?: string
    boundary?: string
  }
  layoffContext?: Record<string, unknown>
}

export type LifecycleTriggerDecision =
  | {
      decision: "send"
      status: "send_ready"
      eventType: LifecycleTriggerEventType
      eventReason: string
      cooldownKey: string
      cooldownUntil: string
      reason: string
      reasons: string[]
      blockedSignals: []
      body: string
      evidence: Record<string, unknown>
    }
  | {
      decision: "do_not_send"
      status: "suppressed"
      eventType: LifecycleTriggerEventType
      eventReason: string
      cooldownKey: string
      cooldownUntil?: string
      reason: string
      reasons: string[]
      blockedSignals: string[]
      evidence: Record<string, unknown>
    }

export type LifecycleTriggerResult = {
  ok: true
  candidateId: string
  eventId: string
  decision: LifecycleTriggerDecision
  outboundId?: string
  dryRun: boolean
}

export type CandidateLifecycleTriggerDeps = {
  readCandidate(candidateId: string): Promise<CandidateLifecycleSnapshot | null>
  hasActivePrescreenSession?(candidateId: string): Promise<boolean>
  writeLifecycleEvent(eventId: string, row: Record<string, unknown>): Promise<void>
  updateLifecycleEvent?(eventId: string, patch: Record<string, unknown>): Promise<void>
  enqueueOutbound?(input: {
    userId: string
    toE164: string
    imessageChatId?: string
    body: string
    idempotencyKey: string
  }): Promise<{ id: string; created: boolean }>
  updateCandidate?(candidateId: string, patch: Record<string, unknown>): Promise<void>
  now(): string
  log?: (...args: unknown[]) => void
}

function hashId(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32)
}

function parseMs(value: string | undefined): number {
  if (!value) return 0
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : 0
}

function addDaysIso(nowIso: string, days: number): string {
  return new Date(parseMs(nowIso) + days * 24 * 60 * 60 * 1000).toISOString()
}

function isFuture(value: string | undefined, nowIso: string): boolean {
  const ms = parseMs(value)
  return ms > 0 && ms > parseMs(nowIso)
}

function isWithinDays(value: string | undefined, nowIso: string, days: number): boolean {
  const valueMs = parseMs(value)
  const nowMs = parseMs(nowIso)
  if (!valueMs || !nowMs) return false
  return nowMs >= valueMs && nowMs - valueMs < days * 24 * 60 * 60 * 1000
}

function firstName(displayName: string | undefined): string {
  const token = (displayName ?? "").trim().split(/\s+/)[0] ?? ""
  return token.length > 1 ? token : ""
}

function cooldownDaysFor(eventType: LifecycleTriggerEventType): number {
  switch (eventType) {
    case "laid_off_checkin":
      return 14
    case "match_notification":
      return 7
    case "profile_freshness_nudge":
      return 30
    case "status_followup":
      return 21
  }
}

function cooldownKeyFor(input: CandidateLifecycleTriggerInput): string {
  if (input.eventType === "match_notification" && input.job?.jobId) {
    return `match_notification:${input.job.jobId}`
  }
  return input.eventType
}

function activeWorkSessionKind(candidate: CandidateLifecycleSnapshot): string | undefined {
  const session = candidate.workSession
  if (!session || session.status !== "active") return undefined
  return session.kind || "unknown"
}

function renderLifecycleBody(input: {
  candidate: CandidateLifecycleSnapshot
  request: CandidateLifecycleTriggerInput
}): string {
  const name = firstName(input.candidate.displayName)
  const prefix = name ? `Hey ${name}, Claire from WeKruit here.` : "Claire from WeKruit here."
  const job = input.request.job

  switch (input.request.eventType) {
    case "laid_off_checkin":
      return `${prefix} Checking in because you shared the layoff update. How are things going this week, and has what you want next changed?`
    case "match_notification": {
      const company = job?.companyName ? ` at ${job.companyName}` : ""
      const requirements = job?.requirements?.length
        ? ` Requirements: ${job.requirements.slice(0, 5).join(", ")}.`
        : ""
      const reason = job?.matchReason
        ? ` I remember the context you shared: ${job.matchReason}`
        : " I matched this from the profile details you shared."
      const url = job?.jobUrl ? ` Link: ${job.jobUrl}.` : ""
      return `${prefix} I found a role based on what you shared: ${job?.jobTitle}${company}.${requirements}${reason}${url} Want me to start the quick screen for it?`
    }
    case "profile_freshness_nudge":
      return `${prefix} Quick profile check-in: are your target roles, location, visa/work authorization, and availability still accurate? A short update is enough.`
    case "status_followup":
      return `${prefix} How is the search going now: still looking, interviewing, or did things change?`
  }
}

function blockDecision(input: {
  request: CandidateLifecycleTriggerInput
  cooldownKey: string
  reason: string
  blockedSignals: string[]
  reasons?: string[]
  cooldownUntil?: string
  evidence?: Record<string, unknown>
}): LifecycleTriggerDecision {
  return {
    decision: "do_not_send",
    status: "suppressed",
    eventType: input.request.eventType,
    eventReason: input.request.eventReason,
    cooldownKey: input.cooldownKey,
    ...(input.cooldownUntil ? { cooldownUntil: input.cooldownUntil } : {}),
    reason: input.reason,
    reasons: input.reasons ?? [input.reason],
    blockedSignals: input.blockedSignals,
    evidence: input.evidence ?? {},
  }
}

export function evaluateCandidateLifecycleTrigger(input: {
  request: CandidateLifecycleTriggerInput
  candidate: CandidateLifecycleSnapshot
  now: string
  activePrescreen?: boolean
}): LifecycleTriggerDecision {
  const { request, candidate, now } = input
  const cooldownKey = cooldownKeyFor(request)
  const activeKind = activeWorkSessionKind(candidate)

  if (candidate.candidateLifecycleState === "deleted") {
    return blockDecision({
      request,
      cooldownKey,
      reason: "candidate profile is deleted",
      blockedSignals: ["candidate_deleted"],
    })
  }
  if (candidate.doNotContact || candidate.outreach?.status === "opted_out") {
    return blockDecision({
      request,
      cooldownKey,
      reason: "candidate opted out or is marked do-not-contact",
      blockedSignals: ["opted_out"],
    })
  }
  if (candidate.outreachPaused || candidate.outreach?.status === "paused") {
    return blockDecision({
      request,
      cooldownKey,
      reason: "candidate outreach is paused",
      blockedSignals: ["outreach_paused"],
    })
  }
  if (!candidate.phoneE164) {
    return blockDecision({
      request,
      cooldownKey,
      reason: "candidate has no reachable phone for lifecycle message",
      blockedSignals: ["unreachable"],
    })
  }
  if (activeKind || input.activePrescreen) {
    return blockDecision({
      request,
      cooldownKey,
      reason: "candidate has an active work session; lifecycle message would interrupt it",
      blockedSignals: ["active_session"],
      evidence: {
        activeSessionKind: activeKind ?? "job_prescreen",
      },
    })
  }
  if (isFuture(candidate.outreach?.cooldownUntil, now)) {
    return blockDecision({
      request,
      cooldownKey,
      reason: "candidate outbound cooldown is active",
      blockedSignals: ["cooldown_active"],
      cooldownUntil: candidate.outreach?.cooldownUntil,
    })
  }
  if (isWithinDays(candidate.outreach?.lastOutboundAt, now, GLOBAL_OUTBOUND_COOLDOWN_DAYS)) {
    return blockDecision({
      request,
      cooldownKey,
      reason: "candidate has recent outbound outreach",
      blockedSignals: ["cooldown_active"],
      cooldownUntil: addDaysIso(candidate.outreach!.lastOutboundAt!, GLOBAL_OUTBOUND_COOLDOWN_DAYS),
    })
  }

  const lifecycleCooldown = candidate.lifecycle?.cooldowns?.[cooldownKey]
  if (isFuture(lifecycleCooldown?.until, now)) {
    return blockDecision({
      request,
      cooldownKey,
      reason: "lifecycle event cooldown is active",
      blockedSignals: ["lifecycle_cooldown_active"],
      cooldownUntil: lifecycleCooldown?.until,
    })
  }

  if (request.eventType === "laid_off_checkin") {
    const hasLayoffContext = Boolean(candidate.layoffContext && Object.keys(candidate.layoffContext).length > 0)
    if (candidate.source !== LAYOFF_SOURCE && !hasLayoffContext) {
      return blockDecision({
        request,
        cooldownKey,
        reason: "laid-off check-in requires a layoff source or layoff context",
        blockedSignals: ["missing_layoff_context"],
      })
    }
  }

  if (request.eventType === "match_notification" && !request.job) {
    return blockDecision({
      request,
      cooldownKey,
      reason: "match notification requires job context",
      blockedSignals: ["missing_job_context"],
    })
  }
  if (
    request.eventType === "match_notification" &&
    (!request.job?.jobUrl || !Array.isArray(request.job.requirements) || request.job.requirements.length === 0)
  ) {
    return blockDecision({
      request,
      cooldownKey,
      reason: "match notification requires a job link and requirements",
      blockedSignals: ["missing_job_link_or_requirements"],
    })
  }

  const cooldownUntil = addDaysIso(now, cooldownDaysFor(request.eventType))
  return {
    decision: "send",
    status: "send_ready",
    eventType: request.eventType,
    eventReason: request.eventReason,
    cooldownKey,
    cooldownUntil,
    reason: "candidate-value lifecycle message is eligible",
    reasons: [
      "explicit event reason present",
      "candidate is reachable",
      "no active work session",
      "no relevant cooldown or suppression",
    ],
    blockedSignals: [],
    body: renderLifecycleBody({ candidate, request }),
    evidence: {
      source: candidate.source ?? null,
      jobId: request.job?.jobId ?? null,
      matchId: request.job?.matchId ?? null,
    },
  }
}

function eventIdFor(input: {
  candidateId: string
  cooldownKey: string
  now: string
  dryRun: boolean
}): string {
  const day = input.now.slice(0, 10)
  const mode = input.dryRun ? "dry-run" : "live"
  return `lifecycle_${hashId(`${input.candidateId}:${input.cooldownKey}:${day}:${mode}`)}`
}

function eventRow(input: {
  eventId: string
  request: CandidateLifecycleTriggerInput
  candidate: CandidateLifecycleSnapshot
  decision: LifecycleTriggerDecision
  dryRun: boolean
  now: string
  actor?: string
}): Record<string, unknown> {
  const status =
    input.decision.decision === "send"
      ? input.dryRun
        ? "dry_run_send"
        : "queued_pending"
      : "suppressed"
  return {
    id: input.eventId,
    candidateId: input.candidate.candidateId,
    eventType: input.request.eventType,
    eventReason: input.request.eventReason,
    source: "candidate_lifecycle",
    status,
    dryRun: input.dryRun,
    decision: input.decision.decision,
    decisionReason: input.decision.reason,
    reasons: input.decision.reasons,
    blockedSignals: input.decision.blockedSignals,
    cooldownKey: input.decision.cooldownKey,
    ...(input.decision.cooldownUntil ? { cooldownUntil: input.decision.cooldownUntil } : {}),
    ...(input.decision.decision === "send" ? { body: input.decision.body } : {}),
    candidateSnapshot: {
      source: input.candidate.source ?? null,
      candidateLifecycleState: input.candidate.candidateLifecycleState ?? null,
      outreachStatus: input.candidate.outreach?.status ?? null,
    },
    ...(input.request.job ? { job: input.request.job } : {}),
    evidence: input.decision.evidence,
    workSession: {
      kind: "candidate_lifecycle",
      status: input.decision.decision === "send" ? "planned" : "ended",
      boundary: input.decision.decision === "send" ? "event_trigger" : "suppressed",
      startedAt: input.now,
      ...(input.decision.decision === "do_not_send" ? { endedAt: input.now } : {}),
    },
    actor: input.actor ?? "system",
    createdAt: input.now,
    updatedAt: input.now,
  }
}

export async function runCandidateLifecycleTrigger(
  request: CandidateLifecycleTriggerInput,
  deps: CandidateLifecycleTriggerDeps,
  actor = "system",
): Promise<LifecycleTriggerResult> {
  const now = deps.now()
  const candidate = await deps.readCandidate(request.candidateId)
  if (!candidate) {
    throw new HttpsError("not-found", "candidate not found")
  }
  const activePrescreen = deps.hasActivePrescreenSession
    ? await deps.hasActivePrescreenSession(request.candidateId)
    : false
  const decision = evaluateCandidateLifecycleTrigger({ request, candidate, now, activePrescreen })
  const eventId = eventIdFor({
    candidateId: request.candidateId,
    cooldownKey: decision.cooldownKey,
    now,
    dryRun: request.dryRun,
  })
  await deps.writeLifecycleEvent(eventId, eventRow({
    eventId,
    request,
    candidate,
    decision,
    dryRun: request.dryRun,
    now,
    actor,
  }))

  let outboundId: string | undefined
  if (decision.decision === "send" && !request.dryRun) {
    if (!deps.enqueueOutbound) throw new HttpsError("failed-precondition", "enqueue dependency missing")
    if (!deps.updateCandidate) throw new HttpsError("failed-precondition", "candidate update dependency missing")
    const queued = await deps.enqueueOutbound({
      userId: candidate.candidateId,
      toE164: candidate.phoneE164!,
      ...(candidate.imessageChatId ? { imessageChatId: candidate.imessageChatId } : {}),
      body: decision.body,
      idempotencyKey: `candidate_lifecycle:${candidate.candidateId}:${decision.cooldownKey}:${now.slice(0, 10)}`,
    })
    outboundId = queued.id
    await deps.updateLifecycleEvent?.(eventId, {
      status: "queued",
      outboundId,
      outboundCreated: queued.created,
      workSession: {
        kind: "candidate_lifecycle",
        status: "active",
        boundary: "event_trigger",
        startedAt: now,
      },
      updatedAt: now,
    })
    await deps.updateCandidate(candidate.candidateId, {
      lifecycle: {
        lastTouchAt: now,
        lastTouchType: request.eventType,
        lastLifecycleEventId: eventId,
        cooldowns: {
          [decision.cooldownKey]: {
            until: decision.cooldownUntil,
            lastSentAt: now,
          },
        },
      },
      outreach: {
        ...(candidate.outreach ?? {}),
        lastOutboundAt: now,
      },
      updatedAt: now,
    })
  }

  deps.log?.("[candidate-lifecycle] decision", {
    candidateId: request.candidateId,
    eventType: request.eventType,
    decision: decision.decision,
    eventId,
    outboundId,
    dryRun: request.dryRun,
  })

  return {
    ok: true,
    candidateId: candidate.candidateId,
    eventId,
    decision,
    ...(outboundId ? { outboundId } : {}),
    dryRun: request.dryRun,
  }
}

async function hasActivePrescreenSession(db: ReturnType<typeof getFirestore>, candidateId: string): Promise<boolean> {
  const snap = await db
    .collection("pa-prescreen-sessions")
    .where("userId", "==", candidateId)
    .where("terminal", "==", null)
    .limit(1)
    .get()
  return !snap.empty
}

export const paCandidateLifecycleTrigger = onCall(
  {
    region: "us-central1",
    memory: "256MiB",
    secrets: [PA_ADMIN_TOKEN],
  },
  async (req): Promise<LifecycleTriggerResult> => {
    const { uid } = authorizeAdminCallable(
      req as { auth?: { token?: { admin?: unknown } }; data?: unknown },
    )
    const parsed = CandidateLifecycleTriggerInputSchema.safeParse(req.data)
    if (!parsed.success) {
      throw new HttpsError("invalid-argument", parsed.error.message)
    }
    const db = getFirestore()
    return runCandidateLifecycleTrigger(parsed.data, {
      readCandidate: async (candidateId) => {
        const snap = await db.collection("pa-users").doc(candidateId).get()
        if (!snap.exists) return null
        return { candidateId: snap.id, ...(snap.data() as Record<string, unknown>) } as CandidateLifecycleSnapshot
      },
      hasActivePrescreenSession: (candidateId) => hasActivePrescreenSession(db, candidateId),
      writeLifecycleEvent: async (eventId, row) => {
        await db.collection(CANDIDATE_LIFECYCLE_EVENT_COLLECTION).doc(eventId).set(row, { merge: true })
      },
      updateLifecycleEvent: async (eventId, patch) => {
        await db.collection(CANDIDATE_LIFECYCLE_EVENT_COLLECTION).doc(eventId).set(patch, { merge: true })
      },
      enqueueOutbound: (input) => defaultEnqueueOutbound(db, input),
      updateCandidate: async (candidateId, patch) => {
        await db.collection("pa-users").doc(candidateId).set(patch, { merge: true })
      },
      now: () => new Date().toISOString(),
      log: (...args) => logger.info("[candidate-lifecycle]", ...args),
    }, uid)
  },
)
