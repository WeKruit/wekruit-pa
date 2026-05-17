/**
 * Unit tests for OnboardingPipeline.
 *
 * Coverage:
 *   - First turn emits the first Q's prompt
 *   - Accept advances to next Q
 *   - Multiple irrelevant replies bump counter and rotate variants
 *   - Halt fires precisely at maxAttempts
 *   - Halted state is sticky — subsequent turns re-emit halt msg
 *   - onAccepted hook fires on accept
 *   - postCollect hook fires after last Q accepted
 *   - onDeclined advance=true skips Q without storing value
 *   - Lang preservation across turns
 */
import test from "node:test"
import assert from "node:assert/strict"

import { OnboardingPipeline, type RunTurnInput } from "./pipeline.js"
import { InMemoryPipelineStateProvider } from "./state-memory.js"
import { makeQuestion, type Judge, type JudgeCtx, type JudgeResult, type Lang, type Question } from "./question.js"
import { StaticVariantsRephraser } from "./rephrasers/variants.js"

class AcceptOnce implements Judge<string> {
  readonly kind = "accept-once"
  private hits = 0
  constructor(private readonly trigger: string) {}
  async judge(reply: string): Promise<JudgeResult<string>> {
    this.hits++
    if (reply.trim() === this.trigger) return { accept: true, value: reply.trim(), confidence: 1.0 }
    return { accept: false, reason: "irrelevant" }
  }
  callCount() {
    return this.hits
  }
}

class AlwaysDeclines implements Judge<string> {
  readonly kind = "always-declines"
  async judge(): Promise<JudgeResult<string>> {
    return { accept: false, reason: "declined" }
  }
}

const HALT: { zh: string; en: string } = { zh: "请联系 admin", en: "contact admin" }

function makeQ1(): Question<string> {
  return makeQuestion({
    id: "q1",
    prompt: { zh: "Q1 中文", en: "Q1 EN" },
    judge: new AcceptOnce("ans1"),
    rephraser: new StaticVariantsRephraser([
      { zh: "再问 Q1 (1)", en: "reask Q1 (1)" },
      { zh: "再问 Q1 (2)", en: "reask Q1 (2)" },
      { zh: "再问 Q1 (3)", en: "reask Q1 (3)" },
      { zh: "再问 Q1 (4)", en: "reask Q1 (4)" },
    ]),
    haltMessage: HALT,
  })
}

function makeQ2(onAccepted?: () => Promise<void>): Question<string> {
  return makeQuestion({
    id: "q2",
    prompt: { zh: "Q2 中文", en: "Q2 EN" },
    judge: new AcceptOnce("ans2"),
    rephraser: new StaticVariantsRephraser([
      { zh: "再问 Q2", en: "reask Q2" },
    ]),
    haltMessage: HALT,
    onAccepted: onAccepted ? async () => onAccepted() : undefined,
  })
}

function makePipeline(opts: {
  questions: Question<unknown>[]
  postCollect?: (collected: Record<string, unknown>) => Promise<void>
  initialLang?: Lang
}) {
  const state = new InMemoryPipelineStateProvider()
  const emitted: { text: string; qId: string | null; kind: string }[] = []
  const pipeline = new OnboardingPipeline({
    questions: opts.questions,
    state,
    haltMessageDefault: HALT,
    emit: async (text, meta) => {
      emitted.push({ text, qId: meta.qId, kind: meta.kind })
    },
    postCollect: opts.postCollect ? async (c) => opts.postCollect!(c) : undefined,
  })
  return { state, pipeline, emitted }
}

function makeInput(reply: string, userId = "u1"): RunTurnInput {
  return { userId, turnId: `t-${Math.random()}`, reply }
}

