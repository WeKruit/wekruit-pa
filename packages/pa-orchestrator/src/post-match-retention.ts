/**
 * Post-match retention FSM — conversational follow-up after job recs (Pattern D).
 * Runs before general Claire when `pa-users.postMatchRetention.stage` is active.
 *
 * Flow: like? → (if no) why? → daily subscribe? → collab prescreen offer?
 */
import type { Firestore } from "firebase-admin/firestore"
import type { AgentDef, InboundEvent } from "@pa/core-types"
import { PA_COLLECTIONS } from "@pa/core-types"
import { runConnector } from "@pa/pa-connectors"
import { getFlag, writeFeedbackEvent } from "@pa/pa-persistence"
import { detectLang } from "./voice/imperfection-injector/index.js"
import { sendCollabPrescreenOfferFromCandidateOptIn } from "./collab-match-invite.js"
import type { GenerateJobRecsFn } from "./match-connector-hooks.js"

const POST_MATCH_RETENTION_TOOL_AGENT: AgentDef = {
  id: "post-match-retention",
  name: "Post-match retention",
  version: "1",
  systemPrompt: "Deterministic post-match retention flow.",
  provider: "other",
  model: "deterministic",
  temperature: 0,
  toolPolicy: "allowlist",
  allowedConnectors: ["set-matching-preferences", "set-daily-job-recommendation-subscription"],
  toolBudgetPerTurn: 2,
  memoryMode: "firestore_only",
}

export type PostMatchRetentionStage =
  | "await_liked"
  | "await_dislike_reason"
  | "await_subscribe"
  | "await_prescreen"
  | "complete"

export type PostMatchRetentionState = {
  stage: PostMatchRetentionStage
  startedAt: string
  updatedAt: string
  recCount?: number
  jobIds?: string[]
  sentiment?: "positive" | "negative"
  subscribeOptIn?: boolean
  prescreenOptIn?: boolean
  suppressPrescreenOffer?: boolean
}

