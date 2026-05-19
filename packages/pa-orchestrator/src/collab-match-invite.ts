import type { Firestore } from "firebase-admin/firestore"
import type { AgentDef, InboundEvent } from "@pa/core-types"
import { PA_COLLECTIONS } from "@pa/core-types"
import { getFlag } from "@pa/pa-persistence"
import type { ConnectorName } from "@pa/pa-connectors"
import { detectLang } from "./voice/imperfection-injector/index.js"
import {
  buildCollabInviteIntent,
  buildCollabInviteTemplate,
  detectCollabInviteReplyIntent,
} from "./collab-invite-surface.js"
import { buildMatchConnectorHooks, type GenerateJobRecsFn } from "./match-connector-hooks.js"
import {
  frameConnectorResult,
  isConnectorNarrationEnabled,
  runConnectorWithNarration,
} from "./run-connector-with-narration.js"
import { applyTemplateOutboundHumanize } from "./outbound-template-humanize.js"
import {
  injectVoiceProfilePrefix,
  resolveProfileForUser,
} from "./voice/voice-profiles/index.js"
import type { SharedOnboardingRunAgentTurn } from "./shared-onboarding-outbound.js"

export type CollabInviteReplyStore = {
  db?: Firestore
  nowIso(): string
  appendMessage(message: {
    id: string
    sessionId: string
    userId: string
    role: "assistant"
    body: string
    createdAt: string
    idempotencyKey: string
    rawMeta?: Record<string, unknown>
  }): Promise<void>
  enqueueOutbound(
    userId: string,
    toE164: string,
    body: string,
    input?: Record<string, unknown>
  ): Promise<void>
  updateTurn(turnId: string, patch: Record<string, unknown>): Promise<void>
  markEventSucceeded(eventId: string): Promise<void>
  markEventFailed(eventId: string, errorCode: string, error: string): Promise<void>
  log(...args: unknown[]): void
  startPrescreenForJob?: (input: {
    userId: string
    jobId: string
    toE164: string
  }) => Promise<{ ok: boolean; reason?: string }>
}

/** Minimum V16 composite score (0–1) before we proactively invite. */
export const COLLAB_INVITE_MIN_SCORE = 0.45

export type CollabInvitePending = {
  jobId: string
  jobTitle: string
  company: string
  invitedAt: string
  matchScore?: number
  sessionId?: string
}

export type CollabMatchInviteDeps = {
  db: Firestore
  userId: string
  toE164: string
  sessionId?: string
  generateJobRecs?: GenerateJobRecsFn
  enqueueOutbound: (
    userId: string,
    toE164: string,
    body: string,
    extra?: Record<string, unknown>
  ) => Promise<void>
  runAgentTurn?: SharedOnboardingRunAgentTurn
  createSession?: (input: { sessionId: string; userId: string }) => unknown
  getAgentForUser?: (userId: string) => Promise<AgentDef | null>
  log?: (name: string, payload?: Record<string, unknown>) => void
}

export async function isCollabMatchInviteEnabled(
  db: Firestore,
  userId: string
): Promise<boolean> {
  try {
    return (await getFlag(db, "paCollabMatchInviteEnabled", { userId, env: process.env })) === true
  } catch {
    return false
  }
}

export async function isResumeUploadAutoInviteEnabled(
  db: Firestore,
  userId: string
): Promise<boolean> {
  try {
    return (await getFlag(db, "paResumeUploadAutoInvite", { userId, env: process.env })) === true
  } catch {
    return false
  }
}

export async function loadCollabInvitePending(
  db: Firestore,
  userId: string
): Promise<CollabInvitePending | null> {
  const snap = await db.collection(PA_COLLECTIONS.users).doc(userId).get()
  if (!snap.exists) return null
  const raw = snap.data()?.collabInvitePending as CollabInvitePending | undefined
  if (!raw?.jobId || !raw.jobTitle || !raw.company) return null
  return raw
}

export async function writeCollabInvitePending(
  db: Firestore,
  userId: string,
  pending: CollabInvitePending | null
): Promise<void> {
  await db.collection(PA_COLLECTIONS.users).doc(userId).set(
    pending ? { collabInvitePending: pending } : { collabInvitePending: null },
    { merge: true }
  )
}

