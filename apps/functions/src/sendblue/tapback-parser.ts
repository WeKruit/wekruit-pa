/**
 * Inbound iMessage tapback / reaction parser.
 *
 * iMessage relays tapback reactions as plaintext lines on the recipient side.
 * Apple's localization for the en_US/zh_CN locale we observe in production
 * emits the reaction verb in English followed by a quoted excerpt of the
 * message that was reacted to. Smart quotes (U+201C / U+201D) are the iOS
 * default; plain ASCII quotes also occur on macOS Messages. Examples seen
 * in the wild:
 *
 *   Loved "Here are 3 jobs that match…"
 *   Liked 'Career check-in tomorrow?'
 *   Laughed at "see you then"
 *   Emphasized "test"
 *   Questioned "draft attached"
 *
 * The parser MUST be defensive — false positives leak garbage into
 * pa-tapback-events, false negatives drop user reactions silently. We
 * anchor with `^` + `$`, accept smart-or-plain quotes, and bound the quoted
 * text length to 200 chars (iMessage truncates the excerpt around 100 chars
 * but Apple has nudged that ceiling several times).
 *
 * Returns the canonical Sendblue reaction value (love / like / dislike /
 * laugh / emphasize / question) so downstream code can pass it directly to
 * `sendReaction()` without re-mapping.
 */

export type TapbackKind =
  | "love"
  | "like"
  | "dislike"
  | "laugh"
  | "emphasize"
  | "question"

export type ParsedTapback = {
  kind: TapbackKind
  quotedText: string
}

// Smart quotes: U+201C left double, U+201D right double, U+2018 left single,
// U+2019 right single. Plain ASCII " and ' also accepted.
const QUOTE_OPEN = "[“‘\"']"
const QUOTE_CLOSE = "[”’\"']"

// Verb → canonical kind. Keep in sync with Sendblue Reactions API.
const VERB_TO_KIND: Record<string, TapbackKind> = {
  loved: "love",
  liked: "like",
  disliked: "dislike",
  "laughed at": "laugh",
  emphasized: "emphasize",
  questioned: "question",
}

const VERB_PATTERN = "(Loved|Liked|Disliked|Laughed at|Emphasized|Questioned)"

// Anchored: full string must be `<Verb> <openQuote><quotedText><closeQuote>`.
// Quoted text is non-greedy, 1-200 chars, no embedded line breaks.
const TAPBACK_REGEX = new RegExp(
  `^${VERB_PATTERN}\\s+${QUOTE_OPEN}([^\\r\\n]{1,200}?)${QUOTE_CLOSE}\\s*$`
)

export function parseInboundTapback(content: string): ParsedTapback | null {
  if (typeof content !== "string") return null
  const trimmed = content.trim()
  if (!trimmed) return null

  const match = TAPBACK_REGEX.exec(trimmed)
  if (!match) return null

  const verb = (match[1] ?? "").toLowerCase()
  const quotedText = match[2] ?? ""
  const kind = VERB_TO_KIND[verb]
  if (!kind) return null
  if (!quotedText) return null

  return { kind, quotedText }
}
