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

  if (!onboardingComplete) {
    try {
      if (!isSharedOnboardingActiveUser(user)) {
        // Cold start (e.g. just reinitialized): seed durable state + ask the first ASKED slot
        // (target_role, 2026-06-02 trim). The inbound is the kickoff/greeting, NOT an answer →
        // awaitingAnswer:false, the agent only asks.
        await bootstrapOnboarding(args.db, args.userId, now)
        log("mode.onboarding_bootstrap", { userId: args.userId })
        return {
          mode: "onboarding",
          awaitingAnswer: false,
          onboardingSlot: FIRST_ASKED_SLOT,
          pendingStep: buildSharedOnboardingPrompt(FIRST_ASKED_SLOT, null),
          currentStep: buildSharedOnboardingPrompt(FIRST_ASKED_SLOT, null),
          processStore: seedStore([]),
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
  return { mode: "triage" }
}
