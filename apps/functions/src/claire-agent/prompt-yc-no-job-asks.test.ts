import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { buildClairePrompt } from "./prompt.js"

/**
 * Adam-LOCKED 2026-07-24: "for YC source they should not be asked about job rec / anything from
 * Claire… so for this we don't need this ask 'want me to pull roles now?' and the location+salary
 * ask."
 *
 * These lock ABSENCE, not presence of a counterweight. #611 established that appending a YC
 * override loses to a concrete instruction still sitting in the prompt, so the job-search
 * instructions must simply not be there for a YC user.
 */
const YC = { mode: "triage" as const, lang: "en" as const, entryPosture: "yc_startup_school" as const }
const NORMAL = { mode: "triage" as const, lang: "en" as const }

describe("YC prompt — zero job asks", () => {
  /**
   * The banned phrases legitimately appear inside the YC directive's own PROHIBITIONS
   * ("Do NOT ask 'want me to pull roles now?'"). So assert every occurrence is NEGATED —
   * i.e. the prompt never AFFIRMATIVELY instructs the ask. A blanket doesNotMatch would
   * fail on the guard text itself.
   */
  function assertOnlyNegatedMentions(prompt: string, phrase: RegExp, label: string) {
    const re = new RegExp(phrase.source, "gi")
    let m: RegExpExecArray | null
    let found = 0
    while ((m = re.exec(prompt)) !== null) {
      found += 1
      const before = prompt.slice(Math.max(0, m.index - 90), m.index)
      assert.match(
        before,
        /do not|don'?t|never|no job/i,
        `${label}: found a NON-negated mention → the prompt is instructing the ask. Context: ${JSON.stringify(before.slice(-70))}`,
      )
    }
    return found
  }

  it("never affirmatively instructs 'want me to pull roles now?'", () => {
    const p = buildClairePrompt(YC)
    assertOnlyNegatedMentions(p, /want me to pull (roles now|fresh roles|a few roles)/, "pull-roles ask")
  })

  it("never affirmatively instructs the location + salary ask", () => {
    const p = buildClairePrompt(YC)
    assert.doesNotMatch(p, /which city\/metro, and rough target salary/i)
    assertOnlyNegatedMentions(p, /target salary/, "salary ask")
  })

  it("drops every job-search scaffolding block", () => {
    const p = buildClairePrompt(YC)
    assert.doesNotMatch(p, /persist durable role\/job-type\/location prefs/i, "PREFERENCES dropped")
    assert.doesNotMatch(p, /US-ONLY SCOPE/i, "US_SCOPE dropped")
    assert.doesNotMatch(p, /AFFIRMATIVE → EXECUTE/i, "DELIVERY dropped")
    assert.doesNotMatch(p, /THEN offer to pull roles/i, "POSITIONING dropped")
    assert.doesNotMatch(p, /recommend me some roles/i, "FEWSHOT dropped")
    assert.doesNotMatch(p, /offer_interview_slots/i, "SCHEDULING dropped")
  })

  it("never instructs pulling or offering roles anywhere in the prompt", () => {
    const p = buildClairePrompt(YC)
    assert.doesNotMatch(p, /pull a few roles/i)
    assert.doesNotMatch(p, /offer to pull roles/i)
    assert.doesNotMatch(p, /recommendations → find_match/i)
    assert.doesNotMatch(p, /MATCH COMMANDS/i)
  })

  it("keeps résumé enrichment (YC users still upload a résumé for their profile)", () => {
    assert.match(buildClairePrompt(YC), /cv_parse/)
  })

  it("DOES carry the people-lane framing so the turn still has direction", () => {
    const p = buildClairePrompt(YC)
    assert.match(p, /YC STARTUP SCHOOL PEOPLE LANE/i)
    assert.match(p, /record_yc_intake/)
    assert.match(p, /who they'd want to meet|who do you want to meet/i)
  })

  it("leaves the NORMAL candidate prompt fully intact (no fleet-wide regression)", () => {
    const p = buildClairePrompt(NORMAL)
    assert.match(p, /want me to pull roles now/i)
    assert.match(p, /rough target salary/i)
    assert.match(p, /US-ONLY SCOPE/i)
    assert.match(p, /persist durable role\/job-type\/location prefs/i)
    assert.match(p, /recommendations → find_match/i)
    assert.doesNotMatch(p, /YC STARTUP SCHOOL PEOPLE LANE/i)
  })
})
