/**
 * Core regression sentinel — Adam 2026-05-19 voice polish plan §"No regressions".
 *
 * Voice / delivery / choreography are SIDE-EFFECT layers — they wrap compose
 * and outbound, but must NEVER change:
 *   - the slot router (resolveNextSharedOnboardingQuestionId)
 *   - the prompt context shape (buildSharedOnboardingPromptContext)
 *   - the answer judge tag projection (projectSharedOnboardingAnswer)
 *   - the canonical templated prompts (buildSharedOnboardingPrompt)
 *
 * This file exercises those four core surfaces under every plausible
 * combination of voice/delivery env flags. If a future voice patch
 * accidentally writes through to the core path, this test breaks first.
 */
import { strict as assert } from "node:assert"
import { afterEach, beforeEach, describe, it } from "node:test"

import {
  buildSharedOnboardingPrompt,
  buildSharedOnboardingPromptContext,
  projectSharedOnboardingAnswer,
  resolveNextSharedOnboardingQuestionId,
  resolveNextAskedSharedOnboardingQuestionId,
  resolveNextMissingSharedOnboardingQuestionId,
  SHARED_ONBOARDING_QUESTIONS,
  ALL_SHARED_ONBOARDING_QUESTIONS,
} from "../shared-onboarding.js"

describe("resolveNextMissingSharedOnboardingQuestionId (#3 ask-only-missing)", () => {
  it("skips industry_interest + location_relocation when extract-first already captured them", () => {
    // target_role inserted at index 2 (Adam 2026-05-30): after culture_stage the
    // positional resolver now asks target_role (NOT industry_interest). target_role
    // is onboarding-specific (the chat extractor can't auto-satisfy it), so the
    // ask-only-missing resolver also stops there — only industry_interest and
    // location_relocation are extractor-satisfiable. From target_role, with both of
    // those captured out-of-slot, the skip lands on seniority_comp, then special_context.
    const tags = {
      industrySector: ["financial_technology", "artificial_intelligence_and_machine_learning"],
      targetLocations: ["new_york", "remote"],
    }
    const positional = resolveNextSharedOnboardingQuestionId("culture_stage")
    assert.equal(positional.nextQuestionId, "target_role") // positional next is the new slot
    // target_role is never auto-satisfied → ask-only-missing stops there too.
    const missingFromCulture = resolveNextMissingSharedOnboardingQuestionId("culture_stage", tags, null)
    assert.equal(missingFromCulture.nextQuestionId, "target_role")
    // Once past target_role, both captured slots are skipped → seniority_comp.
    const missing = resolveNextMissingSharedOnboardingQuestionId("target_role", tags, null)
    assert.equal(missing.nextQuestionId, "seniority_comp") // skips both filled slots → next unfilled
  })

  it("does not skip slots the chat extractor cannot fill (main_goal / culture_stage always asked)", () => {
    const tags = { industrySector: ["financial_technology"], targetLocations: ["remote"] }
    // From main_goal, culture_stage is next — never auto-satisfied (not extractor-emittable).
    const r = resolveNextMissingSharedOnboardingQuestionId("main_goal", tags, null)
    assert.equal(r.nextQuestionId, "culture_stage")
  })

  it("falls back to positional order when no tags captured (legacy FULL-set walker)", () => {
    // resolveNextMissing… is the LEGACY (dead on thin) walker — it still traverses the FULL 7-slot
    // set, so with no tags captured it must equal the FULL positional order. We assert it over the
    // FULL set (ALL_SHARED_ONBOARDING_QUESTIONS), not the trimmed ASKED set. The thin-path positional
    // walker (resolveNextSharedOnboardingQuestionId, ASKED set) is covered separately below.
    const FULL_ORDER: Array<{ from: string; next: string | null }> = [
      { from: "main_goal", next: "culture_stage" },
      { from: "culture_stage", next: "target_role" },
      { from: "target_role", next: "industry_interest" },
      { from: "industry_interest", next: "location_relocation" },
      { from: "location_relocation", next: "seniority_comp" },
      { from: "seniority_comp", next: "special_context" },
      { from: "special_context", next: null },
    ]
    for (const step of FULL_ORDER) {
      const b = resolveNextMissingSharedOnboardingQuestionId(
        step.from as (typeof ALL_SHARED_ONBOARDING_QUESTIONS)[number]["id"],
        null,
        null,
      )
      assert.equal(b.nextQuestionId, step.next, `legacy FULL walker from=${step.from}`)
    }
  })
})

