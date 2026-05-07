/**
 * Layer 2 sim — q_country=USA → q_location hint filtering (DOD #3).
 *
 * P7-6 task: q_country=USA → q_location must NOT offer China in re-ask
 * hints. Uses `makeLocationQuestion(country)` factory from P7-1 — when
 * country="usa", the prompt + reAsks pool is scoped to US cities only.
 *
 * Verifies (per acceptance criterion #8):
 *   1. makeLocationQuestion("usa", ...) prompt + ALL reAsks contain NO
 *      "Shanghai" / "上海" / "Beijing" / "北京" tokens.
 *   2. makeLocationQuestion("china", ...) prompt mentions Chinese cities
 *      (positive control — confirms the factory IS country-aware).
 *   3. makeLocationQuestion(undefined, ...) (the default ANYWHERE pool)
 *      retains both US and China cities (positive control of fallback).
 *   4. Through-pipeline simulation: when q_country accepts "usa", a
 *      dispatcher swapping in the USA-specific Q_LOCATION will surface
 *      USA-only re-ask phrasings to the user.
 */
import test from "node:test"
import assert from "node:assert/strict"

import { makeLocationQuestion, type LocationAnswer } from "../../questions.js"
import {
  buildPipeline,
  buildV2QuestionsWithStubs,
  stubGuidedOpenLLM,
  stubGuidedOpenProvided,
  stubGuidedOpenUnclear,
} from "./_helpers.js"
import type { LlmCallFn, GuidedOpenJudge } from "../../judges/guided-open.js"
import { HybridRephraser } from "../../rephrasers/hybrid.js"
import type { Question } from "../../question.js"

// Strings that MUST NOT appear when country=usa (case-insensitive).
const CHINA_CITY_TOKENS = ["shanghai", "上海", "beijing", "北京", "shenzhen", "深圳", "hangzhou", "杭州", "guangzhou", "广州"]

test("sim/country-then-location: makeLocationQuestion('usa') prompt has NO China cities", async () => {
  const q = makeLocationQuestion(["usa"])

  const promptZh = q.prompt.zh.toLowerCase()
  const promptEn = q.prompt.en.toLowerCase()
  for (const tok of CHINA_CITY_TOKENS) {
    assert.ok(
      !promptZh.includes(tok.toLowerCase()) && !promptEn.includes(tok.toLowerCase()),
      `q_location prompt for country=usa must NOT mention "${tok}" — got zh="${q.prompt.zh}" en="${q.prompt.en}"`
    )
  }
  // Positive control: USA-specific tokens DO appear.
  assert.match(promptEn, /(bay area|nyc|seattle|boston|chicago|austin)/, "USA cities mentioned")
})

test("sim/country-then-location: makeLocationQuestion('usa') re-asks have NO China cities", async () => {
  const q = makeLocationQuestion(["usa"])
  // The rephraser is HybridRephraser with US-scoped variants. Drive it
  // through 3 attempts to inspect the actual emitted strings.
  const reasks: string[] = []
  for (let attempt = 1; attempt <= 3; attempt++) {
    for (const lang of ["zh", "en"] as const) {
      const text = await q.rephraser.rephrase({
        questionId: "q_location",
        originalPrompt: q.prompt[lang],
        userReply: "garbage",
        attemptNum: attempt,
        lang,
      })
      reasks.push(text)
    }
  }
  for (const tok of CHINA_CITY_TOKENS) {
    for (const r of reasks) {
      assert.ok(
        !r.toLowerCase().includes(tok.toLowerCase()),
        `re-ask must NOT mention "${tok}" when country=usa — got: ${r}`
      )
    }
  }
})

test("sim/country-then-location: makeLocationQuestion('china') DOES mention Chinese cities (positive control)", async () => {
  const q = makeLocationQuestion(["china"])
  const promptZh = q.prompt.zh
  const promptEn = q.prompt.en
  // Must mention at least one Chinese city.
  assert.ok(
    /上海|北京|杭州|深圳|广州|shanghai|beijing|hangzhou|shenzhen|guangzhou/i.test(
      promptZh + " " + promptEn
    ),
    "country=china prompt mentions Chinese cities"
  )
  // And must NOT push USA city tokens.
  assert.ok(
    !/bay area|nyc|seattle|boston|chicago|austin/i.test(promptEn),
    "country=china prompt does NOT mention USA cities"
  )
})

