/**
 * Post-match retention FSM — conversational follow-up after job recs (Pattern D).
 * Runs before general Claire when `pa-users.postMatchRetention.stage` is active.
 *
 * Flow: like? -> (if no) why? -> daily subscribe? -> complete.
 */
import type { Firestore } from "firebase-admin/firestore"
import type { InboundEvent } from "@pa/core-types"
import { PA_COLLECTIONS } from "@pa/core-types"
import { getFlag, writeFeedbackEvent } from "@pa/pa-persistence"
import { detectLang } from "./voice/imperfection-injector/index.js"
import type { GenerateJobRecsFn } from "./match-connector-hooks.js"
import {
  AMBIGUOUS_FEEDBACK,
  type FeedbackLlmCall,
  type FeedbackQuestionKind,
  type MatchFeedbackResult,
} from "./match-feedback-extractor.js"
import { extractFromConversation } from "./conversation-tagging.js"
import { applyPartialUserTags } from "./tags/user-tags-writer.js"

export type PostMatchRetentionStage =
  | "await_liked"
  | "await_dislike_reason"
  | "await_subscribe"
  // Legacy stored state from the removed partner-screen offer step.
  | "await_prescreen"
  | "complete"

export type PostMatchRetentionState = {
  stage: PostMatchRetentionStage
  startedAt: string
  updatedAt: string
  recCount?: number
  jobIds?: string[]
  sentiment?: "positive" | "negative"
  /** LLM-classified dislike reason category (no-regex, 2026-05-30). */
  reasonCategory?: string
  subscribeOptIn?: boolean
}

export type PostMatchRetentionStore = {
  db?: Firestore
  nowIso(): string
  getOnboardingUser?(userId: string): Promise<{ onboardingState?: string } | null>
  generateJobRecs?: GenerateJobRecsFn
  /**
   * Injectable LLM seam for match-feedback classification (no-regex, 2026-05-30).
   * Production wires the OpenAI→Anthropic chain; evals inject a deterministic
   * stub. When absent, the FSM fails OPEN to `ambiguous` (re-asks) — it never
   * regex-classifies the reply.
   */
  classifyFeedback?: FeedbackLlmCall
  log(name: string, payload?: Record<string, unknown>): void
  enqueueOutbound?(
    userId: string,
    toE164: string,
    body: string,
    extra?: Record<string, unknown>
  ): Promise<void>
  updateTurn(turnId: string, patch: Record<string, unknown>): Promise<void>
  markEventSucceeded(eventId: string): Promise<void>
}

export async function isPostMatchRetentionEnabled(
  db: Firestore | undefined,
  userId: string
): Promise<boolean> {
  if (!db) return false
  try {
    return (await getFlag(db, "paPostMatchRetentionEnabled", { userId, env: process.env })) === true
  } catch {
    return false
  }
}

export async function loadPostMatchRetention(
  db: Firestore,
  userId: string
): Promise<PostMatchRetentionState | null> {
  const snap = await db.collection(PA_COLLECTIONS.users).doc(userId).get()
  if (!snap.exists) return null
  const raw = snap.data()?.postMatchRetention as PostMatchRetentionState | undefined
  if (!raw?.stage || raw.stage === "complete") return null
  return raw
}

export async function writePostMatchRetention(
  db: Firestore,
  userId: string,
  state: PostMatchRetentionState | null
): Promise<void> {
  await db
    .collection(PA_COLLECTIONS.users)
    .doc(userId)
    .set(
      state ? { postMatchRetention: state } : { postMatchRetention: null },
      { merge: true }
    )
}

/**
 * Classify a retention reply through the UNIFIED conversational tagging
 * interface (`extractFromConversation`, purpose=post_rec_feedback) — the same
 * entry point onboarding + every Q→A path shares (Adam 顶层设计 2026-05-30).
 * No-regex; fails OPEN to `ambiguous` (FSM re-asks) when no classifier is wired
 * or the LLM errors.
 */
