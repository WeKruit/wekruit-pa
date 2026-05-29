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
  resolveNextSharedOnboardingQuestionId,
  buildSharedOnboardingPrompt,
  SHARED_ONBOARDING_WORK_SESSION_KIND,
  type SharedOnboardingQuestionId,
} from "@pa/pa-orchestrator"
import type { ClaireMode } from "./types.js"
import { DEFAULT_ONBOARDING_SLOTS } from "./reducers/onboarding-fsm.js"
import { emptyProcessStore, type ProcessSessionStore } from "./tools/process-tools.js"

const USERS = "pa-users"
const PRESCREEN_SESSIONS = "pa-prescreen-sessions"

export interface ModeDecision {
  mode: ClaireMode
  /** when true, thin DEFERS this turn to the legacy path (an active prescreen exists). */
  deferToLegacy?: boolean
  /** active job id when deferring a prescreen turn (telemetry). */
  jobId?: string
  /** the question Claire should ask THIS turn (current onboarding slot's natural-language prompt). */
  pendingStep?: string
  /** the onboarding slot the inbound message answers (the agent records THIS slot). */
  onboardingSlot?: string
  /** false on the kickoff/bootstrap turn (ask only, do NOT record); true once a question was asked. */
  awaitingAnswer?: boolean
  /** per-turn process store seeded from durable state; injected as ctx.processStore. */
  processStore?: ProcessSessionStore
}

export interface SelectModeArgs {
  db: Firestore
  userId: string
  inboundText: string
  log?: (event: string, payload?: Record<string, unknown>) => void
  nowIso?: () => string
}

/** Is there a non-terminal prescreen session for this user? (active job interview → defer to legacy.) */
async function hasActivePrescreen(
  db: Firestore,
  userId: string,
): Promise<{ active: boolean; jobId?: string }> {
  try {
    const snap = await db
      .collection(PRESCREEN_SESSIONS)
      .where("userId", "==", userId)
      .where("terminal", "==", null)
      .limit(1)
      .get()
    if (snap.empty) return { active: false }
    const d = snap.docs[0]!.data() as Record<string, unknown>
    return { active: true, jobId: typeof d.jobId === "string" ? d.jobId : undefined }
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
          currentQuestionId: "main_goal",
          questionOrder: [...DEFAULT_ONBOARDING_SLOTS],
          answers: {},
          completed: false,
        },
        workSession: {
          kind: SHARED_ONBOARDING_WORK_SESSION_KIND,
          status: "active",
          startedAt: now,
          currentQuestionId: "main_goal",
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
 * Pick the mode for this turn from durable state + seed the process store. ALWAYS resolves
 * (never throws) — any read/write error degrades to triage so the turn still gets a reply.
 */
export async function selectClaireMode(args: SelectModeArgs): Promise<ModeDecision> {
  const log = args.log ?? (() => {})
  const now = (args.nowIso ?? (() => new Date().toISOString()))()

  // 1. ACTIVE PRESCREEN → defer to the legacy runner (prescreen-on-thin is the next slice).
  const ps = await hasActivePrescreen(args.db, args.userId)
  if (ps.active) {
    log("mode.prescreen_defer_legacy", { userId: args.userId, jobId: ps.jobId })
    return { mode: "prescreen", deferToLegacy: true, jobId: ps.jobId }
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
  if (!onboardingComplete) {
    try {
      if (!isSharedOnboardingActiveUser(user)) {
        // Cold start (e.g. just reinitialized): seed durable state + ask main_goal. The inbound is
        // the kickoff/greeting, NOT an answer → awaitingAnswer:false, the agent only asks.
        await bootstrapOnboarding(args.db, args.userId, now)
        log("mode.onboarding_bootstrap", { userId: args.userId })
        return {
          mode: "onboarding",
          awaitingAnswer: false,
          onboardingSlot: "main_goal",
          pendingStep: buildSharedOnboardingPrompt("main_goal", null),
          processStore: seedStore([]),
        }
      }
      // Active: a question was already asked → this inbound answers the current slot. The agent
      // records it (write-through tool), then asks the NEXT question. pendingStep is the NEXT
      // question (positional advance, matching the tool's resolver) so the agent-records path and
      // the deterministic net-records path BOTH leave the agent asking what durable now points to;
      // undefined on the last slot → the directive tells the agent to wrap up after recording.
      const cur = currentSharedOnboardingQuestionId(user) as SharedOnboardingQuestionId
      const answeredSlots = Object.keys((shared?.answers as Record<string, unknown>) ?? {})
      const next = resolveNextSharedOnboardingQuestionId(cur)
      log("mode.onboarding_active", { userId: args.userId, currentSlot: cur, next: next.nextQuestionId, answered: answeredSlots.length })
      return {
        mode: "onboarding",
        awaitingAnswer: true,
        onboardingSlot: cur,
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
