import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import type { AgentDef } from "@pa/core-types"
import {
  buildSharedOnboardingComposeContext,
  composeSharedOnboardingReply,
  effectiveOnboardingComposeUserMessage,
  humanizeVisibleInternalTokens,
} from "../shared-onboarding-outbound.js"
import { CANDIDATE_PROFILE_URL } from "../shared-onboarding.js"

const agent = { id: "friend", systemPrompt: "You are Claire." } as AgentDef

function makeFlagDb(): Firestore {
  return {
    collection: () => ({
      doc: () => ({
        get: async () => ({ exists: false, data: () => undefined }),
      }),
    }),
  } as unknown as Firestore
}

const kickoffContext = buildSharedOnboardingComposeContext({
  inboundKind: "greeting_kickoff",
  routerResult: "bootstrapped_q1_inline",
  slot: "main_goal",
  mode: "ask",
})

test("effectiveOnboardingComposeUserMessage strips kickoff via router composeContext", () => {
  assert.equal(
    effectiveOnboardingComposeUserMessage({
      mode: "ask",
      userMessage: "Hello, WeKruit!",
      composeContext: kickoffContext,
    }),
    ""
  )
})

test("effectiveOnboardingComposeUserMessage strips Hello WeKruit kickoff on ask (legacy)", () => {
  assert.equal(
    effectiveOnboardingComposeUserMessage({ mode: "ask", userMessage: "Hello, WeKruit!" }),
    ""
  )
  assert.equal(
    effectiveOnboardingComposeUserMessage({ mode: "ask", userMessage: "  hello wekruit  " }),
    ""
  )
})

test("effectiveOnboardingComposeUserMessage keeps substantive answers on ask", () => {
  const answer = "I want backend roles in NYC"
  assert.equal(
    effectiveOnboardingComposeUserMessage({
      mode: "ask",
      userMessage: answer,
      composeContext: buildSharedOnboardingComposeContext({
        inboundKind: "user_answer",
        routerResult: "asked_question",
        slot: "culture_stage",
        mode: "ask",
        userMessage: answer,
      }),
    }),
    answer
  )
})

test("humanizeVisibleInternalTokens cleans future enum tags without touching URLs or emails", () => {
  const text =
    "I’ll look for climate_tech_ops, ai_product_management, and backend-platform-systems roles. Update https://example.com/a_b?role=software_engineering or adam_test@example.com."

  const out = humanizeVisibleInternalTokens(text)

  assert.match(out, /climate tech ops/)
  assert.match(out, /AI product management/)
  assert.match(out, /backend platform systems/)
  assert.match(out, /https:\/\/example\.com\/a_b\?role=software_engineering/)
  assert.match(out, /adam_test@example\.com/)
  assert.doesNotMatch(out.replace(/https?:\/\/\S+|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, ""), /[a-z0-9]+_[a-z0-9]+/i)
})

test("composeSharedOnboardingReply passes synthetic onboarding instruction for greeting kickoff", async () => {
  let capturedUserMessage = ""
  const db = makeFlagDb()
  const env = {
    paSharedOnboardingAgenticSurface: "true",
    paBehaviorChoreographerEnabled: "true",
    paReactionTapbackEnabled: "false",
    paFindMatchToolEnabled: "false",
    paHumanizeRuntimeEnabled: "false",
  }

  const prevEnv = process.env
  process.env = { ...prevEnv, ...env, PA_SHARED_ONBOARDING_TEMPLATE_FALLBACK: "false" }

  try {
    const composed = await composeSharedOnboardingReply({
      store: {
        db,
        log: () => undefined,
        runAgentTurn: async ({ userMessage, systemInputs }) => {
          capturedUserMessage = userMessage
          assert.ok(
            systemInputs?.some((s) => s.includes("Write the SMS in English only")),
            "surface intent should lock English for greeting bootstrap"
          )
          assert.ok(
            systemInputs?.some((s) => s.includes("first SMS after the candidate opened with Hello, WeKruit")),
            "greeting bootstrap should carry opening welcome instructions"
          )
          assert.ok(
            systemInputs?.some((s) => s.includes(CANDIDATE_PROFILE_URL)),
            "opening welcome should mention the profile update link"
          )
          assert.ok(
            !systemInputs?.some((s) => s.includes("FRIEND SLANG PALETTE")),
            "opening welcome should not receive slang-palette pressure"
          )
          return { text: "Hey! What matters most in your next company: career growth, compensation, stability, mission, learning, or something else?" }
        },
        createSession: () => ({
          async getSessionId() {
            return "sess-1"
          },
          async getItems() {
            return []
          },
          async addItems() {
            /* no-op */
          },
          async popItem() {
            return undefined
          },
          async clearSession() {
            /* no-op */
          },
        }),
      },
      userId: "UThMpnAGzjaWnxDsKEMH",
      sessionId: "sess-1",
      turnId: "turn-greeting",
      slot: "main_goal",
      mode: "ask",
      promptContext: { firstName: "Test", recentTitles: ["Designer"], recentCompanies: ["Figma"] },
      userMessage: "Hello, WeKruit!",
      composeContext: kickoffContext,
      agent,
    })

    assert.match(composed.text, /what matters most/i)
    assert.deepEqual(composed.slangPicked, [])
    assert.match(capturedUserMessage, /\[ONBOARDING\].*main goal for the next company/)
    assert.doesNotMatch(capturedUserMessage, /target role/)
    assert.doesNotMatch(capturedUserMessage, /main_goal|job_title|tech_swe/)
    assert.doesNotMatch(capturedUserMessage, /Hello, WeKruit/i)
  } finally {
    process.env = prevEnv
  }
})