test("OnboardingPipeline: first turn emits first Q's prompt + sets currentQId", async () => {
  const { pipeline, emitted, state } = makePipeline({ questions: [makeQ1()] })
  // First turn: any reply (even meaningless) — pipeline emits Q1 prompt without judging.
  const r = await pipeline.startTurn(makeInput("hi"))
  assert.equal(r.handled, true)
  assert.equal(r.currentQId, "q1")
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0]!.text, "Q1 EN") // default lang = en
  assert.equal(emitted[0]!.kind, "first_prompt")
  const persisted = state.peek("u1")
  assert.equal(persisted?.currentQId, "q1")
})

test("OnboardingPipeline: judge accept advances to next Q + emits its prompt", async () => {
  const { pipeline, emitted } = makePipeline({ questions: [makeQ1(), makeQ2()] })
  await pipeline.startTurn(makeInput("hi")) // turn 1: Q1 prompt
  const r = await pipeline.startTurn(makeInput("ans1")) // turn 2: accept Q1, emit Q2
  assert.equal(r.currentQId, "q2")
  assert.equal(emitted.at(-1)?.text, "Q2 EN")
  assert.equal(emitted.at(-1)?.kind, "first_prompt")
})

test("OnboardingPipeline: accepted reply with side question answers the aside before next prompt", async () => {
  const yoeQ = makeQuestion<number>({
    id: "q_yoe",
    prompt: { zh: "几年?", en: "how many years?" },
    judge: {
      kind: "accept-yoe",
      judge: async () => ({ accept: true, value: 2, confidence: 1 }),
    },
    rephraser: new StaticVariantsRephraser([{ zh: "几年?", en: "how many years?" }]),
    haltMessage: HALT,
  })
  const visaQ = makeQuestion<string>({
    id: "q_visa",
    prompt: { zh: "签证?", en: "what's your work auth?" },
    judge: new AcceptOnce("citizen"),
    rephraser: new StaticVariantsRephraser([{ zh: "签证?", en: "work auth?" }]),
    haltMessage: HALT,
  })
  const { pipeline, emitted } = makePipeline({ questions: [yoeQ, visaQ] })

  await pipeline.startTurn(makeInput("hi"))
  await pipeline.startTurn(makeInput("About 2 years. Quick aside: if I say new-grad-ish, is that okay for matching?"))

  assert.equal(emitted.at(-1)?.qId, "q_visa")
  assert.equal(emitted.at(-1)?.kind, "first_prompt")
  assert.equal(
    emitted.at(-1)?.text,
    "Yes — I’ll treat that as about 2 years / early-career for your profile.\n\nwhat's your work auth?",
  )
})

test("OnboardingPipeline: accepted startup preference answers ATS aside before next prompt", async () => {
  const startupQ = makeQuestion<string>({
    id: "q_startup_pref",
    prompt: { zh: "公司偏好?", en: "startup or bigger company?" },
    judge: {
      kind: "accept-startup",
      judge: async () => ({ accept: true, value: "startup", confidence: 1 }),
    },
    rephraser: new StaticVariantsRephraser([{ zh: "公司偏好?", en: "startup or bigger company?" }]),
    haltMessage: HALT,
  })
  const countryQ = makeQuestion<string>({
    id: "q_country",
    prompt: { zh: "国家?", en: "which country/region?" },
    judge: new AcceptOnce("usa"),
    rephraser: new StaticVariantsRephraser([{ zh: "国家?", en: "country?" }]),
    haltMessage: HALT,
  })
  const { pipeline, emitted } = makePipeline({ questions: [startupQ, countryQ] })

  await pipeline.startTurn(makeInput("hi"))
  await pipeline.startTurn(makeInput("Startups are best. Random question: will you avoid huge-company ATS black holes?"))

  assert.equal(emitted.at(-1)?.qId, "q_country")
  assert.equal(emitted.at(-1)?.kind, "first_prompt")
  assert.equal(
    emitted.at(-1)?.text,
    "Yes - I’ll treat startups and smaller teams as the default, and only show bigger-company roles when the requirements and link look worth checking.\n\nwhich country/region?",
  )
})

