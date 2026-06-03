/**
 * mode-selector.test.ts — WS-1(b) enrichment-in-flight read + WS-2 website-origin short path.
 *
 * No existing test drove selectClaireMode directly (cutover.test.ts covers the seam only). These
 * pin the two new deterministic branches and prove the non-canary path is byte-unchanged.
 *
 * WS-2: a website-origin candidate (parsed résumé on file, onboarding never started) must SKIP the
 *       two-question wall → triage + postParsePitch (canary only). Non-canary keeps the cold-start.
 * WS-1(b): the durable enrichmentInFlight marker surfaces ModeDecision.enrichmentInFlight (canary only),
 *       and the cv-parsed re-entry turn NEVER carries it (that turn is the completion).
 *
 * Run: node --import tsx --test apps/functions/src/claire-agent/mode-selector.test.ts
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { selectClaireMode } from "./mode-selector.js"

const CANARY_UID = "8fEwIduUrzxZsblHHsNz" // Adam — in CANARY_UIDS
const NONCANARY_UID = "z_not_a_dev_phone_uid"

/**
 * Minimal Firestore stub: serves a pa-users doc, an EMPTY pa-prescreen-sessions query (no active
 * screen), records pa-users .set() merges, and an empty parsedCandidateResumes query. Enough for
 * selectClaireMode's reads/writes on the non-prescreen path.
 */
function makeDb(userDoc: Record<string, unknown>) {
  const writes: Array<Record<string, unknown>> = []
  let current = { ...userDoc }
  const emptyQuery = {
    where() {
      return this
    },
    limit() {
      return this
    },
    orderBy() {
      return this
    },
    async get() {
      return { empty: true, docs: [] }
    },
  }
  const db = {
    collection(name: string) {
      if (name === "pa-users") {
        return {
          doc() {
            return {
              async get() {
                return { exists: true, data: () => current }
              },
              async set(patch: Record<string, unknown>) {
                writes.push(patch)
                // shallow-merge so a follow-on read reflects markSharedOnboardingComplete etc.
                current = { ...current, ...patch }
              },
            }
          },
        }
      }
      // pa-prescreen-sessions / parsedCandidateResumes → empty query.
      return {
        where: () => emptyQuery,
        doc() {
          return { async get() { return { exists: false, data: () => undefined } } }
        },
      }
    },
  } as never
  return { db, writes: () => writes }
}

test("WS-2: canary website-origin (parsed résumé on file, onboarding never started) → triage + postParsePitch, marks complete, NO wall", async () => {
  const { db, writes } = makeDb({
    latestResumeArtifactId: "candidate_upload_abc_123",
    // sharedOnboarding absent → isSharedOnboardingActiveUser false; onboardingState not complete.
  })
  const decision = await selectClaireMode({ db, userId: CANARY_UID, inboundText: "hey" })
  assert.equal(decision.mode, "triage")
  assert.equal(decision.postParsePitch, true)
  // it did NOT bootstrap the onboarding wall (no onboardingState:"pending" write).
  const bootstrapped = writes().some((w) => w.onboardingState === "pending")
  assert.equal(bootstrapped, false, "must NOT cold-start the onboarding wall")
  // it DID mark onboarding complete (self-heal so it never re-enters the wall).
  const completed = writes().some((w) => w.onboardingState === "complete")
  assert.equal(completed, true, "must mark onboarding complete")
})

test("WS-2: NON-canary with the SAME parsed-profile fixture still cold-starts the onboarding wall (unchanged)", async () => {
  const { db, writes } = makeDb({ latestResumeArtifactId: "candidate_upload_abc_123" })
  const decision = await selectClaireMode({ db, userId: NONCANARY_UID, inboundText: "hey" })
  assert.equal(decision.mode, "onboarding")
  assert.equal(decision.awaitingAnswer, false)
  const bootstrapped = writes().some((w) => w.onboardingState === "pending")
  assert.equal(bootstrapped, true, "non-canary must still hit the cold-start bootstrap")
})

test("WS-2 / regression-fix: canary cold with NO parsed profile gets the OFFER and does NOT bootstrap (no state poison)", async () => {
  const { db, writes } = makeDb({}) // no resume artifact, no tags
  const decision = await selectClaireMode({ db, userId: CANARY_UID, inboundText: "hi" })
  assert.equal(decision.mode, "onboarding")
  assert.equal(decision.offerFirstKickoff, true, "canary cold-start must send the deterministic offer, NOT ask a question")
  // CRITICAL (2026-06-03 "Hi → 👍, no reply" regression): the offer turn must NOT bootstrap
  // onboarding. bootstrapOnboarding writes onboardingState:"pending" + marks sharedOnboarding
  // "active" — i.e. "a question was asked". The offer asks NO question, so marking it active
  // poisoned the state: a re-entry/coalesced re-run routed to onboarding_active, treated the next
  // inbound as an ANSWER, and the offer never re-fired. Offer-first leaves the user cold.
  const bootstrapped = writes().some((w) => w.onboardingState === "pending")
  assert.equal(bootstrapped, false, "offer-first must NOT bootstrap/poison onboarding state")
})

