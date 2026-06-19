/**
 * conversation-sentiment-scan.ts — classify candidate↔Claire conversations by
 * sentiment and surface the unhappy ones on the admin dashboard.
 *
 * `paConversationSentimentScan` (scheduled daily + callable for manual re-run)
 * scans pa-messages for the last 7 days, groups by candidate, LLM-classifies
 * each conversation (strict JSON, gpt-5.4-mini via the 3-tier router), and
 * upserts one doc per candidate into pa-conversation-sentiment/{userId}.
 *
 * The classification core is shared with the one-off backfill script
 * (apps/functions/scripts/backfill-conversation-sentiment.mjs) so the dashboard
 * has data immediately from the existing 7-day scan JSON.
 *
 * Admin-only callable (authorizeAdminCallable). Advisory data only — never
 * mutates candidate state, never sends anything. Fail-open per conversation.
 */
import { onCall } from "firebase-functions/v2/https"
import { onSchedule } from "firebase-functions/v2/scheduler"
import { defineSecret } from "firebase-functions/params"
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import { logger } from "firebase-functions/v2"
import { callWithFallback, type ModelConfig } from "@pa/pa-resume-parser"
import {
  CONVERSATION_SENTIMENT_CLASSIFIER_VERSION,
  CONVERSATION_SENTIMENT_JSON_SCHEMA,
  CONVERSATION_SENTIMENT_SYSTEM_PROMPT,
  CONVERSATION_SENTIMENTS,
  CONVERSATION_SENTIMENT_CATEGORIES,
  PA_COLLECTIONS,
  renderConversationForClassifier,
  type ConversationSentiment,
  type ConversationSentimentCategory,
  type ConversationSentimentClassification,
  type ConversationSentimentDoc,
  type ConversationSentimentMessage,
} from "@pa/core-types"
import { getAnthropicConfig, getOpenAIConfig } from "./lib/llm-providers.js"
import { ANTHROPIC_API_KEY } from "./orchestrator-deps.js"
import { authorizeAdminCallable } from "./promote-sandbox-tag.js"

const PA_OPENAI_AGENT_API_KEY = defineSecret("PA_OPENAI_AGENT_API_KEY")
const PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN")

const MESSAGES = PA_COLLECTIONS.messages
const SENTIMENT = PA_COLLECTIONS.conversationSentiment

const SCAN_WINDOW_DAYS = 7
const MAX_CONVERSATIONS_PER_RUN = 400
const MIN_MESSAGES = 2

/**
 * gpt-5.4-mini primary (Adam spec for this surface), Sonnet middle, gpt-4.1-mini
 * final — same graceful fallthrough as the rest of the platform.
 */
const SENTIMENT_TIER_CHAIN: ReadonlyArray<ModelConfig> = [
  { tier: "primary", provider: "openai", model: "gpt-5.4-mini", maxRetries: 2 },
  { tier: "secondary", provider: "anthropic", model: "claude-sonnet-4-6", maxRetries: 1 },
  { tier: "tertiary", provider: "openai", model: "gpt-4.1-mini", maxRetries: 1 },
]

export type ConversationLlm = (args: {
  systemPrompt: string
  userText: string
  schemaName: string
  schema: Record<string, unknown>
}) => Promise<{ rawJson: string; usedModel: string }>

export type ScannedConversation = {
  userId: string
  phone?: string
  messages: ConversationSentimentMessage[]
  lastMessageAt?: string
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : ""
}

function isSentiment(v: unknown): v is ConversationSentiment {
  return typeof v === "string" && (CONVERSATION_SENTIMENTS as readonly string[]).includes(v)
}

function isCategory(v: unknown): v is ConversationSentimentCategory {
  return typeof v === "string" && (CONVERSATION_SENTIMENT_CATEGORIES as readonly string[]).includes(v)
}

/** Coerce raw LLM JSON into a valid classification, defensively. */
export function coerceClassification(raw: unknown): ConversationSentimentClassification {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
  const sentiment: ConversationSentiment = isSentiment(obj.sentiment) ? obj.sentiment : "neutral"
  const category: ConversationSentimentCategory = isCategory(obj.category)
    ? obj.category
    : sentiment === "positive" || sentiment === "very_positive"
      ? "happy_engaged"
      : "neutral_incomplete"
  const unhappy =
    typeof obj.unhappy === "boolean"
      ? obj.unhappy
      : sentiment === "negative" || sentiment === "very_negative"
  return {
    sentiment,
    unhappy,
    category,
    evidenceQuote: str(obj.evidenceQuote),
    whatWentWrong: str(obj.whatWentWrong),
    fixIdea: str(obj.fixIdea),
  }
}

