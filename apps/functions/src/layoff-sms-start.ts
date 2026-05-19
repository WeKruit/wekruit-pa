import type { Firestore } from "firebase-admin/firestore"
import { FieldValue } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import {
  SHARED_ONBOARDING_EVENT_KIND,
  SHARED_ONBOARDING_EVENT_SOURCE,
  SHARED_ONBOARDING_QUESTIONS,
  buildSharedOnboardingPrompt,
  buildSharedOnboardingPromptContext,
  buildSharedOnboardingStartedState,
  loadSharedOnboardingParsedResumeForPrompt,
  WEKRUIT_LAYOFF_SOURCE,
  WEKRUIT_CANDIDATE_SOURCE,
  type SharedOnboardingPromptContext,
  type WekruitSignupSource,
} from "@pa/pa-orchestrator"
import { hashStringToUint } from "./sendblue/pool.js"
import { enqueueRuntimeEventHandoff } from "./runtime-event-handoff.js"

// 2026-05-19 — legacy candidate-visible trigger tokens were removed. The
// website/callable flow owns onboarding kickoff via runLayoffSmsStart →
// shared_onboarding runtime event; any inbound token resembling the old
// strings is suppressed at apps/functions/src/sendblue/triggers/layoff.ts.

export type RunLayoffSmsStartArgs = {
  db: Firestore
  userId: string
  toE164: string
  /** Defaults to WEKRUIT_LAYOFF_SOURCE for back-compat with existing callers. */
  source?: WekruitSignupSource
  runRuntimeKickoff?: (args: {
    db: Firestore
    userId: string
    toE164: string
    startedAt: string
    source: WekruitSignupSource
    promptContext?: SharedOnboardingPromptContext
  }) => Promise<{ eventId: string; outboundId?: string }>
  log?: (event: string, payload?: Record<string, unknown>) => void
}

export type RunLayoffSmsStartResult =
  | {
      ok: true
      kickoffOutboundId: string
      kickoffCreated: boolean
      sourceTag: WekruitSignupSource
    }
  | { ok: false; reason: "user_not_found" | "missing_phone" }

function phoneIndexId(e164: string): string {
  return `p_${hashStringToUint(e164).toString(36)}`
}

export function buildOnboardingStartedFields(
  nowIso: string,
  source: WekruitSignupSource = WEKRUIT_LAYOFF_SOURCE,
  promptContext?: SharedOnboardingPromptContext,
): Record<string, unknown> {
  return buildSharedOnboardingStartedState(nowIso, source, promptContext)
}

/** Back-compat alias — existing callers still want the layoff-flavored fields. */
export function buildLayoffOnboardingStartedFields(nowIso: string): Record<string, unknown> {
  return buildOnboardingStartedFields(nowIso, WEKRUIT_LAYOFF_SOURCE)
}

async function runDefaultRuntimeKickoff(args: {
  db: Firestore
  userId: string
  toE164: string
  startedAt: string
  source: WekruitSignupSource
  promptContext?: SharedOnboardingPromptContext
}): Promise<{ eventId: string; outboundId?: string }> {
  const q1 = SHARED_ONBOARDING_QUESTIONS[0]
  const idempotencyKey = `${SHARED_ONBOARDING_EVENT_SOURCE}:${args.userId}:${args.startedAt}`
  const runtime = await enqueueRuntimeEventHandoff(args.db, {
    userId: args.userId,
    toE164: args.toE164,
    channel: "imessage",
    source: SHARED_ONBOARDING_EVENT_SOURCE,
    eventKind: SHARED_ONBOARDING_EVENT_KIND,
    idempotencyKey,
    requireExistingSession: false,
    nowIso: () => args.startedAt,
    context: {
      signupSource: args.source,
      workSessionKind: "shared_onboarding",
      startedAt: args.startedAt,
      questionId: q1.id,
      questionText: buildSharedOnboardingPrompt(q1.id, args.promptContext),
      ...(args.promptContext && Object.keys(args.promptContext).length > 0
        ? { promptContext: args.promptContext }
        : {}),
    },
  })
  if (!runtime.ok) {
    throw new Error(`runtime_kickoff_failed:${runtime.reason}`)
  }
  return { eventId: runtime.eventId }
}

export function isLayoffIntakeActiveDoc(data: unknown): boolean {
  if (!data || typeof data !== "object") return false
  const doc = data as Record<string, unknown>
  const workSession = doc.workSession && typeof doc.workSession === "object"
    ? doc.workSession as Record<string, unknown>
    : null
  if (workSession?.kind === "shared_onboarding" && workSession.status === "active") return true
  if (workSession?.kind === "layoff_onboarding" && workSession.status === "active") return true
  return false
}

export async function isLayoffIntakeActiveForUser(db: Firestore, userId: string): Promise<boolean> {
  if (!userId) return false
  const snap = await db.collection(PA_COLLECTIONS.users).doc(userId).get()
  return isLayoffIntakeActiveDoc(snap.data())
}

