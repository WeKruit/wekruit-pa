import assert from "node:assert/strict"
import test from "node:test"

import {
  buildSharedOnboardingOpeningPrompt,
  buildSharedOnboardingPostPrescreenOpeningPrompt,
  buildHelloWekruitOpenerBody,
  buildBindCodeOpenerBody,
  parseHelloWekruitOpener,
  isBindCode,
  normalizeBindCode,
  BIND_CODE_ALPHABET,
  BIND_CODE_LENGTH,
  buildLinkedinDoneOpenerBody,
  parseLinkedinDoneOpener,
  buildConnectLinkedinUrl,
  isSharedOnboardingGreetingOrKickoff,
  LINKEDIN_DONE_OPENER_PREFIX,
  SHARED_ONBOARDING_QUESTIONS,
  ALL_SHARED_ONBOARDING_QUESTIONS,
  buildSharedOnboardingPrompt,
  buildSharedOnboardingPromptContext,
  buildSharedOnboardingStartedState,
  getSharedOnboardingQuestion,
  judgeSharedOnboardingAnswer,
  projectSharedOnboardingAnswer,
  resolveNextSharedOnboardingQuestionId,
  resolveNextAskedSharedOnboardingQuestionId,
  resolveNextAskedMissingSharedOnboardingQuestionId,
  isSharedOnboardingSlotSatisfied,
  shouldIgnoreSharedOnboardingDuplicateKickoff,
  shouldSharedOnboardingAdvanceDespiteJudge,
  sharedOnboardingSignupSource,
} from "../shared-onboarding.js"
import { WEKRUIT_CANDIDATE_SOURCE, WEKRUIT_LAYOFF_SOURCE } from "../onboarding.js"

test("start-greeting opener (2026-06-02 #2) includes candidate id for phone binding", () => {
  assert.equal(buildHelloWekruitOpenerBody("abc_user_99"), "Hi, WeKruit! abc_user_99")
  assert.deepEqual(parseHelloWekruitOpener("Hi, WeKruit! abc_user_99"), { candidateId: "abc_user_99" })
  // bare opener (no token) → no candidate id
  assert.equal(parseHelloWekruitOpener("Hi, WeKruit!"), null)
})

test("back-compat openers still parse (in-flight QR links from prior prints)", () => {
  // 2026-06-02 #1 verification-code phrasing
  assert.deepEqual(parseHelloWekruitOpener("Hi, WeKruit, my verification code is abc_user_99"), {
    candidateId: "abc_user_99",
  })
  assert.equal(parseHelloWekruitOpener("Hi, WeKruit, my verification code is"), null)
  // original Hello, WeKruit! phrasing
  assert.deepEqual(parseHelloWekruitOpener("Hello, WeKruit! abc_user_99"), { candidateId: "abc_user_99" })
  assert.equal(parseHelloWekruitOpener("Hello, WeKruit!"), null)
})

test("LEGACY job interview opener (job+uid) still binds the inbound phone to the candidate id", () => {
  assert.deepEqual(
    parseHelloWekruitOpener("WeKruit_photon-macos-devops_abc_user_99_Job"),
    { candidateId: "abc_user_99" },
  )
  assert.deepEqual(
    parseHelloWekruitOpener("Wekruit_photon-macos-devops_abc-user-99_Job"),
    { candidateId: "abc-user-99" },
  )
})

test("NEW job-only opener (no uid → phone-is-auth) parses to null candidateId but IS a kickoff", () => {
  // Job-only token: identity comes from the inbound phone, not the token. The
  // candidateId parser returns null (no uid to extract) — the phone resolves
  // the candidate downstream.
  assert.equal(parseHelloWekruitOpener("WeKruit_photon-macos-devops_Job"), null)
  assert.equal(parseHelloWekruitOpener("WeKruit_hs-10996795-invoko-product-manager_Job"), null)
  // It must still classify as a kickoff/greeting (never a stray slot answer).
  assert.equal(isSharedOnboardingGreetingOrKickoff("WeKruit_photon-macos-devops_Job"), true)
  // And the legacy job+uid form is a kickoff too.
  assert.equal(isSharedOnboardingGreetingOrKickoff("WeKruit_photon-macos-devops_abc_user_99_Job"), true)
})

