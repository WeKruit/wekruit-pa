/**
 * mode-selector.ts — the deterministic per-turn mode picker for thin Claire (READ-ONLY seeder).
 *
 * The thin agent is one Agent with a mode-scoped prompt (triage/onboarding/prescreen). NOTHING
 * picked the mode before this: the cutover always ran the default "triage", so the onboarding +
 * prescreen directives were dead on the live path.
 *
 * This module picks the mode each turn from durable state and SEEDS the per-turn process store from
 * that state — but it does NOT record answers itself. Recording flows through the AGENT calling the
 * `record_onboarding_answer` TOOL, which writes the SAME canonical interface (pa-users.tags via
 * applyPartialUserTags + sharedOnboarding) the legacy path + triage use. One agent, one set of tools,
 * one source of truth (v2.0 rule #8). All reads FAIL-SAFE (any error → triage, never throws).
 *
 * Decision (priority order):
 *   1. ACTIVE PRESCREEN (a non-terminal `pa-prescreen-sessions` doc) → defer to the legacy runner
 *      for now (deferToLegacy). Prescreen-on-the-thin-tool-route is the next slice.
 *   2. ONBOARDING INCOMPLETE → mode "onboarding"; seed the process store from `sharedOnboarding`
 *      so the FSM tools enforce order, and tell the agent which slot the inbound answers
 *      (`onboardingSlot`/`awaitingAnswer`) + the current question text (`pendingStep`). Cold start
 *      writes the started-state once (session init, not an answer) so "main_goal asked" is durable.
 *   3. else → TRIAGE.
 */
import type { Firestore } from "firebase-admin/firestore"
import {
  isSharedOnboardingActiveUser,
  currentSharedOnboardingQuestionId,
  resolveNextAskedMissingSharedOnboardingQuestionId,
  isSharedOnboardingSlotSatisfied,
  buildSharedOnboardingPrompt,
  SHARED_ONBOARDING_WORK_SESSION_KIND,
  parseLinkedinDoneOpener,
  type SharedOnboardingQuestionId,
} from "@pa/pa-orchestrator"
import type { ClaireMode } from "./types.js"
import { DEFAULT_ONBOARDING_SLOTS } from "./reducers/onboarding-fsm.js"
import { emptyProcessStore, type ProcessSessionStore } from "./tools/process-tools.js"
import { isThinPrescreenEnabled } from "./flags.js"
import { buildThinPrescreenSeed } from "./prescreen-config.js"
import { loadPrescreenContext } from "./prescreen-context.js"
import { isCanaryUser } from "./canary.js"
import { isEnrichmentInFlight } from "./enrichment-inflight.js"
import { shouldNudgeGmail } from "./gmail-nudge.js"

const USERS = "pa-users"
const PRESCREEN_SESSIONS = "pa-prescreen-sessions"

export interface ModeDecision {
  mode: ClaireMode
  /** when true, thin DEFERS this turn to the legacy path (an active prescreen exists). */
  deferToLegacy?: boolean
  /** active job id when deferring a prescreen turn (telemetry). */
  jobId?: string
  /** the NEXT question to ask after the candidate answers the current slot (positional advance). */
  pendingStep?: string
  /** the CURRENT onboarding question's text — what's on screen now; the agent RE-ASKS this when the
   *  candidate didn't actually answer (asked something / went off-topic), instead of force-advancing. */
  currentStep?: string
  /** the onboarding slot the inbound message answers (the agent records THIS slot). */
  onboardingSlot?: string
  /** false on the kickoff/bootstrap turn (ask only, do NOT record); true once a question was asked. */
  awaitingAnswer?: boolean
  /** per-turn process store seeded from durable state; injected as ctx.processStore. */
  processStore?: ProcessSessionStore
  /** prescreen (thin): qId → DIRECTION question text (from the job's prescreenConfig). */
  prescreenPrompts?: Record<string, string>
  /** prescreen (thin): qId → judge rubric (keyword hints + clarify cue). */
  judgeContext?: Record<string, string>
  /** prescreen (thin): résumé + prior-session context for grounded probing. */
  prescreenContext?: string
  /** prescreen (thin): bare résumé snippet fed to the JUDGE (credits concrete, résumé-consistent answers). */
  prescreenResumeSnippet?: string
  /** prescreen (thin): the REAL pa-prescreen-sessions doc id (score write-back + terminal fire). */
  prescreenSessionId?: string
  /** cv-parsed re-entry (Adam 2026-06-02): this turn is the post-parse pitch turn — swap the generic
   *  kickoff for the PART-2 proactive pitch (consumed by prompt.ts). Set only for the resume_parse_completed
   *  re-entry (canary), never on a normal onboarding/triage turn. */
  postParsePitch?: boolean
  /** WS-1(b) (Adam 2026-06-03): the durable enrichmentInFlight marker is set (résumé parse / LinkedIn
   *  import still running from an EARLIER turn) → the turn-context directive tells Claire to say "still
   *  pulling your info, one sec" instead of pitching on empty data. Canary-only; NEVER set on the
   *  cv-parsed re-entry turn (that turn IS the completion). */
  enrichmentInFlight?: boolean
  /** WS-3(b) (Adam 2026-06-03): this turn MAY carry the occasional "connect Gmail on wekruit.com" nudge
   *  (deterministic cooldown reducer passed). Canary-only; the agent decides whether to actually surface
   *  it. The stamp is written when this is true so we don't re-nudge inside the cooldown. */
  gmailNudge?: boolean
  /** COLD OFFER-FIRST KICKOFF (Adam 2026-06-03): a brand-new candidate with NO profile on file. The agent
   *  sends a DETERMINISTIC offer (connect LinkedIn = recommended / drop résumé in chat / upload on site)
   *  with NO onboarding question — pitch-first; the pitch fires after they connect/drop. Set on the cold
   *  bootstrap turn. */
  offerFirstKickoff?: boolean
  /** LinkedIn-DONE re-entry (Adam 2026-06-03, Image #25): the candidate tapped "log in with LinkedIn"
   *  and came back via "I've done LinkedIn submission <token>", but OAuth bound IDENTITY ONLY (our app
   *  can't get the profile URL yet, so no Coresignal enrich fired). The turn-context directive makes
   *  Claire ACK by name + ask for résumé/URL to pull experience — NEVER re-offer the cold kickoff. */
  linkedinJustConnected?: boolean
  /** SUPPRESS the reply entirely (Adam 2026-06-03): a vestigial system echo with nothing new to say —
   *  e.g. the "I've done LinkedIn submission" reroute that lands AFTER the callback already enriched +
   *  pushed the pitch. cutover marks the inbound handled and sends NOTHING (no duplicate re-ask). */
  suppressReply?: boolean
  suppressReason?: string
  /** Canonical flow Step 4 (Adam-LOCKED): the ONE conditional pre-match ask. Set when location AND
   *  salary are both missing and never asked — prompt asks for both in one short message, defers
   *  find_match one turn. Once-only (stamped by mode-selector). */
  locationSalaryAsk?: boolean
  /** WARM RETURNING GREETING (Adam 2026-06-05): a KNOWN/returning candidate (has ANY profile —
   *  résumé / LinkedIn bind / canonical tags / experienceHighlights) whose onboarding was left in a
   *  half-state (never marked complete) sends a cold greeting like "Hi". They must NOT get the
   *  brand-new offer kickoff (they already gave their stuff) and must NEVER get the legacy target_role
   *  onboarding question. Route to triage with this directive → Claire warmly greets them back by name
   *  and offers to pull fresh matches / asks how she can help. Set on the cold-start triage branch. */
  warmReturningGreeting?: boolean
}

