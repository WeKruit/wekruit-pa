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

  // 2026-05-27 — real gpt-5.4-nano receipt (apps/eval/conversation-experience/
  // llm-runner.mjs): the model emits a SCALAR for single-value array fields,
  // e.g. `targetRoleFunction: "product_management"` not `["product_management"]`.
  // The old strict `z.array(...)` rejected the scalar → parse_error → the
  // extractor silently dropped a correct patch → matcher kept stale tags.
  // These tests pin the scalar→array coercion that fixes the Adam-bug.
  it("coerces a scalar enum to a single-element array (targetRoleFunction)", () => {
    const r = ConversationExtractResultSchema.parse({
      tagPatch: { targetRoleFunction: "product_management" },
      memoryEntities: [],
      confidence: 0.9,
      rationale: "",
    })
    assert.deepEqual(r.tagPatch.targetRoleFunction, ["product_management"])
  })

  it("coerces scalar targetJobType + targetLocations", () => {
    const r = ConversationExtractResultSchema.parse({
      tagPatch: { targetJobType: "full_time", targetLocations: "san_francisco_bay_area" },
      memoryEntities: [],
      confidence: 0.9,
      rationale: "",
    })
    assert.deepEqual(r.tagPatch.targetJobType, ["full_time"])
    assert.deepEqual(r.tagPatch.targetLocations, ["san_francisco_bay_area"])
  })

  it("still accepts a real array (no double-wrap)", () => {
    const r = ConversationExtractResultSchema.parse({
      tagPatch: { targetRoleFunction: ["product_management", "data_analysis"] },
      memoryEntities: [],
      confidence: 0.9,
      rationale: "",
    })
    assert.deepEqual(r.tagPatch.targetRoleFunction, ["product_management", "data_analysis"])
  })

  it("still rejects a scalar that is out of vocab after coercion", () => {
    assert.throws(() =>
      ConversationExtractResultSchema.parse({
        tagPatch: { targetRoleFunction: "underwater_basket_weaving" },
        memoryEntities: [],
        confidence: 0.9,
        rationale: "",
      }),
    )
  })

  it("drops empty-string scalar to undefined (no [\"\"])", () => {
    const r = ConversationExtractResultSchema.parse({
      tagPatch: { targetLocations: "" },
      memoryEntities: [],
      confidence: 0.9,
      rationale: "",
    })
    assert.equal(r.tagPatch.targetLocations, undefined)
  })

  // 2026-06-09 — negation parity for the jobType axis. The schema had negative
  // tokens only for roleFunction + industrySector; "I am not looking for an
  // internship" was INEXPRESSIBLE, so a stale targetJobType=["internship"]
  // (an EXACT-match hard filter) kept matching only intern jobs.
  it("accepts negativeJobType (array + scalar coercion)", () => {
    const arr = ConversationExtractResultSchema.parse({
      tagPatch: { negativeJobType: ["internship", "new_graduate"] },
      memoryEntities: [],
      confidence: 0.9,
      rationale: "",
    })
    assert.deepEqual(arr.tagPatch.negativeJobType, ["internship", "new_graduate"])
    const scalar = ConversationExtractResultSchema.parse({
      tagPatch: { negativeJobType: "internship" },
      memoryEntities: [],
      confidence: 0.9,
      rationale: "",
    })
    assert.deepEqual(scalar.tagPatch.negativeJobType, ["internship"])
  })

  it("rejects an off-vocab negativeJobType token", () => {
    assert.throws(() =>
      ConversationExtractResultSchema.parse({
        tagPatch: { negativeJobType: ["side_hustle"] },
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

  it("lists negativeJobType as an emittable field with avoid instructions", () => {
    // NOTE: the transcript body deliberately does NOT mention internships, so
    // these assertions can only be satisfied by the INSTRUCTION text.
    const prompt = buildExtractorPrompt({
      userId: "u",
      recentMessages: [
        { role: "user", body: "hey what roles do you have", createdAt: "2026-06-09T00:00:00.000Z" },
      ],
      existingTags: { targetJobType: ["internship"] },
      trigger: "turn_count",
    })
    assert.ok(prompt.includes("negativeJobType"), "field key listed")
    assert.ok(
      /not looking for an internship/i.test(prompt),
      "the avoid-job-type instruction carries the canonical example",
    )
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

// ===========================================================================
// SOFT-vs-HARD preference capture (2026-05-28)
// ===========================================================================

describe("SOFT-vs-HARD preference capture", () => {
  it("schema accepts preferenceHardness with hard/soft per axis", () => {
    const r = ConversationExtractResultSchema.parse({
      tagPatch: {
        industrySector: ["financial_technology"],
        preferenceHardness: {
          industrySector: { hardness: "hard" },
          companyStage: { hardness: "soft" },
        },
      },
      memoryEntities: [],
      confidence: 0.9,
      rationale: "",
    })
    assert.equal(r.tagPatch.preferenceHardness?.industrySector?.hardness, "hard")
    assert.equal(r.tagPatch.preferenceHardness?.companyStage?.hardness, "soft")
  })

  // RESILIENCE (2026-06-04): preferenceHardness is an OPTIONAL hint. A malformed hint must NEVER throw,
  // because a strict throw was a parse_error that dropped the ENTIRE tagPatch — the candidate's real
  // visa/salary/location/industry tags silently lost (the mid-onboarding real-seam data-loss bug). The
  // schema now `.catch(undefined)`s a malformed axis (and the whole map for an unknown axis key), so the
  // hint is dropped while the rest of the patch always lands. These tests lock that contract in.
  it("TOLERATES an unknown hardness axis — drops preferenceHardness, never nukes the patch", () => {
    const r = ConversationExtractResultSchema.parse({
      tagPatch: {
        industrySector: ["financial_technology"],
        preferenceHardness: { madeUpAxis: { hardness: "hard" } },
      },
      memoryEntities: [],
      confidence: 0.9,
      rationale: "",
    })
    assert.deepEqual(r.tagPatch.industrySector, ["financial_technology"]) // real tag survives
    assert.equal(r.tagPatch.preferenceHardness, undefined) // unknown axis → whole hint dropped, NOT thrown
  })

  it("TOLERATES an out-of-vocab hardness value — drops ONLY that axis, keeps valid axes + the patch", () => {
    const r = ConversationExtractResultSchema.parse({
      tagPatch: {
        industrySector: ["financial_technology"],
        preferenceHardness: {
          location: { hardness: "kinda" }, // out-of-vocab → this axis alone is dropped
          industrySector: { hardness: "hard" }, // valid → preserved
        },
      },
      memoryEntities: [],
      confidence: 0.9,
      rationale: "",
    })
    assert.deepEqual(r.tagPatch.industrySector, ["financial_technology"]) // real tag survives
    assert.equal(r.tagPatch.preferenceHardness?.location, undefined) // malformed axis dropped
    assert.equal(r.tagPatch.preferenceHardness?.industrySector?.hardness, "hard") // valid axis preserved
  })

  it("prompt documents hard vs soft detection cues", () => {
    const prompt = buildExtractorPrompt({
      userId: "u",
      recentMessages: [{ role: "user", body: "x", createdAt: "2026-05-18T20:00:00.000Z" }],
      existingTags: {},
      trigger: "turn_count",
    })
    assert.ok(prompt.includes("preferenceHardness"))
    assert.ok(prompt.toLowerCase().includes("dealbreaker"))
    assert.ok(prompt.toLowerCase().includes("prefer"))
  })

  it("runExtraction stamps source+updatedAt on captured hardness entries", async () => {
    const result: ConversationExtractResult = {
      tagPatch: {
        industrySector: ["financial_technology"],
        preferenceHardness: { industrySector: { hardness: "hard" } },
      } as ConversationExtractResult["tagPatch"],
      memoryEntities: [
        { entityKind: "industrySector", value: "financial_technology", confidence: 0.9, evidence: "I only want fintech" },
      ],
      confidence: 0.9,
      rationale: "user said only fintech",
    }
    const deps = makeDeps()
    const { llm } = makeLlmStub(result)
    deps.llm = llm
    const out = await runExtraction(
      makeReq({ recentMessages: [{ role: "user", body: "I ONLY want fintech", createdAt: "2026-05-18T20:00:00.000Z" }] }),
      deps,
    )
    assert.equal(out.ran, true)
    assert.equal(deps.__tagWrites.length, 1)
    const written = deps.__tagWrites[0]!.patch as {
      preferenceHardness?: Record<string, { hardness: string; source: string; updatedAt: string }>
    }
    assert.equal(written.preferenceHardness?.industrySector?.hardness, "hard")
    assert.equal(written.preferenceHardness?.industrySector?.source, "conversation")
    assert.equal(written.preferenceHardness?.industrySector?.updatedAt, "2026-05-18T20:01:23.000Z")
  })

  it("runExtraction drops preferenceHardness when no valid entries remain", async () => {
    const result: ConversationExtractResult = {
      // Empty hardness object → stamped object has no keys → field removed.
      tagPatch: {
        industrySector: ["financial_technology"],
        preferenceHardness: {},
      } as ConversationExtractResult["tagPatch"],
      memoryEntities: [
        { entityKind: "industrySector", value: "financial_technology", confidence: 0.9, evidence: "fintech" },
      ],
      confidence: 0.9,
      rationale: "",
    }
    const deps = makeDeps()
    const { llm } = makeLlmStub(result)
    deps.llm = llm
    const out = await runExtraction(makeReq(), deps)
    assert.equal(out.ran, true)
    const written = deps.__tagWrites[0]!.patch as { preferenceHardness?: unknown }
    assert.equal("preferenceHardness" in written, false)
  })
})

// ────────────────────────────────────────────────────────────────────────
// BUG B (2026-06-11, live RJcsA285Drcml1kTPZjI): a candidate DESCRIBING a job he was applying to
// ("Invoko.ai Product Manager in San Francisco I got sent an email to interview with Claire…") had
// that job written into pa-users.tags as his EMPLOYMENT (recentCompany=invoko.ai,
// workHistorySummary="product_manager @ invoko.ai", careerStage=mid_level, yoeRange=[0,0]).
// Two invariants locked here:
//   1. The extractor SCHEMA can never carry employment-identity fields — a model that fabricates
//      them invalidates the WHOLE patch (strict) → zero writes (deterministic guard).
//   2. The extractor PROMPT carries the explicit LLM-judgment instruction that a job being
//      pursued/discussed is NOT evidence about the user (prompt contract).
// ────────────────────────────────────────────────────────────────────────

const AVI_INQUIRY_MESSAGE =
  "Invoko.ai Product Manager in San Francisco I got sent an email to interview with Claire, " +
  "created my profile and uploaded resume / info and sent the magic link to email and used that " +
  "to send this message to you, do you have access to my profile?"

describe("employment-identity protection (job-inquiry ≠ work history)", () => {
  it("a patch fabricating employment-identity fields from the Avi inquiry is rejected WHOLE — no tag write, no memory write", async () => {
    const deps = makeDeps()
    // The exact fabrication shape observed live (employment-identity keys are NOT in the schema —
    // .strict() must reject the whole patch rather than silently persisting any of it).
    deps.llm = async () => ({
      json: {
        tagPatch: {
          recentCompany: "invoko.ai",
          recentRoleTitle: "product_manager",
          workHistorySummary: "product_manager @ invoko.ai",
          yoeRange: [0, 0],
          careerStage: "mid_level",
          targetRoleFunction: ["product_management"],
        },
        memoryEntities: [],
        confidence: 0.95,
        rationale: "user mentioned invoko.ai product manager",
      },
      modelUsed: "gpt-5.4-nano",
      tokensIn: 900,
      tokensOut: 90,
      costUsd: 0.0004,
    })
    const out = await runExtraction(
      makeReq({
        recentMessages: [
          { role: "user", body: AVI_INQUIRY_MESSAGE, createdAt: "2026-06-11T21:42:07.000Z" },
        ],
      }),
      deps,
    )
    assert.equal(out.ran, false, "fabricated employment-identity patch must not run")
    assert.equal(out.reason, "parse_error", "strict schema rejects unknown employment keys wholesale")
    assert.equal(deps.__tagWrites.length, 0, "NO tag write may land from the fabricated patch")
    assert.equal(deps.__memoryWrites.length, 0)
  })

  it("schema has NO employment-identity fields (recentCompany / recentRoleTitle / workHistorySummary / yoeRange are unparseable)", () => {
    for (const key of ["recentCompany", "recentRoleTitle", "workHistorySummary", "yoeRange"]) {
      const r = ConversationExtractResultSchema.safeParse({
        tagPatch: { [key]: key === "yoeRange" ? [0, 0] : "anything" },
        memoryEntities: [],
        confidence: 0.9,
        rationale: "",
      })
      assert.equal(r.success, false, `tagPatch.${key} must be rejected by the strict schema`)
    }
  })

  it("prompt instructs the model that a job being asked about / applied to / interviewed for is NOT user evidence", () => {
    const prompt = buildExtractorPrompt(
      makeReq({
        recentMessages: [
          { role: "user", body: AVI_INQUIRY_MESSAGE, createdAt: "2026-06-11T21:42:07.000Z" },
        ],
      }),
    )
    assert.ok(
      prompt.includes("ASKING ABOUT, APPLYING TO, INTERVIEWING FOR"),
      "discussed-job carve-out missing from extractor prompt",
    )
    assert.ok(
      prompt.includes("Never derive careerStage"),
      "careerStage must be explicitly excluded from job-inquiry inference",
    )
    assert.ok(
      prompt.includes("recentCompany, recentRoleTitle, workHistorySummary"),
      "prompt must name the forbidden employment-history fields",
    )
    assert.ok(
      prompt.includes("never transient process state"),
      "relevantTags must exclude process-state tokens like <company>_interviewing",
    )
  })
})