async function composeCollabInviteMessage(deps: CollabMatchInviteDeps, input: {
  jobTitle: string
  company: string
  matchSummary?: string
  turnId: string
}): Promise<string> {
  const lang = "en" as const
  const template = buildCollabInviteTemplate({
    lang,
    jobTitle: input.jobTitle,
    company: input.company,
  })

  if (!deps.runAgentTurn || !deps.createSession || !deps.getAgentForUser) {
    const { text } = await applyTemplateOutboundHumanize({
      body: template,
      userId: deps.userId,
      turnId: input.turnId,
      db: deps.db,
    })
    return text
  }

  const agent = await deps.getAgentForUser(deps.userId)
  if (!agent) {
    const { text } = await applyTemplateOutboundHumanize({
      body: template,
      userId: deps.userId,
      turnId: input.turnId,
      db: deps.db,
    })
    return text
  }

  try {
    const profile = await resolveProfileForUser("friend_prescreen_invite", deps.userId)
    const surfaceIntent = buildCollabInviteIntent({
      jobTitle: input.jobTitle,
      company: input.company,
      mode: "invite",
      voiceProfile: profile,
      matchSummary: input.matchSummary,
    })
    const systemInputs = [
      injectVoiceProfilePrefix("", profile, lang),
      surfaceIntent,
    ].filter((s) => s.length > 0)
    const sessionId = deps.sessionId ?? `collab-invite-${deps.userId}`
    const session = deps.createSession({ sessionId, userId: deps.userId })
    const { text } = await deps.runAgentTurn({
      agent,
      systemPrompt: injectVoiceProfilePrefix(agent.systemPrompt, profile, lang),
      userMessage:
        "[COLLAB_INVITE] Compose the partner-role prescreen invite SMS. Do not start interview questions yet.",
      history: [],
      memoryBlock: "",
      session: session as never,
      systemInputs,
      tools: [],
    })
    const trimmed = (text ?? "").trim()
    if (!trimmed) throw new Error("empty_collab_invite")
    const { text: safe } = await applyTemplateOutboundHumanize({
      body: trimmed,
      userId: deps.userId,
      turnId: input.turnId,
      db: deps.db,
      maxLength: profile.invariants.lengthCapChars,
    })
    deps.log?.("pa.collab_invite.agentic.applied", { userId: deps.userId })
    return safe
  } catch (err) {
    deps.log?.("pa.collab_invite.agentic.fallback", {
      userId: deps.userId,
      error: err instanceof Error ? err.message : String(err),
    })
    const { text } = await applyTemplateOutboundHumanize({
      body: template,
      userId: deps.userId,
      turnId: input.turnId,
      db: deps.db,
    })
    return text
  }
}

/**
 * Collab prescreen match + invite composition. Proactive SMS is HITL-only (dashboard
 * operator approve) — do not call from cv-ingest or other lifecycle hooks.
 */