export interface SelectModeArgs {
  db: Firestore
  userId: string
  inboundText: string
  log?: (event: string, payload?: Record<string, unknown>) => void
  nowIso?: () => string
  /** cv-parsed re-entry (Adam 2026-06-02): the cutover sets this when the inbound is the
   *  resume_parse_completed runtime event (canary only) so this turn becomes the post-parse pitch turn. */
  cvParsedTrigger?: boolean
  /** A FILE arrived this turn (mediaUrl present). The cutover file pipeline normally handles + returns
   *  BEFORE selectClaireMode; this flag is defense so a file turn that DOES reach here never gets the
   *  deterministic "still pulling your info" ack (Adam 2026-06-05 — a file is not a mid-enrich question). */
  hasInboundMedia?: boolean
}

/**
 * Is there a non-terminal prescreen session for this user? (active job interview.) Returns the session
 * doc + its id too, so the thin path can seed buildThinPrescreenSeed (resume = prior scores) + thread
 * the REAL sessionId for score write-back / the terminal fire — without a second read.
 */
async function hasActivePrescreen(
  db: Firestore,
  userId: string,
): Promise<{ active: boolean; jobId?: string; sessionId?: string; session?: Record<string, unknown> }> {
  try {
    const snap = await db
      .collection(PRESCREEN_SESSIONS)
      .where("userId", "==", userId)
      .where("terminal", "==", null)
      .limit(1)
      .get()
    if (snap.empty) return { active: false }
    const doc = snap.docs[0]!
    const d = doc.data() as Record<string, unknown>
    return {
      active: true,
      jobId: typeof d.jobId === "string" ? d.jobId : undefined,
      sessionId: doc.id,
      session: d,
    }
  } catch {
    return { active: false } // stub db (evals) / query error → fail-safe
  }
}

/** Write the cold-start sharedOnboarding/workSession doc (legacy buildSharedOnboardingStartedState shape). */
async function bootstrapOnboarding(
  db: Firestore,
  userId: string,
  now: string,
  firstSlot?: SharedOnboardingQuestionId,
): Promise<void> {
  // Seed the slot the cold-start actually intends to ask. The gap-aware cold start may SKIP a
  // tag-satisfied target_role and open at the first GENUINELY-missing slot (e.g. location_relocation);
  // the durable currentQuestionId MUST match that or the next inbound is recorded against the wrong
  // slot (decision says location, durable says target_role → incoherent re-ask). Defaults to the first
  // asked slot for back-compat callers.
  const seedSlot = firstSlot ?? (DEFAULT_ONBOARDING_SLOTS[0] as SharedOnboardingQuestionId)
  await db
    .collection(USERS)
    .doc(userId)
    .set(
      {
        onboardingState: "pending",
        onboardingStatus: "invited",
        updatedAt: now,
        sharedOnboarding: {
          status: "active",
          startedAt: now,
          updatedAt: now,
          currentQuestionId: seedSlot,
          questionOrder: [...DEFAULT_ONBOARDING_SLOTS],
          answers: {},
          completed: false,
        },
        workSession: {
          kind: SHARED_ONBOARDING_WORK_SESSION_KIND,
          status: "active",
          startedAt: now,
          currentQuestionId: seedSlot,
          boundary: "shared_onboarding",
        },
      },
      { merge: true },
    )
}

/** Seed the per-turn process store's onboarding state from the durable sharedOnboarding.answers. */
function seedStore(answeredSlots: string[]): ProcessSessionStore {
  const store = emptyProcessStore()
  store.onboarding = {
    slots: [...DEFAULT_ONBOARDING_SLOTS],
    answers: Object.fromEntries(answeredSlots.map((s) => [s, "recorded"])),
    complete: false,
  }
  return store
}

/**
 * The first ASKED onboarding slot (2026-06-02 trim). `DEFAULT_ONBOARDING_SLOTS` derives
 * from the trimmed ASKED array (`SHARED_ONBOARDING_QUESTIONS` = [target_role,
 * location_relocation]), so this is `target_role`. Used for cold-start seeds + the in-flight
 * rescue, so the literal slot name lives in ONE place.
 */
