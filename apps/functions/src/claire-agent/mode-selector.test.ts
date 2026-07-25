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

test("ALREADY-PITCHED canary returning candidate (parsed résumé on file) on a PLAIN text → warm greeting, marks complete, NO wall, NO re-pitch", async () => {
  // An already-pitched returner (pitchedAt set) saying 'Hi' wants a warm we-know-you greeting + matches,
  // NOT their résumé re-pitched. The genuine 'just parsed, pitch now' path is the cvParsedTrigger
  // re-entry (separate test below); the FIRST-text-in pitch for a never-pitched recognized user is the
  // test directly below this one (Adam 2026-06-15).
  const { db, writes } = makeDb({
    latestResumeArtifactId: "candidate_upload_abc_123",
    pitchedAt: "2026-06-10T00:00:00.000Z", // already pitched → no re-pitch
    // sharedOnboarding absent → isSharedOnboardingActiveUser false; onboardingState not complete.
  })
  const decision = await selectClaireMode({ db, userId: CANARY_UID, inboundText: "hey" })
  assert.equal(decision.mode, "triage")
  assert.equal(decision.warmReturningGreeting, true, "already-pitched returning plain text → warm greeting")
  assert.notEqual(decision.postParsePitch, true, "already-pitched plain text must NOT re-pitch")
  // it did NOT bootstrap the onboarding wall (no onboardingState:"pending" write).
  const bootstrapped = writes().some((w) => w.onboardingState === "pending")
  assert.equal(bootstrapped, false, "must NOT cold-start the onboarding wall")
  // it DID mark onboarding complete (self-heal so it never re-enters the wall).
  const completed = writes().some((w) => w.onboardingState === "complete")
  assert.equal(completed, true, "must mark onboarding complete")
})

test("FIRST text-in: recognized canary (ingested background) NEVER pitched → warm PITCH (postParsePitch), not a cold matches-question (Adam 2026-06-15: Leonard)", async () => {
  // A recognized candidate who just bound their phone and texts in for the first time (pitchedAt unset)
  // must get the warm, we-know-you 3-bubble PITCH — not "want me to pull matches? tell me role+location".
  // warmReturningGreeting is set as a companion so a pitch-composer miss still falls through to warm copy.
  const { db, writes } = makeDb({ latestResumeArtifactId: "candidate_upload_abc_123" }) // no pitchedAt
  const decision = await selectClaireMode({ db, userId: CANARY_UID, inboundText: "Hi, my verification code is DPA6C438" })
  assert.equal(decision.mode, "triage")
  assert.equal(decision.postParsePitch, true, "recognized never-pitched first text → warm pitch")
  assert.equal(decision.warmReturningGreeting, true, "companion so a pitch miss falls through to warm copy, never a bare reply")
  const bootstrapped = writes().some((w) => w.onboardingState === "pending")
  assert.equal(bootstrapped, false, "must NOT cold-start the onboarding wall")
})

