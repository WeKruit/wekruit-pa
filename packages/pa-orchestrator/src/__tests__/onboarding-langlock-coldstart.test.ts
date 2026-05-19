/**
 * Phase 53 — Bug 2 fix unit tests: cold-start onboarding lang-lock hole.
 *
 * Background (Adam iMessage 2026-05-03 00:34 repro):
 *   Cold-start ZH user sent "我想找工作" + "swe的" + "yoe1年的". Claire's
 *   reply 2 came back EN+ZH-mixed ("yoe1 SWE. What kind of SWE..."). RCA
 *   showed the onboarding branch in `processInboundEvent` returns BEFORE
 *   the main-path post-gen langLock translate (Phase 11 hotfix v4) AND
 *   does not inject the langLock pre-gen sandwich either. Mirror of Bug A
 *   pattern (crisis-hotline cold-start hole).
 *
 * Current architecture: cold-start onboarding no longer calls the LLM-compose
 * branch. The runtime pipeline emits its prompt directly, and seeds prompt
 * language from the user's current message or stored preference.
 *   5. Main-path regression: onboardingState=complete + ZH user → main
 *      path lang-lock still fires (helper extraction did not break main path).
 *   6. Pre-gen sandwich content: systemPrompt passed to runAgentTurn for ZH
 *      user contains the ZH LANGUAGE-LOCK directive at top + FINAL-REMINDER
 *      at bottom (string-level proof langLock pre-gen is wired in onboarding).
 */
import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import type {
  AgentDef,
  InboundEvent,
  MemoryFact,
  User,
} from "@pa/core-types"
import { processInboundEvent, type OrchestratorStore } from "../index.js"

// ---------- Fixture: minimal agent + base event ----------------------------

const agent: AgentDef = {
  id: "default",
  name: "Claire",
  systemPrompt:
    "# IDENTITY\nYou are Claire. First message: 在呢. 今天找你聊点啥? 🍋",
  provider: "openai",
  model: "gpt-5.4-nano",
  temperature: 0.7,
  memoryMode: "firestore_only",
  toolPolicy: "none",
  version: "phase53",
}

const baseUser: User = {
  id: "u-coldstart-langlock",
  phoneE164: "+19999991010",
  createdAt: "2026-05-02T00:00:00.000Z",
  onboardingStatus: "pending",
  onboardingState: undefined, // fresh user — triggers onboarding branch
}

const baseEvent: InboundEvent = {
  id: "evt-coldstart-ll-1",
  userId: baseUser.id,
  sessionId: "s-coldstart-ll",
  channel: "imessage",
  externalChatId: baseUser.phoneE164,
  from: baseUser.phoneE164,
  body: "placeholder",
  status: "pending",
  createdAt: "2026-05-02T12:00:00.000Z",
  idempotencyKey: "imessage-in-coldstart-ll-1",
}

// ---------- fakeStore ------------------------------------------------------

interface ColdStartLangCaptures {
  outboundBodies: string[]
  systemPrompts: string[]
  userMessages: string[]
  systemInputs: string[][]
  llmCalls: number
  logs: Array<{ event: string; payload: Record<string, unknown> }>
}

interface MakeStoreOpts {
  llmReplyBody?: string
  onboardingState?:
    | "pending"
    | "first_mes_sent"
    | "grounding_q1_asked"
    | "q_role_asked"
    | "q_yoe_asked"
    | "q_visa_asked"
    | "q_startup_pref_asked"
    | "q_location_asked"
    | "complete"
}

