import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import type { AgentDef } from "@pa/core-types"
import {
  buildSharedOnboardingComposeContext,
  composeSharedOnboardingReply,
  effectiveOnboardingComposeUserMessage,
} from "../shared-onboarding-outbound.js"

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

test("composeSharedOnboardingReply passes synthetic onboarding instruction for greeting kickoff", async () => {
  let capturedUserMessage = ""
  const db = makeFlagDb()
  const env = {
    paSharedOnboardingAgenticSurface: "true",
    paBehaviorChoreographerEnabled: "false",
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
          return { text: "Hey! What kind of role are you aiming for right now?" }
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
      promptContext: { firstName: "Test" },
      userMessage: "Hello, WeKruit!",
      composeContext: kickoffContext,
      agent,
    })

    assert.match(composed.text, /role/i)
    assert.ok(Array.isArray(composed.slangPicked))
    assert.match(capturedUserMessage, /\[ONBOARDING\].*main_goal/)
    assert.doesNotMatch(capturedUserMessage, /Hello, WeKruit/i)
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
