/**
 * YC people-lane job-offer scrub (Adam-LOCKED 2026-07-24).
 *
 * #611 removed every job TOOL from the YC agent's tool set, so a YC user can never be
 * DELIVERED a job listing — verified live: zero ATS/apply links have ever gone out to a
 * yc-source user. But offering roles in PROSE needs no tool, and the only thing stopping
 * the offer was prompt text. prompt.ts literally says `NEVER offer 'want me to pull roles'`
 * and the model emitted that phrase near-verbatim to a real YC user 14.5h after the guards
 * shipped ("want me to pull a few roles that fit this kind of cv/ml + training focus",
 * 2026-07-24T15:46Z). Prompt-only rules are non-deterministic; this is the deterministic
 * backstop at the delivery seam.
 *
 * CRITICAL — refusals must survive. Claire's CORRECT behaviour also contains job words
 * ("for YC startup school i can't pull job listings here"). Those are the guard working and
 * must NOT be scrubbed. So a sentence is dropped only when it offers roles WITHOUT a
 * negation; a negated/refusing sentence is kept verbatim.
 */

/** Affirmative role/job offers — the shapes the model actually reaches for. */
const JOB_OFFER_RE =
  /(pull|find|share|send|show|grab|surface|line up|dig up|list)\s+(you\s+)?(a\s+few\s+|some\s+|any\s+|the\s+)?(other\s+|more\s+|open\s+|relevant\s+|matching\s+)?(roles?|jobs?|openings?|positions?|listings?|gigs?)|(roles?|jobs?|openings?|positions?)\s+that\s+(fit|align|match|suit)|also\s+fits?\b[^.!?]{0,60}\broles?\b|peek\s+at\s+who'?s\s+building|startups?\s+that\s+are\s+hiring|who'?s\s+hiring/i

/**
 * Negation / refusal markers. If one sits in the same sentence as an offer pattern the
 * sentence is Claire correctly declining, not offering — keep it.
 */
const NEGATION_RE =
  /\b(can'?t|cannot|can not|won'?t|will not|don'?t|do not|doesn'?t|isn'?t|aren'?t|not\s+set\s+up|no\s+job|never|instead\s+of|rather\s+than|off\s+for\s+yc|not\s+for\s+yc|unable)\b/i

/** Deterministic people-framed replacement when scrubbing empties a bubble. */
export const YC_PEOPLE_REDIRECT =
  "for YC Startup School this chat is people-matching (founders, investors, operators worth meeting) — not job roles. i'll text you a first few right here, and more after."

/**
 * Split on sentence boundaries while KEEPING the delimiter, so rebuilt text reads naturally
 * and a dropped sentence doesn't smear its neighbours together.
 */
function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?…])\s+/).filter((s) => s.length > 0)
}

/* ────────────────────────────────────────────────────────────────────────────
 * INTERNAL-STATE NARRATION SCRUB (2026-07-25, live YC Startup School event)
 *
 * MEASURED, not theoretical. Over today's 478 YC threads, 11 of the 81 people who
 * actually reached the matcher (13.6%) were told about our plumbing as if it were
 * their world, 2.5 times each — the single highest repeat-rate failure of the event
 * and the source of every "really bad experience" screenshot. Verbatim, +19257918082:
 *
 *   user  : "I just want u to give me as many investors as u can"
 *   claire: "i just pushed a batch already, and it looks like you're still on that
 *            same screen on your side, so i don't want to spam more right now.
 *            which 1–2 investors from the ones i sent should i go deeper on?"
 *   user  : "I want 10 more"
 *   claire: "that last investor batch is still the one on your screen right now…"
 *   user  : "I Alr did"
 *
 * The user does not have a "batch" or a "screen". They have a conversation.
 *
 * WHY A DETERMINISTIC SCRUB AND NOT MORE PROMPT (this is the load-bearing part):
 *
 *  1. The negative ban-list already existed and already failed. The tool's own
 *     `nextAction` said, in those words, do not say "still on your screen",
 *     "previous batch", "i tried to pull", and never ask which one to "go deeper
 *     on" — and the model emitted all four anyway, on three consecutive turns.
 *     Enumerating a forbidden phrase is also the most reliable way to put it in
 *     the model's mouth. This is the same lesson, and the same remedy, as the
 *     job-offer scrub above.
 *
 *  2. THE ECHO — the reason payload fixes alone cannot close this. Once one leaked
 *     sentence lands in the transcript it becomes conversation history, and the
 *     model reproduces it on later turns from context alone, with no tool call and
 *     no guard involved. Measured: at 17:28 the window guard was NOT firing (the
 *     budget had expired 21s earlier) and the phrase "still on your screen" appears
 *     nowhere in the zero-results payload, yet Claire said it twice more. No change
 *     to a tool return value can reach that. Only the delivery seam can.
 *
 * SCOPE — narrow on purpose. Every pattern below requires the INTERNAL FRAMING, never
 * a bare topic word, because the honest copy this lane depends on is full of the same
 * nouns: "nobody here matches that exactly", "not many here match that closely, so
 * this is a short list rather than a padded one", "more Startup School profiles are
 * still coming in". Those are the guard working correctly and must survive byte-intact.
 * "batch" in particular is a real YC word — "Cofounder @ AgentMail (YC S25)", "which
 * batch are they in" — so it only matches when possessed by our own bookkeeping
 * ("previous/last/that batch", "batch is still…on screen").
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Unambiguous leaks — our delivery bookkeeping narrated as a thing in the person's world.
 * Each of these is verbatim-shaped from a message we actually sent today.
 */
