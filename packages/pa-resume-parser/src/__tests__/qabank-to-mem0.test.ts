import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  mapQuestionToIntentTag,
  memDedupeHash,
  writeQaBankToMem0,
  type Mem0AddArgsForQa,
} from "../qabank-to-mem0.js"

describe("mapQuestionToIntentTag", () => {
  it("maps visa keywords to work_authorization (English)", () => {
    assert.equal(mapQuestionToIntentTag("Are you authorized to work in the US?"), "work_authorization")
    assert.equal(mapQuestionToIntentTag("Do you have an H1B visa?"), "work_authorization")
    assert.equal(mapQuestionToIntentTag("Are you on OPT?"), "work_authorization")
  })
  it("maps green card / 工作授权 (zh)", () => {
    assert.equal(mapQuestionToIntentTag("你有绿卡吗?"), "work_authorization")
    assert.equal(mapQuestionToIntentTag("工作授权状态"), "work_authorization")
  })
  it("maps salary patterns", () => {
    assert.equal(mapQuestionToIntentTag("What's your expected salary?"), "salary_expectation")
    assert.equal(mapQuestionToIntentTag("期望工资多少?"), "salary_expectation")
  })
  it("maps start_date", () => {
    assert.equal(mapQuestionToIntentTag("When can you start?"), "start_date")
    assert.equal(mapQuestionToIntentTag("What's your notice period?"), "start_date")
    assert.equal(mapQuestionToIntentTag("什么时候开始?"), "start_date")
  })
  it("maps relocation", () => {
    assert.equal(mapQuestionToIntentTag("Are you willing to relocate?"), "relocation_willingness")
    assert.equal(mapQuestionToIntentTag("可以搬到旧金山吗?"), "relocation_willingness")
  })
  it("maps remote_preference", () => {
    assert.equal(mapQuestionToIntentTag("Do you prefer remote or on-site?"), "remote_preference")
    assert.equal(mapQuestionToIntentTag("你想远程工作还是线下?"), "remote_preference")
  })
  it("maps relevant_experience", () => {
    assert.equal(mapQuestionToIntentTag("How many years of experience do you have?"), "relevant_experience")
    assert.equal(mapQuestionToIntentTag("工作年限"), "relevant_experience")
  })
  it("maps career_goals", () => {
    assert.equal(mapQuestionToIntentTag("What are your career goals?"), "career_goals")
    assert.equal(mapQuestionToIntentTag("长期目标是什么?"), "career_goals")
  })
  it("maps sponsorship_need above experience for 'sponsor experience' edge", () => {
    // 'sponsorship' must take priority because 'sponsor' precedes 'experience' patterns
    assert.equal(mapQuestionToIntentTag("Do you need sponsorship?"), "sponsorship_need")
  })
  it("returns 'other' for unknown questions", () => {
    assert.equal(mapQuestionToIntentTag("What's your favorite color?"), "other")
    assert.equal(mapQuestionToIntentTag(""), "other")
  })
})

describe("memDedupeHash", () => {
  it("is case+whitespace insensitive within question", () => {
    const a = memDedupeHash("u1", "Years of Experience")
    const b = memDedupeHash("u1", "  years of experience  ")
    assert.equal(a, b)
  })
  it("is user-scoped (different users → different hashes)", () => {
    const a = memDedupeHash("u1", "Years of Experience")
    const b = memDedupeHash("u2", "Years of Experience")
    assert.notEqual(a, b)
  })
  it("returns 16-char hex prefix", () => {
    const h = memDedupeHash("u1", "Q")
    assert.match(h, /^[0-9a-f]{16}$/)
  })
})

describe("writeQaBankToMem0", () => {
  const baseAnswers = [
    { question: "Years of experience?", answer: "5", confidence: 0.9, category: "experience" as const },
    { question: "Visa status?", answer: "US Citizen", confidence: 0.95, category: "personal" as const },
    { question: "What's your favorite color?", answer: "blue", confidence: 0.5, category: "personal" as const },
  ]

  it("calls mem0Add for every inferredAnswer, with metadata + intentTag", async () => {
    const calls: Mem0AddArgsForQa[] = []
    const result = await writeQaBankToMem0({
      userId: "u1",
      partitionKey: "u1",
      resumeId: "r1",
      inferredAnswers: baseAnswers,
      mem0Add: async (args) => {
        calls.push(args)
      },
    })
    assert.equal(result.written, 3)
    assert.equal(result.skippedDedupe, 0)
    assert.equal(calls[0]!.metadata.qaIntentTag, "relevant_experience")
    assert.equal(calls[1]!.metadata.qaIntentTag, "work_authorization")
    assert.equal(calls[2]!.metadata.qaIntentTag, "other")
    assert.equal(calls[0]!.metadata.qaCategory, "experience")
    assert.equal(calls[0]!.metadata.source, "resume_inferred")
    assert.equal(calls[0]!.metadata.resumeId, "r1")
    assert.equal(typeof calls[0]!.metadata.qaDedupeHash, "string")
  })

  it("skips dedupe hits when mem0Search returns matching hash", async () => {
    const expectedHash = memDedupeHash("u1", "Years of experience?")
    const result = await writeQaBankToMem0({
      userId: "u1",
      partitionKey: "u1",
      inferredAnswers: [baseAnswers[0]!],
      mem0Search: async () => [`memory containing ${expectedHash} as substring`],
      mem0Add: async () => {
        throw new Error("should not be called when dedupe hit")
      },
    })
    assert.equal(result.written, 0)
    assert.equal(result.skippedDedupe, 1)
  })

  it("emits tag-events when recordTagEvent adapter present", async () => {
    const tagEvents: { rawTag: string; source: string; userId: string }[] = []
    const result = await writeQaBankToMem0({
      userId: "u1",
      partitionKey: "u1",
      resumeId: "r1",
      inferredAnswers: baseAnswers.slice(0, 2),
      mem0Add: async () => {},
      recordTagEvent: async (args) => {
        tagEvents.push({ rawTag: args.rawTag, source: args.source, userId: args.userId })
      },
    })
    assert.equal(result.tagEventsRecorded, 2)
    assert.equal(tagEvents[0]!.rawTag, "relevant_experience")
    assert.equal(tagEvents[0]!.source, "pa-cv-ingest")
    assert.equal(tagEvents[1]!.rawTag, "work_authorization")
  })

  it("counts errors but does not throw on partial mem0Add failure", async () => {
    let i = 0
    const result = await writeQaBankToMem0({
      userId: "u1",
      partitionKey: "u1",
      inferredAnswers: baseAnswers,
      mem0Add: async () => {
        i++
        if (i === 2) throw new Error("transient mem0 failure")
      },
    })
    assert.equal(result.written, 2)
    assert.equal(result.errored, 1)
  })

  it("skips empty/blank questions", async () => {
    let count = 0
    const result = await writeQaBankToMem0({
      userId: "u1",
      partitionKey: "u1",
      inferredAnswers: [
        { question: "", answer: "x", confidence: 0.5, category: "personal" },
        { question: "   ", answer: "y", confidence: 0.5, category: "personal" },
      ],
      mem0Add: async () => {
        count++
      },
    })
    assert.equal(count, 0)
    assert.equal(result.written, 0)
  })
})
