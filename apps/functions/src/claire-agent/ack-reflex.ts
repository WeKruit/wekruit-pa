/**
 * ack-reflex.ts — deterministic tapback for low-information acknowledgements.
 *
 * WHY: the Sendblue reaction mechanism works (verified live 2026-06-01 — a manual
 * reaction from the right pool line on a fresh inbound handle renders a ❤️). The
 * "no tapbacks" regression was NOT the transport (host/from_number/line all fine);
 * it was that the thin agent, when the user sends a bare "ok"/"k"/"thanks", replies
 * with TEXT (or a stray prescreen-pause line) instead of calling react_to_user. The
 * prompt asks the LLM to tapback on a low-info ack, but the LLM does not do it
 * reliably. So we make it deterministic — exactly like deterministic rec delivery.
 *
 * SCOPE (intentionally narrow + safe):
 *   - TRIAGE mode only. Onboarding / prescreen own their own flow and must keep
 *     consuming the user's turn (a bare "ok" mid-onboarding may need to advance).
 *   - Only NON-ACTIONABLE acknowledgements. We deliberately EXCLUDE yes/yeah/yep/
 *     sure/ok-let's — those can mean "do the thing" (e.g. "yes find me jobs") and
 *     must reach the agent. A pure ack ("ok", "thanks", "got it", 👍) never carries
 *     an action, so a tapback + silence is the correct human response.
 *
 * This is a delivery CONTROL reflex (a closed keyword set), not enum tagging — the
 * no-regex-in-tagging rule does not apply here.
 */

/** Lowercased, punctuation-stripped tokens that are pure acknowledgements. */
const ACK_TOKENS = new Set<string>([
  "ok", "okay", "oka", "oki", "okie", "k", "kk", "kkk", "okk", "okok", "okie dokie",
  "thanks", "thank you", "thankyou", "thx", "thnx", "thanx", "ty", "tysm", "tyvm", "tq",
  "got it", "gotit", "gotcha", "noted", "understood", "makes sense", "sounds good",
  "soundsgood", "sg", "sounds great", "will do", "willdo", "cool", "coolcool", "nice",
  "great", "perfect", "awesome", "sweet", "word", "bet", "for sure thanks", "appreciate it",
  "appreciated", "ok thanks", "okthanks", "ok thank you", "thanks!", "alright", "aight",
])

/** Emoji that, ALONE, are pure acks (thumbs up / ok hand / pray / handshake). Skin-tone
 *  modifiers, variation selectors and ZWJ are stripped first so 👍🏽 == 👍. */
const ACK_EMOJI_RE = /^(?:\p{Extended_Pictographic}|\u{1F3FB}|\u{1F3FC}|\u{1F3FD}|\u{1F3FE}|\u{1F3FF}|️|‍|\s)+$/u
const ACK_BASE_EMOJI = new Set<string>(["👍", "👌", "🙏", "🤝"])

/**
 * True when `text` is a bare, non-actionable acknowledgement that should be
 * answered with a tapback and no text. Conservative by design: anything with
 * extra content (a question, a request, "ok but...", "ok let's do X") returns
 * false and falls through to the agent.
 */
export function isLowInfoAck(text: string | null | undefined): boolean {
  if (typeof text !== "string") return false
  const raw = text.trim()
  if (!raw || raw.length > 24) return false // longer than any bare ack → has content

  // Emoji-only ack (👍 / 👌 / 🙏 ...). Reject other emoji (😡, ❓, etc.).
  if (ACK_EMOJI_RE.test(raw)) {
    const base = raw.replace(/[\u{1F3FB}-\u{1F3FF}️‍\s]/gu, "")
    const chars = Array.from(base)
    return chars.length > 0 && chars.every((c) => ACK_BASE_EMOJI.has(c))
  }

  // Normalize: lowercase, strip trailing/leading punctuation + emoji, collapse spaces.
  const norm = raw
    .toLowerCase()
    .replace(/[\p{Extended_Pictographic}️‍]/gu, "")
    .replace(/[.!~,…\-\s]+$/u, "")
    .replace(/^[.!~,…\-\s]+/u, "")
    .replace(/\s+/g, " ")
    .trim()
  if (!norm) return false
  return ACK_TOKENS.has(norm)
}