// ───────────────────────── transit-safe bind code (2026-06-13) ──────────────

test("bind-code alphabet excludes ALL ambiguous glyphs (I, L, O, U, 0, 1)", () => {
  for (const bad of ["I", "L", "O", "U", "0", "1"]) {
    assert.equal(BIND_CODE_ALPHABET.includes(bad), false, `alphabet must not contain ${bad}`)
  }
  assert.equal(BIND_CODE_LENGTH, 8)
})

test("buildBindCodeOpenerBody carries the CODE (not a uid) and keeps back-compat wording", () => {
  const body = buildBindCodeOpenerBody("ABCD2345")
  assert.equal(body, "Hi, WeKruit, my verification code is ABCD2345")
  // round-trips: the parser sees a bind CODE, never a candidateId.
  assert.deepEqual(parseHelloWekruitOpener(body), { bindCode: "ABCD2345" })
  // empty → bare prefix, no dangling token.
  assert.equal(buildBindCodeOpenerBody(""), "Hi, WeKruit, my verification code is")
})

test("parser classifies the 8-char Crockford shape as a bindCode, NOT a candidateId", () => {
  const parsed = parseHelloWekruitOpener("Hi, WeKruit, my verification code is GHJK2345")
  assert.deepEqual(parsed, { bindCode: "GHJK2345" })
  assert.equal(parsed?.candidateId, undefined)
})

test("raw Firebase push-id uids still parse as candidateId (back-compat), never as a bindCode", () => {
  // 20-char push id with `-`/`_` — never collides with the strict 8-char shape.
  const uid = "aBcD-1eFgH_2iJkLmNoP"
  assert.deepEqual(parseHelloWekruitOpener(`Hi, WeKruit, my verification code is ${uid}`), {
    candidateId: uid,
  })
  // legacy build path output also stays a candidateId.
  assert.deepEqual(parseHelloWekruitOpener(buildHelloWekruitOpenerBody(uid)), { candidateId: uid })
})

test("normalize: strips whitespace + uppercases; never remaps excluded glyphs", () => {
  assert.equal(normalizeBindCode(" abcd 2345 "), "ABCD2345")
  assert.equal(isBindCode("abcd2345"), true) // lowercased input normalizes to a valid code
  // A corrupted code that introduces an EXCLUDED glyph (e.g. O for 0, l for 1)
  // is NOT remapped → it simply fails the shape check → no match downstream.
  assert.equal(isBindCode("ABCD234O"), false) // contains O (excluded)
  assert.equal(isBindCode("ABCD234l"), false) // contains L (excluded, case-insensitive)
  assert.equal(isBindCode("ABCD2345X9"), false) // wrong length
  assert.equal(isBindCode("ABCD-345"), false) // hyphen not in alphabet
})

test("a bind-code opener is a kickoff/greeting (never a slot answer)", () => {
  assert.equal(
    isSharedOnboardingGreetingOrKickoff("Hi, WeKruit, my verification code is ABCD2345"),
    true,
  )
})

test("LinkedIn-done re-entry marker round-trips the connect TOKEN (not a candidateId)", () => {
  const token = "li_connect_tok_abcdef"
  const body = buildLinkedinDoneOpenerBody(token)
  assert.equal(body, `${LINKEDIN_DONE_OPENER_PREFIX} ${token}`)
  assert.deepEqual(parseLinkedinDoneOpener(body), { token })
  // case/apostrophe-insensitive, optional colon, bare phrase (no token).
  assert.deepEqual(parseLinkedinDoneOpener("Ive done linkedin submission li_connect_tok_abcdef"), {
    token,
  })
  assert.deepEqual(parseLinkedinDoneOpener("I've done LinkedIn submission"), { token: "" })
  assert.equal(buildLinkedinDoneOpenerBody(""), LINKEDIN_DONE_OPENER_PREFIX)
})

