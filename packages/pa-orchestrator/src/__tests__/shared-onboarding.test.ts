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

test("Hello, WeKruit! opener includes candidate id for phone binding", () => {
  assert.equal(buildHelloWekruitOpenerBody("abc_user_99"), "Hello, WeKruit! abc_user_99")
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

test("shared onboarding asks the five conversational questions in launch order", () => {
  assert.deepEqual(SHARED_ONBOARDING_QUESTIONS.map((q) => q.id), [
    "main_goal",
    "culture_stage",
    "industry_interest",
    "location_relocation",
    "special_context",
  ])
  assert.match(getSharedOnboardingQuestion("main_goal").prompt, /career growth, compensation, stability, mission, learning/i)
  assert.match(getSharedOnboardingQuestion("location_relocation").prompt, /remote, onsite, or relocating/i)
  assert.match(getSharedOnboardingQuestion("special_context").prompt, /constraints, strengths, dealbreakers, timing/i)
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
  assert.match(q4, /remote, onsite, or relocating/i)
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
  assert.match(opener, /https:\/\/candidate\.wekruit\.com\/me\/profile/i)
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

test("free-form answers produce memory evidence and confident tag patches", () => {
  const mainGoalRole = projectSharedOnboardingAnswer(
    "main_goal",
    "Growth and operations",
  )
  assert.deepEqual(mainGoalRole.tags.targetRoleFunction, ["marketing"])

  const industry = projectSharedOnboardingAnswer(
    "industry_interest",
    "Fintech, AI infrastructure, and maybe crypto infra are the sectors I keep coming back to.",
  )
  assert.match(industry.memoryFact, /Fintech, AI infrastructure/)
  assert.deepEqual(industry.tags.industrySector, [
    "artificial_intelligence_and_machine_learning",
    "financial_technology",
    "crypto_web3_blockchain",
  ])

  const roleLikeIndustry = projectSharedOnboardingAnswer(
    "industry_interest",
    "I would say marketing and product management.",
  )
  assert.deepEqual(roleLikeIndustry.tags.targetRoleFunction, [
    "product_management",
    "marketing",
  ])

  const location = projectSharedOnboardingAnswer(
    "location_relocation",
    "NYC or remote would be best, but I can relocate to Seattle for the right team.",
  )
  assert.deepEqual(location.tags.targetLocations, [
    "new_york_metro",
    "remote_united_states",
    "seattle_metro",
  ])
  assert.equal(location.evidence.relocationOpen, true)

  const misplacedIndustry = projectSharedOnboardingAnswer(
    "location_relocation",
    "I’m especially drawn to fashion/lifestyle, entertainment, gaming, media, and consumer brands.",
  )
  assert.deepEqual(misplacedIndustry.tags.industrySector, [
    "gaming_and_esports",
    "media_and_entertainment",
    "fashion_and_apparel",
    "consumer_goods",
  ])
})

test("recommendations become eligible only after Q5 is collected", () => {
  assert.deepEqual(resolveNextSharedOnboardingQuestionId("main_goal"), {
    nextQuestionId: "culture_stage",
    completed: false,
    shouldRecommend: false,
  })
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

test("special_context accepts realtime-communication answer without waiting on LLM", async () => {
  let llmCalls = 0
  const result = await judgeSharedOnboardingAnswer({
    questionId: "special_context",
    answer: "I've done a lot of realtime communication handling. Maybe worthy?",
    lang: "en",
    llmCallFactory: () => async () => {
      llmCalls += 1
      throw new Error("LLM should not be needed for this answer")
    },
  })

  assert.equal(llmCalls, 0)
  assert.equal(result.accept, true)
  if (result.accept) {
    assert.equal(result.value, "I've done a lot of realtime communication handling. Maybe worthy?")
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