function makeStore(
  captures: ColdStartLangCaptures,
  opts: MakeStoreOpts = {}
): OrchestratorStore {
  const facts: MemoryFact[] = []
  const replyBody = opts.llmReplyBody ?? "在呢. 今天找你聊点啥? 🍋"
  return {
    markEventRunning: async () => undefined,
    markEventSucceeded: async () => undefined,
    markEventFailed: async () => undefined,
    createTurn: async () => "turn-coldstart-ll",
    updateTurn: async () => undefined,
    appendMessage: async () => undefined,
    getAgentForUser: async () => agent,
    getMem0UserId: async () => undefined,
    loadHistory: async () => [],
    enqueueOutbound: async (_uid, _to, body) => {
      captures.outboundBodies.push(body)
    },
    listMemoryFacts: async () => facts,
    createMemoryFact: async () => "f1",
    deleteMemoryFacts: async () => undefined,
    recordMemoryAction: async () => undefined,
    loadPersonalizationContext: async () => ({
      memoryBlock: null,
      mem0Degraded: false,
      mem0SearchResultCount: 0,
      mem0DegradedReason: null,
    }),
    createSession: () => ({
      async getSessionId() {
        return "s-coldstart-ll"
      },
      async getItems() {
        return []
      },
      async addItems() {},
      async popItem() {
        return undefined
      },
      async clearSession() {},
    }),
    runAgentTurn: async ({ systemPrompt, userMessage, systemInputs }) => {
      captures.llmCalls++
      captures.systemPrompts.push(systemPrompt ?? "")
      captures.userMessages.push(userMessage ?? "")
      captures.systemInputs.push(systemInputs ?? [])
      return { text: replyBody }
    },
    afterAssistantTurn: async () => ({
      writebackRan: false,
      writebackSkipReason: "memory_mode",
    }),
    maybeHandleResetCommand: async () => ({ handled: false }),
    buildTurnTools: async () => [],
    recordHostedToolCalls: async () => undefined,
    nowIso: () => "2026-05-02T12:00:00.000Z",
    log: (...args: unknown[]) => {
      const [event, payload] = args
      if (typeof event === "string") {
        captures.logs.push({
          event,
          payload: (payload as Record<string, unknown>) ?? {},
        })
      }
    },
    checkInboundSafety: async () => ({ allow: true }),
    cancelAllPendingProactiveJobs: async () => 0,
    writeProactiveCancelAudit: async () => undefined,
    getOnboardingUser: async () => ({
      id: baseUser.id,
      phoneE164: baseUser.phoneE164,
      onboardingState: opts.onboardingState,
    }),
    applyOnboarding: async () => undefined,
    db: undefined as Firestore | undefined,
  }
}

function emptyCaptures(): ColdStartLangCaptures {
  return {
    outboundBodies: [],
    systemPrompts: [],
    userMessages: [],
    systemInputs: [],
    llmCalls: 0,
    logs: [],
  }
}

// ============================================================================
// Test 1 — Cold-start ZH user: manual SMS onboarding is gated to the website.
// ============================================================================
test("coldstart-langlock: ZH user '我想找工作' → website start gate without LLM", async () => {
  const captures = emptyCaptures()
  const store = makeStore(captures, {
    // Already-ZH onboarding greeting — no translate needed.
    llmReplyBody: "在呢. 今天找你聊点啥? 🍋",
  })
  await processInboundEvent(
    { ...baseEvent, body: "我想找工作" },
    store
  )
  assert.equal(captures.llmCalls, 0)
  assert.equal(captures.outboundBodies.length, 1)
  // 2026-05-19 — shared_onboarding bootstrap owns cold-start Q1, no URL redirect.
  assert.doesNotMatch(captures.outboundBodies[0] ?? "", /candidate\.wekruit\.com\/onboarding/i)
  assert.match(captures.outboundBodies[0] ?? "", /matters most in your next company/)
  assert.doesNotMatch(captures.outboundBodies[0] ?? "", /email/i)
  assert.deepEqual(captures.systemPrompts, [])
  assert.deepEqual(captures.userMessages, [])
  // No translate event fired — reply was already ZH.
  const applied = captures.logs.find(
    (l) => l.event === "pa.voice.lang_translate.applied"
  )
  assert.equal(applied, undefined, "no translate should fire when reply already ZH")
})

// ============================================================================
// Test 2 — Cold-start EN user: runtime pipeline does not start from manual SMS.
// ============================================================================
test("coldstart-langlock: EN user 'I want a job' → website start gate without LLM", async () => {
  const captures = emptyCaptures()
  const store = makeStore(captures, {
    llmReplyBody: "yo, what kinda role you eyeing?",
  })
  await processInboundEvent(
    { ...baseEvent, id: "evt-en-ll", body: "I want a job" },
    store
  )
  assert.equal(captures.llmCalls, 0)
  // 2026-05-19 — shared_onboarding bootstrap owns cold-start Q1, no URL redirect.
  assert.doesNotMatch(captures.outboundBodies[0] ?? "", /candidate\.wekruit\.com\/onboarding/i)
  assert.match(captures.outboundBodies[0] ?? "", /matters most in your next company/)
  assert.doesNotMatch(captures.outboundBodies[0] ?? "", /email/i)
  assert.deepEqual(captures.systemPrompts, [])
  assert.deepEqual(captures.userMessages, [])
})