test("non-canary cold with NO parsed profile keeps the legacy wall: bootstraps + asks, NO offer", async () => {
  const { db, writes } = makeDb({}) // no resume artifact, no tags
  const decision = await selectClaireMode({ db, userId: "z_non_canary_uid", inboundText: "hi" })
  assert.equal(decision.mode, "onboarding")
  assert.notEqual(decision.offerFirstKickoff, true, "non-canary must NOT get the offer (dev-phone only)")
  const bootstrapped = writes().some((w) => w.onboardingState === "pending")
  assert.equal(bootstrapped, true, "non-canary keeps the legacy onboarding bootstrap + question")
})

test("Image #24 fix: COLD canary mid-enrich (LinkedIn-done re-entry) ACKS in triage, does NOT re-offer", async () => {
  // No active onboarding (cold, just connected LinkedIn) + enrichment in flight → the "I've done
  // LinkedIn submission" re-entry must ack "one sec", NOT re-fire the offer-first kickoff.
  const { db } = makeDb({
    enrichmentInFlight: true,
    enrichmentStartedAt: new Date().toISOString(),
    // NO sharedOnboarding → cold; with enrichment in flight this must beat the offer-first branch.
  })
  const decision = await selectClaireMode({ db, userId: CANARY_UID, inboundText: "I've done LinkedIn submission tok_abc12345" })
  assert.equal(decision.mode, "triage", "mid-enrich cold re-entry acks in triage, not onboarding offer")
  assert.equal(decision.enrichmentInFlight, true, "carries the in-flight ack directive")
  assert.notEqual(decision.offerFirstKickoff, true, "must NOT re-offer the cold kickoff while enriching")
})

test("Image #25 fix: LINKEDIN-DONE opener with NO enrich (OAuth name-only) → triage ack, NOT re-offer", async () => {
  // Cold canary, NO enrichmentInFlight (LinkedIn login bound identity but couldn't pull the URL/enrich)
  // → the "I've done LinkedIn submission <tok>" re-entry must route to triage with linkedinJustConnected,
  // never the cold offer-first kickoff.
  const { db } = makeDb({}) // cold, no enrich
  const decision = await selectClaireMode({ db, userId: CANARY_UID, inboundText: "I've done LinkedIn submission tok_abc12345" })
  assert.equal(decision.mode, "triage")
  assert.equal(decision.linkedinJustConnected, true, "acks the connection + asks for résumé/URL")
  assert.notEqual(decision.offerFirstKickoff, true, "must NOT re-offer the cold kickoff after they connected")
})

test("WS-1(b): canary with an in-flight marker (onboarding active) surfaces enrichmentInFlight on the decision", async () => {
  const { db } = makeDb({
    enrichmentInFlight: true,
    enrichmentStartedAt: new Date().toISOString(),
    sharedOnboarding: {
      status: "active",
      currentQuestionId: "target_role",
      answers: {},
      completed: false,
    },
  })
  const decision = await selectClaireMode({ db, userId: CANARY_UID, inboundText: "wait what's happening" })
  assert.equal(decision.mode, "onboarding")
  assert.equal(decision.enrichmentInFlight, true, "in-flight marker must surface on an onboarding turn")
})

test("WS-1(b): the cv-parsed re-entry turn NEVER carries enrichmentInFlight (that turn IS the completion)", async () => {
  const { db } = makeDb({
    enrichmentInFlight: true,
    enrichmentStartedAt: new Date().toISOString(),
    onboardingState: "complete",
    sharedOnboarding: { status: "complete", completed: true },
  })
  const decision = await selectClaireMode({
    db,
    userId: CANARY_UID,
    inboundText: "[resume just finished parsing]",
    cvParsedTrigger: true,
  })
  assert.equal(decision.postParsePitch, true, "cv-parsed re-entry must pitch")
  assert.notEqual(decision.enrichmentInFlight, true, "cv-parsed turn must NOT say 'still loading'")
})

test("WS-1(b): NON-canary never gets enrichmentInFlight even with the marker set", async () => {
  const { db } = makeDb({
    enrichmentInFlight: true,
    enrichmentStartedAt: new Date().toISOString(),
    onboardingState: "complete",
    sharedOnboarding: { status: "complete", completed: true },
  })
  const decision = await selectClaireMode({ db, userId: NONCANARY_UID, inboundText: "hi" })
  assert.notEqual(decision.enrichmentInFlight, true)
})