const FIRST_ASKED_SLOT = (DEFAULT_ONBOARDING_SLOTS[0] ?? "target_role") as SharedOnboardingQuestionId

/**
 * IN-FLIGHT RESCUE (2026-06-02 trim): if a user's durable currentQuestionId is a slot that is
 * no longer ASKED (one of the 5 dropped soft-signal slots), don't re-ask that stale question —
 * resolve to the earliest UNANSWERED slot in the trimmed ASKED set instead. A stored slot that
 * IS still asked is returned unchanged. Worst case: one short re-ask of an asked slot.
 */
function rescueOnboardingSlot(
  stored: SharedOnboardingQuestionId,
  answeredSlots: string[],
): SharedOnboardingQuestionId {
  if (DEFAULT_ONBOARDING_SLOTS.includes(stored)) return stored
  const answered = new Set(answeredSlots)
  const firstUnanswered = DEFAULT_ONBOARDING_SLOTS.find((s) => !answered.has(s))
  return (firstUnanswered ?? FIRST_ASKED_SLOT) as SharedOnboardingQuestionId
}

/**
 * COMPLETION GUARD — IN-FLIGHT STALL GUARD (2026-06-02 trim) + TAG-AWARE (2026-06-04 #1 re-ask fix).
 *
 * STALL GUARD origin: a user durable-paused at a now-DROPPED slot that the OLD order placed AFTER both
 * surviving asked slots (e.g. seniority_comp / special_context) has ALREADY answered both ASKED slots
 * (target_role + location_relocation). Without this guard the rescue falls back to FIRST_ASKED_SLOT and
 * re-asks a question whose answer already exists → recordOnboardingAnswer returns already_complete → the
 * durable `completed` flag never flips → INFINITE re-ask.
 *
 * TAG-AWARE extension: an asked slot counts as satisfied when it was either ANSWERED in this onboarding
 * (`answeredSlots`) OR its canonical axis is already present on `pa-users.tags` / `statedPreferences`
 * (`isSharedOnboardingSlotSatisfied`). So a candidate whose enriched profile already carries every asked
 * axis (e.g. résumé gave `targetRoleFunction`, chat gave `targetLocations`) is "done" even though
 * `sharedOnboarding.answers` is empty/partial — no re-ask of an axis the matcher already has. When every
 * asked slot is satisfied, onboarding is effectively done: complete it + route to triage (where the agent
 * pitches + matches). NO regex; pure presence over the validated closed enums.
 */
function allAskedOnboardingSlotsSatisfiedWithTags(
  answeredSlots: string[],
  tags: Record<string, unknown> | null | undefined,
  statedPreferences: Record<string, unknown> | null | undefined,
): boolean {
  if (DEFAULT_ONBOARDING_SLOTS.length === 0) return false
  const answered = new Set(answeredSlots)
  return DEFAULT_ONBOARDING_SLOTS.every(
    (s) =>
      answered.has(s) ||
      isSharedOnboardingSlotSatisfied(s as SharedOnboardingQuestionId, tags, statedPreferences),
  )
}

/** Best-effort durable mark-complete (mirrors bootstrapOnboarding's shape). Never throws upward. */
async function markSharedOnboardingComplete(db: Firestore, userId: string, now: string): Promise<void> {
  try {
    await db
      .collection(USERS)
      .doc(userId)
      .set(
        {
          onboardingState: "complete",
          // ALSO onboardingStatus (Adam 2026-06-04): loadGlobalContext's "already onboarded?" guard
          // reads onboardingStatus; leaving it stale re-surfaced the connect-LinkedIn / upload offers.
          onboardingStatus: "complete",
          updatedAt: now,
          sharedOnboarding: { status: "complete", completed: true, updatedAt: now },
        },
        { merge: true },
      )
  } catch {
    // Routing to triage already breaks the stall this turn; the write is just the durable self-heal.
  }
}

/** WS-3(b) best-effort durable stamp so the Gmail nudge respects its cooldown. Never throws upward. */
async function stampGmailNudge(db: Firestore, userId: string, now: string): Promise<void> {
  try {
    await db.collection(USERS).doc(userId).set({ lastGmailNudgeAt: now, updatedAt: now }, { merge: true })
  } catch {
    /* best-effort — a missed stamp just allows one extra nudge next eligible turn */
  }
}

/**
 * WS-2: does this user already have a PARSED résumé/profile on file? (website / ATS / bulk-resume
 * cohort.) True when a parsed resume artifact is recorded (latestResumeArtifactId) OR resume-derived
 * tags exist (skills / recentRoleTitle) — both written by the website upload's mergeUserTags. Pure
 * structured-field read over the already-fetched pa-users doc; NO LLM, NO text→enum regex.
 */
function hasParsedProfileOnFile(user: Record<string, unknown>): boolean {
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "")
  if (str(user.latestResumeArtifactId)) return true
  const tags = (user.tags ?? {}) as Record<string, unknown>
  const skills = Array.isArray(tags.skills) ? tags.skills : []
  if (skills.length > 0) return true
  if (str(tags.recentRoleTitle)) return true
  return false
}

/**
 * WARM-RETURNING SIGNAL (Adam 2026-06-05): does this user already have ANY durable profile signal?
 * This is the SUPERSET of hasParsedProfileOnFile — a candidate is "known/returning" (not brand-new)
 * if they have a parsed résumé OR a LinkedIn bind OR any meaningful canonical tag OR enriched
 * experienceHighlights on file. Used to keep a cold "Hi" from a KNOWN candidate (whose onboarding was
 * never marked complete) OUT of the brand-new offer-first kickoff AND off the legacy target_role
 * onboarding question — they instead get a warm returning greeting (triage). Pure structured-field
 * read over the already-fetched pa-users doc; NO LLM, NO text→enum regex (presence checks over
 * validated closed enums + identity flags only).
 */
