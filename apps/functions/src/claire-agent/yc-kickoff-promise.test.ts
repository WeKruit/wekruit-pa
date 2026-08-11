import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { buildClaireTurnContext } from "./prompt.js"

/**
 * The YC first message must never promise something we do not deliver.
 *
 * Live 2026-07-24: the kickoff said "...then will share the list you should go connect and help you
 * match after that!" while #622 had already removed the attendee list everywhere else. Users duly
 * asked for it ("Share the list with me") and Claire, with nothing to give, produced FIVE clarifying
 * questions and then invented a capability she has no tool for — "i'll send everything as a single
 * email attachment" — ending in the user replying "I didn't received the email".
 *
 * These lock the directive-side rules. The kickoff copy itself is asserted in the yc-qr e2e sim.
 */
const ycPrompt = (intake?: Record<string, unknown>) =>
  buildClaireTurnContext({
    mode: "triage",
    lang: "en",
    entryPosture: "yc_startup_school",
    ...(intake ? { ycEventIntake: intake } : {}),
  } as never)

describe("YC lane — never promise what we can't deliver", () => {
  const withIntake = ycPrompt({ next: "building", offerLinkedin: true })

  it("tells the model there is NO list and to say we match them directly", () => {
    assert.match(withIntake, /IF THEY ASK FOR THE ATTENDEE \/ CONTACT LIST/i)
    assert.match(withIntake, /There is NO list to share/i)
    assert.match(withIntake, /match you directly/i)
  })

  it("forbids inventing an email/attachment capability", () => {
    assert.match(withIntake, /NEVER INVENT A CAPABILITY/i)
    assert.match(withIntake, /canNOT send email/i)
    assert.match(withIntake, /NEVER ask for their email address in order to send something/i)
  })

  it("forbids the interrogation loop when it can't deliver", () => {
    assert.match(withIntake, /ANSWER, DON'T INTERROGATE/i)
    assert.match(withIntake, /at most ONE question per message/i)
  })

  it("names a recorded answer back and forbids re-asking it", () => {
    const p = ycPrompt({
      next: "wants_to_meet",
      offerLinkedin: false,
      recorded: { building: "an AI vet scribe" },
    })
    assert.match(p, /ALREADY ON FILE — what they're building: "an AI vet scribe"/)
    assert.match(p, /NEVER ask what they're building\/working on again/i)
  })

  it("on a COMPLETE intake, instructs asking nothing further", () => {
    const p = ycPrompt({
      next: "wants_to_meet",
      offerLinkedin: false,
      intakeComplete: true,
      recorded: { building: "an AI vet scribe", wantsToMeet: "consumer founders" },
    })
    assert.match(p, /INTAKE IS COMPLETE — ask NOTHING further/i)
    assert.match(p, /NEVER re-open the intake/i)
    // Both answers are named back so the model can reference rather than re-ask.
    assert.match(p, /an AI vet scribe/)
    assert.match(p, /consumer founders/)
  })
})