/** Classify a single conversation. Returns null on hard failure (fail-open). */
export async function classifyConversation(
  convo: ScannedConversation,
  llm: ConversationLlm,
  now: string,
): Promise<ConversationSentimentDoc | null> {
  if (convo.messages.length < MIN_MESSAGES) return null
  try {
    const userText = renderConversationForClassifier(convo.messages)
    const out = await llm({
      systemPrompt: CONVERSATION_SENTIMENT_SYSTEM_PROMPT,
      userText,
      schemaName: "ConversationSentimentClassification",
      schema: CONVERSATION_SENTIMENT_JSON_SCHEMA,
    })
    const classification = coerceClassification(JSON.parse(out.rawJson))
    return {
      userId: convo.userId,
      ...(convo.phone ? { phone: convo.phone } : {}),
      ...classification,
      ...(convo.lastMessageAt ? { lastMessageAt: convo.lastMessageAt } : {}),
      messageCount: convo.messages.length,
      classifiedAt: now,
      model: out.usedModel,
      classifierVersion: CONVERSATION_SENTIMENT_CLASSIFIER_VERSION,
    }
  } catch {
    return null
  }
}

/** Write classifications idempotently — one doc per candidate (doc id = userId). */
export async function writeSentimentDocs(
  db: Firestore,
  docs: ConversationSentimentDoc[],
): Promise<number> {
  let written = 0
  // Firestore batch cap is 500.
  for (let i = 0; i < docs.length; i += 400) {
    const batch = db.batch()
    for (const doc of docs.slice(i, i + 400)) {
      batch.set(db.collection(SENTIMENT).doc(doc.userId), doc, { merge: true })
      written += 1
    }
    await batch.commit()
  }
  return written
}

/**
 * Pull the last-N-day pa-messages, group into per-candidate conversations.
 * Only candidates who sent at least one inbound (role:"user") message in the
 * window are scanned — that's a real candidate conversation, not an outbound-only
 * blast.
 */
export async function scanRecentConversations(
  db: Firestore,
  opts: { windowDays?: number; maxConversations?: number; now?: () => string } = {},
): Promise<ScannedConversation[]> {
  const windowDays = opts.windowDays ?? SCAN_WINDOW_DAYS
  const nowMs = opts.now ? Date.parse(opts.now()) : Date.now()
  const since = new Date(nowMs - windowDays * 24 * 60 * 60 * 1000).toISOString()

  const byUser = new Map<string, ConversationSentimentMessage[]>()
  const lastAt = new Map<string, string>()
  const hasInbound = new Set<string>()

  let cursor: string | undefined
  for (;;) {
    let q = db
      .collection(MESSAGES)
      .where("createdAt", ">=", since)
      .orderBy("createdAt", "asc")
      .limit(2_000)
    if (cursor !== undefined) q = q.startAfter(cursor)
    const snap = await q.get()
    if (snap.empty) break
    for (const d of snap.docs) {
      const data = d.data() as Record<string, unknown>
      const userId = str(data.userId)
      if (!userId) continue
      const role = data.role === "assistant" ? "assistant" : "user"
      const body = str(data.body) || str(data.text) || str(data.content)
      if (!body) continue
      const createdAt =
        str(data.createdAt) ||
        (data.createdAt as { toDate?: () => Date } | undefined)?.toDate?.()?.toISOString?.() ||
        since
      const list = byUser.get(userId) ?? []
      list.push({ role, body, createdAt })
      byUser.set(userId, list)
      if (role === "user") hasInbound.add(userId)
      lastAt.set(userId, createdAt)
    }
    const last = snap.docs[snap.docs.length - 1]!.data() as Record<string, unknown>
    const lastCursor = str(last.createdAt)
    if (!lastCursor || lastCursor === cursor || snap.docs.length < 2_000) break
    cursor = lastCursor
  }

  const conversations: ScannedConversation[] = []
  for (const [userId, messages] of byUser) {
    if (!hasInbound.has(userId)) continue
    conversations.push({
      userId,
      messages,
      ...(lastAt.get(userId) ? { lastMessageAt: lastAt.get(userId)! } : {}),
    })
  }
  // Most-recently-active candidates first; cap the run.
  conversations.sort((a, b) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? ""))
  return conversations.slice(0, opts.maxConversations ?? MAX_CONVERSATIONS_PER_RUN)
}

export type ConversationSentimentScanResult = {
  scanned: number
  classified: number
  written: number
  unhappy: number
}