test("LinkedIn-done marker does NOT collide with the candidateId opener parser", () => {
  // The marker token must NEVER be routed through parseHelloWekruitOpener as a uid.
  assert.equal(parseHelloWekruitOpener("I've done LinkedIn submission li_connect_tok_abcdef"), null)
  // Non-marker text is not a LinkedIn-done marker.
  assert.equal(parseLinkedinDoneOpener("Hi, WeKruit! abc_user_99"), null)
  assert.equal(parseLinkedinDoneOpener("hello there"), null)
})

test("LinkedIn-done marker counts as a kickoff/greeting (never a slot answer)", () => {
  assert.equal(isSharedOnboardingGreetingOrKickoff("I've done LinkedIn submission li_connect_tok_abcdef"), true)
  assert.equal(isSharedOnboardingGreetingOrKickoff("Ive done linkedin submission"), true)
})

test("LinkedIn-done marker is dropped on Q1 + never advances the slot (no token leak as an answer)", async () => {
  // Because the marker is a kickoff/greeting, the Q1 (main_goal) duplicate-hello
  // guard ignores it: it neither advances the slot nor gets stored as an answer.
  assert.equal(
    shouldIgnoreSharedOnboardingDuplicateKickoff("main_goal", "I've done LinkedIn submission li_connect_tok_abcdef"),
    true,
  )
  assert.equal(
    shouldSharedOnboardingAdvanceDespiteJudge("main_goal", "I've done LinkedIn submission li_connect_tok_abcdef"),
    false,
  )
  // And the LLM answer-judge rejects it as irrelevant WITHOUT ever calling the
  // model — so the connect token never reaches an LLM as candidate-supplied text.
  let llmCalls = 0
  const judged = await judgeSharedOnboardingAnswer({
    questionId: "special_context",
    answer: "I've done LinkedIn submission li_connect_tok_abcdef",
    lang: "en",
    llmCallFactory: () => async () => {
      llmCalls += 1
      return JSON.stringify({ intent: "provided", value: "x", confidence: 0.9 })
    },
  })
  assert.equal(judged.accept, false)
  assert.equal(llmCalls, 0, "marker is filtered before any LLM call — token never leaks to the model")
})

test("buildConnectLinkedinUrl emits an apex-domain connect link", () => {
  assert.equal(
    buildConnectLinkedinUrl("tok_abc"),
    "https://wekruit.com/connect-linkedin?token=tok_abc",
  )
  assert.equal(buildConnectLinkedinUrl(""), "https://wekruit.com/connect-linkedin")
})

test("shared onboarding asks ONLY the two hard-filter questions upfront (2026-06-02 trim)", () => {
  // Adam #1 friction ("too many questions / minimal upfront / super easy to start"): the ASKED
  // flow is now ONLY the two HARD-filter axes — target_role (forward intent + warm opener) then
  // location_relocation (targetLocations + the only place US-only is surfaced).
  assert.deepEqual(SHARED_ONBOARDING_QUESTIONS.map((q) => q.id), [
    "target_role",
    "location_relocation",
  ])
  // target_role (Adam 2026-05-30): confirm forward role intent (résumé only seeds
  // targetRoleFunction from history; this asks what they want NEXT). Now the FIRST asked slot.
  assert.match(getSharedOnboardingQuestion("target_role").prompt, /what kind of roles are you going for next/i)
  assert.match(getSharedOnboardingQuestion("target_role").prompt, /product, data, or design/i)
  assert.match(getSharedOnboardingQuestion("location_relocation").prompt, /remote within the US, onsite, or relocating/i)
  assert.doesNotMatch(
    SHARED_ONBOARDING_QUESTIONS.map((q) => q.prompt).join("\n"),
    /email|e-mail|what email|why are you looking/i,
  )
})

