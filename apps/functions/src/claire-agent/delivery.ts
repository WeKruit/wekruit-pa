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
 * STALENESS WINDOW (Adam 2026-06-04, "cross_turn dedup keeps triggering"): the cross-turn guard exists
 * to stop Claire repeating "the last few messages" — NOT to forbid her ever re-using a phrase she sent
 * days ago. A session can span days (the live case-A thread ran 2026-06-02 → 2026-06-04 inside the last
 * 5 rows), so a 2-day-old "what's your target salary?" must NOT suppress today's distinct turn. Drop any
 * recent-sent row older than this many ms before comparing. 10 min comfortably covers a normal
 * back-and-forth while excluding stale history. Belt-and-suspenders with the turn-start bound below.
 */
const RECENT_SENT_STALENESS_MS = 10 * 60 * 1000

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
/**
 * True when `body` is the SDK structured-output wrapper that FirestoreSession.addItems persists —
 * a JSON object string with a top-level `messages` array (the agent's `{"messages":[…]}` reply
 * shape). Those rows are NOT delivered iMessages; they are the SDK transcript item written by
 * @openai/agents `run()` and must be excluded from the "recently SENT" cross-turn dedup set so a turn
 * never near-dups its own just-persisted wrapper. Cheap + fail-safe: only JSON-object bodies are
 * parsed, and any parse error returns false (treat as a normal sent bubble).
 */
function isStructuredOutputWrapper(body: unknown): boolean {
  if (typeof body !== "string") return false
  const trimmed = body.trim()
  if (!trimmed.startsWith("{") || !trimmed.includes("\"messages\"")) return false
  try {
    const parsed = JSON.parse(trimmed) as { messages?: unknown }
    return Array.isArray(parsed?.messages)
  } catch {
    return false
  }
}

export async function getRecentSentMessages(
  ctx: Pick<ClaireToolContext, "db" | "userId" | "sessionId">,
  limit = RECENT_SENT_WINDOW,
  // turnStartedAtIso (Adam 2026-06-04, the "cross_turn dedup keeps triggering / silent turn" fix): the
  // ISO timestamp captured BEFORE the agent run started this turn. Rows at-or-after it were written by
  // THIS turn (a tool that delivered mid-run, e.g. find_match's role bubbles, OR the SDK session item) —
  // they are NOT genuinely-prior messages, so a turn must never near-dup its OWN just-written rows. When
  // provided, exclude rows with createdAt >= turnStartedAt. This makes "cross-turn" mean what it says.
  // Omitted (legacy callers / tests) → no time bound (back-compat); the source-filter below still guards
  // the SDK-session self-collision.
  turnStartedAtIso?: string,
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
  // Parse the turn-start bound once (Date.parse → ms; undefined when not provided / unparseable → no
  // bound). nowMs anchors the staleness window. Both compared against each row's ISO createdAt below.
  const turnStartedAtMs =
    turnStartedAtIso && !Number.isNaN(Date.parse(turnStartedAtIso)) ? Date.parse(turnStartedAtIso) : undefined
  const nowMs = Date.now()
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
        // ROOT-CAUSE FIX (2026-06-04, the "dedup keeps triggering / silent turn" bug): the durable
        // `pa-messages` transcript carries TWO kinds of assistant row, and only ONE of them is a
        // message Claire actually SENT to the user:
        //   - source="pa-outbound"        → the real delivered iMessage bubble (written by the outbox
        //                                    AFTER send). THIS is "what Claire sent".
        //   - source="agents_sdk_session" → the SDK's own structured-output item, body is the RAW
        //                                    `{"messages":["…"]}` wrapper. @openai/agents `run()`
        //                                    PERSISTS this to the session (FirestoreSession.addItems)
        //                                    BEFORE deliverBubblesEx reads recentSent, so the SAME
        //                                    turn's own JSON wrapper is already in the transcript.
        // A single-bubble turn then near-dups its OWN just-written JSON wrapper (the unpacked bubble
        // shares every token but the literal "messages" key → token Jaccard = N/(N+1) ≥ 0.857 for any
        // bubble ≥ 6 tokens, well past JACCARD_THRESHOLD 0.85) → cross_turn-suppressed → NOTHING
        // delivered → silent. The cross-turn guard must compare against ACTUALLY-SENT bubbles only, so
        // exclude the SDK-session rows. Defensive on BOTH signals (source tag + the JSON wrapper shape)
        // so it holds even if rawMeta is sparse on legacy rows.
        const source = (d?.rawMeta as { source?: unknown } | undefined)?.source
        if (source === "agents_sdk_session") return false
        if (source !== "pa-outbound" && isStructuredOutputWrapper(d?.body)) return false
        // TIME BOUND (Adam 2026-06-04, the "cross_turn dedup keeps triggering" fix). Two cuts, both on
        // the row's ISO `createdAt` (outbox writes now().toISOString(), so it sorts/compares as a string
        // AND parses as a Date):
        //   1. THIS-TURN exclusion — drop rows written at-or-after turnStart. A tool that delivers
        //      mid-run (find_match's role bubbles via ctx.transport.sendText → outbox → a `pa-outbound`
        //      row) lands a real "sent" row DURING this turn; without this, the model's final bubble
        //      that restates a just-sent role-clarifier near-dups its OWN send → cross_turn-suppressed →
        //      silent. "cross-turn" must mean a GENUINELY-PRIOR turn, never this one.
        //   2. STALENESS — drop rows older than RECENT_SENT_STALENESS_MS. The guard targets "the last few
        //      messages" (Adam R1), not a days-old ask that happens to sit in the last-5 of a long-lived
        //      session. A distinct turn must not be eaten by a 2-day-old phrasing.
        // Both cuts are GATED on a turn-start stamp being supplied (the production cross-turn-dedup path
        // always threads it). Legacy/unit callers that pass no turnStart keep the unbounded behavior
        // (they are still source-filtered above) — so existing fixtures with hardcoded past dates are not
        // surprised by a wall-clock staleness drop. Unparseable/missing createdAt → keep (fail-open).
        if (turnStartedAtMs !== undefined) {
          const createdAtRaw = typeof d?.createdAt === "string" ? d.createdAt : ""
          const createdMs = createdAtRaw ? Date.parse(createdAtRaw) : NaN
          if (!Number.isNaN(createdMs)) {
            if (createdMs >= turnStartedAtMs) return false // written THIS turn → not a prior turn
            if (nowMs - createdMs > RECENT_SENT_STALENESS_MS) return false // stale → not "the last few"
          }
        }
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
  // turnStartedAtIso (Adam 2026-06-04): the ISO time captured BEFORE this turn's agent run. Threaded to
  // getRecentSentMessages so the cross-turn guard excludes rows THIS turn already wrote (a tool that
  // delivered mid-run) — i.e. so a turn never near-dups its own just-sent bubble. Optional; omitted →
  // unbounded recent-sent read (back-compat, still source-filtered).
  turnStartedAtIso?: string,
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
  const recentSent = skipCrossTurnDedup
    ? []
    : await getRecentSentMessages(ctx, RECENT_SENT_WINDOW, turnStartedAtIso)
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