test("composeSharedOnboardingReply humanizes unknown future tag tokens from agentic output", async () => {
  const db = makeFlagDb()
  const prevEnv = process.env
  process.env = {
    ...prevEnv,
    paSharedOnboardingAgenticSurface: "true",
    paBehaviorChoreographerEnabled: "false",
    paReactionTapbackEnabled: "false",
    paFindMatchToolEnabled: "false",
    paHumanizeRuntimeEnabled: "false",
    PA_SHARED_ONBOARDING_TEMPLATE_FALLBACK: "false",
  }

  try {
    const composed = await composeSharedOnboardingReply({
      store: {
        db,
        log: () => undefined,
        runAgentTurn: async () => ({
          text: "Got it — I’ll focus on climate_tech_ops and ai_product_management roles. Any special_context_notes I should keep in mind?",
        }),
        createSession: () => ({
          async getSessionId() {
            return "sess-1"
          },
          async getItems() {
            return []
          },
          async addItems() {
            /* no-op */
          },
          async popItem() {
            return undefined
          },
          async clearSession() {
            /* no-op */
          },
        }),
      },
      userId: "future-tag-user",
      sessionId: "sess-1",
      turnId: "turn-future-tag",
      slot: "special_context",
      mode: "ask",
      promptContext: {},
      userMessage: "NYC or remote",
      composeContext: buildSharedOnboardingComposeContext({
        inboundKind: "user_answer",
        routerResult: "asked_question",
        slot: "special_context",
        mode: "ask",
        userMessage: "NYC or remote",
      }),
      agent,
    })

    assert.match(composed.text, /climate tech ops/)
    assert.match(composed.text, /AI product management/)
    assert.match(composed.text, /special context notes/)
    assert.doesNotMatch(composed.text, /climate_tech_ops|ai_product_management|special_context_notes/)
  } finally {
    process.env = prevEnv
  }
})

test("composeSharedOnboardingReply does not pressure shared onboarding reasks with slang", async () => {
  const db = makeFlagDb()
  let capturedSystemInputs: string[] = []
  const prevEnv = process.env
  process.env = {
    ...prevEnv,
    paSharedOnboardingAgenticSurface: "true",
    paBehaviorChoreographerEnabled: "true",
    paReactionTapbackEnabled: "false",
    paFindMatchToolEnabled: "false",
    paHumanizeRuntimeEnabled: "false",
    PA_SHARED_ONBOARDING_TEMPLATE_FALLBACK: "false",
  }

  try {
    const composed = await composeSharedOnboardingReply({
      store: {
        db,
        log: () => undefined,
        runAgentTurn: async ({ systemInputs }) => {
          capturedSystemInputs = systemInputs ?? []
          return { text: "Got it. What matters most in your next company: growth, compensation, stability, mission, learning, or something else?" }
        },
        createSession: () => ({
          async getSessionId() {
            return "sess-1"
          },
          async getItems() {
            return []
          },
          async addItems() {
            /* no-op */
          },
          async popItem() {
            return undefined
          },
          async clearSession() {
            /* no-op */
          },
        }),
      },
      userId: "reask-user",
      sessionId: "sess-1",
      turnId: "turn-reask",
      slot: "main_goal",
      mode: "reask",
      promptContext: { firstName: "Adam", recentCompanies: ["Tesla Inc"] },
      userMessage: "Sure",
      composeContext: buildSharedOnboardingComposeContext({
        inboundKind: "user_answer",
        routerResult: "reasked_question",
        slot: "main_goal",
        mode: "reask",
        userMessage: "Sure",
      }),
      agent,
    })

    assert.deepEqual(composed.slangPicked, [])
    assert.equal(capturedSystemInputs.some((input) => input.includes("FRIEND SLANG PALETTE")), false)
    assert.ok(
      capturedSystemInputs.some((input) => input.includes("No slang, meme phrases")),
      "surface intent should explicitly ban slangy reask openers",
    )
    assert.doesNotMatch(composed.text, /lowkey|manifest|deadass|fr\b/i)
  } finally {
    process.env = prevEnv
  }
})

