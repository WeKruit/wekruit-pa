/**
 * delivery.ts — WS-delivery owns this file.
 *
 * The two deterministic delivery REFLEXES (no LLM round-trip), mirrors poc-v2:
 *   - mark-read reflex: fire ctx.transport.markRead() on EVERY inbound, before run().
 *   - typing reflex: agent.on("agent_tool_start", …) fires ctx.transport.typing()
 *     before slow tools (find_match etc). NOTE: in @openai/agents 0.8.5 this is the
 *     event-emitter API `agent.on(...)`, NOT an AgentHooks override (which silently
 *     never fires in 0.8.5 — see poc README). Verified firing order:
 *     agent_tool_start → execute.
 *
 * Also the post-run delivery decision: if run() produced prose AND no delivery tool
 * (tapback/no_reply) already handled it, send it as text.
 */
import type { ClaireToolContext } from "./types.js"
import { normalizeReply } from "./guardrails.js"
import { isNearDuplicateOfAny } from "./dedup.js"

/** Slow tools that should trigger the typing reflex. */
export const SLOW_TOOLS = ["find_match", "match_collab", "cv_parse"] as const

/** pa-messages collection name (durable transcript — what Claire actually sent). */
const PA_MESSAGES = "pa-messages"

/**
 * How many of Claire's most-recent assistant messages (this session) to compare a new bubble
 * against for the CROSS-TURN near-dup guard. A small window keeps the read cheap and bounds
 * suppression to the recent conversation (Adam R1: "the last few messages").
 */
const RECENT_SENT_WINDOW = 5

/**
 * Read up to `limit` of the most-recent messages Claire SENT to this user in this session, from the
 * durable `pa-messages` transcript (NOT pa-outbound — that is the delivery queue and may contain
 * not-yet-sent / failed rows). Used by deliverBubbles to suppress a bubble that is near-identical to
 * something Claire already sent (Adam R1, 2026-06-04).
 *
 * FAIL-OPEN by design: if db/userId/sessionId are absent, or the read throws, return [] so delivery
 * is NEVER blocked. The within-turn exact-dedup still runs regardless.
 *
 * Query shape mirrors FirestoreSession.getItems: filter by sessionId ONLY, then filter role +
 * liveness + sort in memory. This deliberately avoids a Firestore composite index (sessionId +
 * userId + role + orderBy createdAt) that does not exist in prod.
 */
export async function getRecentSentMessages(
  ctx: Pick<ClaireToolContext, "db" | "userId" | "sessionId">,
  limit = RECENT_SENT_WINDOW,
): Promise<string[]> {
  const db = ctx?.db as
    | {
        collection?: (name: string) => {
          where: (
            field: string,
            op: string,
            value: unknown,
          ) => {
            limit: (n: number) => {
              get: () => Promise<{ docs: Array<{ data: () => Record<string, unknown> }> }>
            }
          }
        }
      }
    | undefined
  const sessionId = ctx?.sessionId
  const userId = ctx?.userId
  // Need a session to scope the read; without db/session we cannot (and must not) block delivery.
  if (!db || typeof db.collection !== "function" || !sessionId) return []
  try {
    const snap = await db
      .collection(PA_MESSAGES)
      .where("sessionId", "==", sessionId)
      .limit(200)
      .get()
    const rows = snap.docs
      .map((d) => d.data())
      .filter((d) => {
        if (d?.role !== "assistant") return false
        if (d?.cleared === true || d?.popped === true) return false
        // If userId is known on both sides, keep only this user's rows; tolerate missing userId.
        if (userId && typeof d?.userId === "string" && d.userId && d.userId !== userId) return false
        return true
      })
    rows.sort((a, b) => String(a?.createdAt ?? "").localeCompare(String(b?.createdAt ?? "")))
    return rows
      .slice(-limit)
      .map((d) => (typeof d?.body === "string" ? d.body : ""))
      .filter(Boolean)
  } catch (err) {
    // Fail open: never let a transcript read failure break the conversational turn.
    try {
      ctx && (ctx as { log?: (e: string, p?: Record<string, unknown>) => void }).log?.(
        "claire.dedup.recent_read_error",
        { error: String((err as { message?: unknown })?.message ?? err) },
      )
    } catch {
      /* noop */
    }
    return []
  }
}

/**
 * Hard cap on bubbles per turn — a runaway `messages` array can never flood the thread. Overflow
 * is MERGED into the last bubble (never dropped), so content is preserved, just compacted.
 */
const MAX_BUBBLES = 4

/** Fire the mark-read reflex (immediate, every inbound, pre-run). */
export async function markReadReflex(ctx: ClaireToolContext): Promise<void> {
  await ctx.transport.markRead()
}

