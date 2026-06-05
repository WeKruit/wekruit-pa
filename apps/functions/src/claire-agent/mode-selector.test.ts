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

test("2026-06-05 supersede: canary returning candidate (parsed résumé on file) on a PLAIN text → warm returning greeting, marks complete, NO wall, NO re-pitch", async () => {
  // SUPERSEDES the old WS-2 'website-profile → postParsePitch' on a plain returning text (Adam 2026-06-05:
  // a returning user saying 'Hi' wants a greeting + matches, not their résumé re-pitched). The genuine
  // 'just parsed, pitch now' path is the cvParsedTrigger re-entry (separate test below), NOT this.
  const { db, writes } = makeDb({
    latestResumeArtifactId: "candidate_upload_abc_123",
    // sharedOnboarding absent → isSharedOnboardingActiveUser false; onboardingState not complete.
  })
  const decision = await selectClaireMode({ db, userId: CANARY_UID, inboundText: "hey" })
  assert.equal(decision.mode, "triage")
  assert.equal(decision.warmReturningGreeting, true, "known/returning plain text → warm greeting")
  assert.notEqual(decision.postParsePitch, true, "plain returning text must NOT re-pitch (that's the parse re-entry's job)")
  // it did NOT bootstrap the onboarding wall (no onboardingState:"pending" write).
  const bootstrapped = writes().some((w) => w.onboardingState === "pending")
  assert.equal(bootstrapped, false, "must NOT cold-start the onboarding wall")
  // it DID mark onboarding complete (self-heal so it never re-enters the wall).
  const completed = writes().some((w) => w.onboardingState === "complete")
  assert.equal(completed, true, "must mark onboarding complete")
})

