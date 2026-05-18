/**
 * 2026-05-18 — conversation-extractor unit tests.
 *
 * Covers:
 *   - `shouldRunExtractor` — debounce / compact / time_window / turn_count / no-trigger / cold-start
 *   - `runExtraction` — happy path / empty patch / low confidence / dual-write fan-out / llm error
 *   - `ConversationExtractResultSchema` — strict, rejects unknown fields, drops bad values
 *
 * Goal: .planning/GOAL-chat-tag-memory-extraction.md test plan.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  shouldRunExtractor,
  runExtraction,
  buildExtractorPrompt,
  ConversationExtractResultSchema,
  MIN_CONFIDENCE,
  type ExtractorTriggerState,
  type ConversationExtractRequest,
  type ConversationExtractorDeps,
  type ConversationExtractResult,
} from "../conversation-extractor.js"

const baseState = (overrides: Partial<ExtractorTriggerState> = {}): ExtractorTriggerState => ({
  lastExtractedAt: null,
  lastExtractedTurnCount: 0,
  currentTurnCount: 0,
  estimatedTranscriptTokens: 0,
  modelContextLimit: 128_000,
  userMsgsSinceLast: 0,
  nowMs: Date.parse("2026-05-18T20:00:00.000Z"),
  ...overrides,
})

describe("shouldRunExtractor", () => {
  it("returns false at cold start with no signal", () => {
    const r = shouldRunExtractor(baseState())
    assert.equal(r.run, false)
    assert.equal(r.reason, "no_trigger_yet")
  })

  it("fires `compact` trigger when transcript >= 75% of context", () => {
    const r = shouldRunExtractor(
      baseState({
        estimatedTranscriptTokens: 100_000,
        modelContextLimit: 128_000,
      }),
    )
    assert.equal(r.run, true)
    assert.equal(r.trigger, "compact")
  })

  it("does NOT fire `time_window` without 3+ user messages", () => {
    const r = shouldRunExtractor(
      baseState({
        lastExtractedAt: "2026-05-18T19:00:00.000Z",
        userMsgsSinceLast: 2,
      }),
    )
    assert.equal(r.run, false)
  })

  it("fires `time_window` when >=30min AND >=3 msgs", () => {
    const r = shouldRunExtractor(
      baseState({
        lastExtractedAt: "2026-05-18T19:00:00.000Z",
        userMsgsSinceLast: 3,
      }),
    )
    assert.equal(r.run, true)
    assert.equal(r.trigger, "time_window")
  })

  it("fires `turn_count` at 10 turns since last", () => {
    const r = shouldRunExtractor(
      baseState({
        lastExtractedAt: "2026-05-18T19:50:00.000Z",
        lastExtractedTurnCount: 20,
        currentTurnCount: 30,
      }),
    )
    assert.equal(r.run, true)
    assert.equal(r.trigger, "turn_count")
  })

  it("debounces — blocks any trigger within 5 minutes of last run", () => {
    const r = shouldRunExtractor(
      baseState({
        lastExtractedAt: "2026-05-18T19:58:00.000Z",
        estimatedTranscriptTokens: 100_000,
        userMsgsSinceLast: 5,
        currentTurnCount: 50,
        lastExtractedTurnCount: 30,
      }),
    )
    assert.equal(r.run, false)
    assert.equal(r.reason, "debounce_5min")
  })

  it("treats corrupted ISO as cold-start (debounce skipped)", () => {
    const r = shouldRunExtractor(
      baseState({
        lastExtractedAt: "not-a-date",
        estimatedTranscriptTokens: 100_000,
      }),
    )
    assert.equal(r.run, true)
    assert.equal(r.trigger, "compact")
  })
})

// ────────────────────────────────────────────────────────────────────────

function makeLlmStub(result: ConversationExtractResult, costUsd = 0.001) {
  const calls: Array<{ prompt: string }> = []
  const llm = async ({ prompt }: { prompt: string }) => {
    calls.push({ prompt })
    return {
      json: result,
      modelUsed: "gpt-5.4-nano",
      tokensIn: 1200,
      tokensOut: 80,
      costUsd,
    }
  }
  return { llm, calls }
}

function makeDeps(): ConversationExtractorDeps & {
  __tagWrites: Array<{ userId: string; patch: Record<string, unknown> }>
  __memoryWrites: Array<{ userId: string; ents: unknown[] }>
  __costRows: unknown[]
  __auditRows: unknown[]
  __logs: Array<{ event: string; payload?: Record<string, unknown> }>
} {
  const tagWrites: Array<{ userId: string; patch: Record<string, unknown> }> = []
  const memoryWrites: Array<{ userId: string; ents: unknown[] }> = []
  const costRows: unknown[] = []
  const auditRows: unknown[] = []
  const logs: Array<{ event: string; payload?: Record<string, unknown> }> = []
  return {
    llm: async () => {
      throw new Error("llm not stubbed for this test")
    },
    writeUserTags: async (userId, patch) => {
      tagWrites.push({ userId, patch })
      return { ok: true }
    },
    writeMemoryEntities: async (userId, ents) => {
      memoryWrites.push({ userId, ents })
      return { ok: true, added: ents.length }
    },
    writeCostLedger: async (entry) => {
      costRows.push(entry)
    },
    writeAudit: async (entry) => {
      auditRows.push(entry)
    },
    log: (event, payload) => {
      logs.push({ event, payload })
    },
    now: () => new Date("2026-05-18T20:01:23.000Z"),
    __tagWrites: tagWrites,
    __memoryWrites: memoryWrites,
    __costRows: costRows,
    __auditRows: auditRows,
    __logs: logs,
  }
}

function makeReq(overrides: Partial<ConversationExtractRequest> = {}): ConversationExtractRequest {
  return {
    userId: "u_test",
    recentMessages: [
      { role: "user", body: "I want fintech roles", createdAt: "2026-05-18T20:00:00.000Z" },
    ],
    existingTags: {},
    trigger: "turn_count",
    ...overrides,
  }
}

describe("runExtraction", () => {
  it("rejects empty userId early", async () => {
    const deps = makeDeps()
    const out = await runExtraction(makeReq({ userId: "" }), deps)
    assert.equal(out.ran, false)
    assert.equal(out.reason, "no_user_id")
  })

  it("rejects empty transcript early", async () => {
    const deps = makeDeps()
    const out = await runExtraction(makeReq({ recentMessages: [] }), deps)
    assert.equal(out.ran, false)
    assert.equal(out.reason, "empty_transcript")
  })

  it("skips dual-write on low-confidence response (writes cost row)", async () => {
    const deps = makeDeps()
    const stub = makeLlmStub({
      tagPatch: { industrySector: ["financial_technology"] },
      memoryEntities: [],
      confidence: 0.5,
      rationale: "weak signal",
    })
    deps.llm = stub.llm
    const out = await runExtraction(makeReq(), deps)
    assert.equal(out.ran, false)
    assert.equal(out.reason, "low_confidence")
    assert.equal(deps.__tagWrites.length, 0)
    assert.equal(deps.__memoryWrites.length, 0)
    // Cost ledger still written so we see the budget burn even on skips.
    assert.equal(deps.__costRows.length, 1)
  })

  it("skips writes when tagPatch and memoryEntities both empty", async () => {
    const deps = makeDeps()
    const stub = makeLlmStub({
      tagPatch: {},
      memoryEntities: [],
      confidence: 0.95,
      rationale: "nothing new",
    })
    deps.llm = stub.llm
    const out = await runExtraction(makeReq(), deps)
    assert.equal(out.ran, false)
    assert.equal(out.reason, "empty_patch")
    assert.equal(deps.__tagWrites.length, 0)
    assert.equal(deps.__memoryWrites.length, 0)
  })

  it("dual-writes tag patch + memory entities + audit on happy path", async () => {
    const deps = makeDeps()
    const stub = makeLlmStub({
      tagPatch: { industrySector: ["financial_technology"], targetLocations: ["los_angeles"] },
      memoryEntities: [
        {
          entityKind: "industry_preference",
          value: "financial_technology",
          confidence: 0.92,
          evidence: 'user said "I want fintech roles"',
        },
      ],
      confidence: 0.9,
      rationale: "explicit user statement of industry + city preference",
    })
    deps.llm = stub.llm
    const out = await runExtraction(makeReq(), deps)
    assert.equal(out.ran, true)
    assert.equal(out.reason, "ok")
    assert.deepEqual(out.tagFieldsChanged, ["industrySector", "targetLocations"])
    assert.equal(out.memoryEntitiesAdded, 1)
    assert.equal(deps.__tagWrites.length, 1)
    assert.equal(deps.__memoryWrites.length, 1)
    assert.equal(deps.__auditRows.length, 1)
    assert.equal(deps.__costRows.length, 1)
  })

  it("propagates llm error as soft outcome (no writes)", async () => {
    const deps = makeDeps()
    deps.llm = async () => {
      throw new Error("openai 503")
    }
    const out = await runExtraction(makeReq(), deps)
    assert.equal(out.ran, false)
    assert.match(out.reason, /^llm_error:/)
    assert.equal(deps.__tagWrites.length, 0)
    assert.equal(deps.__memoryWrites.length, 0)
  })

  it("propagates schema parse error as soft outcome", async () => {
    const deps = makeDeps()
    deps.llm = async () => ({
      json: { tagPatch: { roleFunction: "invalid_value" }, memoryEntities: [] },
      modelUsed: "gpt-5.4-nano",
      tokensIn: 100,
      tokensOut: 30,
      costUsd: 0.0005,
    })
    const out = await runExtraction(makeReq(), deps)
    assert.equal(out.ran, false)
    assert.equal(out.reason, "parse_error")
    // Cost row still written.
    assert.equal(deps.__costRows.length, 1)
  })
})

describe("ConversationExtractResultSchema", () => {
  it("accepts a complete valid payload", () => {
    const r = ConversationExtractResultSchema.parse({
      tagPatch: { targetRoleFunction: ["software_engineering"] },
      memoryEntities: [
        {
          entityKind: "role_preference",
          value: "swe",
          confidence: 0.8,
          evidence: "stated",
        },
      ],
      confidence: 0.88,
      rationale: "looks good",
    })
    assert.equal(r.confidence, 0.88)
    assert.equal(r.tagPatch.targetRoleFunction?.length, 1)
  })

  it("rejects unknown tagPatch fields (strict)", () => {
    assert.throws(() =>
      ConversationExtractResultSchema.parse({
        tagPatch: { hackerNewsKarma: 99 },
        memoryEntities: [],
        confidence: 0.9,
        rationale: "",
      }),
    )
  })

  it("rejects out-of-vocab enum values", () => {
    assert.throws(() =>
      ConversationExtractResultSchema.parse({
        tagPatch: { visaStatus: "h1b_extension_pending" },
        memoryEntities: [],
        confidence: 0.9,
        rationale: "",
      }),
    )
  })

  it("caps relevantTags at 12", () => {
    const big = new Array(13).fill(0).map((_, i) => `tag${i}`)
    assert.throws(() =>
      ConversationExtractResultSchema.parse({
        tagPatch: { relevantTags: big },
        memoryEntities: [],
        confidence: 0.9,
        rationale: "",
      }),
    )
  })
})

describe("buildExtractorPrompt", () => {
  it("includes canonical vocab labels + existing tags + recent turns", () => {
    const prompt = buildExtractorPrompt({
      userId: "u",
      recentMessages: [{ role: "user", body: "I want fintech", createdAt: "2026-05-18T20:00:00.000Z" }],
      existingTags: { industrySector: [] },
      trigger: "turn_count",
    })
    assert.ok(prompt.includes("software_engineering"))
    assert.ok(prompt.includes("financial_technology"))
    assert.ok(prompt.includes("sponsor_needed"))
    assert.ok(prompt.includes(`< ${MIN_CONFIDENCE}`))
    assert.ok(prompt.includes('"industrySector":[]'))
    assert.ok(prompt.includes("I want fintech"))
  })

  it("slices recentMessages to last 20", () => {
    const messages = new Array(40).fill(0).map((_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      body: `msg-${i}`,
      createdAt: `2026-05-18T20:00:${String(i).padStart(2, "0")}.000Z`,
    }))
    const prompt = buildExtractorPrompt({
      userId: "u",
      recentMessages: messages,
      existingTags: {},
      trigger: "turn_count",
    })
    assert.equal(prompt.includes("msg-0"), false)
    assert.equal(prompt.includes("msg-20"), true)
    assert.equal(prompt.includes("msg-39"), true)
  })
})
