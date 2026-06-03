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
  resolveNextAskedSharedOnboardingQuestionId,
  buildSharedOnboardingPrompt,
  SHARED_ONBOARDING_WORK_SESSION_KIND,
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
async function bootstrapOnboarding(db: Firestore, userId: string, now: string): Promise<void> {
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
          // 2026-06-02 trim: cold-start seeds the first ASKED slot (target_role).
          currentQuestionId: DEFAULT_ONBOARDING_SLOTS[0],
          questionOrder: [...DEFAULT_ONBOARDING_SLOTS],
          answers: {},
          completed: false,
        },
        workSession: {
          kind: SHARED_ONBOARDING_WORK_SESSION_KIND,
          status: "active",
          startedAt: now,
          currentQuestionId: DEFAULT_ONBOARDING_SLOTS[0],
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
 * IN-FLIGHT STALL GUARD (2026-06-02 trim): a user durable-paused at a now-DROPPED slot that the
 * OLD order placed AFTER both surviving asked slots (e.g. seniority_comp / special_context, old
 * positions 6/7, after location_relocation@5) has ALREADY answered both ASKED slots (target_role +
 * location_relocation). Without this guard the rescue falls back to FIRST_ASKED_SLOT and re-asks a
 * question whose answer already exists → recordOnboardingAnswer returns already_complete → the
 * durable `completed` flag never flips → INFINITE re-ask. When every asked slot is satisfied,
 * onboarding is effectively done: complete it + route to triage (where the agent can pitch + match).
 */
function allAskedOnboardingSlotsSatisfied(answeredSlots: string[]): boolean {
  if (DEFAULT_ONBOARDING_SLOTS.length === 0) return false
  const answered = new Set(answeredSlots)
  return DEFAULT_ONBOARDING_SLOTS.every((s) => answered.has(s))
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
  if (enrichmentInFlight && !isSharedOnboardingActiveUser(user)) {
    log("mode.enrichment_in_flight_ack", { userId: args.userId })
    return { mode: "triage", ...inFlightDecision }
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
        if (allAskedOnboardingSlotsSatisfied(answeredSlots)) {
          // Both asked slots already answered (paused at a dropped late slot) → don't re-ask; the
          // résumé just parsed, so pitch in triage then OFFER find_match.
          await markSharedOnboardingComplete(args.db, args.userId, now)
          log("mode.cv_parsed_pitch_complete", { userId: args.userId })
          return { mode: "triage", postParsePitch: true }
        }
        const cur = rescueOnboardingSlot(
          currentSharedOnboardingQuestionId(user) as SharedOnboardingQuestionId,
          answeredSlots,
        )
        const next = resolveNextAskedSharedOnboardingQuestionId(cur)
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
  if (
    isCanaryUser(args.userId) &&
    !onboardingComplete &&
    !isSharedOnboardingActiveUser(user) &&
    hasParsedProfileOnFile(user)
  ) {
    await markSharedOnboardingComplete(args.db, args.userId, now)
    log("mode.website_profile_pitch", { userId: args.userId })
    return { mode: "triage", postParsePitch: true }
  }

  if (!onboardingComplete) {
    try {
      if (!isSharedOnboardingActiveUser(user)) {
        const offerFirst = isCanaryUser(args.userId)
        // Cold start (e.g. just reinitialized): ask the first ASKED slot (target_role, 2026-06-02
        // trim) — UNLESS offer-first (canary), which sends the DETERMINISTIC offer (LinkedIn/résumé/
        // upload) and asks NO question.
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
        if (!offerFirst) await bootstrapOnboarding(args.db, args.userId, now)
        log("mode.onboarding_bootstrap", { userId: args.userId, offerFirst })
        return {
          mode: "onboarding",
          awaitingAnswer: false,
          onboardingSlot: FIRST_ASKED_SLOT,
          pendingStep: buildSharedOnboardingPrompt(FIRST_ASKED_SLOT, null),
          currentStep: buildSharedOnboardingPrompt(FIRST_ASKED_SLOT, null),
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
      if (allAskedOnboardingSlotsSatisfied(answeredSlots)) {
        // STALL GUARD: every asked slot is answered (in-flight user paused at a dropped late slot) →
        // onboarding is effectively done. Complete it + route to triage instead of re-asking forever.
        await markSharedOnboardingComplete(args.db, args.userId, now)
        log("mode.onboarding_already_satisfied_complete", { userId: args.userId, answered: answeredSlots.length })
        return { mode: "triage" }
      }
      const cur = rescueOnboardingSlot(
        currentSharedOnboardingQuestionId(user) as SharedOnboardingQuestionId,
        answeredSlots,
      )
      const next = resolveNextAskedSharedOnboardingQuestionId(cur)
      log("mode.onboarding_active", { userId: args.userId, currentSlot: cur, next: next.nextQuestionId, answered: answeredSlots.length })
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
  // WS-3(b): a plain conversational triage turn is the right place for the occasional Gmail nudge
  // (not mid-onboarding, not a pitch, not enrichment-in-flight). Stamp the cooldown when it fires.
  if (gmailNudgeEligible) {
    await stampGmailNudge(args.db, args.userId, now)
    log("mode.gmail_nudge", { userId: args.userId })
    return { mode: "triage", ...inFlightDecision, gmailNudge: true }
  }
  return { mode: "triage", ...inFlightDecision }
}