test("ALL 7 question definitions stay resolvable via the map (in-flight migration safety)", () => {
  // KEYSTONE: the 5 dropped slots (main_goal / culture_stage / industry_interest / seniority_comp /
  // special_context) are no longer ASKED but MUST still resolve a prompt — an in-flight user whose
  // durable currentQuestionId is one of them cannot stall. getSharedOnboardingQuestion reads the FULL
  // map, so every one resolves.
  assert.deepEqual(ALL_SHARED_ONBOARDING_QUESTIONS.map((q) => q.id), [
    "main_goal",
    "culture_stage",
    "target_role",
    "industry_interest",
    "location_relocation",
    "seniority_comp",
    "special_context",
  ])
  for (const id of ["main_goal", "culture_stage", "industry_interest", "seniority_comp", "special_context"] as const) {
    assert.ok(getSharedOnboardingQuestion(id).prompt.length > 0, `${id} still resolves a prompt`)
  }
  assert.match(getSharedOnboardingQuestion("main_goal").prompt, /career growth, compensation, stability, mission, learning/i)
  assert.match(getSharedOnboardingQuestion("seniority_comp").prompt, /internships or full-time/i)
  assert.match(getSharedOnboardingQuestion("special_context").prompt, /non-negotiables/i)
})

test("normal and laid-off website starts create the same shared SMS onboarding state", () => {
  const layoff = buildSharedOnboardingStartedState("2026-05-18T20:00:00.000Z", WEKRUIT_LAYOFF_SOURCE)
  const candidate = buildSharedOnboardingStartedState("2026-05-18T20:00:00.000Z", WEKRUIT_CANDIDATE_SOURCE)

  assert.equal((layoff.workSession as Record<string, unknown>).kind, "shared_onboarding")
  assert.equal((candidate.workSession as Record<string, unknown>).kind, "shared_onboarding")
  // buildSharedOnboardingStartedState is the LEGACY website-start seeder — still seeds main_goal
  // (the legacy deterministic flow walks the FULL 7-slot set). The thin trim lives in the thin
  // cold-start (mode-selector) + the ASKED SHARED_ONBOARDING_QUESTIONS, not this legacy seeder.
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
  // LEGACY website-start opener leads with main_goal (the thin path uses its own PART-2 pitch).
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
  // LEGACY post-prescreen opener leads with main_goal.
  assert.match(opener, /career growth, compensation, stability, mission, learning/i)
  assert.doesNotMatch(opener, /Saw your resume come through/i)
})