export async function runCollabMatchInviteAfterResumeIngest(
  deps: CollabMatchInviteDeps
): Promise<{ invited: boolean; reason?: string }> {
  const log = deps.log ?? (() => undefined)
  // Product lock: proactive collab SMS is HITL human-trigger only. Never wire from cv-ingest hooks.
  if (process.env.PA_COLLAB_MATCH_INVITE_AUTO_SEND !== "true") {
    log("pa.collab_invite.auto_send_skipped", {
      userId: deps.userId,
      reason: "hitl_only",
    })
    return { invited: false, reason: "auto_send_disabled_hitl_only" }
  }
  const masterOn = await isCollabMatchInviteEnabled(deps.db, deps.userId)
  const autoOn = await isResumeUploadAutoInviteEnabled(deps.db, deps.userId)
  if (!masterOn || !autoOn) {
    return { invited: false, reason: "flags_off" }
  }
  if (!deps.generateJobRecs) {
    return { invited: false, reason: "generate_job_recs_missing" }
  }

  const existing = await loadCollabInvitePending(deps.db, deps.userId)
  if (existing) {
    return { invited: false, reason: "invite_already_pending" }
  }

  const lang: "en" | "zh" = "en"
  const connectorName: ConnectorName = "match-against-collab-jobs"
  const hooks = buildMatchConnectorHooks({ db: deps.db, generateJobRecs: deps.generateJobRecs })
  const narrationOn = await isConnectorNarrationEnabled(deps.db, deps.userId)
  const turnId = `collab-hook-${deps.userId}-${Date.now()}`

  let matchResult: {
    ok?: boolean
    topJobId?: string | null
    topTitle?: string | null
    topCompany?: string | null
    summary?: string
    matchScore?: number
  }

  if (narrationOn) {
    const agent = deps.getAgentForUser ? await deps.getAgentForUser(deps.userId) : null
    const { result } = await runConnectorWithNarration({
      db: deps.db,
      connectorName,
      args: { lang, source: "cv_ingest_resume_parse" },
      lang,
      source: "cv_ingest_resume_parse",
      ctx: {
        db: deps.db,
        agent: agent ?? ({ id: "claire", name: "Claire" } as AgentDef),
        turnId,
        userId: deps.userId,
        sessionId: deps.sessionId ?? turnId,
        hooks,
      },
      outbound: {
        sendPreCallBubble: async (text) => {
          await deps.enqueueOutbound(deps.userId, deps.toE164, text, {
            sessionId: deps.sessionId,
            idempotencyKey: `collab-pre-${deps.userId}`,
          })
        },
        pulseTyping: async () => undefined,
      },
      log,
    })
    matchResult = result as typeof matchResult
  } else {
    const matchCollab = hooks.matchCollabJobs
    if (!matchCollab) {
      return { invited: false, reason: "match_collab_hook_missing" }
    }
    matchResult = await matchCollab({ lang, source: "cv_ingest_resume_parse" }, {
      db: deps.db,
      agent: { id: "claire", name: "Claire" } as AgentDef,
      turnId,
      userId: deps.userId,
      sessionId: deps.sessionId ?? turnId,
      hooks,
    })
  }

  if (!matchResult?.ok || !matchResult.topJobId) {
    log("pa.collab_invite.skipped", {
      userId: deps.userId,
      reason: matchResult?.ok === false ? "no_match" : "missing_job_id",
    })
    return { invited: false, reason: "no_collab_match" }
  }

  const score = matchResult.matchScore ?? 0
  if (score > 0 && score < COLLAB_INVITE_MIN_SCORE) {
    log("pa.collab_invite.skipped", { userId: deps.userId, reason: "below_score_threshold", score })
    return { invited: false, reason: "low_score" }
  }

  const jobTitle = matchResult.topTitle ?? "this role"
  const company = matchResult.topCompany ?? "a partner company"
  const inviteBody = await composeCollabInviteMessage(deps, {
    jobTitle,
    company,
    matchSummary: matchResult.summary,
    turnId,
  })

  const frame =
    narrationOn && matchResult.ok
      ? frameConnectorResult(connectorName, lang, 1)
      : null
  const outbound = [frame, inviteBody].filter(Boolean).join("\n").trim()

  await writeCollabInvitePending(deps.db, deps.userId, {
    jobId: matchResult.topJobId,
    jobTitle,
    company,
    invitedAt: new Date().toISOString(),
    matchScore: score || undefined,
    sessionId: deps.sessionId,
  })

  await deps.enqueueOutbound(deps.userId, deps.toE164, outbound, {
    sessionId: deps.sessionId,
    idempotencyKey: `collab-invite:${deps.userId}:${matchResult.topJobId}`,
    runtimeSource: "collab_match_invite",
  })

  log("pa.collab_invite.sent", {
    userId: deps.userId,
    jobId: matchResult.topJobId,
    score,
  })
  return { invited: true }
}