/**
 * INGESTED-BACKGROUND SIGNAL (Adam 2026-06-06): did we ingest this candidate's actual BACKGROUND —
 * a LinkedIn bind, a parsed résumé, or an enriched experience timeline? This is the NARROWER cousin of
 * hasAnyProfileSignal: it deliberately EXCLUDES the "answered one onboarding slot" case (a bare
 * targetRoleFunction tag), because a user who only told us their target role but never gave a location
 * must still be asked the missing location axis (Adam 2026-06-05 "ONLY ask for non-existing info").
 * Used to route a RECOGNIZED candidate (LinkedIn-login → text) straight to the pitch with NO onboarding
 * wall, while a partial-onboarding user still gets the one genuinely-missing question. Structured
 * presence checks over the already-fetched pa-users doc — NO LLM, NO text→enum regex.
 */
function hasIngestedBackground(user: Record<string, unknown>): boolean {
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "")
  if (hasParsedProfileOnFile(user)) return true
  if (user.linkedinOauthLinked === true) return true
  if (str(user.linkedinUrl)) return true
  if (str(user.linkedinOauthSub)) return true
  if (Array.isArray(user.experienceHighlights) && user.experienceHighlights.length > 0) return true
  return false
}

function hasAnyProfileSignal(user: Record<string, unknown>): boolean {
  if (hasParsedProfileOnFile(user)) return true
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "")
  // LinkedIn bind (OAuth-linked identity OR a stored profile URL) — a known/returning candidate.
  if (user.linkedinOauthLinked === true) return true
  if (str(user.linkedinUrl)) return true
  if (str(user.linkedinOauthSub)) return true
  // Enriched experience timeline (LinkedIn/Coresignal/résumé merge) is durable known-profile data.
  if (Array.isArray(user.experienceHighlights) && user.experienceHighlights.length > 0) return true
  // Any meaningful canonical tag the matcher uses (closed-enum presence check — never text→enum regex).
  const tags = (user.tags ?? {}) as Record<string, unknown>
  const arr = (v: unknown) => (Array.isArray(v) && v.length > 0)
  if (arr(tags.targetRoleFunction) || arr(tags.industrySector) || arr(tags.targetLocations)) return true
  if (str(tags.careerStage) || str(tags.visaStatus) || str(tags.recentCompany)) return true
  return false
}

/**
 * Pick the mode for this turn from durable state + seed the process store. ALWAYS resolves
 * (never throws) — any read/write error degrades to triage so the turn still gets a reply.
 */