async function classifyRetentionReply(
  store: PostMatchRetentionStore,
  questionKind: FeedbackQuestionKind,
  reply: string,
  jobIds: string[],
  existingTags?: Record<string, unknown>,
): Promise<MatchFeedbackResult> {
  if (!store.classifyFeedback) return AMBIGUOUS_FEEDBACK
  const result = await extractFromConversation(
    {
      purpose: "post_rec_feedback",
      feedbackQuestionKind: questionKind,
      existingTags,
      ...(jobIds[0] ? { recommendation: { jobId: jobIds[0] } } : {}),
      log: (name, payload) => store.log(name, payload),
    },
    reply,
    store.classifyFeedback,
  )
  const fb = result.feedbackEvents[0]
  return {
    replyKind: fb?.replyKind ?? "feedback_answer",
    sentiment: fb?.sentiment ?? "ambiguous",
    intent: fb?.intent ?? "ambiguous",
    reasonCategory: fb?.reasonCategory ?? "none",
    tagDeltas: result.tagDeltas,
  }
}

type CurrentPromptStage = Exclude<PostMatchRetentionStage, "await_prescreen" | "complete">

function copyForStage(stage: CurrentPromptStage, lang: "zh" | "en"): string {
  switch (stage) {
    case "await_liked":
      return lang === "zh"
        ? "刚才那几条岗位感觉怎么样？有用还是差点意思？随便说～"
        : "How did those roles feel — useful, meh, or totally off? Be honest."
    case "await_dislike_reason":
      return lang === "zh"
        ? "懂，哪块最不对？方向/级别/公司/地点/薪资都行，一句话就行。"
        : "Got it — what was off? role level, company, location, pay… one line is enough."
    case "await_subscribe":
      return lang === "zh"
        ? "要不要我每天给你推最新匹配的岗？有合适的直接发你，想停随时跟我说。"
        : "Want me to text you fresh matched roles daily? I'll only send good fits — say stop anytime."
    default:
      return lang === "zh" ? "收到，我们继续聊。" : "Sounds good — keep chatting anytime."
  }
}

async function loadRecentRecJobIds(
  db: Firestore,
  userId: string,
  sinceIso: string
): Promise<string[]> {
  try {
    const snap = await db
      .collection("pa-user-job-recommendations")
      .doc(userId)
      .collection("jobs")
      .where("lastRecommendedAt", ">=", sinceIso)
      .limit(12)
      .get()
    return snap.docs
      .map((d) => d.id)
      .filter((id) => typeof id === "string" && id.length > 0)
  } catch {
    return []
  }
}

/** True when an object has at least one own enumerable key. */
function hasKeys(obj: Record<string, unknown>): boolean {
  return Object.keys(obj).length > 0
}

