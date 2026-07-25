import { YC_MATCH_DELIVERY_WHEN } from "@pa/pa-orchestrator"
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
  `for YC Startup School this chat is people-matching (founders, investors, operators worth meeting) — not job roles. your matches land on ${YC_MATCH_DELIVERY_WHEN} and i'll text you right here (and email you).`

/**
 * Split on sentence boundaries while KEEPING the delimiter, so rebuilt text reads naturally
 * and a dropped sentence doesn't smear its neighbours together.
 */
function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?…])\s+/).filter((s) => s.length > 0)
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