test("OnboardingPipeline: accepted country answer answers remote-scope aside before next prompt", async () => {
  const countryQ = makeQuestion<string>({
    id: "q_country",
    prompt: { zh: "国家?", en: "which country/region?" },
    judge: {
      kind: "accept-country",
      judge: async () => ({ accept: true, value: "usa", confidence: 1 }),
    },
    rephraser: new StaticVariantsRephraser([{ zh: "国家?", en: "country?" }]),
    haltMessage: HALT,
  })
  const locationQ = makeQuestion<string>({
    id: "q_location",
    prompt: { zh: "城市?", en: "which city or remote preference?" },
    judge: new AcceptOnce("nyc"),
    rephraser: new StaticVariantsRephraser([{ zh: "城市?", en: "city?" }]),
    haltMessage: HALT,
  })
  const { pipeline, emitted } = makePipeline({ questions: [countryQ, locationQ] })

  await pipeline.startTurn(makeInput("hi"))
  await pipeline.startTurn(makeInput("USA, mainly NYC or remote. Quick question: when I say remote, do you treat that as US remote unless I say global?"))

  assert.equal(emitted.at(-1)?.qId, "q_location")
  assert.equal(emitted.at(-1)?.kind, "first_prompt")
  assert.equal(
    emitted.at(-1)?.text,
    "Yes - I’ll treat remote as US remote unless you explicitly say global or worldwide.\n\nwhich city or remote preference?",
  )
})

test("OnboardingPipeline: side question without an answer does not count as failed attempt", async () => {
  const { pipeline, emitted, state } = makePipeline({ questions: [makeQ1()] })

  await pipeline.startTurn(makeInput("hi"))
  await pipeline.startTurn(makeInput("Quick question: do you store this forever or can I delete it?"))

  assert.equal(emitted.at(-1)?.qId, "q1")
  assert.equal(emitted.at(-1)?.kind, "reask")
  assert.equal(
    emitted.at(-1)?.text,
    "Good question. I use this for your WeKruit candidate profile and recruiting flow; you can ask to delete or export it.\n\nQ1 EN",
  )
  assert.equal(state.peek("u1")?.attempts.q1 ?? 0, 0)
})

test("OnboardingPipeline: next Q can auto-accept on entry without emitting prompt", async () => {
  const q2 = makeQuestion({
    id: "q2",
    prompt: { zh: "Q2 中文", en: "Q2 EN" },
    judge: new AcceptOnce("ans2"),
    rephraser: new StaticVariantsRephraser([{ zh: "再问 Q2", en: "reask Q2" }]),
    haltMessage: HALT,
    onEnter: async () => ({ accept: true, value: "prefilled", confidence: 0.95 }),
  } as Question<string>)
  const { pipeline, emitted, state } = makePipeline({ questions: [makeQ1(), q2] })

  await pipeline.startTurn(makeInput("hi"))
  const final = await pipeline.startTurn(makeInput("ans1"))

  assert.equal(final.completed, true)
  assert.equal(final.currentQId, null)
  assert.equal(emitted.some((e) => e.qId === "q2" && e.kind === "first_prompt"), false)
  assert.deepEqual(state.peek("u1")?.collected, { q1: "ans1", q2: "prefilled" })
})