/**
 * Wire the typing-before-slow-tool reflex onto the agent's event emitter.
 *
 * `agent` is typed `unknown` because Wave B owns the concrete Agent type; we only
 * need the `.on` event-emitter surface. In `agent.on("agent_tool_start", cb)` the
 * 0.8.5 AgentHooks signature is `(context, tool, details)` — so the SECOND arg is
 * the Tool (with `.name`). We still read `t?.name ?? a?.name` defensively to match
 * the proven POC and survive either argument shape.
 */
export function wireTypingReflex(agent: unknown, ctx: ClaireToolContext): void {
  const emitter = agent as {
    on?: (
      event: "agent_tool_start",
      cb: (
        _c: unknown,
        a: { name?: string } | undefined,
        t: { name?: string } | undefined,
      ) => void,
    ) => void
  }
  if (typeof emitter?.on !== "function") return
  emitter.on("agent_tool_start", (_c, a, t) => {
    const name = t?.name ?? a?.name
    if (name && (SLOW_TOOLS as readonly string[]).includes(name)) {
      // fire-and-forget: typing is a UX reflex, never blocks the tool execute.
      void ctx.transport.typing()
    }
  })
}

/**
 * Post-run delivery decision (Wave B's run loop calls this).
 *
 * If the agent produced prose AND no delivery tool already handled this turn
 * (tapback / no_reply marks `deliveredViaTool`), send the prose as a text bubble.
 * `deliveredViaTool` is tracked by the run loop from the tool calls observed.
 */
export async function deliverFinalText(
  ctx: ClaireToolContext,
  finalText: string,
  deliveredViaTool = false,
): Promise<boolean> {
  const out = String(finalText ?? "").trim()
  if (!out || deliveredViaTool) return false
  await ctx.transport.sendText(out)
  return true
}

/**
 * Richer outcome of a bubble-delivery attempt — lets a caller distinguish the two zero-delivery cases
 * the bare count conflates (Adam 2026-06-04, the "Hi → silence, feels glitchy" anti-silence work):
 *   - `sent === 0 && suppressedAll === false`  → there was NOTHING to send (empty/blank/tool-handled).
 *     Nothing to do; staying silent is correct.
 *   - `sent === 0 && suppressedAll === true`   → there WAS ≥1 real bubble, but the near-dup dedup
 *     dropped EVERY one (a deterministic pattern that duplicates an earlier message). The caller must
 *     NOT go silent — it should fall through to a FRESH agent turn (see runClaireTurn's anti-silence
 *     fallback). The dedup itself is correct and stays; this just surfaces the "all-suppressed" signal.
 */
export interface DeliverBubblesResult {
  /** count of bubbles actually POSTed this turn. */
  sent: number
  /** true ONLY when ≥1 non-empty bubble existed but the dedup suppressed them ALL. */
  suppressedAll: boolean
}

/**
 * Deliver the agent's structured reply as N iMessage bubbles — ONE Sendblue send per element, in
 * order. This is the SDK-native multi-bubble path (the agent's `outputType.messages` array): the
 * agent emits ALL bubbles in ONE response, and we POST each. It REPLACES the old "send each bubble
 * via a tool" approach, whose `send_status_then_continue` loop spammed "one sec" and timed out (the
 * 2026-05-30 kickoff bug): a status/filler tool is NOT a message-sender, and calling it never ends
 * the turn, so the model looped until claire_run_timeout → "hiccupped" fallback.
 *
 * Each bubble is normalized (markdown strip + length cap) independently. Bubbles beyond MAX_BUBBLES
 * are merged into the last. Returns the count actually sent (0 when a delivery TOOL already handled
 * the turn — tapback/no_reply — or the array is empty).
 *
 * Thin wrapper over deliverBubblesEx for back-compat: existing call sites (and tests) expect a bare
 * count. New callers that need to tell "nothing to send" apart from "dedup suppressed everything"
 * call deliverBubblesEx directly.
 */
export async function deliverBubbles(
  ctx: ClaireToolContext,
  messages: readonly string[],
  deliveredViaTool = false,
): Promise<number> {
  return (await deliverBubblesEx(ctx, messages, deliveredViaTool)).sent
}

/**
 * deliverBubblesEx — same delivery as deliverBubbles but returns the richer {sent, suppressedAll}
 * outcome so the anti-silence fallback can fire when a deterministic pattern's bubbles are ALL
 * dropped by the dedup. Dedup thresholds + getRecentSentMessages are UNCHANGED.
 */
