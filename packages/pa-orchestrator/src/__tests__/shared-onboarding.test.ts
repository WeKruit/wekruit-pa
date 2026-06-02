import assert from "node:assert/strict"
import test from "node:test"

import {
  buildSharedOnboardingOpeningPrompt,
  buildSharedOnboardingPostPrescreenOpeningPrompt,
  buildHelloWekruitOpenerBody,
  parseHelloWekruitOpener,
  SHARED_ONBOARDING_QUESTIONS,
  buildSharedOnboardingPrompt,
  buildSharedOnboardingPromptContext,
  buildSharedOnboardingStartedState,
  getSharedOnboardingQuestion,
  judgeSharedOnboardingAnswer,
  projectSharedOnboardingAnswer,
  resolveNextSharedOnboardingQuestionId,
  shouldIgnoreSharedOnboardingDuplicateKickoff,
  shouldSharedOnboardingAdvanceDespiteJudge,
  sharedOnboardingSignupSource,
} from "../shared-onboarding.js"
import { WEKRUIT_CANDIDATE_SOURCE, WEKRUIT_LAYOFF_SOURCE } from "../onboarding.js"

test("verification-code opener includes candidate id for phone binding", () => {
  assert.equal(
    buildHelloWekruitOpenerBody("abc_user_99"),
    "Hi, WeKruit, my verification code is abc_user_99",
  )
  assert.deepEqual(
    parseHelloWekruitOpener("Hi, WeKruit, my verification code is abc_user_99"),
    { candidateId: "abc_user_99" },
  )
  // bare opener (no token) → no candidate id
  assert.equal(parseHelloWekruitOpener("Hi, WeKruit, my verification code is"), null)
})

test("legacy Hello, WeKruit! opener still parses (back-compat for in-flight QR links)", () => {
  assert.deepEqual(parseHelloWekruitOpener("Hello, WeKruit! abc_user_99"), { candidateId: "abc_user_99" })
  assert.equal(parseHelloWekruitOpener("Hello, WeKruit!"), null)
})

test("job interview opener binds the inbound phone to the candidate id", () => {
  assert.deepEqual(
    parseHelloWekruitOpener("WeKruit_photon-macos-devops_abc_user_99_Job"),
    { candidateId: "abc_user_99" },
  )
  assert.deepEqual(
    parseHelloWekruitOpener("Wekruit_photon-macos-devops_abc-user-99_Job"),
    { candidateId: "abc-user-99" },
  )
})

test("shared onboarding asks the seven conversational questions in launch order", () => {
  assert.deepEqual(SHARED_ONBOARDING_QUESTIONS.map((q) => q.id), [
    "main_goal",
    "culture_stage",
    "target_role",
    "industry_interest",
    "location_relocation",
    "seniority_comp",
    "special_context",
  ])
  assert.match(getSharedOnboardingQuestion("main_goal").prompt, /career growth, compensation, stability, mission, learning/i)
  // target_role (Adam 2026-05-30): confirm forward role intent (résumé only
  // seeds targetRoleFunction from history; this asks what they want NEXT).
  assert.match(getSharedOnboardingQuestion("target_role").prompt, /what kind of roles are you going for next/i)
  assert.match(getSharedOnboardingQuestion("target_role").prompt, /product, data, or design/i)
  assert.match(getSharedOnboardingQuestion("location_relocation").prompt, /remote within the US, onsite, or relocating/i)
  // seniority_comp (Adam 2026-05-30): one warm question covering intern-vs-full-time +
  // seniority + expected salary + whether those are negotiable or firm.
  assert.match(getSharedOnboardingQuestion("seniority_comp").prompt, /internships or full-time/i)
  assert.match(getSharedOnboardingQuestion("seniority_comp").prompt, /salary/i)
  assert.match(getSharedOnboardingQuestion("seniority_comp").prompt, /flexible\/negotiable or pretty firm/i)
  assert.match(getSharedOnboardingQuestion("special_context").prompt, /non-negotiables/i)
  assert.doesNotMatch(
    getSharedOnboardingQuestion("special_context").prompt,
    /constraints, strengths, dealbreakers, timing/i,
  )
  assert.doesNotMatch(
    SHARED_ONBOARDING_QUESTIONS.map((q) => q.prompt).join("\n"),
    /email|e-mail|what email|why are you looking/i,
  )
})

