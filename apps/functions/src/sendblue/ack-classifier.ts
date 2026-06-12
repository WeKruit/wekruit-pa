/**
 * ack-classifier.ts — deterministic "does this inbound await a real reply?" classifier.
 *
 * SCOPE (read this before touching it): this classifier exists ONLY to make a
 * DELIVERY decision — "tapback-vs-text" for an ack, and "is this inbound genuinely
 * unanswered" for the operator-review alert sweep. It is NEVER used to classify a
 * message into a TAG / enum (the repo's absolute no-regex-in-tagging rule). The
 * agent itself still uses LLM judgment to decide react_to_user vs text on the live
 * conversational path (prompt.ts: the ack/greeting tapback directive). This module
 * is the deterministic floor for:
 *   (1) the unanswered-inbound alert sweep — exclude messages that genuinely need
 *       no reply (pure ack, STOP/opt-out) so we never alert an operator for a
 *       "thanks 👍" that correctly got a tapback and no text.
 *   (2) a tapback-vs-text fallback hint — a pure ack that FOLLOWS a Claire message
 *       should get a tapback, never dead silence; a bare greeting / first contact
 *       must get a TEXT reply (the "Greeting ≠ tapback" carve-out, 2026-06-04).
 *
 * Conservative by construction: when in doubt we return `other` (→ DO alert / DO
 * reply). A false `pure_ack` would suppress a real reply/alert, which is the worse
 * failure, so the patterns are anchored, short, and whole-string.
 */

export type InboundReplyNeed =
  | "pure_ack" // "thanks" / "ok" / "👍" / "sounds good" — no real reply owed
  | "greeting" // "hi" / "hey" — a conversation OPENER; always owes a TEXT reply
  | "stop" // STOP / opt-out — terminal, no reply owed
  | "other" // a substantive message — a real reply IS owed

export interface ClassifyInboundOptions {
  /**
   * True when this inbound FOLLOWS a Claire message (i.e. there is prior assistant
   * context in the thread). A bare ack only means "no reply owed" when it follows
   * something Claire said — a cold ack with no preceding Claire turn is treated as
   * `other` (we should still engage). Defaults to true (the common case in a live
   * thread); the sweep passes the real signal.
   */
  followsClaireMessage?: boolean
}

// STOP / opt-out — must mirror the deterministic SMS STOP gate vocabulary. These
// are terminal; the user is owed NO further outbound (handling them is the STOP
// gate's job, not the alert sweep's).
const STOP_WORDS = new Set([
  "stop",
  "stopall",
  "unsubscribe",
  "cancel",
  "end",
  "quit",
  "optout",
  "opt-out",
  "opt out",
  "remove me",
  "delete",
  "delete me",
  "leave me alone",
  "do not contact",
  "don't contact me",
])

// Pure low-information acknowledgements. Whole-string, lowercased, punctuation
// stripped. Kept tight — anything beyond these short tokens is `other`.
const ACK_PHRASES = new Set([
  "ok",
  "okay",
  "k",
  "kk",
  "kay",
  "yes",
  "yep",
  "yup",
  "yeah",
  "ya",
  "sure",
  "sounds good",
  "sound good",
  "sg",
  "got it",
  "gotit",
  "will do",
  "willdo",
  "thanks",
  "thank you",
  "thank u",
  "thx",
  "ty",
  "tysm",
  "thanks!",
  "cool",
  "nice",
  "great",
  "perfect",
  "awesome",
  "appreciate it",
  "much appreciated",
  "done",
  "noted",
  "understood",
  "makes sense",
  "for sure",
  "alright",
  "all good",
  "no worries",
  "np",
])

const GREETING_PHRASES = new Set([
  "hi",
  "hii",
  "hiya",
  "hey",
  "heyy",
  "hello",
  "hellooo",
  "yo",
  "sup",
  "whats up",
  "what's up",
  "wassup",
  "howdy",
  "你好",
  "哈喽",
  "在吗",
])

/**
 * True when the trimmed string is composed ENTIRELY of emoji / pictographic
 * characters (a bare reaction emoji like "👍" / "🙏" / "❤️"). A bare emoji that
 * follows a Claire message is a tapback-grade ack. Implemented with Unicode
 * property escapes (NOT a token→tag map) — purely a delivery signal.
 */
function isBareEmoji(s: string): boolean {
  if (!s) return false
  // Strip variation selectors / ZWJ / skin-tone modifiers, then require every
  // remaining grapheme to be an emoji/pictographic or whitespace.
  const cleaned = s.replace(/[‍️\u{1f3fb}-\u{1f3ff}]/gu, "")
  if (!cleaned) return false
  return /^[\p{Extended_Pictographic}\p{Emoji_Presentation}\s]+$/u.test(cleaned)
}

/** Normalize for matching: lowercase, collapse whitespace, strip trailing punctuation/emoji. */
function normalize(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[‍️]/gu, "")
    .replace(/\s+/g, " ")
    // strip a trailing run of punctuation / emoji (e.g. "thanks!! 🙏" → "thanks")
    .replace(/[\s!.,~)\]}"'’”\p{Extended_Pictographic}]+$/u, "")
    .trim()
}

/**
 * Classify how much of a reply this inbound message owes. Deterministic and
 * conservative — anything not clearly an ack / greeting / stop is `other`.
 */
export function classifyInboundReplyNeed(
  rawBody: string,
  opts: ClassifyInboundOptions = {},
): InboundReplyNeed {
  const followsClaire = opts.followsClaireMessage !== false
  if (typeof rawBody !== "string") return "other"
  const trimmed = rawBody.trim()
  if (!trimmed) return "other"

  // Long messages are never a bare ack/greeting — short-circuit before normalizing.
  if (trimmed.length > 40) {
    // still allow a long emoji-only string through the emoji branch below
    if (!isBareEmoji(trimmed)) return classifyLongOrStop(trimmed)
  }

  const norm = normalize(trimmed)

  // STOP / opt-out is terminal regardless of preceding context.
  if (STOP_WORDS.has(norm)) return "stop"

  // A bare reaction emoji ("👍") FOLLOWING a Claire message is a tapback-grade ack.
  if (isBareEmoji(trimmed)) return followsClaire ? "pure_ack" : "greeting"

  if (GREETING_PHRASES.has(norm)) return "greeting"

  // A pure ack only counts as "no reply owed" when it FOLLOWS a Claire message —
  // an ack with no preceding Claire turn should still get real engagement.
  if (ACK_PHRASES.has(norm)) return followsClaire ? "pure_ack" : "other"

  // "thanks <something>" / "ok <something>" combos: only the bare forms are acks.
  return "other"
}

/** STOP check for the long-message branch (a verbose "please remove me ..." still opts out). */
function classifyLongOrStop(trimmed: string): InboundReplyNeed {
  const norm = normalize(trimmed)
  if (STOP_WORDS.has(norm)) return "stop"
  return "other"
}

/**
 * Convenience predicate for the alert sweep: TRUE when this inbound genuinely
 * awaits a real reply (so a missing reply IS alert-worthy). FALSE for pure acks
 * and STOP/opt-out — those are correctly handled by a tapback / the STOP gate and
 * must never raise an operator alert.
 *
 * Greetings DO await a reply (a bare "hi" must get a TEXT back — the greeting
 * carve-out), so a greeting that went unanswered for >6h IS alert-worthy.
 */
export function inboundAwaitsRealReply(
  rawBody: string,
  opts: ClassifyInboundOptions = {},
): boolean {
  const need = classifyInboundReplyNeed(rawBody, opts)
  return need === "other" || need === "greeting"
}
