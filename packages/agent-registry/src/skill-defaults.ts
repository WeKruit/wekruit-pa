/**
 * iter30 WS4-A — Migration metadata for the 6 EXISTING skills.
 *
 * Source of truth for the V2 fields seeded onto the existing 6
 * Firestore docs by the migration script
 * (`apps/functions/scripts/migrate-skills-v2.mjs`). Addenda + regexTriggers
 * are UNCHANGED from V1 — this file only carries the 8 new fields.
 *
 * Priority rationale (sparse 1-100 so WS4-B's 13 new skills can interpolate):
 *   - vent_support: 80 — wins all conflicts, emotional distress is hard veto.
 *   - motivation_nudge: 60 — between vent (80) and headhunter (40), specific
 *     but not crisis.
 *   - interview_prep: 55 — stance-aligned with headhunter, stacks cleanly.
 *   - negotiation: 50 — peer of interview_prep.
 *   - jd_roast: 45 — peer of headhunter, can stack with both.
 *   - headhunter: 40 — lowest of the 6, "ambient" mode, yields to anything
 *     more specific.
 *
 * Adam-lock crisis = 100, ambient = 30-, leaves headroom for new skills.
 */
import type { SkillKey } from "./skill-schema.js"
import type { RequiresCtxState } from "./skill-schema.js"

export type SkillMetadataV2 = {
  intentDescription: string
  provides: string[]
  requires: string[]
  requiresCtxState?: RequiresCtxState
  composableWith: SkillKey[]
  conflictsWith: SkillKey[]
  priority: number
  allowedTools: string[]
  llmInvokable: boolean
}

/**
 * V2 metadata for the 6 existing skills. Null entries = WS4-B authors
 * metadata + body for the 13 new skills.
 *
 * To re-seed: run `apps/functions/scripts/migrate-skills-v2.mjs --apply`.
 */