type FlagPermutation = {
  label: string
  env: Record<string, string | undefined>
}

const VOICE_FLAGS: readonly string[] = [
  "PA_SLANG_INJECTOR_DISABLED",
  "PA_REACTION_TAPBACK_DISABLED",
  "PA_SHARED_ONBOARDING_TEMPLATE_FALLBACK",
  "PA_CHOREO_ACK_RATE",
  "PA_IMPERFECTION_RATE",
]

const FLAG_PERMUTATIONS: readonly FlagPermutation[] = [
  {
    label: "all voice/delivery OFF",
    env: {
      PA_SLANG_INJECTOR_DISABLED: "true",
      PA_REACTION_TAPBACK_DISABLED: "true",
      PA_SHARED_ONBOARDING_TEMPLATE_FALLBACK: "true",
      PA_CHOREO_ACK_RATE: "0",
      PA_IMPERFECTION_RATE: "0",
    },
  },
  {
    label: "all voice/delivery ON",
    env: {
      PA_SLANG_INJECTOR_DISABLED: undefined,
      PA_REACTION_TAPBACK_DISABLED: undefined,
      PA_SHARED_ONBOARDING_TEMPLATE_FALLBACK: undefined,
      PA_CHOREO_ACK_RATE: "1",
      PA_IMPERFECTION_RATE: "1",
    },
  },
  {
    label: "mixed (slang ON, tapback OFF, choreo ON)",
    env: {
      PA_SLANG_INJECTOR_DISABLED: undefined,
      PA_REACTION_TAPBACK_DISABLED: "true",
      PA_SHARED_ONBOARDING_TEMPLATE_FALLBACK: undefined,
      PA_CHOREO_ACK_RATE: "0.5",
      PA_IMPERFECTION_RATE: "0.5",
    },
  },
]

let snapshot: Record<string, string | undefined> = {}

beforeEach(() => {
  snapshot = {}
  for (const flag of VOICE_FLAGS) {
    snapshot[flag] = process.env[flag]
  }
})

afterEach(() => {
  for (const flag of VOICE_FLAGS) {
    const prev = snapshot[flag]
    if (prev === undefined) delete process.env[flag]
    else process.env[flag] = prev
  }
})