test("composeSharedOnboardingReply gives reasks transcript memory and retries restart drafts", async () => {
  const db = makeFlagDb()
  let calls = 0
  let popCalls = 0
  let firstUserMessage = ""
  let retryUserMessage = ""
  let capturedSystemInputs: string[] = []
  let capturedHistory: unknown[] = []
  const prevEnv = process.env
  process.env = {
    ...prevEnv,
    paSharedOnboardingAgenticSurface: "true",
    paBehaviorChoreographerEnabled: "true",
    paReactionTapbackEnabled: "false",
    paFindMatchToolEnabled: "false",
    paHumanizeRuntimeEnabled: "true",
    PA_SHARED_ONBOARDING_TEMPLATE_FALLBACK: "false",
  }

  try {
    const composed = await composeSharedOnboardingReply({
      store: {
        db,
        log: () => undefined,
        runAgentTurn: async ({ userMessage, systemInputs, history }) => {
          calls += 1
          capturedSystemInputs = systemInputs ?? []
          capturedHistory = history ?? []
          if (calls === 1) {
            firstUserMessage = userMessage
            return { text: "manifesting—Hey Adam, I saw your resume come through. What matters most in your next company?" }
          }
          retryUserMessage = userMessage
          return { text: "Got it — I still need the preference piece first. What matters most in your next company?" }
        },
        createSession: () => ({
          async getSessionId() {
            return "sess-1"
          },
          async getItems() {
            return []
          },
          async addItems() {
            /* no-op */
          },
          async popItem() {
            popCalls += 1
            return undefined
          },
          async clearSession() {
            /* no-op */
          },
        }),
      },
      userId: "reask-memory-user",
      sessionId: "sess-1",
      turnId: "turn-reask-memory",
      slot: "main_goal",
      mode: "reask",
      promptContext: { firstName: "Adam", recentCompanies: ["Tesla Inc"] },
      userMessage: "Sure",
      recentMessages: [
        {
          role: "assistant",
          body: "lowkey manifest — What matters most in your next company?",
          createdAt: "2026-05-27T20:00:00.000Z",
        },
        { role: "user", body: "Sure", createdAt: "2026-05-27T20:01:00.000Z" },
      ],
      composeContext: buildSharedOnboardingComposeContext({
        inboundKind: "user_answer",
        routerResult: "reasked_question",
        slot: "main_goal",
        mode: "reask",
        userMessage: "Sure",
      }),
      agent,
    })

    assert.equal(calls, 2)
    assert.equal(popCalls, 1)
    assert.match(firstUserMessage, /candidate just replied: "Sure"/i)
    assert.match(firstUserMessage, /do not restart/i)
    assert.match(retryUserMessage, /previous draft restarted/i)
    assert.equal(capturedHistory.length, 2)
    assert.ok(
      capturedSystemInputs.some((input) => input.includes("Recent SMS transcript")),
      "reask composer should pass recent transcript as explicit context",
    )
    assert.ok(
      capturedSystemInputs.some((input) => input.includes("Do not copy odd prior Claire phrasing")),
      "reask composer should tell the model not to mirror awkward prior wording",
    )
    assert.doesNotMatch(composed.text, /lowkey|manifest|resume come through/i)
  } finally {
    process.env = prevEnv
  }
})

test("composeContext greeting_kickoff forces synthetic instruction even with non-empty userMessage", async () => {
  let capturedUserMessage = ""
  const db = makeFlagDb()
  const prevEnv = process.env
  process.env = {
    ...prevEnv,
    paSharedOnboardingAgenticSurface: "true",
    paBehaviorChoreographerEnabled: "false",
    paReactionTapbackEnabled: "false",
    paFindMatchToolEnabled: "false",
    paHumanizeRuntimeEnabled: "false",
    PA_SHARED_ONBOARDING_TEMPLATE_FALLBACK: "false",
  }

  try {
    await composeSharedOnboardingReply({
      store: {
        db,
        log: () => undefined,
        runAgentTurn: async ({ userMessage }) => {
          capturedUserMessage = userMessage
          return { text: "What are you looking for in your next role?" }
        },
        createSession: () => ({
          async getSessionId() {
            return "sess-1"
          },
          async getItems() {
            return []
          },
          async addItems() {
            /* no-op */
          },
          async popItem() {
            return undefined
          },
          async clearSession() {
            /* no-op */
          },
        }),
      },
      userId: "user-kickoff-belt",
      sessionId: "sess-1",
      turnId: "turn-belt",
      slot: "main_goal",
      mode: "ask",
      promptContext: {},
      userMessage: "Hello, WeKruit! I am excited to chat.",
      composeContext: kickoffContext,
      agent,
    })

    assert.match(capturedUserMessage, /\[ONBOARDING\]/)
    assert.doesNotMatch(capturedUserMessage, /excited to chat/i)
  } finally {
    process.env = prevEnv
  }
})