export async function deliverBubblesEx(
  ctx: ClaireToolContext,
  messages: readonly string[],
  deliveredViaTool = false,
  // skipCrossTurnDedup (2026-06-04): set TRUE for the anti-silence FALLBACK turn. The fallback exists to
  // GUARANTEE a reply when the normal turn was cross-turn-suppressed — but its fresh agent reply (e.g. a
  // greeting that resembles a past greeting) would hit the SAME cross-turn near-dup guard and get dropped
  // too → still silence (the live "Hi → fallback fires → fallback ALSO suppressed → nothing" bug). When
  // true we skip the recent-sent read so cross-turn suppression is OFF; WITHIN-turn exact + near-dup still
  // run (no double bubbles). One guaranteed reply, never an infinite loop (the fallback runs at most once).
  skipCrossTurnDedup = false,
): Promise<DeliverBubblesResult> {
  if (deliveredViaTool) return { sent: 0, suppressedAll: false }
  const cleanRaw = (Array.isArray(messages) ? messages : [])
    .map((m) => normalizeReply(String(m ?? "")).trim())
    .filter(Boolean)
  // DEDUP (Adam 2026-06-04): gpt-5.4-nano sometimes emits the SAME bubble twice in its `messages` array
  // — the live "still pulling your info—give me a sec 🔍" sent-twice bug. A turn NEVER legitimately
  // sends a byte-identical normalized bubble more than once, so drop exact duplicates (keep first). This
  // is the universal last-line-of-defense for the whole class (any turn, any directive), independent of
  // prompt hardening.
  const seenBubble = new Set<string>()
  const exactClean = cleanRaw.filter((m) => {
    if (seenBubble.has(m)) return false
    seenBubble.add(m)
    return true
  })
  // NOTHING to send (the array was empty / all-blank / tool-handled) — NOT a suppression. The exact-dup
  // collapse above keeps the first of any byte-identical pair, so reaching here means there was no real
  // content at all; staying silent is correct (no fallback).
  if (exactClean.length === 0) return { sent: 0, suppressedAll: false }

  // NEAR-DUP guard (Adam R1, 2026-06-04): drop bubbles that are SIMILAR — not just byte-identical —
  // to (a) a bubble already accepted earlier in THIS turn, or (b) one of the last few messages Claire
  // already SENT this session. On a near-dup we DROP it (send nothing) — never substitute a variant.
  // The recent-sent read is fail-open: a Firestore error (or a stub ctx without db) returns [], so this
  // degrades gracefully to within-turn-only suppression and NEVER blocks delivery.
  const recentSent = skipCrossTurnDedup ? [] : await getRecentSentMessages(ctx)
  const acceptedThisTurn: string[] = []
  const clean: string[] = []
  for (const bubble of exactClean) {
    if (isNearDuplicateOfAny(bubble, acceptedThisTurn)) {
      ctx.log?.("claire.dedup.near_dup_suppressed", { scope: "within_turn", bubble: bubble.slice(0, 120) })
      continue
    }
    if (isNearDuplicateOfAny(bubble, recentSent)) {
      ctx.log?.("claire.dedup.near_dup_suppressed", { scope: "cross_turn", bubble: bubble.slice(0, 120) })
      continue
    }
    acceptedThisTurn.push(bubble)
    clean.push(bubble)
  }
  // SUPPRESSED-ALL: there WERE ≥1 real bubbles (exactClean) but the near-dup guard dropped every one.
  // Signal it so the caller can fall through to a fresh agent turn instead of going silent ("Hi →
  // nothing" glitch). The dedup decision itself stands — we never resurrect the dropped bubbles here.
  if (clean.length === 0) return { sent: 0, suppressedAll: true }
  const bubbles =
    clean.length > MAX_BUBBLES
      ? [...clean.slice(0, MAX_BUBBLES - 1), clean.slice(MAX_BUBBLES - 1).join(" ")]
      : clean

  // SINGLE interface for ALL multi-bubble outbound (onboarding, recs, proactive) — ordered + human.
  // WHY (Adam 2026-05-30, the reversed-greeting bug): two bubbles enqueue two independent pa-outbound
  // rows, each delivered by a SEPARATE concurrent outbox CF instance whose typing dwell is LENGTH-
  // based — the longer compliment dwelled longer and arrived AFTER the shorter question. Fix here, at
  // the single emit seam:
  //   1. send SEQUENTIALLY, and for every bubble after the first, fire a typing indicator + a small
  //      RANDOMIZED human delay BEFORE it. That spaces the `createdAt` timestamps ≥600ms apart (so
  //      create order is unambiguous) AND reads like a person typing the next message.
  //   2. tag each row { seq, paced } so the outbox SKIPS its own length-based dwell for these rows
  //      (delivery.ts already paced them) — no double-pacing, no length-skew reorder.
  // Single bubble (the common case) keeps the legacy path: no emit delay, forwarder dwell as before.
  const multi = bubbles.length > 1
  for (let i = 0; i < bubbles.length; i++) {
    if (i > 0) {
      await ctx.transport.typing().catch(() => {})
      const ms = 600 + Math.floor(Math.random() * 900) // 600–1500ms human inter-bubble beat
      await new Promise((r) => setTimeout(r, ms))
    }
    await ctx.transport.sendText(bubbles[i]!, multi ? { seq: i, paced: true } : undefined)
  }
  return { sent: bubbles.length, suppressedAll: false }
}