test("projector carries LLM canonical tags and avoids broad free-text industry classification", () => {
  // Without LLM-provided tags, broad semantic tag extraction stays out of this
  // projector; it only produces the memory fact + raw-answer bookkeeping for
  // normal axes. Matcher-critical literal fallbacks are covered separately below.
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

test("LEGACY full-set walker: main_goal → culture_stage … special_context → done (unchanged by the trim)", () => {
  // resolveNextSharedOnboardingQuestionId is the LEGACY walker — it still traverses the FULL 7-slot
  // set (the legacy deterministic onboarding path depends on this). The thin trim does NOT touch it.
  assert.deepEqual(resolveNextSharedOnboardingQuestionId("main_goal"), {
    nextQuestionId: "culture_stage",
    completed: false,
    shouldRecommend: false,
  })
  assert.deepEqual(resolveNextSharedOnboardingQuestionId("location_relocation"), {
    nextQuestionId: "seniority_comp",
    completed: false,
    shouldRecommend: false,
  })
  assert.deepEqual(resolveNextSharedOnboardingQuestionId("special_context"), {
    nextQuestionId: null,
    completed: true,
    shouldRecommend: true,
  })
})

test("THIN asked-set walker + in-flight rescue (2026-06-02 trim)", () => {
  // resolveNextAskedSharedOnboardingQuestionId is the THIN-path walker over the trimmed ASKED set:
  // target_role → location_relocation → complete.
  assert.deepEqual(resolveNextAskedSharedOnboardingQuestionId("target_role"), {
    nextQuestionId: "location_relocation",
    completed: false,
    shouldRecommend: false,
  })
  assert.deepEqual(resolveNextAskedSharedOnboardingQuestionId("location_relocation"), {
    nextQuestionId: null,
    completed: true,
    shouldRecommend: true,
  })
  // In-flight rescue: a now-dropped stored slot resolves back to the first ASKED slot (target_role),
  // never null/stall — so an in-flight user re-asks at most one short slot.
  for (const dropped of ["main_goal", "culture_stage", "industry_interest", "seniority_comp", "special_context"] as const) {
    const r = resolveNextAskedSharedOnboardingQuestionId(dropped)
    assert.equal(r.nextQuestionId, "target_role", `${dropped} rescues to target_role`)
    assert.equal(r.completed, false)
  }
})

test("TAG-AWARE slot satisfaction (2026-06-04 #1) — target_role satisfied off pa-users.tags.targetRoleFunction", () => {
  // The matcher's sole role axis is tags.targetRoleFunction[] (D1). When a résumé/chat enrich already
  // filled it, the target_role onboarding question is redundant → treat the slot as satisfied. NO regex;
  // pure presence over the validated closed enum.
  assert.equal(
    isSharedOnboardingSlotSatisfied("target_role", { targetRoleFunction: ["software_engineering"] }, null),
    true,
    "target_role satisfied when targetRoleFunction present on tags",
  )
  // legacy statedPreferences mirror also satisfies (some paths still write there).
  assert.equal(
    isSharedOnboardingSlotSatisfied("target_role", null, { targetRoleFunction: ["product_management"] }),
    true,
    "target_role satisfied via statedPreferences fallback",
  )
  // empty / absent axis → NOT satisfied (still asked).
  assert.equal(isSharedOnboardingSlotSatisfied("target_role", { targetRoleFunction: [] }, null), false)
  assert.equal(isSharedOnboardingSlotSatisfied("target_role", null, null), false)
  // location_relocation keeps its existing tag-satisfaction (targetLocations).
  assert.equal(isSharedOnboardingSlotSatisfied("location_relocation", { targetLocations: ["new_york"] }, null), true)
})

test("THIN tag-aware missing-walker (2026-06-04 #1) — skips slots already in tags, never re-asks", () => {
  // No tags → identical to the positional asked-set walker (target_role → location_relocation → done).
  assert.deepEqual(resolveNextAskedMissingSharedOnboardingQuestionId("target_role", null, null), {
    nextQuestionId: "location_relocation",
    completed: false,
    shouldRecommend: false,
  })
  // targetRoleFunction already captured + scanning from the head (in-flight/unknown id) → SKIP target_role,
  // ask location_relocation instead. This is the live +18563790960 case (résumé gave software_engineering).
  assert.deepEqual(
    resolveNextAskedMissingSharedOnboardingQuestionId(
      "main_goal", // a dropped/unknown id → scan whole ASKED set from head
      { targetRoleFunction: ["software_engineering"] },
      null,
    ),
    { nextQuestionId: "location_relocation", completed: false, shouldRecommend: false },
  )
  // BOTH asked axes already in tags → completed, never re-asks either.
  assert.deepEqual(
    resolveNextAskedMissingSharedOnboardingQuestionId(
      "main_goal",
      { targetRoleFunction: ["software_engineering"], targetLocations: ["new_york"] },
      null,
    ),
    { nextQuestionId: null, completed: true, shouldRecommend: true },
  )
  // Advancing FROM target_role when location is already in tags → completed (no redundant location ask).
  assert.deepEqual(
    resolveNextAskedMissingSharedOnboardingQuestionId("target_role", { targetLocations: ["remote"] }, null),
    { nextQuestionId: null, completed: true, shouldRecommend: true },
  )
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