test("2026-06-05 supersede: NON-canary with the SAME parsed-profile fixture still cold-starts the onboarding wall (unchanged)", async () => {
  const { db, writes } = makeDb({ latestResumeArtifactId: "candidate_upload_abc_123" })
  const decision = await selectClaireMode({ db, userId: NONCANARY_UID, inboundText: "hey" })
  assert.equal(decision.warmReturningGreeting, undefined, "warm-returning is canary-only")
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

test("2026-06-03 fix: ENRICHED cv-parsed re-entry (LinkedIn photo-enrich filled skills) → triage + postParsePitch, NO onboarding wall", async () => {
  // The login enriched a real profile (skills on file) → the pitch turn must NOT bootstrap the
  // target_role question; it pitches + opens conversation (Adam: "pitch & conversation first").
  const { db, writes } = makeDb({ tags: { skills: ["typescript", "react"] } })
  const decision = await selectClaireMode({
    db,
    userId: CANARY_UID,
    inboundText: "[linkedin just finished enriching]",
    cvParsedTrigger: true,
  })
  assert.equal(decision.mode, "triage")
  assert.equal(decision.postParsePitch, true)
  const bootstrapped = writes().some((w) => w.onboardingState === "pending")
  assert.equal(bootstrapped, false, "enriched pitch must NOT bootstrap the target_role wall")
})

test("2026-06-03 fix: LinkedIn-done echo AFTER enrichment landed → suppressReply (no duplicate 'drop résumé/URL')", async () => {
  // Photo-enrich already pulled the profile + server-pushed the pitch. The vestigial
  // "I've done LinkedIn submission" reroute echo must be SUPPRESSED, not re-ask for data we have.
  const { db } = makeDb({ tags: { skills: ["typescript"] } })
  const decision = await selectClaireMode({
    db,
    userId: CANARY_UID,
    inboundText: "I've done LinkedIn submission tok_abc12345",
  })
  assert.equal(decision.suppressReply, true, "enriched LinkedIn-done echo must be suppressed")
  assert.notEqual(decision.linkedinJustConnected, true, "must NOT re-ask résumé/URL when already enriched")
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

// ── 2026-06-04 #1 RE-ASK FIX: tag-aware onboarding slot picker ─────────────────────────────────
// Live bug (+18563790960): a candidate whose enriched profile already carries
// tags.targetRoleFunction was re-asked "what kind of role do you want" because the thin picker
// chose the next slot purely from sharedOnboarding.answers and NEVER read pa-users.tags. These pin
// that the active-onboarding picker now SKIPS an axis whose canonical tag is already present, and
// COMPLETES to triage (hand to find_match, no loop) when every asked axis is satisfied by tags.

test("#1 re-ask fix: active onboarding with targetRoleFunction in tags does NOT re-ask target_role — skips to location_relocation", async () => {
  const { db } = makeDb({
    // résumé/chat enrich already filled the role axis (the live shape: ["software_engineering"]).
    tags: { targetRoleFunction: ["software_engineering"] },
    sharedOnboarding: {
      status: "active",
      currentQuestionId: "target_role",
      answers: {}, // nothing recorded yet, but the axis exists in tags
      completed: false,
    },
  })
  const decision = await selectClaireMode({ db, userId: NONCANARY_UID, inboundText: "hey there" })
  assert.equal(decision.mode, "onboarding")
  assert.notEqual(decision.onboardingSlot, "target_role", "must NOT re-ask the already-captured role axis")
  assert.equal(decision.onboardingSlot, "location_relocation", "asks the genuinely-missing location axis")
})

test("#1 re-ask fix: active onboarding with BOTH asked axes in tags → completes to triage (hand to find_match, no loop)", async () => {
  const { db, writes } = makeDb({
    tags: { targetRoleFunction: ["software_engineering"], targetLocations: ["new_york"] },
    sharedOnboarding: {
      status: "active",
      currentQuestionId: "target_role",
      answers: {},
      completed: false,
    },
  })
  const decision = await selectClaireMode({ db, userId: NONCANARY_UID, inboundText: "hey" })
  assert.equal(decision.mode, "triage", "every asked axis satisfied by tags → done, route to triage")
  // it self-healed the durable flag so it never re-enters the wall.
  const completed = writes().some((w) => w.onboardingState === "complete")
  assert.equal(completed, true, "marks onboarding complete when tag-satisfied")
})

test("#1 re-ask fix: active onboarding with NO role tag still asks target_role (unchanged baseline)", async () => {
  const { db } = makeDb({
    // no tags at all → the picker behaves exactly as before (asks the first missing asked slot).
    sharedOnboarding: {
      status: "active",
      currentQuestionId: "target_role",
      answers: {},
      completed: false,
    },
  })
  const decision = await selectClaireMode({ db, userId: NONCANARY_UID, inboundText: "hey" })
  assert.equal(decision.mode, "onboarding")
  assert.equal(decision.onboardingSlot, "target_role", "no role tag → still asks the role axis")
})

// ───────────────────────────────────────────────────────────────────────────────────────────────
// 2026-06-05 (Adam): "no legacy target_role EVER for a thin/canary user on a cold open." A cold "Hi"
// has exactly two right outcomes for a canary user:
//   (a) BRAND-NEW (no profile signal whatsoever) → OFFER-FIRST (offerFirstKickoff), NEVER a question.
//   (b) KNOWN/returning (ANY profile: résumé / LinkedIn bind / canonical tags / experienceHighlights)
//       whose onboarding was left in a half-state → WARM RETURNING GREETING (triage), NOT the offer,
//       NOT the onboarding question.
// In NEITHER case may the decision carry the onboardingSlot=target_role question. These tests LOCK
// both branches + the never-role-question invariant.

const isRoleQuestionDecision = (d: { mode: string; onboardingSlot?: string; offerFirstKickoff?: boolean }) =>
  d.mode === "onboarding" && d.onboardingSlot === "target_role" && d.offerFirstKickoff !== true

test("COLD-OPEN LOCK A — BRAND-NEW canary (no profile signal) → offer-first, NEVER the target_role question", async () => {
  const { db } = makeDb({}) // no artifact, no tags, no linkedin, no highlights
  const decision = await selectClaireMode({ db, userId: CANARY_UID, inboundText: "Hi" })
  assert.equal(decision.offerFirstKickoff, true, "brand-new canary cold open → deterministic offer")
  assert.equal(decision.warmReturningGreeting, undefined, "brand-new is NOT a returning greeting")
  assert.equal(isRoleQuestionDecision(decision), false, "must NEVER be the legacy target_role question")
})

test("COLD-OPEN LOCK B1 — KNOWN canary via LinkedIn bind → warm returning greeting, NOT offer, NOT role question", async () => {
  const { db, writes } = makeDb({
    linkedinOauthLinked: true,
    displayName: "Adam Yang",
    // no parsed résumé artifact, no tags → would otherwise fall to offer/onboarding-question.
  })
  const decision = await selectClaireMode({ db, userId: CANARY_UID, inboundText: "Hi" })
  assert.equal(decision.mode, "triage", "known/returning → triage")
  assert.equal(decision.warmReturningGreeting, true, "→ warm returning greeting directive")
  assert.notEqual(decision.offerFirstKickoff, true, "they already gave their info — NO re-offer")
  assert.equal(isRoleQuestionDecision(decision), false, "must NEVER be the legacy target_role question")
  // self-heals the half-state so it never re-enters the wall.
  assert.equal(writes().some((w) => w.onboardingState === "complete"), true, "marks onboarding complete")
})

test("COLD-OPEN LOCK B2 — KNOWN canary via canonical tags only → warm returning greeting, NOT role question", async () => {
  const { db } = makeDb({
    tags: { targetRoleFunction: ["software_engineering"] }, // matcher-meaningful tag, no résumé artifact
  })
  const decision = await selectClaireMode({ db, userId: CANARY_UID, inboundText: "hey" })
  assert.equal(decision.mode, "triage")
  assert.equal(decision.warmReturningGreeting, true)
  assert.equal(isRoleQuestionDecision(decision), false, "tags-known returning user never gets the role question")
})

test("COLD-OPEN LOCK B3 — KNOWN canary via experienceHighlights only → warm returning greeting", async () => {
  const { db } = makeDb({
    experienceHighlights: [{ title: "Software Engineer", company: "Tesla" }],
  })
  const decision = await selectClaireMode({ db, userId: CANARY_UID, inboundText: "Hi" })
  assert.equal(decision.mode, "triage")
  assert.equal(decision.warmReturningGreeting, true)
  assert.notEqual(decision.offerFirstKickoff, true)
  assert.equal(isRoleQuestionDecision(decision), false)
})

test("COLD-OPEN LOCK B4 — KNOWN canary via parsed-résumé artifact on a PLAIN text → warm greeting (not re-pitch, not role question)", async () => {
  const { db } = makeDb({ latestResumeArtifactId: "candidate_upload_xyz" })
  const decision = await selectClaireMode({ db, userId: CANARY_UID, inboundText: "Hi" })
  assert.equal(decision.mode, "triage")
  assert.equal(decision.warmReturningGreeting, true, "parsed-résumé returning user's plain 'Hi' → warm greeting")
  assert.notEqual(decision.postParsePitch, true, "plain returning text must NOT re-pitch")
  assert.equal(isRoleQuestionDecision(decision), false)
})

test("COLD-OPEN LOCK — the genuine parse RE-ENTRY (cvParsedTrigger) still pitches (postParsePitch), NOT the warm greeting", async () => {
  const { db } = makeDb({ tags: { skills: ["typescript", "react"] } })
  const decision = await selectClaireMode({
    db,
    userId: CANARY_UID,
    inboundText: "[resume just finished parsing]",
    cvParsedTrigger: true,
  })
  assert.equal(decision.mode, "triage")
  assert.equal(decision.postParsePitch, true, "the actual parse event pitches from fresh data")
  assert.notEqual(decision.warmReturningGreeting, true, "warm-greeting must not steal the parse re-entry pitch")
})

test("COLD-OPEN LOCK — NON-canary with a known profile is UNCHANGED (still cold-starts the legacy wall)", async () => {
  const { db } = makeDb({ tags: { targetRoleFunction: ["software_engineering"] } })
  const decision = await selectClaireMode({ db, userId: NONCANARY_UID, inboundText: "Hi" })
  assert.equal(decision.warmReturningGreeting, undefined, "warm-returning is canary-only")
  assert.equal(decision.mode, "onboarding", "non-canary keeps the legacy onboarding cold-start")
})