export async function handleCollabInviteReply(
  event: InboundEvent,
  store: CollabInviteReplyStore,
  turnId: string
): Promise<boolean> {
  if (!store.db) return false
  const pending = await loadCollabInvitePending(store.db, event.userId)
  if (!pending) return false

  const intent = detectCollabInviteReplyIntent(event.body)
  const lang = detectLang(event.body) === "zh" ? "zh" : "en"

  if (intent === "ambiguous") {
    const profile = await resolveProfileForUser("friend_prescreen_invite", event.userId)
    const clarify = buildCollabInviteTemplate({
      lang,
      jobTitle: pending.jobTitle,
      company: pending.company,
    })
    const question =
      lang === "zh"
        ? `你是想试一下 ${pending.company} 那个 ${pending.jobTitle} 的快速初筛吗？回「好」或「不用」就行。`
        : `just to confirm — want the quick ~5min screen for ${pending.jobTitle} @ ${pending.company}? reply yeah or pass`
    const body = `${clarify}\n\n${question}`.slice(0, profile.invariants.lengthCapChars)
    const { text } = await applyTemplateOutboundHumanize({
      body,
      userId: event.userId,
      turnId,
      db: store.db,
    })
    await sendCollabInviteReply(store, event, turnId, text)
    await store.updateTurn(turnId, {
      status: "succeeded",
      stage: "succeeded",
      directIntent: "collab_invite_clarify",
      completedAt: store.nowIso(),
    })
    await store.markEventSucceeded(event.id)
    return true
  }

  if (intent === "decline") {
    await writeCollabInvitePending(store.db, event.userId, null)
    const body =
      lang === "zh"
        ? "没问题，先记着。以后有更合适的合作岗我再喊你。"
        : "all good — I'll keep you in mind if another partner role looks like a fit"
    await sendCollabInviteReply(store, event, turnId, body)
    await store.updateTurn(turnId, {
      status: "succeeded",
      stage: "succeeded",
      directIntent: "collab_invite_declined",
      completedAt: store.nowIso(),
    })
    await store.markEventSucceeded(event.id)
    return true
  }

  // accept
  await writeCollabInvitePending(store.db, event.userId, null)
  if (!store.startPrescreenForJob) {
    const body =
      lang === "zh"
        ? "收到！我这边稍后会发第一题 — 如果一分钟内没动静你跟我说一声。"
        : "got it — I'll kick off the quick screen in a sec. ping me if nothing shows up in a minute"
    await sendCollabInviteReply(store, event, turnId, body)
    await store.updateTurn(turnId, {
      status: "succeeded",
      stage: "succeeded",
      directIntent: "collab_invite_accept_no_prescreen_wiring",
      completedAt: store.nowIso(),
    })
    await store.markEventSucceeded(event.id)
    store.log("pa.collab_invite.accept_missing_prescreen_wiring", { userId: event.userId, jobId: pending.jobId })
    return true
  }

  const started = await store.startPrescreenForJob({
    userId: event.userId,
    jobId: pending.jobId,
    toE164: event.from,
  })

  if (!started.ok) {
    const body =
      lang === "zh"
        ? "我这边拉不起那个初筛流程，稍等我查一下再回你。"
        : "hmm I couldn't start that screen right now — give me a sec to fix it"
    await sendCollabInviteReply(store, event, turnId, body)
    await store.updateTurn(turnId, {
      status: "failed",
      stage: "failed",
      errorCode: started.reason ?? "prescreen_start_failed",
      completedAt: store.nowIso(),
    })
    await store.markEventFailed(event.id, started.reason ?? "prescreen_start_failed", "collab prescreen start failed")
    return true
  }

  await store.updateTurn(turnId, {
    status: "succeeded",
    stage: "succeeded",
    directIntent: "collab_invite_accept_prescreen_started",
    completedAt: store.nowIso(),
  })
  await store.markEventSucceeded(event.id)
  store.log("pa.collab_invite.accept_prescreen_started", {
    userId: event.userId,
    jobId: pending.jobId,
  })
  return true
}

async function sendCollabInviteReply(
  store: CollabInviteReplyStore,
  event: InboundEvent,
  turnId: string,
  body: string
): Promise<void> {
  const at = store.nowIso()
  await store.appendMessage({
    id: `out-collab-${event.id}`,
    sessionId: event.sessionId,
    userId: event.userId,
    role: "assistant",
    body,
    createdAt: at,
    idempotencyKey: `out-collab-${event.id}`,
    rawMeta: { source: "collab_invite", turnId, eventId: event.id },
  })
  if (shouldSuppressOutbound(event)) return
  await store.enqueueOutbound(event.userId, event.from, body, {
    sessionId: event.sessionId,
    idempotencyKey: `out-collab-${event.id}`,
  })
}

function shouldSuppressOutbound(event: InboundEvent): boolean {
  return event.rawMeta?.suppressOutbound === true
}