export async function supersedeActivePrescreensForLayoff(
  db: Firestore,
  input: { candidateId: string; nowIso: string },
): Promise<void> {
  const sessionsCollection = db.collection("pa-prescreen-sessions")
  if (typeof (sessionsCollection as unknown as { where?: unknown }).where !== "function") return
  const snap = await sessionsCollection
    .where("userId", "==", input.candidateId)
    .where("terminal", "==", null)
    .get()
  await Promise.all(
    snap.docs.map((doc) =>
      doc.ref.set(
        {
          terminal: "PAUSE",
          terminalReason: "superseded_by_layoff_onboarding",
          currentQId: null,
          supersededAt: input.nowIso,
          updatedAt: input.nowIso,
          workSession: {
            kind: "job_prescreen",
            status: "ended",
            endedAt: input.nowIso,
            boundary: "superseded",
            supersededBy: "layoff_onboarding",
          },
        },
        { merge: true },
      ),
    ),
  )
}

/**
 * Shared kickoff path for both layoff.wekruit.com and candidate.wekruit.com.
 * The product invariant is one pa-users row, one source flag, one Claire opener.
 */
export async function runLayoffSmsStart(
  args: RunLayoffSmsStartArgs,
): Promise<RunLayoffSmsStartResult> {
  const userRef = args.db.collection(PA_COLLECTIONS.users).doc(args.userId)
  const userSnap = await userRef.get()
  if (!userSnap.exists) return { ok: false, reason: "user_not_found" }

  const user = userSnap.data() as Record<string, unknown>
  const phoneE164 = args.toE164 || (typeof user.phoneE164 === "string" ? user.phoneE164 : "")
  if (!phoneE164) return { ok: false, reason: "missing_phone" }

  const source: WekruitSignupSource = args.source ?? WEKRUIT_LAYOFF_SOURCE
  const isLayoff = source === WEKRUIT_LAYOFF_SOURCE

  const startedAt = new Date().toISOString()
  const parsedResume = await loadSharedOnboardingParsedResumeForPrompt(args.db, args.userId, user, args.log)
  const promptContext = buildSharedOnboardingPromptContext({ user, parsedResume })
  const startedFields = buildOnboardingStartedFields(startedAt, source, promptContext)
  const phoneHash = phoneIndexId(phoneE164)

  const initialPayload: Record<string, unknown> = {
    source,
    updatedAt: startedAt,
    smsState: "shared-onboarding-starting",
    smsThreadId: `iMessage;-;${phoneE164}`,
    ...startedFields,
  }
  if (isLayoff) {
    initialPayload.lastLaidOffAt = FieldValue.serverTimestamp()
    initialPayload.layoffContext = {
      sms: {
        phoneE164,
        smsTriggeredAt: FieldValue.serverTimestamp(),
      },
    }
  } else {
    initialPayload.candidateContext = {
      sms: {
        phoneE164,
        smsTriggeredAt: FieldValue.serverTimestamp(),
      },
    }
  }

  await userRef.set(initialPayload, { merge: true })
  await userRef.update({ workSession: startedFields.workSession })

  if (isLayoff) {
    await args.db.collection("layoff_phone_index").doc(phoneHash).set(
      {
        candidateId: args.userId,
        lastLaidOffAt: FieldValue.serverTimestamp(),
        phoneHash,
      },
      { merge: true },
    )
  }

  const pendingTriggerRef = args.db.collection("pa-ats-pending-trigger").doc(phoneE164)
  const deletePendingTrigger = (pendingTriggerRef as unknown as { delete?: () => Promise<unknown> }).delete
  if (typeof deletePendingTrigger === "function") {
    await deletePendingTrigger.call(pendingTriggerRef).catch(() => undefined)
  }
  if (isLayoff) {
    await supersedeActivePrescreensForLayoff(args.db, {
      candidateId: args.userId,
      nowIso: startedAt,
    })
  }

  const runtimeKickoff = await (args.runRuntimeKickoff ?? runDefaultRuntimeKickoff)({
    db: args.db,
    userId: args.userId,
    toE164: phoneE164,
    startedAt,
    source,
    promptContext,
  })

  const followupPayload: Record<string, unknown> = {
    source,
    updatedAt: new Date().toISOString(),
    smsState: "runtime-kickoff-enqueued",
    smsKickoffAt: FieldValue.serverTimestamp(),
    smsThreadId: `iMessage;-;${phoneE164}`,
    kickoffRuntimeEventId: runtimeKickoff.eventId,
    kickoffOutboundId: runtimeKickoff.outboundId ?? runtimeKickoff.eventId,
  }
  if (isLayoff) followupPayload.lastLaidOffAt = FieldValue.serverTimestamp()
  await userRef.set(followupPayload, { merge: true })

  args.log?.(isLayoff ? "layoff.sms_start.enqueued" : "candidate.sms_start.enqueued", {
    userId: args.userId,
    kickoffRuntimeEventId: runtimeKickoff.eventId,
    kickoffOutboundId: runtimeKickoff.outboundId ?? null,
    source,
    created: true,
  })

  return {
    ok: true,
    kickoffOutboundId: runtimeKickoff.outboundId ?? runtimeKickoff.eventId,
    kickoffCreated: true,
    sourceTag: source,
  }
}