test("2026-06-06 (Adam): NON-canary with a parsed-profile fixture → PITCH, NEVER the onboarding wall (recognized background; supersedes the old non-canary cold-start)", async () => {
  // Reversed by Adam 2026-06-06: a recognized candidate (parsed résumé = ingested background) is pitched
  // directly with no onboarding questions, NON-canary included (the question-SUPPRESSION is universal;
  // only the warm-greeting COPY stays canary). Pre-fix this asserted the non-canary cold-start wall.
  const { db, writes } = makeDb({ latestResumeArtifactId: "candidate_upload_abc_123" })
  const decision = await selectClaireMode({ db, userId: NONCANARY_UID, inboundText: "hey" })
  assert.equal(decision.warmReturningGreeting, undefined, "warm-returning COPY is canary-only")
  assert.equal(decision.mode, "triage", "recognized background → triage/pitch, not the onboarding wall")
  assert.equal(decision.postParsePitch, true, "pitch the recognized candidate (pitch asks role inline)")
  const bootstrapped = writes().some((w) => w.onboardingState === "pending")
  assert.equal(bootstrapped, false, "must NOT bootstrap the onboarding wall for a recognized user")
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

test("COLD-OPEN LOCK B4 — KNOWN canary via parsed-résumé artifact, ALREADY pitched, on a PLAIN text → warm greeting (not re-pitch, not role question)", async () => {
  const { db } = makeDb({ latestResumeArtifactId: "candidate_upload_xyz", pitchedAt: "2026-06-10T00:00:00.000Z" })
  const decision = await selectClaireMode({ db, userId: CANARY_UID, inboundText: "Hi" })
  assert.equal(decision.mode, "triage")
  assert.equal(decision.warmReturningGreeting, true, "already-pitched parsed-résumé returner's plain 'Hi' → warm greeting")
  assert.notEqual(decision.postParsePitch, true, "already-pitched plain text must NOT re-pitch")
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

test("COLD-OPEN LOCK — NON-canary LinkedIn-bound (ingested background) → triage, NEVER onboarding wall (Adam 2026-06-06)", async () => {
  // The LinkedIn-login → text pattern: a recognized candidate with ingested background must be pitched,
  // never walled with onboarding questions — and this question-suppression is UNIVERSAL (non-canary too).
  const { db, writes } = makeDb({
    linkedinOauthLinked: true,
    linkedinUrl: "https://linkedin.com/in/someone",
    // NO canonical tags at all → pre-fix this would have asked target_role.
  })
  const decision = await selectClaireMode({ db, userId: NONCANARY_UID, inboundText: "Hi" })
  assert.equal(decision.mode, "triage", "recognized (LinkedIn bind) → triage, not the onboarding wall")
  assert.equal(decision.postParsePitch, true, "pitch the recognized user (pitch asks role inline) — Adam 2026-06-06")
  assert.notEqual(decision.mode, "onboarding", "must NEVER ask onboarding questions of a recognized user")
  assert.equal(isRoleQuestionDecision(decision), false, "no target_role question for a LinkedIn-bound user")
  assert.equal(decision.warmReturningGreeting, undefined, "warm-greeting COPY stays canary-only; non-canary just suppresses the question")
  assert.equal(writes().some((w) => w.onboardingState === "complete"), true, "self-heals onboarding so it never re-enters the wall")
})

test("COLD-OPEN LOCK — NON-canary with ONLY a target_role tag (no background) STILL asks the missing location axis (Adam 2026-06-05 preserved)", async () => {
  // Guards the narrowness of hasIngestedBackground: a bare onboarding answer is NOT "recognized
  // background", so the genuinely-missing axis is still asked. (This is the case the 2026-06-06 gate
  // must NOT swallow.)
  const { db } = makeDb({ tags: { targetRoleFunction: ["software_engineering"] } })
  const decision = await selectClaireMode({ db, userId: NONCANARY_UID, inboundText: "Hi" })
  assert.notEqual(decision.mode, "triage", "a role-only user is NOT recognized background → not auto-triaged")
  assert.equal(decision.mode, "onboarding")
  assert.equal(decision.onboardingSlot, "location_relocation", "asks the genuinely-missing location axis, not target_role")
})

test("COLD-OPEN LOCK — NON-canary with a known profile gets the GAP-AWARE cold-start (no warm-greeting copy; asks only the missing axis)", async () => {
  // 2026-06-05 (Adam "ONLY ask for non-existing info"): the gap-aware skip is UNIVERSAL (bug-class),
  // so a non-canary user with targetRoleFunction set is NO LONGER asked target_role again — they get
  // the genuinely-missing location axis. The NEW warm-greeting COPY stays canary-only (undefined here).
  const { db } = makeDb({ tags: { targetRoleFunction: ["software_engineering"] } })
  const decision = await selectClaireMode({ db, userId: NONCANARY_UID, inboundText: "Hi" })
  assert.equal(decision.warmReturningGreeting, undefined, "warm-returning COPY is canary-only")
  assert.equal(decision.mode, "onboarding", "a real gap (location) remains → onboarding")
  assert.equal(decision.onboardingSlot, "location_relocation", "asks only the MISSING axis, not the known role")
  assert.notEqual(decision.onboardingSlot, "target_role", "must NOT re-ask the already-on-file role axis")
})

// ───────────────────────────────────────────────────────────────────────────────────────────────
// 2026-06-05 (Adam): UNIVERSAL gap-aware COLD START — "ONLY ask for non-existing info." The Jasmaine
// defect: a NON-canary LinkedIn-OAuth user with enriched experience pitched correctly, then was STILL
// asked target_role + a location question — both already on file. The cold-start (`!active`) branch
// now inventories tags first and (a) routes to triage if nothing is missing, or (b) seeds the FIRST
// genuinely-missing asked slot — for ALL users, not just canary (it's a bug-class re-ask removal).
// These are the new universal assertions (T1-T3, T6) plus no-regression guards (T4, T5, T7, T8).

test("T1 — cold full profile (role+location on file), NON-canary → triage, NO re-ask, marks complete", async () => {
  // The Jasmaine-class fix: both asked axes already present on a cold opener → ask NOTHING.
  const { db, writes } = makeDb({
    tags: { targetRoleFunction: ["software_engineering"], targetLocations: ["new_york"] },
    // cold: no sharedOnboarding, onboardingState not complete.
  })
  const decision = await selectClaireMode({ db, userId: NONCANARY_UID, inboundText: "Hello, WeKruit! <uid>" })
  assert.equal(decision.mode, "triage", "both asked axes satisfied → straight to triage/find_match")
  assert.equal(decision.onboardingSlot, undefined, "no onboarding slot seeded")
  const bootstrapped = writes().some((w) => w.onboardingState === "pending")
  assert.equal(bootstrapped, false, "no onboarding bootstrap on a fully-satisfied cold opener")
  const completed = writes().some((w) => w.onboardingState === "complete")
  assert.equal(completed, true, "self-heals onboardingState → complete")
})

test("T2 — cold role-known / location-missing, NON-canary → onboarding asks ONLY location_relocation", async () => {
  const { db, writes } = makeDb({ tags: { targetRoleFunction: ["software_engineering"] } })
  const decision = await selectClaireMode({ db, userId: NONCANARY_UID, inboundText: "hi" })
  assert.equal(decision.mode, "onboarding")
  assert.equal(decision.onboardingSlot, "location_relocation", "asks only the missing location axis")
  assert.notEqual(decision.onboardingSlot, "target_role", "must NOT re-ask the known role axis")
  assert.equal(decision.awaitingAnswer, false, "cold-start kickoff (ask, don't record)")
  const bootstrapped = writes().some((w) => w.onboardingState === "pending")
  assert.equal(bootstrapped, true, "non-offer cold-start bootstraps durable state")
})

test("T3 — cold location-known / role-missing, NON-canary → onboarding asks ONLY target_role (order respected)", async () => {
  const { db } = makeDb({ tags: { targetLocations: ["remote"] } })
  const decision = await selectClaireMode({ db, userId: NONCANARY_UID, inboundText: "hi" })
  assert.equal(decision.mode, "onboarding")
  assert.equal(decision.onboardingSlot, "target_role", "asks only the missing role axis")
  assert.equal(decision.awaitingAnswer, false)
})

test("T4 — cold brand-new (nothing on file), NON-canary → unchanged: asks target_role, no offer", async () => {
  const { db, writes } = makeDb({})
  const decision = await selectClaireMode({ db, userId: NONCANARY_UID, inboundText: "hi" })
  assert.equal(decision.mode, "onboarding")
  assert.equal(decision.onboardingSlot, "target_role", "nothing satisfied → first asked slot, byte-unchanged")
  assert.notEqual(decision.offerFirstKickoff, true, "non-canary never gets the offer")
  const bootstrapped = writes().some((w) => w.onboardingState === "pending")
  assert.equal(bootstrapped, true, "non-canary brand-new still bootstraps")
})

test("T5 — cold brand-new (nothing on file), CANARY → unchanged: offer-first, NO bootstrap (no state poison)", async () => {
  const { db, writes } = makeDb({})
  const decision = await selectClaireMode({ db, userId: CANARY_UID, inboundText: "hi" })
  assert.equal(decision.mode, "onboarding")
  assert.equal(decision.offerFirstKickoff, true, "canary brand-new → deterministic offer")
  const bootstrapped = writes().some((w) => w.onboardingState === "pending")
  assert.equal(bootstrapped, false, "offer-first must NOT bootstrap/poison onboarding state")
})

test("T6 — Jasmaine REVISED (Adam 2026-06-06): NON-canary LinkedIn-OAuth + experienceHighlights, NO canonical role/loc tags → PITCH (ask role inside the pitch), NEVER the onboarding wall", async () => {
  // SUPERSEDES the 2026-06-05 "ask target_role once" behavior. Adam 2026-06-06: a LinkedIn-login user is
  // RECOGNIZED (we ingested their background) — pitch them directly, "no more onboarding questions."
  // Adam's chosen resolution for the missing canonical role is "pitch first, ask role INSIDE the pitch"
  // (compose-pitch confirms/elicits target_role inline: "targeting SWE roles — that right? 👍"), so we
  // never wall them with a separate onboarding question. hasIngestedBackground (linkedinOauthLinked +
  // parsed skills) is true → triage + postParsePitch. Universal (non-canary too); the warm-greeting COPY
  // remains canary-only and is NOT shipped here.
  const { db, writes } = makeDb({
    linkedinOauthLinked: true,
    experienceHighlights: [{ title: "Software Engineer Intern", company: "Microsoft" }],
    tags: { skills: ["python", "rag"], recentRoleTitle: "SWE Intern" },
  })
  const decision = await selectClaireMode({ db, userId: NONCANARY_UID, inboundText: "Hello, WeKruit! <uid>" })
  assert.equal(decision.mode, "triage", "recognized LinkedIn background → pitch in triage, NOT the onboarding wall")
  assert.equal(decision.postParsePitch, true, "pitch the recognized candidate (the pitch asks role inline)")
  assert.notEqual(decision.mode, "onboarding", "must NEVER ask a separate onboarding question of a recognized user")
  assert.equal(decision.warmReturningGreeting, undefined, "warm-greeting copy is canary-only, not shipped here")
  assert.equal(writes().some((w) => w.onboardingState === "complete"), true, "self-heals onboarding so it never re-enters the wall")
})

test("T7 — cold full profile, CANARY → warm-greeting path still wins (new copy stays gated; universal skip doesn't steal it)", async () => {
  const { db } = makeDb({
    linkedinOauthLinked: true,
    tags: { targetRoleFunction: ["software_engineering"], targetLocations: ["san_francisco_bay_area"] },
  })
  const decision = await selectClaireMode({ db, userId: CANARY_UID, inboundText: "hey" })
  assert.equal(decision.mode, "triage")
  assert.equal(decision.warmReturningGreeting, true, "canary keeps the warm-greeting surface (gated copy intact)")
})

test("T8 — ACTIVE onboarding, both tags present, NON-canary → triage (existing branch regression guard)", async () => {
  const { db, writes } = makeDb({
    sharedOnboarding: { status: "active", answers: {} },
    tags: { targetRoleFunction: ["software_engineering"], targetLocations: ["remote"] },
  })
  const decision = await selectClaireMode({ db, userId: NONCANARY_UID, inboundText: "idk" })
  assert.equal(decision.mode, "triage", "active-branch tag-satisfaction completion unchanged")
  assert.equal(writes().some((w) => w.onboardingState === "complete"), true, "active branch still marks complete")
})

// ─── YC FOUNDER-MATCH ENTRY POSTURE (Adam 2026-07-20 "换个口吻…不用推进") ────────────────────────────
// A /yc-startup arrival (pa-users.source=yc_startup_school) NEVER gets the structured onboarding
// push — light chat posture; the prompt directive owns the tone + the notify-on-match promise.

test("YC entry: incomplete onboarding + NO background → triage + entryPosture, never the wall/offer", async () => {
  const { db, writes } = makeDb({ source: "yc_startup_school" })
  const decision = await selectClaireMode({ db, userId: NONCANARY_UID, inboundText: "hey" })
  assert.equal(decision.mode, "triage", "no onboarding mode for a yc arrival")
  assert.equal(decision.entryPosture, "yc_startup_school")
  assert.notEqual(decision.offerFirstKickoff, true, "no offer kickoff push")
  const bootstrapped = writes().some((w) => w.onboardingState === "pending")
  assert.equal(bootstrapped, false, "must NOT bootstrap the onboarding wall")
})

test("YC entry: ingested background → we-know-you PITCH + entryPosture, marks complete", async () => {
  const { db, writes } = makeDb({ source: "yc_startup_school", latestResumeArtifactId: "candidate_upload_x" })
  const decision = await selectClaireMode({ db, userId: NONCANARY_UID, inboundText: "hey" })
  assert.equal(decision.mode, "triage")
  assert.equal(decision.postParsePitch, true, "pitch what we hold — the closer is the notify promise")
  assert.equal(decision.entryPosture, "yc_startup_school")
  const completed = writes().some((w) => w.onboardingState === "complete")
  assert.equal(completed, true, "self-heal: never re-enter the wall")
})

test("YC entry: completed onboarding plain turn still carries entryPosture on triage", async () => {
  const { db } = makeDb({ source: "yc_startup_school", onboardingState: "complete" })
  const decision = await selectClaireMode({ db, userId: NONCANARY_UID, inboundText: "what kind of startups do you know?" })
  assert.equal(decision.mode, "triage")
  assert.equal(decision.entryPosture, "yc_startup_school")
})

test("non-YC sources carry NO entryPosture (byte-unchanged decisions)", async () => {
  const { db } = makeDb({ source: "candidate", onboardingState: "complete" })
  const decision = await selectClaireMode({ db, userId: NONCANARY_UID, inboundText: "hey" })
  assert.equal(decision.entryPosture, undefined)
})

test("YC EVENT INTAKE: incomplete ycIntake → ycEventIntake slot progression rides the posture", async () => {
  // Cold event-QR user: no background, no intake → LinkedIn leads + ask building.
  const cold = await selectClaireMode({
    ...{ db: makeDb({ source: "yc_startup_school" }).db },
    userId: NONCANARY_UID,
    inboundText: "Hey! I'm at YC Startup School — my code is 3f9c2a10-8b4e-4d6f-9a12-77cc01ab34de",
  })
  assert.equal(cold.entryPosture, "yc_startup_school")
  assert.deepEqual(cold.ycEventIntake, { next: "building", offerLinkedin: true, kickoff: true })

  // Building recorded → next is wants_to_meet; background landed → no LinkedIn offer.
  const mid = await selectClaireMode({
    ...{
      db: makeDb({
        source: "yc_startup_school",
        latestResumeArtifactId: "coresignal_x",
        ycIntake: { building: "an eval harness" },
      }).db,
    },
    userId: NONCANARY_UID,
    inboundText: "it's an eval harness for agents",
  })
  // `recorded` carries what is ALREADY on file so the prompt can name it back and forbid re-asking
  // (2026-07-24 live: "what are you building right now?" asked three times in one thread).
  assert.deepEqual(mid.ycEventIntake, {
    next: "wants_to_meet",
    offerLinkedin: false,
    recorded: { building: "an eval harness" },
  })

  // Intake complete → ycEventIntake is STILL emitted, carrying intakeComplete + both recorded
  // answers. It used to be cleared to `undefined` here, which left the model with no directive at
  // all once intake finished — the live re-ask loop (2026-07-24: "what are you building right now?"
  // at 04:41, again 04:46, then "what are you hoping to connect with most" 04:50). The prompt now
  // names both answers back and forbids re-asking.
  const done = await selectClaireMode({
    ...{
      db: makeDb({
        source: "yc_startup_school",
        onboardingState: "complete",
        ycIntake: { building: "x", wantsToMeet: "y", completedAt: "2026-07-21T19:00:00.000Z" },
      }).db,
    },
    userId: NONCANARY_UID,
    inboundText: "cool thanks",
  })
  assert.equal(done.entryPosture, "yc_startup_school")
  assert.deepEqual(done.ycEventIntake, {
    next: "wants_to_meet",
    offerLinkedin: false,
    intakeComplete: true,
    recorded: { building: "x", wantsToMeet: "y" },
  })
})

test("YC LINKEDIN-URL ASK: the tap worked but LinkedIn gave us no profile (2026-07-25)", async () => {
  // Live: 87 YC users connected; 54 arrived with a real vanity URL and ALL 54 enriched, 33 got only
  // the `/oauth-linked/<sub>` placeholder and 1 enriched. They are invisible to the existing beats
  // because hasIngestedBackground counts the OAuth bind, so offerLinkedin is false for them.
  const stranded = {
    source: "yc_startup_school",
    linkedinOauthLinked: true,
    linkedinUrl: "https://www.linkedin.com/oauth-linked/7RLX9e4Qjo",
  }
  const askFake = makeDb(stranded)
  const ask = await selectClaireMode({
    db: askFake.db,
    userId: NONCANARY_UID,
    inboundText: "i'm building an eval harness for agents",
  })
  assert.equal(ask.ycEventIntake?.askLinkedinUrl, true, "OAuth-linked + placeholder + no background → ask")
  assert.equal(ask.ycEventIntake?.offerLinkedin, false, "never re-offer the connect link — they connected")
  assert.equal(
    askFake.writes().find((w) => (w.ycIntake as Record<string, unknown> | undefined)?.linkedinUrlAskedAt),
    undefined,
    "no selection-time stamp — cutover stamps after delivery",
  )

  // Fires after the intake is finished too: 11 of the 32 had already completed it.
  const doneToo = await selectClaireMode({
    db: makeDb({
      ...stranded,
      ycIntake: { building: "x", wantsToMeet: "y", completedAt: "2026-07-25T00:00:00.000Z" },
    }).db,
    userId: NONCANARY_UID,
    inboundText: "cool thanks",
  })
  assert.equal(doneToo.ycEventIntake?.askLinkedinUrl, true, "completed intake still gets the ask")

  // One-shot, on its OWN stamp — linkedinNudgedAt must NOT swallow it (they were usually nudged
  // BEFORE they connected, so a shared stamp would silence the ask for exactly the affected people).
  const nudgedThenLinked = await selectClaireMode({
    db: makeDb({ ...stranded, ycIntake: { linkedinNudgedAt: "2026-07-25T00:00:00.000Z" } }).db,
    userId: NONCANARY_UID,
    inboundText: "ok",
  })
  assert.equal(nudgedThenLinked.ycEventIntake?.askLinkedinUrl, true, "nudge stamp does not consume the ask")
  const alreadyAsked = await selectClaireMode({
    db: makeDb({ ...stranded, ycIntake: { linkedinUrlAskedAt: "2026-07-25T00:00:00.000Z" } }).db,
    userId: NONCANARY_UID,
    inboundText: "ok",
  })
  assert.equal(alreadyAsked.ycEventIntake?.askLinkedinUrl, undefined, "stamped → never asked twice")

  // Who must NEVER get it: an enriched user, someone with a real URL, and someone who never connected.
  for (const [label, user] of [
    ["enriched", { ...stranded, experienceHighlights: ["Founder @ Foo"] }],
    ["real url", { ...stranded, linkedinUrl: "https://www.linkedin.com/in/ada-lovelace" }],
    ["never connected", { source: "yc_startup_school" }],
  ] as const) {
    const d = await selectClaireMode({
      db: makeDb(user).db,
      userId: NONCANARY_UID,
      inboundText: "i'm building an eval harness for agents",
    })
    assert.equal(d.ycEventIntake?.askLinkedinUrl, undefined, `${label} → no URL ask`)
  }
})

test("YC EVENT ENTRY: existing non-yc user sending the YC opener flips into the event posture (Noah 2026-07-22)", async () => {
  const opener = "Hey! I'm at YC Startup School — my code is 3f9c2a10-8b4e-4d6f-9a12-77cc01ab34de"
  // Existing candidate: sticky source, résumé on file, onboarding complete — pre-fix
  // they kept the standard "pull you roles?" posture.
  const fake = makeDb({
    source: "qr_imessage",
    onboardingState: "complete",
    latestResumeArtifactId: "candidate_upload_noah",
    pitchedAt: "2026-06-01T00:00:00.000Z",
  })
  const flip = await selectClaireMode({ db: fake.db, userId: NONCANARY_UID, inboundText: opener })
  assert.equal(flip.entryPosture, "yc_startup_school", "opener turn → yc posture despite sticky source")
  assert.equal(flip.ycEventIntake?.kickoff, true, "opener → deterministic event kickoff")
  assert.equal(flip.ycEventIntake?.offerLinkedin, false, "résumé on file → no LinkedIn offer")
  const stamped = fake.writes().find((w) => typeof w.ycEventEntryAt === "string")
  assert.ok(stamped, "ycEventEntryAt stamped for durable posture on later turns")

  // Later turn: stamp present, plain answer text → posture + intake persist, no re-kickoff.
  const later = await selectClaireMode({
    ...{
      db: makeDb({
        source: "qr_imessage",
        onboardingState: "complete",
        latestResumeArtifactId: "candidate_upload_noah",
        ycEventEntryAt: "2026-07-22T19:00:00.000Z",
      }).db,
    },
    userId: NONCANARY_UID,
    inboundText: "i want to meet infra founders",
  })
  assert.equal(later.entryPosture, "yc_startup_school")
  assert.equal(later.ycEventIntake?.kickoff, undefined)
  assert.equal(later.ycEventIntake?.nudgeLinkedin, undefined, "background ingested → never a LinkedIn nudge")

  // Plain text from a non-yc user WITHOUT the opener/stamp → byte-unchanged standard posture.
  const plainFake = makeDb({ source: "qr_imessage", onboardingState: "complete" })
  const plain = await selectClaireMode({ db: plainFake.db, userId: NONCANARY_UID, inboundText: "hey" })
  assert.equal(plain.entryPosture, undefined)
  assert.equal(plainFake.writes().some((w) => "ycEventEntryAt" in w), false, "no stray stamp")
})

test("YC EVENT INTAKE: opener first-contact turn carries kickoff:true; later turns do not", async () => {
  const opener = "Hey! I'm at YC Startup School — my code is 3f9c2a10-8b4e-4d6f-9a12-77cc01ab34de"
  const first = await selectClaireMode({
    ...{ db: makeDb({ source: "yc_startup_school" }).db },
    userId: NONCANARY_UID,
    inboundText: opener,
  })
  assert.equal(first.ycEventIntake?.kickoff, true, "opener turn → deterministic kickoff")

  const answerFake = makeDb({ source: "yc_startup_school" })
  const answerTurn = await selectClaireMode({
    ...{ db: answerFake.db },
    userId: NONCANARY_UID,
    inboundText: "i'm building an eval harness for agents",
  })
  assert.equal(answerTurn.ycEventIntake?.kickoff, undefined, "real answer → model turn, no kickoff")
  // First non-kickoff turn, LinkedIn unconnected → the ONE mandatory consequence nudge.
  assert.equal(answerTurn.ycEventIntake?.nudgeLinkedin, true, "first model turn carries the nudge")
  // selectMode must NOT stamp — cutover stamps AFTER delivery. A selection-time stamp
  // let the defer/preview pass consume the one-shot before the owner pass replied
  // (live probe 2026-07-22): a same-turn SECOND selection still carries the nudge.
  const stamped = answerFake.writes().find(
    (w) => typeof (w.ycIntake as Record<string, unknown> | undefined)?.linkedinNudgedAt === "string",
  )
  assert.equal(stamped, undefined, "no selection-time stamp (delivery-time only, in cutover)")
  const secondPass = await selectClaireMode({
    ...{ db: answerFake.db },
    userId: NONCANARY_UID,
    inboundText: "i'm building an eval harness for agents",
  })
  assert.equal(secondPass.ycEventIntake?.nudgeLinkedin, true, "same-turn re-selection still nudges")

  // Already stamped → never again.
  const nudged = await selectClaireMode({
    ...{
      db: makeDb({
        source: "yc_startup_school",
        ycIntake: { linkedinNudgedAt: "2026-07-22T05:00:00.000Z" },
      }).db,
    },
    userId: NONCANARY_UID,
    inboundText: "still thinking about the linkedin thing",
  })
  assert.equal(nudged.ycEventIntake?.nudgeLinkedin, undefined, "stamped → nudge never repeats")

  const afterRecord = await selectClaireMode({
    ...{ db: makeDb({ source: "yc_startup_school", ycIntake: { building: "x" } }).db },
    userId: NONCANARY_UID,
    inboundText: "hey",
  })
  assert.equal(afterRecord.ycEventIntake?.kickoff, undefined, "recorded progress → never re-kickoff")
})