test("normal and laid-off website starts create the same shared SMS onboarding state", () => {
  const layoff = buildSharedOnboardingStartedState("2026-05-18T20:00:00.000Z", WEKRUIT_LAYOFF_SOURCE)
  const candidate = buildSharedOnboardingStartedState("2026-05-18T20:00:00.000Z", WEKRUIT_CANDIDATE_SOURCE)

  assert.equal((layoff.workSession as Record<string, unknown>).kind, "shared_onboarding")
  assert.equal((candidate.workSession as Record<string, unknown>).kind, "shared_onboarding")
  assert.equal((layoff.workSession as Record<string, unknown>).currentQuestionId, "main_goal")
  assert.equal((candidate.workSession as Record<string, unknown>).currentQuestionId, "main_goal")
  assert.equal((layoff.sharedOnboarding as Record<string, unknown>).source, WEKRUIT_LAYOFF_SOURCE)
  assert.equal((candidate.sharedOnboarding as Record<string, unknown>).source, WEKRUIT_CANDIDATE_SOURCE)
})

test("shared onboarding prompts ground Q1 and Q4 in resume/profile context when available", () => {
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
  })

  const q1 = buildSharedOnboardingPrompt("main_goal", promptContext)
  assert.match(q1, /Hey Ada/i)
  assert.match(q1, /resume/i)
  assert.match(q1, /Backend Engineer/i)
  assert.match(q1, /Rain/i)
  assert.match(q1, /career growth, compensation, stability, mission, learning/i)

  const q3 = buildSharedOnboardingPrompt("industry_interest", promptContext)
  assert.match(q3, /financial technology/i)
  assert.doesNotMatch(q3, /financial_technology|developer_tools/i)
  assert.match(q3, /actually most interested/i)

  const q4 = buildSharedOnboardingPrompt("location_relocation", promptContext)
  assert.match(q4, /New York, NY/i)
  assert.match(q4, /remote within the US, onsite, or open to relocating/i)
})

test("shared onboarding opening prompt carries Claire persona guidance without changing the opener token", () => {
  const promptContext = buildSharedOnboardingPromptContext({
    user: {
      displayName: "Sarah Chen",
      location: "Brooklyn, NY",
      candidateContext: { location: "Brooklyn, NY" },
    },
    parsedResume: {
      candidateProfile: { skills: ["Product Design", "Research"] },
      experiences: [
        { company: "Figma", title: "Product Designer", location: "Brooklyn" },
      ],
      industryTags: ["software_and_saas"],
    },
  })

  const opener = buildSharedOnboardingOpeningPrompt(promptContext)

  assert.deepEqual(parseHelloWekruitOpener("Hello, WeKruit! abc_user_99"), { candidateId: "abc_user_99" })
  assert.match(opener, /Hey Sarah/i)
  assert.match(opener, /Product Designer/i)
  assert.match(opener, /Brooklyn/i)
  assert.match(opener, /Figma/i)
  assert.match(opener, /hiring manager/i)
  assert.match(opener, /Before I match roles/i)
  assert.match(opener, /https:\/\/wekruit\.com\/me\/profile/i)
  assert.match(opener, /just tell me here/i)
  assert.match(opener, /career growth, compensation, stability, mission, learning/i)
  assert.doesNotMatch(opener, /I am Claire|How may I assist|software_and_saas|job_title|tech_swe|timeline|dealbreaker/i)
})

test("post-prescreen opening prompt thanks for the role screen and avoids first-time resume copy", () => {
  const promptContext = buildSharedOnboardingPromptContext({
    user: {
      displayName: "Sunny Li",
      candidateContext: { location: "Chicago" },
    },
    parsedResume: {
      experiences: [
        { company: "YouTube", title: "Digital Content Creator", location: "Chicago" },
      ],
    },
  })

  const opener = buildSharedOnboardingPostPrescreenOpeningPrompt(promptContext, {
    jobTitle: "Member of Technical Staff, macOS DevOps",
    company: "Photon",
  })

  assert.match(opener, /completing the role screen/i)
  assert.match(opener, /Member of Technical Staff, macOS DevOps/i)
  assert.match(opener, /Photon/i)
  assert.match(opener, /career growth, compensation, stability, mission, learning/i)
  assert.doesNotMatch(opener, /Saw your resume come through/i)
})