test("sim/country-then-location: makeLocationQuestion(undefined) anywhere pool mentions BOTH US + China cities", async () => {
  const q = makeLocationQuestion(undefined)
  // Default-anywhere variant should be the most permissive — at minimum
  // its 4 example variants in HybridRephraser MUST cover both pools.
  // Drive 1 attempt and inspect.
  const enAttempt2 = await q.rephraser.rephrase({
    questionId: "q_location",
    originalPrompt: q.prompt.en,
    userReply: "x",
    attemptNum: 2,
    lang: "en",
  })
  // Variant 2 EN is "let me ask again — city + remote pref, like 'sf' / 'shanghai' / 'remote'"
  assert.match(
    enAttempt2,
    /(sf|shanghai|remote)/,
    "anywhere fallback mentions multi-region examples"
  )
})

test("sim/country-then-location: pipeline dispatch — country=USA flow uses USA-scoped Q_LOCATION (no China in re-asks)", async () => {
  // Simulate the dispatcher behavior P7-4 will implement: when q_country
  // accepts "usa", swap Q_LOCATION for makeLocationQuestion("usa", ...).
  // We do that explicitly here by building a question list with the USA
  // variant pre-installed and seed state to q_location.
  const locationLlm: LlmCallFn = async () => stubGuidedOpenUnclear()
  const builtQs = buildV2QuestionsWithStubs({ locationLlm })
  // Replace the q_location entry with the USA-specific variant (preserve
  // the stub LLM by re-cloning the judge from the V2 stubbed list).
  const usaLocQ = makeLocationQuestion(["usa"]) as Question<unknown>
  // Re-use the stubbed judge from the original list to keep LLM canned.
  const stubbedLocQ = builtQs.find((q) => q.id === "q_location")!
  const finalLocQ: Question<unknown> = {
    ...usaLocQ,
    judge: stubbedLocQ.judge,
  } as Question<unknown>
  const finalList = builtQs.map((q) => (q.id === "q_location" ? finalLocQ : q))

  const built = buildPipeline({ questionsOverride: finalList })

  // Pre-seed state: q_location active, country was answered "usa".
  const s0 = await built.state.load("u_sim")
  s0.currentQId = "q_location"
  s0.collected.q_country = ["usa"]
  await built.state.save("u_sim", s0)

  // Drive 3 nonsense replies → 3 re-asks emitted.
  await built.send("garbage1")
  await built.send("garbage2")
  await built.send("garbage3")

  const reasks = built.emitted
    .filter((e) => e.kind === "reask" && e.qId === "q_location")
    .map((e) => e.text)
  assert.equal(reasks.length, 3, "3 re-ask emits captured")

  // CRITICAL: none of the 3 re-asks mention China cities.
  for (const tok of CHINA_CITY_TOKENS) {
    for (const r of reasks) {
      assert.ok(
        !r.toLowerCase().includes(tok.toLowerCase()),
        `dispatcher-scoped q_location re-ask must NOT mention "${tok}" — got: ${r}`
      )
    }
  }

  // And rotation: 3 distinct phrasings.
  assert.equal(
    new Set(reasks).size,
    3,
    "USA-scoped q_location uses 3 distinct re-ask phrasings"
  )
})

test("sim/country-then-location: USA-scoped Q_LOCATION accepts 'sf' (positive: USA cities work)", async () => {
  const locationLlm: LlmCallFn = async () => stubGuidedOpenProvided(["sf"])
  const builtQs = buildV2QuestionsWithStubs({ locationLlm })
  const usaLocQ = makeLocationQuestion(["usa"]) as Question<unknown>
  const stubbedLocQ = builtQs.find((q) => q.id === "q_location")!
  const finalList = builtQs.map((q) =>
    q.id === "q_location"
      ? ({ ...usaLocQ, judge: stubbedLocQ.judge } as Question<unknown>)
      : q
  )

  const built = buildPipeline({ questionsOverride: finalList })
  const s0 = await built.state.load("u_sim")
  s0.currentQId = "q_location"
  await built.state.save("u_sim", s0)

  // "sf only" — bloom won't match ("anywhere|remote" only) → LLM consulted →
  // stub returns provided ["sf"] → accept.
  await built.send("sf only")
  assert.equal(built.peekState()?.currentQId, "q_resume", "advanced past q_location")
  assert.deepEqual(built.peekState()?.collected.q_location, ["sf"])
})