const HARD_LEAK_RE =
  /\bstill\s+(on|showing\s+on|on-screen|showing|the\s+one\s+on)\b[^.!?]{0,30}\b(screen|side)\b|\b(on|still on)\s+(their|that same|the same)\s+screen\b|\bscreen\s+on\s+your\s+side\b|\bbubbles\s+are\s+still\b|\bnothing\s+new\s+(came|could come|can|is coming|to pull)\b|\bnothing\s+(new\s+)?can\s+land\b|\bwon'?t\s+load\s+new\s+matches\b|\bi\s+(just\s+)?tried\s+to\s+(pull|re-?match)\b|\bi\s+just\s+pushed\s+a\s+batch\b|\b(can'?t|cannot|couldn'?t|not\s+able\s+to)\s+(send|push|pull)\s+(you\s+)?(the\s+)?(another|more|a new|the next|a fresh)\b|\b(don'?t|do not)\s+want\s+to\s+spam\b|\bspam\s+(you\s+)?(duplicates|more)\b/i

/**
 * "batch" and friends are OUR words for a delivery, but they are not always a leak —
 * "my last batch wasn't security-heavy enough" is an honest self-correction, and YC's own
 * vocabulary uses the word too ("Cofounder @ AgentMail (YC S25)", "which batch are they in").
 * So the noun alone is never enough: it only counts when the sentence ALSO blames it for
 * blocking us, which is the shape that confuses and stonewalls the reader.
 */
// NOT "profiles" — the honest standing line we fall back to is "more Startup School profiles are
// still coming in", which pairs that noun with "still" and would scrub itself.
const DELIVERY_NOUN_RE = /\b(batch|people bubbles|bubbles|people list)\b/i
const BLOCKED_FRAME_RE =
  /\b(still|already\s+(got|have|viewing)|can'?t|cannot|couldn'?t|won'?t|don'?t\s+want|didn'?t\s+come\s+through|nothing\s+new|spam|not\s+able)\b/i

/**
 * The invented follow-up. We do not do "pick two of the people I already sent and
 * I'll go deeper" — there is no such capability, nobody asked for it, and it is what
 * the model reaches for when it has decided it cannot send anyone. Commit 16228311
 * banned it in the prompt; it was still going out to real users hours later.
 */
const PICK_BETWEEN_RE =
  /\b(go|going|dig|dive|digging|diving)\s+deeper\s+on\b|\bwhich\s+(1|2|one|two)\s*[–—-]?\s*(1|2|one|two)?\s*(of\s+)?(the\s+)?(investors|founders|people|folks|ones)\b.{0,40}\b(deeper|focus|prioriti[sz]e)\b/i

/**
 * Honest replacement when scrubbing empties a bubble. Carries NO internal state and
 * NO promise of timing — only the two things that are unconditionally true: the pool
 * is still filling, and we will text them when someone good lands.
 */
export const YC_MORE_COMING =
  "more Startup School people are still landing in the pool — i'll text you here the moment there's someone worth your time."

/**
 * Scrub internal-state narration out of ONE bubble.
 * Returns the cleaned bubble, or null when nothing survives (caller substitutes YC_MORE_COMING).
 */
function isInternalNarration(sentence: string): boolean {
  if (HARD_LEAK_RE.test(sentence)) return true
  if (PICK_BETWEEN_RE.test(sentence)) return true
  // Soft case: our delivery noun, but only when it is being blamed for blocking us.
  return DELIVERY_NOUN_RE.test(sentence) && BLOCKED_FRAME_RE.test(sentence)
}

export function scrubYcInternalNarrationFromBubble(bubble: string): string | null {
  if (!isInternalNarration(bubble)) return bubble // fast path — untouched, byte-identical
  const kept = splitSentences(bubble).filter((s) => !isInternalNarration(s))
  const rebuilt = kept.join(" ").trim()
  return rebuilt.length > 0 ? rebuilt : null
}

/**
 * Delivery-seam guard: no bubble may describe our own delivery bookkeeping to the person.
 * YC lane only, so every other path is byte-unchanged.
 */
export function scrubYcInternalNarration(bubbles: string[]): {
  bubbles: string[]
  scrubbed: number
} {
  let scrubbed = 0
  const out: string[] = []
  for (const b of bubbles) {
    const cleaned = scrubYcInternalNarrationFromBubble(b)
    if (cleaned === b) {
      out.push(b)
      continue
    }
    scrubbed += 1
    // Substitution (never a drop) is what keeps this from trading a leak for silence —
    // the turn always still says something true.
    out.push(cleaned ?? YC_MORE_COMING)
  }
  return { bubbles: out, scrubbed }
}

/**
 * Scrub affirmative job-role offers out of ONE bubble.
 * Returns the cleaned bubble, or null when nothing survives (caller substitutes the redirect).
 */
export function scrubYcJobOffersFromBubble(bubble: string): string | null {
  if (!JOB_OFFER_RE.test(bubble)) return bubble // fast path — untouched, byte-identical
  const kept = splitSentences(bubble).filter(
    (s) => !JOB_OFFER_RE.test(s) || NEGATION_RE.test(s),
  )
  const rebuilt = kept.join(" ").trim()
  return rebuilt.length > 0 ? rebuilt : null
}

/**
 * Delivery-seam guard for the YC people lane. Only runs when ycPeopleMode is true, so every
 * non-YC path is byte-unchanged. Reports what it scrubbed for telemetry.
 */
export function scrubYcJobOffers(bubbles: string[]): {
  bubbles: string[]
  scrubbed: number
} {
  let scrubbed = 0
  const out: string[] = []
  for (const b of bubbles) {
    const cleaned = scrubYcJobOffersFromBubble(b)
    if (cleaned === b) {
      out.push(b)
      continue
    }
    scrubbed += 1
    out.push(cleaned ?? YC_PEOPLE_REDIRECT)
  }
  // An all-empty result would go silent; the redirect substitution above already prevents that.
  return { bubbles: out, scrubbed }
}