// ============================================================================
// Test 3 — ZH-frame with EN loanword "swe的": website start gate owns.
// ============================================================================
test("coldstart-langlock: 'swe的' → website start gate, no LLM lang-lock path", async () => {
  const captures = emptyCaptures()
  const store = makeStore(captures, {
    llmReplyBody: "在呢. 今天找你聊点啥? 🍋",
  })
  await processInboundEvent(
    { ...baseEvent, id: "evt-bug2", body: "swe的" },
    store
  )
  assert.equal(captures.llmCalls, 0)
  // 2026-05-19 — shared_onboarding bootstrap owns cold-start Q1, no URL redirect.
  assert.doesNotMatch(captures.outboundBodies[0] ?? "", /candidate\.wekruit\.com\/onboarding/i)
  assert.match(captures.outboundBodies[0] ?? "", /matters most in your next company/)
  assert.doesNotMatch(captures.outboundBodies[0] ?? "", /email/i)
  assert.deepEqual(captures.systemPrompts, [])
  assert.deepEqual(captures.userMessages, [])
})

// ============================================================================
// Test 4 — Cold-start mixed "yoe1年的" stays in website start gate mode.
// ============================================================================
test("coldstart-langlock: 'yoe1年的' → website start gate, no LLM lang-lock path", async () => {
  const captures = emptyCaptures()
  const store = makeStore(captures, {
    llmReplyBody: "在呢. 今天找你聊点啥? 🍋",
  })
  await processInboundEvent(
    { ...baseEvent, id: "evt-bug2-yoe", body: "yoe1年的" },
    store
  )
  assert.equal(captures.llmCalls, 0)
  // 2026-05-19 — shared_onboarding bootstrap owns cold-start Q1, no URL redirect.
  assert.doesNotMatch(captures.outboundBodies[0] ?? "", /candidate\.wekruit\.com\/onboarding/i)
  assert.match(captures.outboundBodies[0] ?? "", /matters most in your next company/)
  assert.doesNotMatch(captures.outboundBodies[0] ?? "", /email/i)
  assert.deepEqual(captures.systemPrompts, [])
})

// ============================================================================
// Test 5 — Main-path regression: onboardingState=complete + ZH user → main
// path lang-lock still fires (helper extraction did not break main path).
// ============================================================================
test("main-path-regression: onboardingState=complete + ZH user → main path langLock pre-gen still fires", async () => {
  const captures = emptyCaptures()
  const store = makeStore(captures, {
    onboardingState: "complete",
    llmReplyBody: "好的，给你看看 SWE 岗位",
  })
  await processInboundEvent(
    {
      ...baseEvent,
      id: "evt-mainpath-ll",
      body: "我想找工作",
    },
    store
  )
  // Main path also calls runAgentTurn — captures.systemPrompts[0] is from main.
  assert.ok(captures.systemPrompts.length >= 1)
  const sp = captures.systemPrompts[0]
  assert.ok(
    sp.includes("user_input_language: zh"),
    `main path must still inject ZH langLock (no regression from helper extraction). systemPrompt: ${sp.slice(0, 300)}`
  )
  assert.ok(
    sp.includes("[FINAL-REMINDER]"),
    "main path must still close with FINAL-REMINDER"
  )
  const um = captures.userMessages[0]
  assert.ok(
    um.includes("[SYSTEM-DIRECTIVE: 用中文回复"),
    `main path userMessage must still get ZH directive, got: ${um}`
  )
})

// ============================================================================
// Test 6 — Cold-start non-crisis greeting "你好" + ZH reply → telemetry MUST
// log NO translate-applied event (no needless Qwen call when reply already
// matches user lang). Cost-control regression.
// ============================================================================
test("coldstart-no-translate: ZH user '你好' + ZH reply → translate guard short-circuits (no Qwen call)", async () => {
  const captures = emptyCaptures()
  const store = makeStore(captures, {
    llmReplyBody: "在呢. 今天找你聊点啥? 🍋",
  })
  await processInboundEvent(
    { ...baseEvent, id: "evt-greet-ll", body: "你好" },
    store
  )
  // Verify no translate-applied / rejected / http_error fired (helper short-
  // circuited at "already_correct_lang").
  for (const evt of [
    "pa.voice.lang_translate.applied",
    "pa.voice.lang_translate.rejected",
    "pa.voice.lang_translate.http_error",
    "pa.voice.lang_translate.error",
  ]) {
    assert.equal(
      captures.logs.find((l) => l.event === evt),
      undefined,
      `${evt} must NOT fire when reply already correct-lang (short-circuit)`
    )
  }
})