function applyEnv(perm: FlagPermutation) {
  for (const [k, v] of Object.entries(perm.env)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

describe("shared onboarding core (router / state / judges) — flag-invariant", () => {
  // Baseline snapshots captured once with default env so each permutation
  // compares against the SAME canonical output. We run the baseline inside
  // the first permutation block to keep beforeEach/afterEach hygiene.
  type Baseline = {
    promptContext: Record<string, unknown>
    canonicalPrompts: Record<string, string>
    routerTransitions: Record<string, ReturnType<typeof resolveNextSharedOnboardingQuestionId>>
    judgements: Record<string, ReturnType<typeof projectSharedOnboardingAnswer>>
  }

  let baseline: Baseline | null = null

  function captureBaseline(): Baseline {
    const promptContext = buildSharedOnboardingPromptContext({
      user: {
        displayName: "Ada Lovelace",
        location: "New York, NY",
        layoffContext: { lastCompany: "Rain", jobTitle: "Backend Engineer" },
      },
      parsedResume: {
        candidateProfile: { skills: ["TypeScript", "Kubernetes", "Postgres"] },
        experiences: [
          { company: "Tesla", title: "Full Stack Engineer", location: "San Francisco" },
          { company: "Extend", title: "Backend Engineer", location: "New York" },
        ],
        industryTags: ["financial_technology", "developer_tools"],
      },
    }) as Record<string, unknown>

    // The LEGACY router (resolveNextSharedOnboardingQuestionId) + canonical prompts cover the FULL
    // 7-slot set, so exercise the FULL set here (the trim does not change the legacy walker).
    const canonicalPrompts: Record<string, string> = {}
    for (const q of ALL_SHARED_ONBOARDING_QUESTIONS) {
      canonicalPrompts[q.id] = buildSharedOnboardingPrompt(q.id, promptContext)
    }

    const routerTransitions: Record<string, ReturnType<typeof resolveNextSharedOnboardingQuestionId>> = {}
    for (const q of ALL_SHARED_ONBOARDING_QUESTIONS) {
      routerTransitions[q.id] = resolveNextSharedOnboardingQuestionId(q.id)
    }

    const judgements = {
      industry: projectSharedOnboardingAnswer(
        "industry_interest",
        "Fintech, AI infrastructure, and maybe crypto infra are the sectors I keep coming back to.",
      ),
      location: projectSharedOnboardingAnswer(
        "location_relocation",
        "NYC or remote would be best, but I can relocate to Seattle for the right team.",
      ),
      stage: projectSharedOnboardingAnswer(
        "culture_stage",
        "I like early-stage startups or scale-ups with high ownership.",
      ),
      goal: projectSharedOnboardingAnswer(
        "main_goal",
        "Career growth and learning, comp matters but not the main driver.",
      ),
    }

    return { promptContext, canonicalPrompts, routerTransitions, judgements }
  }

  for (const perm of FLAG_PERMUTATIONS) {
    it(`router/state/judge outputs are identical under ${perm.label}`, () => {
      applyEnv(perm)
      const current = captureBaseline()
      if (!baseline) {
        baseline = current
        // Sanity: ensure baseline itself contains meaningful canonical text (FULL-set coverage).
        assert.match(
          baseline.canonicalPrompts.main_goal!,
          /career growth, compensation, stability, mission, learning/i,
        )
        // special_context remains the terminal of the LEGACY full-set walker.
        assert.deepEqual(baseline.routerTransitions.special_context, {
          nextQuestionId: null,
          completed: true,
          shouldRecommend: true,
        })
        return
      }
      // Voice/delivery flags must not influence ANY of these surfaces.
      assert.deepEqual(current.promptContext, baseline.promptContext)
      assert.deepEqual(current.canonicalPrompts, baseline.canonicalPrompts)
      assert.deepEqual(current.routerTransitions, baseline.routerTransitions)
      assert.deepEqual(current.judgements, baseline.judgements)
    })
  }

  it("judge projection is deterministic for repeated identical inputs (no random tag drift)", () => {
    const a = projectSharedOnboardingAnswer(
      "industry_interest",
      "Fintech, AI infrastructure, and maybe crypto infra are the sectors I keep coming back to.",
    )
    const b = projectSharedOnboardingAnswer(
      "industry_interest",
      "Fintech, AI infrastructure, and maybe crypto infra are the sectors I keep coming back to.",
    )
    assert.deepEqual(a, b)
  })

  it("LEGACY router transitions form the FULL chain main_goal → culture_stage → … → special_context → done (unchanged by the trim)", () => {
    const expected: Array<{
      from: (typeof ALL_SHARED_ONBOARDING_QUESTIONS)[number]["id"]
      next: (typeof ALL_SHARED_ONBOARDING_QUESTIONS)[number]["id"] | null
    }> = [
      { from: "main_goal", next: "culture_stage" },
      { from: "culture_stage", next: "target_role" },
      { from: "target_role", next: "industry_interest" },
      { from: "industry_interest", next: "location_relocation" },
      { from: "location_relocation", next: "seniority_comp" },
      { from: "seniority_comp", next: "special_context" },
      { from: "special_context", next: null },
    ]
    for (const step of expected) {
      const result = resolveNextSharedOnboardingQuestionId(step.from)
      assert.equal(result.nextQuestionId, step.next, `from=${step.from}`)
    }
  })

  it("THIN ASKED router transitions form the trimmed chain target_role → location_relocation → done + rescue (2026-06-02 trim)", () => {
    // The ASKED upfront flow is exactly the two hard-filter slots.
    assert.deepEqual(SHARED_ONBOARDING_QUESTIONS.map((q) => q.id), ["target_role", "location_relocation"])
    // The thin-path positional walker (resolveNextAsked…) traverses ONLY the two ASKED hard-filter slots.
    assert.equal(resolveNextAskedSharedOnboardingQuestionId("target_role").nextQuestionId, "location_relocation")
    const term = resolveNextAskedSharedOnboardingQuestionId("location_relocation")
    assert.equal(term.nextQuestionId, null)
    assert.equal(term.completed, true)
    // In-flight rescue: a now-dropped stored slot resolves back to the first ASKED slot (target_role),
    // never null/stall — so an in-flight user re-asks at most one short slot.
    for (const dropped of ["main_goal", "culture_stage", "industry_interest", "seniority_comp", "special_context"] as const) {
      assert.equal(resolveNextAskedSharedOnboardingQuestionId(dropped).nextQuestionId, "target_role", `rescue from=${dropped}`)
    }
  })
})