/** Full scan → classify → upsert. Reused by the schedule + callable. */
export async function runConversationSentimentScan(deps: {
  db: Firestore
  llm: ConversationLlm
  windowDays?: number
  maxConversations?: number
  now?: () => string
  log?: (event: string, fields?: Record<string, unknown>) => void
}): Promise<ConversationSentimentScanResult> {
  const log = deps.log ?? (() => {})
  const now = deps.now?.() ?? new Date().toISOString()
  const conversations = await scanRecentConversations(deps.db, {
    ...(deps.windowDays !== undefined ? { windowDays: deps.windowDays } : {}),
    ...(deps.maxConversations !== undefined ? { maxConversations: deps.maxConversations } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  })
  log("scan.loaded", { conversations: conversations.length })

  const docs: ConversationSentimentDoc[] = []
  for (const convo of conversations) {
    const doc = await classifyConversation(convo, deps.llm, now)
    if (doc) docs.push(doc)
  }
  const written = await writeSentimentDocs(deps.db, docs)
  const unhappy = docs.filter((d) => d.unhappy).length
  log("scan.done", { scanned: conversations.length, classified: docs.length, written, unhappy })
  return { scanned: conversations.length, classified: docs.length, written, unhappy }
}

// ---------------------------------------------------------------------------
// Production LLM caller (router with the gpt-5.4-mini-first chain)
// ---------------------------------------------------------------------------

function loadSecretsIntoEnv(): void {
  for (const s of [PA_OPENAI_AGENT_API_KEY] as const) {
    try {
      const v = s.value().trim()
      if (v) process.env[s.name] = v
    } catch {
      /* unset → fail open */
    }
  }
  try {
    const a = ANTHROPIC_API_KEY.value().trim()
    if (a && a !== "__UNSET__") process.env.ANTHROPIC_API_KEY = a
  } catch {
    /* no anthropic fallback */
  }
}

function makeProductionLlm(): ConversationLlm {
  const openai = getOpenAIConfig()
  const anthropic = getAnthropicConfig()
  return async (args) => {
    if (!openai.apiKey) throw new Error("PA_OPENAI_AGENT_API_KEY missing")
    const out = await callWithFallback({
      apiKey: openai.apiKey,
      baseURL: openai.baseURL,
      anthropicApiKey: anthropic.apiKey ?? undefined,
      chain: SENTIMENT_TIER_CHAIN,
      systemPrompt: args.systemPrompt,
      userText: args.userText,
      schemaName: args.schemaName,
      schema: args.schema,
    })
    return { rawJson: out.rawJson, usedModel: out.usedModel ?? "unknown" }
  }
}

// ---------------------------------------------------------------------------
// CFs
// ---------------------------------------------------------------------------

/** Daily scheduled scan — 05:00 UTC. */
export const paConversationSentimentScan = onSchedule(
  {
    schedule: "0 5 * * *",
    region: "us-central1",
    memory: "1GiB",
    timeoutSeconds: 540,
    secrets: [PA_OPENAI_AGENT_API_KEY, ANTHROPIC_API_KEY],
  },
  async () => {
    loadSecretsIntoEnv()
    const result = await runConversationSentimentScan({
      db: getFirestore(),
      llm: makeProductionLlm(),
      log: (event, fields) => logger.info(`[conversation-sentiment] ${event}`, fields ?? {}),
    })
    logger.info("[conversation-sentiment] schedule done", result)
  },
)

/** Manual re-run from the dashboard (admin only). */
export const paConversationSentimentScanRun = onCall(
  {
    region: "us-central1",
    memory: "1GiB",
    timeoutSeconds: 540,
    maxInstances: 1,
    secrets: [PA_OPENAI_AGENT_API_KEY, ANTHROPIC_API_KEY, PA_ADMIN_TOKEN],
  },
  async (req): Promise<ConversationSentimentScanResult> => {
    authorizeAdminCallable(req as { auth?: { token?: { admin?: unknown } }; data?: unknown })
    loadSecretsIntoEnv()
    const data = (req.data ?? {}) as { windowDays?: number; maxConversations?: number }
    return runConversationSentimentScan({
      db: getFirestore(),
      llm: makeProductionLlm(),
      ...(typeof data.windowDays === "number" ? { windowDays: data.windowDays } : {}),
      ...(typeof data.maxConversations === "number" ? { maxConversations: data.maxConversations } : {}),
      log: (event, fields) => logger.info(`[conversation-sentiment] ${event}`, fields ?? {}),
    })
  },
)