/** Read `pa-users/{uid}.tags` (best-effort) so the extractor emits deltas only. */
async function loadUserTags(db: Firestore, userId: string): Promise<Record<string, unknown>> {
  try {
    const snap = await db.collection(PA_COLLECTIONS.users).doc(userId).get()
    const t = snap.data()?.tags
    return t && typeof t === "object" && !Array.isArray(t) ? (t as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

async function writeBatchFeedback(input: {
  db: Firestore
  userId: string
  jobIds: string[]
  kind: "candidate_decline" | "candidate_behavior"
  outcome: string
  reasonCategory?: string
  reasonText: string
  nowIso: string
}): Promise<void> {
  const actor = "candidate" as const
  const jobIds = input.jobIds.length > 0 ? input.jobIds : []
  const writeOne = async (jobId?: string) => {
    const suffix = jobId ?? "batch"
    try {
      await writeFeedbackEvent(input.db, {
        eventId: `post-match-${input.userId}-${suffix}-${input.nowIso}`,
        kind: input.kind,
        actor,
        candidateId: input.userId,
        ...(jobId ? { jobId } : {}),
        outcome: input.outcome,
        evidence: [
          {
            source: "conversation",
            summary: input.reasonText.slice(0, 240),
            confidence: 0.85,
            ...(input.reasonCategory ? { meta: { reasonCategory: input.reasonCategory } } : {}),
          },
        ],
        payloadRedacted: {
          channel: "imessage",
          flow: "post_match_retention",
          ...(input.reasonCategory ? { reasonCategory: input.reasonCategory } : {}),
        },
        createdAt: input.nowIso,
      })
    } catch {
      // flywheel best-effort
    }
  }
  if (jobIds.length === 0) {
    await writeOne()
    return
  }
  for (const jobId of jobIds) {
    await writeOne(jobId)
  }
}

async function persistDailySubscribeOptIn(
  db: Firestore,
  userId: string,
  optedIn: boolean,
  nowIso: string
): Promise<void> {
  await db
    .collection(PA_COLLECTIONS.users)
    .doc(userId)
    .set(
      {
        dailyJobRecSubscribe: {
          optedIn,
          optedInAt: nowIso,
          source: "post_match_retention",
        },
        updatedAt: nowIso,
      },
      { merge: true }
    )
  await db
    .collection("pa-job-profiles")
    .doc(userId)
    .set(
      {
        userId,
        status: optedIn ? "active" : "paused",
        updatedAt: nowIso,
      },
      { merge: true }
    )
}

async function sendImmediateSubscribeMatchBatch(input: {
  store: PostMatchRetentionStore
  event: InboundEvent
  turnId: string
  lang: "zh" | "en"
}): Promise<number> {
  const gen = input.store.generateJobRecs
  if (!gen || !input.store.enqueueOutbound) return 0
  try {
    const recs = await gen(input.event.userId, input.lang, {
      force: true,
      requestedCount: 2,
    })
    const recCount = recs?.recCount ?? 0
    if (!recs?.message || recCount <= 0) {
      input.store.log("pa.post_match_retention.subscribe_match.empty", {
        userId: input.event.userId,
        turnId: input.turnId,
      })
      return 0
    }
    await input.store.enqueueOutbound(input.event.userId, input.event.from, recs.message, {
      sessionId: input.event.sessionId,
      role: "assistant",
      idempotencyKey: `post-match-retention-subscribe-recs-${input.event.id}`,
      directIntent: "post_match_retention",
      runtimeSource: "post_match_retention_subscribe_match",
    })
    input.store.log("pa.post_match_retention.subscribe_match.sent", {
      userId: input.event.userId,
      turnId: input.turnId,
      recCount,
    })
    return recCount
  } catch (err) {
    input.store.log("pa.post_match_retention.subscribe_match.failed", {
      userId: input.event.userId,
      turnId: input.turnId,
      error: err instanceof Error ? err.message : String(err),
    })
    return 0
  }
}

/** Start retention survey after job recs ship; optionally ping the first question. */
export async function startPostMatchRetentionAfterJobRecs(input: {
  db: Firestore
  userId: string
  recCount: number
  sessionId?: string
  toE164?: string
  lang?: "zh" | "en"
  jobIds?: string[]
  enqueueOutbound?: PostMatchRetentionStore["enqueueOutbound"]
}): Promise<void> {
  const enabled = await isPostMatchRetentionEnabled(input.db, input.userId)
  if (!enabled || input.recCount <= 0) return
  const existing = await loadPostMatchRetention(input.db, input.userId)
  if (existing) return
  const at = new Date().toISOString()
  const lang = input.lang ?? "en"
  await writePostMatchRetention(input.db, input.userId, {
    stage: "await_liked",
    startedAt: at,
    updatedAt: at,
    recCount: input.recCount,
    ...(input.jobIds?.length ? { jobIds: input.jobIds } : {}),
  })

  if (input.enqueueOutbound && input.toE164) {
    const body = copyForStage("await_liked", lang)
    await input.enqueueOutbound(input.userId, input.toE164, body, {
      sessionId: input.sessionId,
      role: "assistant",
      idempotencyKey: `post-match-retention-kickoff:${input.userId}:${at}`,
      directIntent: "post_match_retention",
      runtimeSource: "post_match_retention_kickoff",
    })
  }
}

async function resolveJobIds(
  db: Firestore,
  userId: string,
  state: PostMatchRetentionState
): Promise<string[]> {
  if (state.jobIds?.length) return state.jobIds
  const since = new Date(Date.parse(state.startedAt) - 60_000).toISOString()
  return loadRecentRecJobIds(db, userId, since)
}

async function sendRetentionReply(
  store: PostMatchRetentionStore,
  event: InboundEvent,
  turnId: string,
  body: string,
  stage: PostMatchRetentionStage
): Promise<void> {
  if (!store.enqueueOutbound) return
  await store.enqueueOutbound(event.userId, event.from, body, {
    sessionId: event.sessionId,
    role: "assistant",
    idempotencyKey: `post-match-retention-${stage}-${event.id}`,
    directIntent: "post_match_retention",
    runtimeSource: "post_match_retention",
  })
}

/** Handle one inbound turn while retention FSM is active. Returns true if consumed. */
export async function handlePostMatchRetentionReply(
  event: InboundEvent,
  store: PostMatchRetentionStore,
  turnId: string
): Promise<boolean> {
  const db = store.db
  if (!db || !store.enqueueOutbound) return false

  const enabled = await isPostMatchRetentionEnabled(db, event.userId)
  if (!enabled) return false

  const onboarding = store.getOnboardingUser
    ? await store.getOnboardingUser(event.userId)
    : null
  if (onboarding?.onboardingState && onboarding.onboardingState !== "complete") {
    return false
  }

  const state = await loadPostMatchRetention(db, event.userId)
  if (!state) return false

  // LLM-classify the reply for the CURRENT stage's question (no-regex). The
  // single classification drives routing (replyKind), sentiment, intent, and
  // the dislike reason + tag deltas.
  const questionKind: FeedbackQuestionKind =
    state.stage === "await_subscribe"
      ? "daily_subscribe"
      : state.stage === "await_dislike_reason"
        ? "dislike_reason"
        : "rec_batch_sentiment"
  const existingTags = await loadUserTags(db, event.userId)
  const jobIds = await resolveJobIds(db, event.userId, state)
  const feedback = await classifyRetentionReply(store, questionKind, event.body, jobIds, existingTags)

  // Yield to other handlers when the candidate asks a question or states a new
  // concrete job-search preference instead of answering (LLM-classified). Only
  // while we're collecting sentiment / reason — once at the subscribe step we
  // commit to a yes/no.
  if (
    (state.stage === "await_liked" || state.stage === "await_dislike_reason") &&
    (feedback.replyKind === "job_search_preference" || feedback.replyKind === "explicit_question")
  ) {
    store.log("pa.post_match_retention.yielded", {
      userId: event.userId,
      turnId,
      stage: state.stage,
      replyKind: feedback.replyKind,
    })
    return false
  }

  const lang = detectLang(event.body) === "zh" ? "zh" : "en"
  const at = store.nowIso()
  let next: PostMatchRetentionState = { ...state, updatedAt: at }
  let reply = ""

  switch (state.stage) {
    case "await_liked": {
      const sentiment = feedback.sentiment
      if (sentiment === "ambiguous") {
        reply =
          lang === "zh"
            ? "我指的是刚才那几条岗～整体偏有用还是偏离谱？随便一句就行。"
            : "I mean those roles I just sent — overall useful or mostly off?"
        break
      }
      next.sentiment = sentiment
      if (sentiment === "negative") {
        next.stage = "await_dislike_reason"
        reply = copyForStage("await_dislike_reason", lang)
      } else {
        next.stage = "await_subscribe"
        reply = copyForStage("await_subscribe", lang)
      }
      break
    }
    case "await_dislike_reason": {
      // Persist the LLM-extracted canonical tag deltas the dislike reason implies
      // (e.g. "too junior" → careerStage, "all fintech" → negativeIndustrySector)
      // via the sole writer. Best-effort flywheel.
      if (hasKeys(feedback.tagDeltas)) {
        await applyPartialUserTags(db, event.userId, feedback.tagDeltas, {
          source: "chat",
          nowIso: at,
          log: (name, payload) => store.log(name, payload ?? {}),
        }).catch(() => {})
      }
      next.reasonCategory = feedback.reasonCategory
      await writeBatchFeedback({
        db,
        userId: event.userId,
        jobIds,
        kind: "candidate_decline",
        outcome: "batch_not_relevant",
        reasonCategory: feedback.reasonCategory,
        reasonText: event.body,
        nowIso: at,
      })
      next.stage = "await_subscribe"
      reply =
        lang === "zh"
          ? "记下了，我下次会避开这类。要不要我每天给你推更贴的新岗？想停随时说。"
          : "Noted — I'll avoid that vibe next time. Want daily texts when something tighter shows up?"
      break
    }
    case "await_subscribe": {
      const yn = feedback.intent
      if (yn === "ambiguous") {
        reply =
          lang === "zh"
            ? "每天推匹配岗这件事 — 要还是暂时不用？回「要」或「不用」就行。"
            : "Daily matched roles — want that or pass for now? Just say yes or no."
        break
      }
      next.subscribeOptIn = yn === "yes"
      await persistDailySubscribeOptIn(db, event.userId, yn === "yes", at)
      if (yn === "yes") {
        await sendImmediateSubscribeMatchBatch({ store, event, turnId, lang })
      }
      await writeBatchFeedback({
        db,
        userId: event.userId,
        jobIds: [],
        kind: "candidate_behavior",
        outcome: yn === "yes" ? "daily_subscribe_opt_in" : "daily_subscribe_declined",
        reasonText: event.body,
        nowIso: at,
      })
      next.stage = "complete"
      reply =
        yn === "yes"
          ? lang === "zh"
            ? "收到，我会继续在这里给你发强匹配岗位；想停随时说。"
            : "Got it — I'll keep texting strong matches here. Say stop anytime."
          : lang === "zh"
            ? "没问题，我先不每天推送。你想看新岗位时随时跟我说。"
            : "All good — I won't send daily matches. Ask anytime when you want a fresh batch."
      break
    }
    case "await_prescreen": {
      next.stage = "complete"
      reply =
        lang === "zh"
          ? "收到，我会继续在这里给你推匹配岗位；不用再额外确认。"
          : "Got it — I'll keep sending matched roles here. No extra confirmation needed."
      break
    }
    default:
      return false
  }

  await sendRetentionReply(store, event, turnId, reply, state.stage)

  if (next.stage === "complete") {
    await writePostMatchRetention(db, event.userId, {
      ...next,
      stage: "complete",
      updatedAt: at,
    })
    store.log("pa.post_match_retention.complete", {
      userId: event.userId,
      turnId,
      recCount: state.recCount,
      sentiment: next.sentiment,
      subscribeOptIn: next.subscribeOptIn,
    })
  } else {
    await writePostMatchRetention(db, event.userId, next)
    store.log("pa.post_match_retention.advanced", {
      userId: event.userId,
      turnId,
      from: state.stage,
      to: next.stage,
    })
  }

  await store.updateTurn(turnId, {
    status: "succeeded",
    stage: "succeeded",
    directIntent: "post_match_retention",
    postMatchRetentionStage: state.stage,
    completedAt: at,
  })
  await store.markEventSucceeded(event.id)
  return true
}