test("OnboardingPipeline: accepted side question is emitted before next Q auto-accept side effects", async () => {
  const locationQ = makeQuestion<string>({
    id: "q_location",
    prompt: { zh: "城市?", en: "which city or remote preference?" },
    judge: {
      kind: "accept-location",
      judge: async () => ({ accept: true, value: "nyc", confidence: 1 }),
    },
    rephraser: new StaticVariantsRephraser([{ zh: "城市?", en: "city?" }]),
    haltMessage: HALT,
  })
  const resumeQ = makeQuestion<string>({
    id: "q_resume",
    prompt: { zh: "简历?", en: "resume?" },
    judge: new AcceptOnce("resume"),
    rephraser: new StaticVariantsRephraser([{ zh: "简历?", en: "resume?" }]),
    haltMessage: HALT,
    onEnter: async () => ({ accept: true, value: "resume-on-file", confidence: 0.95 }),
    onAccepted: async (_value, ctx) => {
      await ctx.log?.("resume.accepted", {})
    },
    suppressTerminalCompletionMessage: true,
  } as Question<string>)
  const emitted: { text: string; qId: string | null; kind: string }[] = []
  const state = new InMemoryPipelineStateProvider()
  const pipeline = new OnboardingPipeline({
    questions: [locationQ as Question<unknown>, resumeQ as Question<unknown>],
    state,
    haltMessageDefault: HALT,
    emit: async (text, meta) => {
      emitted.push({ text, qId: meta.qId, kind: meta.kind })
    },
    log: async (event) => {
      if (event === "resume.accepted") {
        emitted.push({ text: "resume side effect", qId: "q_resume", kind: "test_side_effect" })
      }
    },
  })

  await pipeline.startTurn(makeInput("hi"))
  await pipeline.startTurn(makeInput("NYC or US remote works. Quick question: if I say remote, do you treat that as US remote unless I say global?"))

  assert.deepEqual(
    emitted.slice(1).map((e) => [e.kind, e.qId, e.text]),
    [
      [
        "side_question_ack",
        "q_location",
        "Yes - I’ll treat remote as US remote unless you explicitly say global or worldwide.",
      ],
      ["test_side_effect", "q_resume", "resume side effect"],
    ],
  )
  assert.equal(state.peek("u1")?.completed, true)
})

test("OnboardingPipeline: irrelevant reply bumps attempt + rotates variants", async () => {
  const { pipeline, emitted } = makePipeline({ questions: [makeQ1()] })
  await pipeline.startTurn(makeInput("hi"))
  await pipeline.startTurn(makeInput("nope")) // attempt 1
  await pipeline.startTurn(makeInput("nope")) // attempt 2
  await pipeline.startTurn(makeInput("nope")) // attempt 3
  await pipeline.startTurn(makeInput("nope")) // attempt 4 (one before halt)
  const reasks = emitted.filter((e) => e.kind === "reask").map((e) => e.text)
  assert.deepEqual(reasks, [
    "reask Q1 (1)",
    "reask Q1 (2)",
    "reask Q1 (3)",
    "reask Q1 (4)",
  ], "variants rotate by attempt index")
})

test("OnboardingPipeline: halt fires at maxAttempts (default 5)", async () => {
  const { pipeline, emitted, state } = makePipeline({ questions: [makeQ1()] })
  await pipeline.startTurn(makeInput("hi"))
  for (let i = 0; i < 5; i++) {
    await pipeline.startTurn(makeInput(`bad${i}`))
  }
  const haltEvent = emitted.find((e) => e.kind === "halt")
  assert.ok(haltEvent, "halt event should be emitted")
  assert.equal(haltEvent?.text, HALT.en)
  const persisted = state.peek("u1")
  assert.ok(persisted?.halted, "state.halted should be set")
  assert.equal(persisted?.halted?.qId, "q1")
})

test("OnboardingPipeline: halted state is sticky — subsequent turns re-emit halt msg", async () => {
  const { pipeline, emitted } = makePipeline({ questions: [makeQ1()] })
  await pipeline.startTurn(makeInput("hi"))
  for (let i = 0; i < 5; i++) {
    await pipeline.startTurn(makeInput(`bad${i}`))
  }
  // After halt: any further turn should ONLY emit halt msg, not run judge.
  const judge = (makeQ1().judge as AcceptOnce)
  await pipeline.startTurn(makeInput("ans1"))
  await pipeline.startTurn(makeInput("ans1"))
  const haltEvents = emitted.filter((e) => e.kind === "halt")
  assert.ok(haltEvents.length >= 3, "halt msg re-emitted on each subsequent turn")
})