test("NO-REGEX: projector carries ONLY the LLM's validated canonical tags (no text classification)", () => {
  // Without LLM-provided tags, the projector classifies NOTHING from free text —
  // it only produces the memory fact + raw-answer bookkeeping. (Regex projector removed 2026-05-30.)
  const noTags = projectSharedOnboardingAnswer(
    "industry_interest",
    "Fintech, AI infrastructure, and maybe crypto infra are the sectors I keep coming back to.",
  )
  assert.match(noTags.memoryFact, /Fintech, AI infrastructure/)
  assert.deepEqual(noTags.tags, {}, "no LLM tags → no tags classified from text")

  // WITH LLM-provided canonical picks, the projector validates them against the
  // shared-tags vocab and passes them through. Multi-value = OR.
  const industry = projectSharedOnboardingAnswer(
    "industry_interest",
    "Fintech, AI infrastructure, and maybe crypto infra.",
    {
      industrySector: [
        "artificial_intelligence_and_machine_learning",
        "financial_technology",
        "crypto_web3_blockchain",
      ],
    },
  )
  assert.deepEqual(industry.tags.industrySector, [
    "artificial_intelligence_and_machine_learning",
    "financial_technology",
    "crypto_web3_blockchain",
  ])
  assert.deepEqual(industry.statedPreferences.industrySector, industry.tags.industrySector)

  // OR multi-pick on companySize: "a small startup or big tech".
  const culture = projectSharedOnboardingAnswer(
    "culture_stage",
    "I'd take a small startup or big tech.",
    { companySize: ["early_startup", "enterprise"] },
  )
  assert.deepEqual(culture.tags.companySize, ["early_startup", "enterprise"])

  // Off-vocab LLM picks are DROPPED (never coerced/pattern-matched).
  const offVocab = projectSharedOnboardingAnswer(
    "industry_interest",
    "robots and stuff",
    { industrySector: ["not_a_real_sector", "financial_technology"] },
  )
  assert.deepEqual(offVocab.tags.industrySector, ["financial_technology"])

  // Locations are free-form normalized tokens (OR), no regex ordering.
  const location = projectSharedOnboardingAnswer(
    "location_relocation",
    "NYC or remote, could do Seattle.",
    { targetLocations: ["new_york", "remote", "seattle"] },
  )
  assert.deepEqual(location.tags.targetLocations, ["new_york", "remote", "seattle"])

  // visaStatus single canonical enum passes through.
  const special = projectSharedOnboardingAnswer(
    "special_context",
    "I need H1B sponsorship and want at least 140k.",
    { visaStatus: "sponsor_needed", minSalary: 140000 },
  )
  assert.equal((special.tags as { visaStatus?: string }).visaStatus, "sponsor_needed")
  assert.equal(special.tags.minSalary, 140000)
  assert.equal(special.statedPreferences.specialContext, "I need H1B sponsorship and want at least 140k.")
})

test("live-bug capture fix: Q4 open-to-anything → anywhere bypass on both axes; Q5 visa + salary floor", () => {
  // Q4 "open to anything" with no concrete place previously captured NOTHING →
  // empty targetLocations → V16 location hard filter over-filtered to recCount=0.
  const anywhere = projectSharedOnboardingAnswer(
    "location_relocation",
    "honestly i'm open to anything, wherever the right role is",
  )
  assert.ok(
    (anywhere.tags.targetLocations ?? []).includes("anywhere"),
    "open-to-anything must emit the 'anywhere' bypass token on targetLocations",
  )
  assert.ok(
    (anywhere.tags.targetCountry ?? []).includes("anywhere"),
    "open-to-anything must emit 'anywhere' on targetCountry too",
  )

  // A named country → canonical lowercase region token.
  const usa = projectSharedOnboardingAnswer("location_relocation", "USA, open to anywhere in the states")
  assert.ok((usa.tags.targetCountry ?? []).includes("usa"))

  // Concrete-only answer must NOT emit anywhere.
  const concrete = projectSharedOnboardingAnswer("location_relocation", "just NYC for me")
  assert.ok(!(concrete.tags.targetLocations ?? []).includes("anywhere"))

  // Q5 "I need H1B sponsorship" previously only set a visa_context LABEL — V16's
  // visa hard filter reads tags.visaStatus, so the sponsorship intent was lost.
  const visa = projectSharedOnboardingAnswer("special_context", "I'll need H1B sponsorship to keep working here")
  assert.equal(visa.tags.visaStatus, "sponsor_needed")
  // Keep the context label too.
  assert.ok((visa.tags.targetCompanyTags ?? []).includes("visa_context"))

  // Q5 explicit salary floor (intent) → tags.minSalary (V16 salary fit).
  const salary = projectSharedOnboardingAnswer("special_context", "looking for at least 120k base, below that is a no")
  assert.equal(salary.tags.minSalary, 120000)
})