export async function selectClaireMode(args: SelectModeArgs): Promise<ModeDecision> {
  const log = args.log ?? (() => {})
  const now = (args.nowIso ?? (() => new Date().toISOString()))()

  // 1. ACTIVE PRESCREEN.
  const ps = await hasActivePrescreen(args.db, args.userId)
  if (ps.active) {
    // Flag OFF (default) → defer this turn to the proven legacy prescreen runner (UNCHANGED).
    let thinOn = false
    try {
      thinOn = await isThinPrescreenEnabled(args.db, args.userId)
    } catch {
      thinOn = false
    }
    if (!thinOn || !ps.jobId) {
      log("mode.prescreen_defer_legacy", { userId: args.userId, jobId: ps.jobId, thinOn })
      return { mode: "prescreen", deferToLegacy: true, jobId: ps.jobId }
    }
    // Flag ON → the THIN agent runs this prescreen turn. Seed from the job's real config + the
    // in-progress session (resume keeps prior scores). All reads fail-safe → defer on any miss.
    try {
      const jobSnap = await args.db.collection("pa-jobs").doc(ps.jobId).get()
      const config = (jobSnap.exists ? jobSnap.data()?.prescreenConfig : null) as
        | Record<string, unknown>
        | null
        | undefined
      const seed = buildThinPrescreenSeed(config, ps.session ?? null)
      if (seed.questionIds.length === 0) {
        // No usable questions → don't strand the candidate on a thin engine with nothing to ask.
        log("mode.prescreen_thin_no_questions", { userId: args.userId, jobId: ps.jobId })
        return { mode: "prescreen", deferToLegacy: true, jobId: ps.jobId }
      }
      const store = emptyProcessStore()
      store.prescreen = seed.prescreen
      // résumé arc + prior-session callbacks (extra reads paid ONLY on a thin prescreen turn).
      const pc = await loadPrescreenContext(args.db, args.userId, ps.jobId, seed.prompts)
      log("mode.prescreen_thin", {
        userId: args.userId,
        jobId: ps.jobId,
        questions: seed.questionIds.length,
        priorScored: Object.keys(seed.prescreen.scores).length,
      })
      return {
        mode: "prescreen",
        deferToLegacy: false,
        jobId: ps.jobId,
        processStore: store,
        prescreenPrompts: seed.prompts,
        judgeContext: seed.judgeContext,
        prescreenContext: pc.contextText,
        prescreenResumeSnippet: pc.resumeSnippet,
        prescreenSessionId: ps.sessionId,
      }
    } catch (err) {
      // Any seeding failure → fall back to the legacy runner so the candidate still gets a reply.
      log("mode.prescreen_thin_error", {
        userId: args.userId,
        jobId: ps.jobId,
        error: err instanceof Error ? err.message : String(err),
      })
      return { mode: "prescreen", deferToLegacy: true, jobId: ps.jobId }
    }
  }

  // 2. ONBOARDING (reuse the legacy sharedOnboarding durable state; the AGENT records via the tool).
  let user: Record<string, unknown> = {}
  try {
    const snap = await args.db.collection(USERS).doc(args.userId).get()
    user = (snap.exists ? snap.data() : {}) ?? {}
  } catch {
    return { mode: "triage" }
  }

  const shared = (user.sharedOnboarding ?? null) as Record<string, unknown> | null
  const onboardingComplete = shared?.completed === true || user.onboardingState === "complete"

  // 2026-06-04 (#1 re-ask fix): the canonical user tags + the legacy statedPreferences mirror from the
  // SAME pa-users snapshot (zero extra read). The onboarding slot picker consults these so it NEVER
  // re-asks an axis whose canonical tag is already present (e.g. a résumé-enriched candidate carrying
  // `targetRoleFunction` being asked "what kind of role" again). Pure structured reads — NO LLM, NO
  // text→enum regex; satisfaction is a presence check over validated closed enums.
  const userTags = (user.tags ?? null) as Record<string, unknown> | null
  const statedPreferences = (user.statedPreferences ?? null) as Record<string, unknown> | null

  // WS-1(b) ENRICHMENT-AWARENESS (Adam 2026-06-03): read the durable enrichmentInFlight marker off the
  // SAME pa-users snapshot (zero extra read). True only when résumé parse / LinkedIn import is still
  // running from an EARLIER turn (TTL self-heals a dropped completion event — see enrichment-inflight.ts).
  // NEVER flag in-flight on the cv-parsed re-entry turn: that turn IS the completion (it CLEARs the marker
  // in cutover) and must pitch, not say "one sec". Canary-only so non-canary mode picks are unchanged.
  const enrichmentInFlight =
    isCanaryUser(args.userId) && !args.cvParsedTrigger && isEnrichmentInFlight(user)
  const inFlightDecision = enrichmentInFlight ? { enrichmentInFlight: true as const } : {}

  // ENRICHMENT-IN-FLIGHT ACK (Adam 2026-06-03, Image #24): the candidate just connected LinkedIn /
  // dropped a résumé and the enrich is still pulling. The "I've done LinkedIn submission" re-entry of
  // a COLD user (no active onboarding) must ACK ("still pulling your info, one sec 🔎"), NOT re-offer
  // the kickoff (the regression) and NOT start a question. The PITCH fires separately on the
  // resume_parse_completed re-entry (cvParsedTrigger, handled below). Gated to the NON-active path:
  // an ACTIVE onboarding user mid-enrich keeps their onboarding decision (which already carries
  // inFlightDecision → ack + the pending question). Triage's in-flight directive (prompt.ts) covers
  // both LinkedIn + résumé sources.
  // DEFENSE (Adam 2026-06-05): a FILE turn must NEVER get the "still pulling" ack — a file is a fresh
  // input to process (the cutover file pipeline already handles it), not a mid-enrich question. The
  // cutover returns before this for a file-only drop; this guard covers any file turn that still reaches
  // here (e.g. a file WITH a caption) so it routes to the agent instead of the hold ack.
  if (enrichmentInFlight && !args.hasInboundMedia && !isSharedOnboardingActiveUser(user)) {
    log("mode.enrichment_in_flight_ack", { userId: args.userId })
    return { mode: "triage", ...inFlightDecision }
  }

  // LINKEDIN-DONE RE-ENTRY (Adam 2026-06-03, Image #25): the candidate tapped "log in with LinkedIn"
  // and came back via "I've done LinkedIn submission <token>". OAuth verified their IDENTITY (we know
  // their name) but — confirmed via LinkedIn docs — OIDC never returns the profile URL, so NO Coresignal
  // enrich could fire (enrichmentInFlight is false → the branch above didn't catch it). This re-entry
  // must NEVER fall through to the cold offer-first re-offer (the bug). Route to triage with the
  // linkedinJustConnected directive → Claire acks by name + asks for their LinkedIn URL or résumé so
  // she can pull experience and start matching. Canary-gated to mirror the offer-first cohort.
  if (isCanaryUser(args.userId) && parseLinkedinDoneOpener(args.inboundText)) {
    // No-paste photo-enrich (2026-06-03) now resolves the profile IN the callback and server-pushes
    // the pitch. By the time this "I've done LinkedIn submission" echo arrives, enrichment is DONE
    // (skills/highlights on file) → the echo is vestigial. SUPPRESS it (no duplicate "drop résumé/URL"
    // re-ask). Only when enrichment did NOT land (candidate not in Coresignal's dataset) do we ack +
    // ask for résumé/URL as the fallback.
    if (hasParsedProfileOnFile(user)) {
      log("mode.linkedin_done_suppress_already_enriched", { userId: args.userId })
      return { mode: "triage", suppressReply: true, suppressReason: "linkedin_done_already_enriched" }
    }
    log("mode.linkedin_just_connected", { userId: args.userId })
    return { mode: "triage", linkedinJustConnected: true }
  }

  // WS-3(b) GMAIL NUDGE (Adam 2026-06-03): occasionally ask the candidate to connect Gmail on
  // wekruit.com (deterministic cooldown reducer — no regex over text). Never while enrichment is in
  // flight (don't pile onto a "one sec" turn) or on the cv-parsed pitch turn. The gate also excludes
  // an active onboarding question (computed below as awaitingAnswer). Surfaced on TRIAGE turns only;
  // we stamp lastGmailNudgeAt when it passes so the cooldown holds. Canary-only.
  const gmailNudgeEligible =
    !enrichmentInFlight &&
    !args.cvParsedTrigger &&
    shouldNudgeGmail({ user, isCanary: isCanaryUser(args.userId) })

  // CV-PARSED RE-ENTRY (Adam 2026-06-02): this turn is the resume_parse_completed runtime event (the
  // cutover only sets cvParsedTrigger for canary users). The résumé just parsed → the agent should
  // PITCH from the freshly-loaded profile (postParsePitch), then offer/run find_match AFTER. Runs AFTER
  // the active-prescreen block above (a late parse must never hijack a live screen) and after the user
  // read. For an UNFINISHED profile we ride the onboarding kickoff shape (postParsePitch swaps the
  // generic compliment for the pitch; messages[1] weaves the next onboarding question). For a COMPLETE/
  // returning profile we ride triage with postParsePitch (the pitch then OFFERs find_match).
  if (args.cvParsedTrigger) {
    if (!onboardingComplete) {
      // PITCH-FIRST ON RICH ENRICHMENT (Adam 2026-06-03: "we want to pitch & conversation first, why
      // ask the onboarding question now?"): LinkedIn/résumé enrich already filled a real profile
      // (skills + experienceHighlights). Skip the onboarding WALL entirely — mark complete + pitch in
      // triage (pitch + OPEN conversation, NO target_role question). Only a profile-LESS cold start
      // (Coresignal miss + no résumé) still rides the bootstrap+ask path below. Mirrors WS-2.
      if (hasParsedProfileOnFile(user)) {
        try {
          await markSharedOnboardingComplete(args.db, args.userId, now)
        } catch (err) {
          log("mode.cv_parsed_enriched_markcomplete_failed", { userId: args.userId, error: String(err) })
        }
        log("mode.cv_parsed_pitch_enriched_no_wall", { userId: args.userId })
        return { mode: "triage", postParsePitch: true }
      }
      try {
        if (!isSharedOnboardingActiveUser(user)) {
          // Cold start that just got a résumé: seed durable state, then pitch + ask the first ASKED
          // slot (target_role, 2026-06-02 trim).
          await bootstrapOnboarding(args.db, args.userId, now)
          log("mode.cv_parsed_pitch_bootstrap", { userId: args.userId })
          return {
            mode: "onboarding",
            awaitingAnswer: false,
            postParsePitch: true,
            onboardingSlot: FIRST_ASKED_SLOT,
            pendingStep: buildSharedOnboardingPrompt(FIRST_ASKED_SLOT, null),
            currentStep: buildSharedOnboardingPrompt(FIRST_ASKED_SLOT, null),
            processStore: seedStore([]),
          }
        }
        const answeredSlots = Object.keys((shared?.answers as Record<string, unknown>) ?? {})
        // TAG-AWARE COMPLETE (2026-06-04 #1): every asked slot satisfied by an answer OR a canonical
        // tag already on file → don't re-ask; the résumé just parsed, so pitch in triage + OFFER match.
        if (allAskedOnboardingSlotsSatisfiedWithTags(answeredSlots, userTags, statedPreferences)) {
          await markSharedOnboardingComplete(args.db, args.userId, now)
          log("mode.cv_parsed_pitch_complete", { userId: args.userId, tagSatisfied: true })
          return { mode: "triage", postParsePitch: true }
        }
        // Skip any tag-satisfied slot when picking what to ASK (never re-ask an axis the parse filled).
        const rescued = rescueOnboardingSlot(
          currentSharedOnboardingQuestionId(user) as SharedOnboardingQuestionId,
          answeredSlots,
        )
        const rescuedSatisfied =
          answeredSlots.includes(rescued) ||
          isSharedOnboardingSlotSatisfied(rescued, userTags, statedPreferences)
        const cur = rescuedSatisfied
          ? resolveNextAskedMissingSharedOnboardingQuestionId(rescued, userTags, statedPreferences)
              .nextQuestionId ?? rescued
          : rescued
        const next = resolveNextAskedMissingSharedOnboardingQuestionId(cur, userTags, statedPreferences)
        log("mode.cv_parsed_pitch_active", { userId: args.userId, currentSlot: cur, next: next.nextQuestionId })
        return {
          mode: "onboarding",
          // kickoff shape (ask, don't record) so the PART-2 pitch fires + the clarifier lands the
          // next onboarding question for an unfinished profile (the parse event is not an answer).
          awaitingAnswer: false,
          postParsePitch: true,
          onboardingSlot: cur,
          currentStep: buildSharedOnboardingPrompt(cur, null),
          ...(next.nextQuestionId
            ? { pendingStep: buildSharedOnboardingPrompt(next.nextQuestionId, null) }
            : { pendingStep: buildSharedOnboardingPrompt(cur, null) }),
          processStore: seedStore(answeredSlots),
        }
      } catch (err) {
        log("mode.cv_parsed_pitch_error", {
          userId: args.userId,
          error: err instanceof Error ? err.message : String(err),
        })
        // Fall through to the normal onboarding/triage resolution below on any read error.
      }
    } else {
      // Returning user re-uploaded a résumé → pitch in triage, then OFFER find_match.
      log("mode.cv_parsed_pitch_triage", { userId: args.userId })
      return { mode: "triage", postParsePitch: true }
    }
  }

  // WS-2 WEBSITE-ORIGIN SHORT PATH (Adam 2026-06-03): a candidate who entered via the WEBSITE
  // (public-cv-ingest → ingestCv with followupDeliveryMode "none") already has a PARSED profile but
  // was NEVER bootstrapped into sharedOnboarding (no resume_parse_completed event fired for them). When
  // they later TEXT Claire, the cold-start block below would put them through the two-question wall
  // despite a complete profile. Instead: if a parsed résumé is on file (latestResumeArtifactId) — or
  // resume-derived tags exist — AND onboarding was never started/completed, SKIP the wall: mark
  // onboarding complete + route straight to the PART-2 pitch (triage + postParsePitch), which pitches
  // FROM the parsed data and then confirms tags + offers find_match (mirrors what S1 did for phone).
  // Reuses the postParsePitch directive + loadGlobalContext's parsedCandidateResumes fallback (the
  // website-upload shape). Canary-only; non-canary falls through to the existing bootstrap unchanged.
  // Sits AFTER the active-prescreen + cv-parsed blocks (a live screen / fresh parse must always win)
  // and BEFORE the onboarding cold-start (line below). Deterministic — NO LLM, NO text→enum regex.
  // WARM RETURNING GREETING (Adam 2026-06-05: "no legacy target_role EVER for a thin/canary user on a
  // cold open"). A plain text turn (NOT the resume_parse_completed re-entry, which pitches above) from a
  // KNOWN/returning candidate — anyone with ANY durable profile signal (parsed résumé / LinkedIn bind /
  // canonical tags / experienceHighlights) — must get a WARM RETURNING GREETING: greet back by name +
  // offer to pull fresh matches / ask how to help. They already gave us their info, so this is NEVER the
  // brand-new offer-first kickoff, and NEVER the legacy onboarding target_role question. This SUPERSEDES
  // the old WS-2 "website-profile → re-pitch" behavior on a plain returning text (a returning user saying
  // "Hi" wants a greeting + matches, not their résumé re-pitched at them); the genuine "just parsed, pitch
  // now" path is the cvParsedTrigger re-entry block ABOVE, which is unaffected. Sits AFTER active-prescreen
  // + the cv-parsed block (a live screen / fresh parse must always win) and BEFORE the onboarding cold-
  // start. Self-heals a half-state onboarding (mark complete) so it never re-enters the wall. Deterministic
  // — NO LLM, NO text→enum regex; structured presence checks over closed-enum tags + identity flags only.
  // Canary-gated so non-canary mode picks are byte-unchanged.
  if (
    isCanaryUser(args.userId) &&
    !args.cvParsedTrigger &&
    !isSharedOnboardingActiveUser(user) &&
    hasAnyProfileSignal(user)
  ) {
    if (!onboardingComplete) await markSharedOnboardingComplete(args.db, args.userId, now)
    log("mode.warm_returning_greeting", { userId: args.userId })
    return { mode: "triage", warmReturningGreeting: true, ...inFlightDecision }
  }

  if (!onboardingComplete) {
    try {
      if (!isSharedOnboardingActiveUser(user)) {
        // UNIVERSAL GAP-AWARE COLD START (Adam 2026-06-05: "ONLY ask for non-existing info").
        // A profiled cold-opener (LinkedIn/résumé/role/location already on file) must NOT be walked
        // through the target_role/location wall — that re-asks info we already hold (the Jasmaine
        // defect: a LinkedIn-OAuth user with enriched experience pitched correctly, then was STILL
        // asked "what kind of roles" + a location question — both already on file). Pure structured
        // presence checks over the closed-enum tags (isSharedOnboardingSlotSatisfied) — NO LLM, NO
        // text→enum regex. This is a bug-class re-ask removal, so it is NOT canary-gated (mirrors the
        // un-gated tag-satisfaction skip already on the onboarding_active branch below and the
        // cv-parsed branch above). The genuinely-NEW conversational surfaces (warm-greeting copy at
        // :583, the offer-first kickoff copy, the PART-2 pitch engine, enriched pitch material) stay
        // canary-gated untouched — only the question-SUPPRESSION crosses to universal.
        // RECOGNIZED CANDIDATE (ingested background) → NEVER the onboarding question wall (Adam
        // 2026-06-06: "login on LinkedIn from website and directly go to text — directly give them a
        // pitch as if we know them, no more onboarding questions"). A LinkedIn bind / parsed résumé /
        // enriched timeline means we already hold this person's background — route to triage (the agent
        // pitches from what we hold + offers find_match), NEVER ask target_role/location. This is the
        // bug-class question-SUPPRESSION (re-asking someone we already know), so it is UNIVERSAL — it
        // mirrors the tag-satisfaction skip just below, the cv-parsed pitch branch above, and the canary
        // warm-returning branch above (which already caught canary users; this catches the NON-canary
        // recognized user who was still dropped into the wall). hasIngestedBackground is NARROWER than
        // hasAnyProfileSignal on purpose: a user who only answered target_role (a bare tag, no
        // background) is NOT "recognized" and still gets the genuinely-missing location question (Adam
        // 2026-06-05 "ONLY ask for non-existing info"). New pitch/greeting COPY stays canary-gated
        // upstream; this only SUPPRESSES the question. NO LLM, NO text→enum regex.
        if (hasIngestedBackground(user)) {
          await markSharedOnboardingComplete(args.db, args.userId, now)
          log("mode.recognized_no_onboarding_wall", { userId: args.userId })
          // PITCH (not a bare triage): Adam 2026-06-06 chose "pitch first, ask role inside the pitch" —
          // the pitch composer confirms/elicits the one missing canonical axis (e.g. "targeting SWE
          // roles — that right? 👍") inline, so we get the role for matching WITHOUT an onboarding wall.
          return { mode: "triage", postParsePitch: true, ...inFlightDecision }
        }
        if (allAskedOnboardingSlotsSatisfiedWithTags([], userTags, statedPreferences)) {
          // NOTHING missing → onboarding is effectively done. Self-heal + route to triage (where the
          // agent pitches from data + offers find_match). No question, no wall.
          await markSharedOnboardingComplete(args.db, args.userId, now)
          log("mode.cold_start_all_satisfied_complete", { userId: args.userId })
          return { mode: "triage", ...inFlightDecision }
        }
        // A real gap remains → seed the FIRST genuinely-missing asked slot (skip any tag-satisfied
        // axis), NOT the unconditional FIRST_ASKED_SLOT. A 1-line presence scan over the ASKED slot
        // list using the same un-gated helper — no off-by-one, no regex. The `?? FIRST_ASKED_SLOT`
        // is unreachable (the guard above proved at least one slot is missing), kept for typing.
        const firstMissing =
          (DEFAULT_ONBOARDING_SLOTS as SharedOnboardingQuestionId[]).find(
            (s) => !isSharedOnboardingSlotSatisfied(s, userTags, statedPreferences),
          ) ?? FIRST_ASKED_SLOT

        const offerFirst = isCanaryUser(args.userId)
        // Cold start (e.g. just reinitialized): ask the first GENUINELY-MISSING asked slot — UNLESS
        // offer-first (canary), which sends the DETERMINISTIC offer (LinkedIn/résumé/upload) and asks
        // NO question.
        //
        // REGRESSION FIX (Adam 2026-06-03, "Hi → 👍, no reply"): only bootstrapOnboarding on the
        // NON-offer path. bootstrapOnboarding marks sharedOnboarding.status="active" — i.e. "a
        // question was asked, the next inbound is an ANSWER". But the offer turn asks NO question,
        // so marking it active POISONED the state: the next inbound (or a coalesced re-run / recovery
        // sweep) routed to the onboarding_active branch, treated "Hi" as an answer, and the offer
        // never re-fired (the candidate fell into the question wall). Offer-first must leave the user
        // COLD so a re-entry simply re-offers; real progression is resume_parse_completed (connect/
        // drop résumé) → pitch (the cv-parsed branch above bootstraps its own state). The slot/prompt
        // below stay set only so agent.ts has a question to ask IF the offer short-circuit falls
        // through (no link surfaced) — a non-fatal degrade, and still no durable poison.
        if (!offerFirst) await bootstrapOnboarding(args.db, args.userId, now, firstMissing)
        log("mode.onboarding_bootstrap", { userId: args.userId, offerFirst, firstMissing })
        return {
          mode: "onboarding",
          awaitingAnswer: false,
          onboardingSlot: firstMissing,
          pendingStep: buildSharedOnboardingPrompt(firstMissing, null),
          currentStep: buildSharedOnboardingPrompt(firstMissing, null),
          processStore: seedStore([]),
          offerFirstKickoff: offerFirst,
          ...inFlightDecision,
        }
      }
      // Active: a question was already asked → this inbound answers the current slot. The agent
      // records it (write-through tool), then asks the NEXT question. pendingStep is the NEXT
      // question (positional advance, matching the tool's resolver) so the agent-records path and
      // the deterministic net-records path BOTH leave the agent asking what durable now points to;
      // undefined on the last slot → the directive tells the agent to wrap up after recording.
      //
      // IN-FLIGHT RESCUE (2026-06-02 trim): a user whose durable currentQuestionId is a now-DROPPED
      // slot (e.g. culture_stage) must NOT be re-asked that stale question. If the stored slot is not
      // in the ASKED set, treat onboarding as at the earliest UNANSWERED asked slot instead. Worst
      // case is one short re-ask of an asked slot; never a stall or data loss, and no Firestore backfill.
      const answeredSlots = Object.keys((shared?.answers as Record<string, unknown>) ?? {})
      // STALL GUARD + TAG-AWARE COMPLETE (2026-06-04 #1): every asked slot is satisfied — by an
      // ANSWER or by a canonical tag already on file (résumé/chat enrich) → onboarding is effectively
      // done. Complete it + route to triage instead of re-asking an axis the matcher already has.
      if (allAskedOnboardingSlotsSatisfiedWithTags(answeredSlots, userTags, statedPreferences)) {
        await markSharedOnboardingComplete(args.db, args.userId, now)
        log("mode.onboarding_already_satisfied_complete", {
          userId: args.userId,
          answered: answeredSlots.length,
          tagSatisfied: true,
        })
        return { mode: "triage" }
      }
      // Pick the slot to ASK = the in-flight-rescued current slot, UNLESS its axis is already captured
      // (answered OR canonical tag already on file). When the rescued slot is already satisfied, SKIP
      // it and ask the first genuinely-missing asked slot instead — never re-ask a tag-satisfied axis.
      // The guard above guarantees at least one asked slot is still missing, so this always resolves to
      // a real question (the `?? rescued` fallback is unreachable, kept only for total typing safety).
      const rescued = rescueOnboardingSlot(
        currentSharedOnboardingQuestionId(user) as SharedOnboardingQuestionId,
        answeredSlots,
      )
      const rescuedSatisfied =
        answeredSlots.includes(rescued) ||
        isSharedOnboardingSlotSatisfied(rescued, userTags, statedPreferences)
      const cur = rescuedSatisfied
        ? resolveNextAskedMissingSharedOnboardingQuestionId(rescued, userTags, statedPreferences)
            .nextQuestionId ?? rescued
        : rescued
      // The NEXT question after `cur` must also skip tag-satisfied slots (tag-aware advance), so the
      // agent's follow-up clarifier never lands a redundant axis.
      const next = resolveNextAskedMissingSharedOnboardingQuestionId(cur, userTags, statedPreferences)
      log("mode.onboarding_active", {
        userId: args.userId,
        currentSlot: cur,
        next: next.nextQuestionId,
        answered: answeredSlots.length,
      })
      return {
        mode: "onboarding",
        awaitingAnswer: true,
        onboardingSlot: cur,
        currentStep: buildSharedOnboardingPrompt(cur, null),
        ...(next.nextQuestionId ? { pendingStep: buildSharedOnboardingPrompt(next.nextQuestionId, null) } : {}),
        processStore: seedStore(answeredSlots),
        ...inFlightDecision,
      }
    } catch (err) {
      log("mode.onboarding_error", {
        userId: args.userId,
        error: err instanceof Error ? err.message : String(err),
      })
      return { mode: "triage" }
    }
  }

  // 3. TRIAGE.
  // CANONICAL FLOW STEP 4 — loc/salary ask moved to MATCH TIME (Adam 2026-06-04: "before we get confirm
  // from user, don't ask"). The old deterministic gate fired the "where + salary?" question on EVERY
  // triage turn whenever both were missing — so a post-pitch profile-refinement message ("either works,
  // here's more context") wrongly triggered it BEFORE the candidate asked for matches. The ask is now
  // the agent's job, only right before find_match (prompt rule), so it never fires before match-intent.

  // WS-3(b): a plain conversational triage turn is the right place for the occasional Gmail nudge
  // (not mid-onboarding, not a pitch, not enrichment-in-flight). Stamp the cooldown when it fires.
  if (gmailNudgeEligible) {
    await stampGmailNudge(args.db, args.userId, now)
    log("mode.gmail_nudge", { userId: args.userId })
    return { mode: "triage", ...inFlightDecision, gmailNudge: true }
  }
  return { mode: "triage", ...inFlightDecision }
}