export const EXISTING_6_METADATA: Record<SkillKey, SkillMetadataV2 | null> = {
  headhunter: {
    intentDescription:
      "Activate when user signals job search / role change / 在看工作 / on the market. NOT for emotional distress; route vent_support if signs of burnout.",
    provides: ["stance:advisor", "tone:friend-roommate", "intent:job_search"],
    requires: [],
    composableWith: [
      "jd_roast",
      "interview_prep",
      "negotiation",
      "cv_followup",
      "referral_request",
    ],
    conflictsWith: ["vent_support"],
    priority: 40,
    allowedTools: ["set-matching-preferences", "find-match"],
    llmInvokable: true,
  },
  vent_support: {
    intentDescription:
      "Activate when user expresses emotional distress, burnout, breakdown, exhaustion, hopelessness, anxiety (zh+en). Do NOT activate when user is asking a factual question or in upbeat mood.",
    provides: ["stance:companion", "tone:vent", "mode:no_advice"],
    requires: [],
    composableWith: ["motivation_nudge", "silence_anchor", "interview_prep"],
    conflictsWith: ["headhunter", "jd_roast"],
    priority: 80,
    allowedTools: [],
    llmInvokable: true,
  },
  motivation_nudge: {
    intentDescription:
      "Activate when user signals procrastination, can't start, stuck, no motivation. Distinguish from vent: this is about action-paralysis, not emotional overload.",
    provides: ["stance:companion", "tone:nudge", "mode:smallest_action"],
    requires: [],
    composableWith: ["vent_support", "interview_prep"],
    conflictsWith: [],
    priority: 60,
    allowedTools: [],
    llmInvokable: true,
  },
  jd_roast: {
    intentDescription:
      "Activate when user shares a job description / asks for thoughts on a role / 帮我看 this JD / should I apply. Do NOT activate for general career chat.",
    provides: ["stance:advisor", "tone:friend-roommate", "mode:jd_review"],
    requires: [],
    composableWith: ["headhunter", "negotiation", "company_research"],
    conflictsWith: ["vent_support"],
    priority: 45,
    allowedTools: [],
    llmInvokable: true,
  },
  interview_prep: {
    intentDescription:
      "Activate when user mentions an upcoming interview, prep, nervousness about a specific round (system design / coding / behavioral).",
    provides: ["stance:companion", "tone:friend-roommate", "mode:interview_prep"],
    requires: [],
    composableWith: ["headhunter", "vent_support", "motivation_nudge"],
    conflictsWith: [],
    priority: 55,
    allowedTools: [],
    llmInvokable: true,
  },
  negotiation: {
    intentDescription:
      "Activate when user is comparing offers, asking how much to ask, counter-offer, 谈薪. Do NOT activate for early-stage role consideration.",
    provides: ["stance:advisor", "tone:friend-roommate", "mode:negotiation"],
    requires: [],
    composableWith: ["headhunter", "jd_roast", "post_offer_decision"],
    conflictsWith: ["vent_support"],
    priority: 50,
    allowedTools: [],
    llmInvokable: true,
  },
  // 13 new skills — null = WS4-B authors metadata + body
  rejection_processing: null,
  post_offer_decision: null,
  referral_request: null,
  silence_anchor: null,
  cv_followup: null,
  layoff_processing: null,
  company_research: null,
  career_pivot: null,
  return_to_work: null,
  daily_batch_reply: null,
  am_i_ai_check: null,
  boundary_test: null,
  mom_test: null,
  // iter30 final closure — proactive onboarding probe.
  //
  // Architecture: this skill is the ACTIVATION GATE; the 6Q content + state
  // machine lives in `packages/pa-orchestrator/src/onboarding.ts` (the
  // existing v2 chain extended with `ask_q_resume` step). The skill's only
  // job is to (a) activate ONLY when onboarding is incomplete via
  // `requiresCtxState.onboarding_completed=false`, (b) conflict with every
  // other skill so vent / headhunter / jd_roast can't hijack the
  // proactive-question turn, and (c) inject a tone-constraint addendum
  // (the literal Q phrase is injected by `composeOnboardingInput`).
  onboarding_probe: {
    intentDescription:
      "Activate when user has not completed onboarding (onboardingState != 'complete'). Drives the proactive 6-question chain (role → yoe → visa → startup-vs-corp → location → resume), one per turn. Skips entirely once onboarding is complete — never re-probes a returning user. Resets to active when __PA_RESET__ clears the user (clearUserMemory writes onboardingState=pending).",
    provides: ["stance:advisor", "tone:friend-roommate", "mode:onboarding_probe", "intent:onboarding"],
    requires: [],
    requiresCtxState: { onboarding_completed: false },
    composableWith: [],
    // Onboarding takes priority over EVERY skill — the orchestrator's
    // `composeOnboardingInput` already produces the exact directive line
    // for the current step, so other skills must not inject additional
    // addenda or LLM would produce a frankenturn (greeting + role-Q +
    // jd-roast tone all at once).
    conflictsWith: [
      "headhunter",
      "vent_support",
      "motivation_nudge",
      "jd_roast",
      "interview_prep",
      "negotiation",
      "rejection_processing",
      "post_offer_decision",
      "referral_request",
      "silence_anchor",
      "cv_followup",
      "layoff_processing",
      "company_research",
      "career_pivot",
      "return_to_work",
      "daily_batch_reply",
      "am_i_ai_check",
      "boundary_test",
      "mom_test",
    ],
    // Highest priority in the catalog. Crisis pseudo-skill (vent at 80) is
    // the floor for everything else; onboarding_probe sits ABOVE crisis
    // because we never want a brand-new user to be hijacked into vent
    // mirroring on turn 0 (intent-aware first_mes already routes vent
    // separately via INTENT_ACK_DIRECTIVES — onboarding_probe still wins
    // because composeOnboardingInput dispatches to the suspended branch
    // when ventLike fires).
    priority: 95,
    allowedTools: [],
    llmInvokable: true,
  },
}

/** Convenience helper: returns only keys with concrete V2 metadata. */
export function getExistingSkillMetadata(): Array<{
  key: SkillKey
  metadata: SkillMetadataV2
}> {
  return Object.entries(EXISTING_6_METADATA)
    .filter(
      (entry): entry is [SkillKey, SkillMetadataV2] => entry[1] !== null
    )
    .map(([key, metadata]) => ({ key, metadata }))
}