test("recommendations become eligible only after the final slot is collected", () => {
  // main_goal still hands off to culture_stage (indices 0→1 unchanged).
  assert.deepEqual(resolveNextSharedOnboardingQuestionId("main_goal"), {
    nextQuestionId: "culture_stage",
    completed: false,
    shouldRecommend: false,
  })
  // location_relocation now hands off to the new seniority_comp slot (Adam 2026-05-30).
  assert.deepEqual(resolveNextSharedOnboardingQuestionId("location_relocation"), {
    nextQuestionId: "seniority_comp",
    completed: false,
    shouldRecommend: false,
  })
  // special_context remains the terminal slot — completing it unlocks recs.
  assert.deepEqual(resolveNextSharedOnboardingQuestionId("special_context"), {
    nextQuestionId: null,
    completed: true,
    shouldRecommend: true,
  })
})

test("shared onboarding never re-asks — judge rejections still advance except Q1 duplicate hello", () => {
  assert.equal(shouldIgnoreSharedOnboardingDuplicateKickoff("main_goal", "hey"), true)
  assert.equal(shouldSharedOnboardingAdvanceDespiteJudge("main_goal", "hey"), false)
  assert.equal(
    shouldSharedOnboardingAdvanceDespiteJudge(
      "special_context",
      "I've done a lot of realtime communication handling",
    ),
    true,
  )
})

test("special_context accepts a substantive answer via the LLM judge", async () => {
  // NO-REGEX (2026-05-30): the bloom-filter accept shortcut was removed, so the
  // judge is LLM-only. The LLM returns a `provided` intent here; the raw answer
  // is preserved as the value.
  let llmCalls = 0
  const answer = "I've done a lot of realtime communication handling. Maybe worthy?"
  const result = await judgeSharedOnboardingAnswer({
    questionId: "special_context",
    answer,
    lang: "en",
    llmCallFactory: () => async () => {
      llmCalls += 1
      return JSON.stringify({ intent: "provided", value: answer, confidence: 0.95 })
    },
  })

  assert.equal(llmCalls, 1)
  assert.equal(result.accept, true)
  if (result.accept) {
    assert.equal(result.value, answer)
  }
})

test("special_context fail-opens to accept a substantive answer when the LLM is unavailable", async () => {
  // failOpenOnLlmError keeps the FSM from stalling: an LLM error still accepts a
  // substantive reply so the slot advances (no re-ask loop).
  const answer = "I've done a lot of realtime communication handling. Maybe worthy?"
  const result = await judgeSharedOnboardingAnswer({
    questionId: "special_context",
    answer,
    lang: "en",
    llmCallFactory: () => async () => {
      throw new Error("LLM unavailable")
    },
  })

  assert.equal(result.accept, true)
  if (result.accept) {
    assert.equal(result.value, answer)
  }
})

test("sharedOnboardingSignupSource: explicit WeKruit_Laid_Off opts into layoff", () => {
  assert.equal(sharedOnboardingSignupSource(WEKRUIT_LAYOFF_SOURCE), WEKRUIT_LAYOFF_SOURCE)
})

test("sharedOnboardingSignupSource: explicit candidate stays candidate", () => {
  assert.equal(sharedOnboardingSignupSource(WEKRUIT_CANDIDATE_SOURCE), WEKRUIT_CANDIDATE_SOURCE)
})

test("sharedOnboardingSignupSource: layoffhedge defaults to candidate", () => {
  assert.equal(sharedOnboardingSignupSource("layoffhedge"), WEKRUIT_CANDIDATE_SOURCE)
})

test("sharedOnboardingSignupSource: undefined defaults to candidate (post-fix)", () => {
  assert.equal(sharedOnboardingSignupSource(undefined), WEKRUIT_CANDIDATE_SOURCE)
})

test("sharedOnboardingSignupSource: garbage defaults to candidate", () => {
  assert.equal(sharedOnboardingSignupSource("totally-not-a-source"), WEKRUIT_CANDIDATE_SOURCE)
})
