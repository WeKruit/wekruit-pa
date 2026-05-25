/**
 * Post-match retention FSM — conversational follow-up after job recs (Pattern D).
 * Runs before general Claire when `pa-users.postMatchRetention.stage` is active.
 *
 * Flow: like? → (if no) why? → daily subscribe? → collab prescreen offer?
 */
import type { Firestore } from "firebase-admin/firestore"
import type { InboundEvent } from "@pa/core-types"
import { PA_COLLECTIONS } from "@pa/core-types"
import { getFlag, writeFeedbackEvent } from "@pa/pa-persistence"
import { detectLang } from "./voice/imperfection-injector/index.js"
import { sendCollabPrescreenOfferFromCandidateOptIn } from "./collab-match-invite.js"
import type { GenerateJobRecsFn } from "./match-connector-hooks.js"

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

function readIsoMillis(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

export async function hasBlockingPrescreenSession(
  db: Firestore,
  userId: string,
  nowIso: string
): Promise<boolean> {
  const recentCutoffMs = Date.parse(nowIso) - 14 * 24 * 60 * 60 * 1000
  try {
    const snap = await db
      .collection("pa-prescreen-sessions")
      .where("userId", "==", userId)
      .limit(20)
      .get()
    for (const doc of snap.docs) {
      const data = doc.data() as Record<string, unknown>
      if (data.terminalActionPendingReview === true) return true
      const terminal = typeof data.terminal === "string" ? data.terminal : null
      if (!terminal) return true
      if (terminal === "PASS" || terminal === "FAIL" || terminal === "HARD_STOP") {
        const updatedMs = readIsoMillis(data.updatedAt) ?? readIsoMillis(data.createdAt)
        if (updatedMs == null || updatedMs >= recentCutoffMs) return true
      }
    }
  } catch {
    return false
  }
  return false
}

function normalizeBody(body: string): string {
  return body.trim().toLowerCase()
}

/** User liked / disliked the batch (conversational, not tapback). */
export function detectRecBatchSentiment(body: string): "positive" | "negative" | "ambiguous" {
  const t = normalizeBody(body)
  if (!t) return "ambiguous"
  if (
    /\b(don'?t like|didn'?t like|not good|not useful|useless|terrible|awful|hate|meh|trash|off\b|wrong|bad|nah|nope|no)\b/i.test(
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

function isActionableJobPreferenceFeedback(body: string): boolean {
  const t = normalizeBody(body)
  if (!t) return false
  const hasJobNoun =
    /\b(?:jobs?|roles?|positions?|opportunities|openings|listings|matches)\b/i.test(t) ||
    /(?:工作|岗位|职位|机会|内推)/.test(t)
  if (!hasJobNoun) return false
  return (
    /\b(?:need|want|looking\s+for|look\s+for|prefer|require|requires|should\s+require|only|instead|too\s+senior|too\s+junior|more\s+junior|entry[-\s]?level|junior|new\s+grad|fresh\s+grad|years?\s+of\s+experience|yoe|exp|remote|onsite|hybrid|salary|visa|sponsor)\b/i.test(t) ||
    /\b\d{1,2}\s*[-–]\s*\d{1,2}\b/.test(t) ||
    /(?:经验|年限|初级|应届|远程|薪资|签证)/.test(t)
  )
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
  suppressPrescreenOffer?: boolean
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

  if (
    (state.stage === "await_liked" || state.stage === "await_dislike_reason") &&
    isActionableJobPreferenceFeedback(event.body)
  ) {
    store.log("pa.post_match_retention.yielded_to_job_search", {
      userId: event.userId,
      turnId,
      stage: state.stage,
    })
    return false
  }

  const lang = detectLang(event.body) === "zh" ? "zh" : "en"
  const at = store.nowIso()
  const jobIds = await resolveJobIds(db, event.userId, state)
  const prescreenBlocked =
    state.suppressPrescreenOffer === true
      ? true
      : state.stage === "await_subscribe" || state.stage === "await_prescreen"
        ? await hasBlockingPrescreenSession(db, event.userId, at)
        : false
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
      if (prescreenBlocked) {
        next.stage = "complete"
        reply =
          lang === "zh"
            ? "收到。我这边已有你的初筛记录，WeKruit 会在这里发你下一步。"
            : "Got it. I already have your screen on file, and WeKruit will text the next step here."
      } else {
        next.stage = "await_prescreen"
        reply = copyForStage("await_prescreen", lang)
      }
      break
    }
    case "await_prescreen": {
      if (prescreenBlocked) {
        next.stage = "complete"
        reply =
          lang === "zh"
            ? "你已经在初筛流程里了。WeKruit 正在看结果，下一步会直接发在这里。"
            : "You're already in the screen flow. WeKruit is reviewing it, and the next step will come here."
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