export type PostMatchRetentionStore = {
  db?: Firestore
  nowIso(): string
  getOnboardingUser?(userId: string): Promise<{ onboardingState?: string } | null>
  generateJobRecs?: GenerateJobRecsFn
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

function normalizeBody(body: string): string {
  return body.trim().toLowerCase()
}

/** User liked / disliked the batch (conversational, not tapback). */
export function detectRecBatchSentiment(body: string): "positive" | "negative" | "ambiguous" {
  const t = normalizeBody(body)
  if (!t) return "ambiguous"
  if (
    /\b(don'?t like|didn'?t like|not good|not useful|not relevant|not interested|not aligned|doesn'?t align|does not align|not fit|doesn'?t fit|useless|terrible|awful|hate|meh|trash|off\b|wrong|bad|nah|nope|no)\b/i.test(
      t
    ) ||
    /(不喜欢|不太行|没用|不行|不好|不对|离谱|垃圾|算了|不太合适|差点意思|不太对)/.test(t)
  ) {
    if (/\b(not bad|not terrible)\b/i.test(t)) return "ambiguous"
    return "negative"
  }
  if (
    /\b(yes|yeah|yep|yup|good|great|love|like|useful|helpful|nice|solid|fire|lfg)\b/i.test(t) ||
    /(不错|可以|还行|挺好|有用|喜欢|爱了|牛|赞|好的|好呀|行)/.test(t)
  ) {
    return "positive"
  }
  return "ambiguous"
}

export function detectYesNoIntent(body: string): "yes" | "no" | "ambiguous" {
  const t = normalizeBody(body)
  if (!t) return "ambiguous"
  if (
    /^(no|nope|nah|pass|skip|later|not now|don'?t|不用|不要|不了|先不|算了|否)\b/i.test(t) ||
    /\b(no thanks|no thank you|not right now|not today|i'?m good|i am good|good for now|fine for now|i'?ll pass|i will pass|don'?t want|do not want|not interested)\b/i.test(t) ||
    /(不用了|先不用|暂时不|不想)/.test(t)
  ) {
    return "no"
  }
  if (
    /^(yes|yeah|yep|yup|sure|ok|okay|down|let'?s|please|好|行|可以|要|愿意|sure)\b/i.test(t) ||
    /(好的呀|没问题|来吧|可以啊|愿意)/.test(t)
  ) {
    return "yes"
  }
  return "ambiguous"
}

function copyForStage(stage: PostMatchRetentionStage, lang: "zh" | "en"): string {
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
    case "await_prescreen":
      return lang === "zh"
        ? "我们有些合作公司愿意走 WeKruit 快速初筛（大概 5 分钟 iMessage）。你有兴趣试一个最匹配的 partner 岗吗？回「好」或「先不用」。"
        : "Some partner companies do a quick ~5min WeKruit screen over iMessage. Want to try one top partner role? Reply yeah or pass."
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

async function writeBatchFeedback(input: {
  db: Firestore
  userId: string
  jobIds: string[]
  kind: "candidate_decline" | "candidate_behavior"
  outcome: string
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
          },
        ],
        payloadRedacted: { channel: "imessage", flow: "post_match_retention" },
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

function deriveDislikePreferencePatch(reasonText: string): Record<string, unknown> | null {
  const normalized = reasonText.trim().toLowerCase()
  if (!normalized) return null
  const patch: Record<string, unknown> = {
    evidenceText: reasonText.slice(0, 1000),
    source: "post_match_retention_feedback",
    constraintStrength: "hard",
  }
  let changed = false
  if (/\b(india|outside\s+(?:the\s+)?u\.?s\.?|outside\s+(?:the\s+)?united\s+states|non[-\s]?us|overseas)\b/i.test(reasonText)) {
    patch.targetCountry = ["usa"]
    changed = true
  }
  if (/\b(senior|staff|principal|director|lead|manager|vp|too\s+senior)\b/i.test(reasonText)) {
    patch.careerStage = "junior"
    changed = true
  }
  if (/\b(customer\s+service|customer\s+support|support\s+role|call\s*center|customer\s+success)\b/i.test(reasonText)) {
    patch.negativeRoleFunctions = ["customer_service_and_support"]
    changed = true
  }
  return changed ? patch : null
}

async function persistDislikePreferencePatch(input: {
  db: Firestore
  event: InboundEvent
  turnId: string
  patch: Record<string, unknown>
}): Promise<void> {
  await runConnector(
    "set-matching-preferences",
    input.patch,
    {
      db: input.db,
      agent: POST_MATCH_RETENTION_TOOL_AGENT,
      turnId: input.turnId,
      userId: input.event.userId,
      sessionId: input.event.sessionId,
      usedThisTurn: 0,
    },
  )
}

async function persistDailySubscribeOptIn(
  db: Firestore,
  event: InboundEvent,
  turnId: string,
  userId: string,
  optedIn: boolean,
): Promise<void> {
  const result = await runConnector(
    "set-daily-job-recommendation-subscription",
    {
      optedIn,
      consentText: event.body,
      source: "post_match_retention",
      lang: detectLang(event.body) === "zh" ? "zh" : "en",
    },
    {
      db,
      agent: POST_MATCH_RETENTION_TOOL_AGENT,
      turnId,
      userId,
      sessionId: event.sessionId,
      usedThisTurn: 0,
    },
  ) as { ok?: boolean }
  if (result.ok !== true) throw new Error("daily_subscription_tool_failed")
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
  suppressPrescreenOffer?: boolean
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
    ...(input.suppressPrescreenOffer ? { suppressPrescreenOffer: true } : {}),
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

  const lang = detectLang(event.body) === "zh" ? "zh" : "en"
  const at = store.nowIso()
  const jobIds = await resolveJobIds(db, event.userId, state)
  let next: PostMatchRetentionState = { ...state, updatedAt: at }
  let reply = ""

  switch (state.stage) {
    case "await_liked": {
      const sentiment = detectRecBatchSentiment(event.body)
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
      await writeBatchFeedback({
        db,
        userId: event.userId,
        jobIds,
        kind: "candidate_decline",
        outcome: "batch_not_relevant",
        reasonText: event.body,
        nowIso: at,
      })
      const preferencePatch = deriveDislikePreferencePatch(event.body)
      if (preferencePatch) {
        try {
          await persistDislikePreferencePatch({ db, event, turnId, patch: preferencePatch })
        } catch (err) {
          store.log("pa.post_match_retention.feedback_preference_tool.failed", {
            userId: event.userId,
            turnId,
            error: err instanceof Error ? err.message : String(err),
          })
          reply =
            lang === "zh"
              ? "我这边保存这个偏好卡了一下，先不假装记下了。你再发一次哪里不对，我重试。"
              : "I hit a save issue on that preference, so I will not pretend it is saved. Send what was off once more and I will retry."
          break
        }
      }
      next.stage = "await_subscribe"
      reply =
        lang === "zh"
          ? "记下了，我下次会避开这类。要不要我每天给你推更贴的新岗？想停随时说。"
          : "Noted — I'll avoid that vibe next time. Want daily texts when something tighter shows up?"
      break
    }
    case "await_subscribe": {
      const yn = detectYesNoIntent(event.body)
      if (yn === "ambiguous") {
        reply =
          lang === "zh"
            ? "每天推匹配岗这件事 — 要还是暂时不用？回「要」或「不用」就行。"
            : "Daily matched roles — want that or pass for now? Just say yes or no."
        break
      }
      next.subscribeOptIn = yn === "yes"
      try {
        await persistDailySubscribeOptIn(db, event, turnId, event.userId, yn === "yes")
      } catch (err) {
        store.log("pa.post_match_retention.subscribe_tool.failed", {
          userId: event.userId,
          turnId,
          error: err instanceof Error ? err.message : String(err),
        })
        reply =
          lang === "zh"
            ? "我这边保存订阅状态卡了一下。你再回一次「要」或「不用」，我重试。"
            : "I hit a save issue on the daily-text setting. Reply yes or no once more and I'll retry."
        break
      }
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
      if (state.suppressPrescreenOffer) {
        next.stage = "complete"
        reply =
          lang === "zh"
            ? "收到。我会继续看更贴的岗，有干净匹配再发你。"
            : "Got it — I'll keep looking and text you when something tighter shows up."
      } else {
        next.stage = "await_prescreen"
        reply = copyForStage("await_prescreen", lang)
      }
      break
    }
    case "await_prescreen": {
      const sentiment = detectRecBatchSentiment(event.body)
      const preferencePatch = deriveDislikePreferencePatch(event.body)
      if (sentiment === "negative" || preferencePatch) {
        await writeBatchFeedback({
          db,
          userId: event.userId,
          jobIds,
          kind: "candidate_decline",
          outcome: "partner_prescreen_offer_not_relevant",
          reasonText: event.body,
          nowIso: at,
        })
        if (preferencePatch) {
          try {
            await persistDislikePreferencePatch({ db, event, turnId, patch: preferencePatch })
          } catch (err) {
            store.log("pa.post_match_retention.prescreen_feedback_preference_tool.failed", {
              userId: event.userId,
              turnId,
              error: err instanceof Error ? err.message : String(err),
            })
            reply =
              lang === "zh"
                ? "我这边保存这个偏好卡了一下，先不假装记下了。你再发一次哪里不对，我重试。"
                : "I hit a save issue on that preference, so I will not pretend it is saved. Send what was off once more and I will retry."
            break
          }
        }
        next.stage = "complete"
        next.sentiment = "negative"
        reply =
          lang === "zh"
            ? "收到，我会避开这类方向，继续帮你找更贴的匹配。"
            : "Got it — I'll avoid that direction and keep looking for tighter matches."
        break
      }
      const yn = detectYesNoIntent(event.body)
      if (yn === "ambiguous") {
        reply =
          lang === "zh"
            ? "合作公司的快速初筛 — 想试一个最匹配的岗吗？回「好」或「先不用」。"
            : "Quick partner prescreen — try one top match? Reply yeah or pass."
        break
      }
      next.prescreenOptIn = yn === "yes"
      if (yn === "yes" && store.generateJobRecs) {
        const offer = await sendCollabPrescreenOfferFromCandidateOptIn({
          db,
          userId: event.userId,
          toE164: event.from,
          sessionId: event.sessionId,
          generateJobRecs: store.generateJobRecs,
          enqueueOutbound: store.enqueueOutbound,
          turnId,
          log: (name, payload) => store.log(name, payload),
        })
        if (offer.sent) {
          reply =
            lang === "zh"
              ? "好，我发你一个最匹配的合作岗邀请～看下上一条，感兴趣回「好」就开初筛。"
              : "bet — check my last message for the partner role. reply yeah when you want the quick screen."
        } else {
          reply =
            lang === "zh"
              ? "好。我这边暂时没捞到合适的合作初筛岗，有的话第一时间喊你。"
              : "down — no strong partner screen match right now. I'll ping you when one lands."
        }
      } else if (yn === "yes") {
        reply =
          lang === "zh"
            ? "好，我记下了。有合作初筛岗我第一时间喊你。"
            : "got it — I'll ping you when a partner screen looks like a fit."
      } else {
        reply =
          lang === "zh"
            ? "没问题。以后有更合适的合作岗我再喊你。"
            : "all good — I'll keep you in mind for partner screens later."
      }
      next.stage = "complete"
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
      prescreenOptIn: next.prescreenOptIn,
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