test("OnboardingPipeline: onAccepted fires on accept", async () => {
  let called = false
  const q2 = makeQ2(async () => {
    called = true
  })
  const { pipeline } = makePipeline({ questions: [makeQ1(), q2] })
  await pipeline.startTurn(makeInput("hi"))
  await pipeline.startTurn(makeInput("ans1")) // advances to q2
  await pipeline.startTurn(makeInput("ans2")) // accepts q2
  assert.equal(called, true)
})

test("OnboardingPipeline: postCollect fires after final Q accepted", async () => {
  let captured: Record<string, unknown> | null = null
  const { pipeline, emitted, state } = makePipeline({
    questions: [makeQ1(), makeQ2()],
    postCollect: async (c) => {
      captured = c
    },
  })
  await pipeline.startTurn(makeInput("hi"))
  await pipeline.startTurn(makeInput("ans1"))
  const final = await pipeline.startTurn(makeInput("ans2"))
  assert.equal(final.completed, true)
  assert.deepEqual(captured, { q1: "ans1", q2: "ans2" })
  const persisted = state.peek("u1")
  assert.equal(persisted?.completed, true)
  assert.ok(emitted.find((e) => e.kind === "completion"))
})

test("OnboardingPipeline: terminal Q can suppress generic completion when onAccepted owns UX", async () => {
  let captured: Record<string, unknown> | null = null
  const terminalQ = makeQuestion({
    id: "terminal",
    prompt: { zh: "terminal 中文", en: "terminal EN" },
    judge: new AcceptOnce("done"),
    rephraser: new StaticVariantsRephraser([{ zh: "x", en: "x" }]),
    suppressTerminalCompletionMessage: true,
  })
  const { pipeline, emitted, state } = makePipeline({
    questions: [terminalQ],
    postCollect: async (c) => {
      captured = c
    },
  })

  await pipeline.startTurn(makeInput("hi"))
  const final = await pipeline.startTurn(makeInput("done"))

  assert.equal(final.completed, true)
  assert.deepEqual(captured, { terminal: "done" })
  assert.equal(emitted.some((e) => e.kind === "completion"), false)
  const persisted = state.peek("u1")
  assert.equal(persisted?.completed, true)
  assert.equal(persisted?.currentQId, null)
})

test("OnboardingPipeline: declined Q with onDeclined.advance=true skips without storing", async () => {
  const tosLike: Question<boolean> = makeQuestion({
    id: "q_skip",
    prompt: { zh: "skip-q 中文", en: "skip-q EN" },
    judge: new AlwaysDeclines() as unknown as Judge<boolean>,
    rephraser: new StaticVariantsRephraser([{ zh: "x", en: "x" }]),
    haltMessage: HALT,
    onDeclined: async () => ({ advance: true }),
  })
  const { pipeline, emitted, state } = makePipeline({
    questions: [tosLike as Question<unknown>, makeQ1()],
  })
  await pipeline.startTurn(makeInput("hi")) // emit skip-q prompt
  await pipeline.startTurn(makeInput("no thanks")) // declines → advance to Q1
  const persisted = state.peek("u1")
  assert.equal(persisted?.currentQId, "q1")
  assert.ok(!("q_skip" in (persisted?.collected ?? {})), "no value stored for declined Q")
  assert.equal(emitted.at(-1)?.text, "Q1 EN")
})

test("OnboardingPipeline: ZH lang preserved across turns (variant uses zh phrasing)", async () => {
  const { pipeline, emitted, state } = makePipeline({ questions: [makeQ1()] })
  // Pre-seed lang. (In production this happens via q_lang.onAccepted writing
  // state.lang. For this test we set directly.)
  const s = await state.load("u1")
  s.lang = "zh"
  await state.save("u1", s)

  await pipeline.startTurn(makeInput("hi")) // emits Q1 ZH prompt
  await pipeline.startTurn(makeInput("nope")) // ZH variant 1
  assert.equal(emitted[0]!.text, "Q1 中文")
  assert.equal(emitted[1]!.text, "再问 Q1 (1)")
})
