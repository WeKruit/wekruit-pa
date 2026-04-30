import assert from "node:assert/strict"
import test from "node:test"
import type OpenAI from "openai"
import {
  _resetNlJudgeClient,
  _setNlJudgeClient,
  defaultNlJudge,
} from "./eval-nl-judge.js"

/**
 * Build a minimal OpenAI-shaped stub. Only `chat.completions.create` is
 * exercised by `defaultNlJudge`, so we satisfy that signature and ignore
 * the rest of the SDK surface.
 */
function fakeClient(impl: (req: unknown) => Promise<{ choices: Array<{ message: { content: string } }> }>): OpenAI {
  return {
    chat: {
      completions: {
        create: impl,
      },
    },
  } as unknown as OpenAI
}

interface CapturedReq {
  messages: Array<{ role: string; content: string }>
  max_tokens: number
  temperature: number
  model: string
}

test("defaultNlJudge: returns 'yes' when nano answers yes", async () => {
  _resetNlJudgeClient()
  let captured: CapturedReq | null = null
  _setNlJudgeClient(
    fakeClient(async (req) => {
      captured = req as CapturedReq
      return { choices: [{ message: { content: "yes" } }] }
    })
  )
  const out = await defaultNlJudge({
    prompt: "Did the user mention being laid off?",
    userTurn: "I just got laid off last week",
    assistantTurn: "I'm sorry to hear that.",
  })
  assert.equal(out, "yes")
  assert.ok(captured, "expected request to be captured")
  const c = captured as CapturedReq
  // Hard cap on prompt budget — 6 tokens is plenty for "Yes."
  assert.equal(c.max_tokens, 6)
  // Deterministic — temperature 0 so the same turn is always classified the same.
  assert.equal(c.temperature, 0)
  // Both turns appear in the user message body.
  const userMsg = c.messages.find((m) => m.role === "user")?.content ?? ""
  assert.match(userMsg, /laid off last week/)
  assert.match(userMsg, /sorry to hear/)
})

test("defaultNlJudge: returns 'no' when nano answers no", async () => {
  _resetNlJudgeClient()
  _setNlJudgeClient(
    fakeClient(async () => ({ choices: [{ message: { content: "No" } }] }))
  )
  const out = await defaultNlJudge({
    prompt: "Did the user mention being laid off?",
    userTurn: "Doing fine, just busy",
    assistantTurn: "Glad to hear",
  })
  // Lower-cased — caller's parser does first-token-yes match so case doesn't
  // matter, but defaultNlJudge normalizes anyway for predictability.
  assert.equal(out, "no")
})

test("defaultNlJudge: trims whitespace + lowercases ('  Yes.\\n' → 'yes.')", async () => {
  _resetNlJudgeClient()
  _setNlJudgeClient(
    fakeClient(async () => ({ choices: [{ message: { content: "  Yes.\n" } }] }))
  )
  const out = await defaultNlJudge({ prompt: "?", userTurn: "u", assistantTurn: "a" })
  assert.equal(out, "yes.")
})

test("defaultNlJudge: NEVER throws — returns '' on network error", async () => {
  _resetNlJudgeClient()
  _setNlJudgeClient(
    fakeClient(async () => {
      throw new Error("ECONNREFUSED")
    })
  )
  const out = await defaultNlJudge({ prompt: "?", userTurn: "u", assistantTurn: "a" })
  assert.equal(out, "")
})

test("defaultNlJudge: NEVER throws — returns '' on timeout abort", async () => {
  _resetNlJudgeClient()
  _setNlJudgeClient(
    fakeClient(async () => {
      // Simulate the abort path the AbortController would trigger.
      throw new Error("Request was aborted")
    })
  )
  const out = await defaultNlJudge({ prompt: "?", userTurn: "u", assistantTurn: "a" })
  assert.equal(out, "")
})

test("defaultNlJudge: empty content → empty string (caller's no-match)", async () => {
  _resetNlJudgeClient()
  _setNlJudgeClient(fakeClient(async () => ({ choices: [{ message: { content: "" } }] })))
  const out = await defaultNlJudge({ prompt: "?", userTurn: "u", assistantTurn: "a" })
  assert.equal(out, "")
})

test("defaultNlJudge: honors per-trigger model override", async () => {
  _resetNlJudgeClient()
  let usedModel: string | null = null
  _setNlJudgeClient(
    fakeClient(async (req) => {
      usedModel = (req as { model: string }).model
      return { choices: [{ message: { content: "yes" } }] }
    })
  )
  await defaultNlJudge({ prompt: "?", userTurn: "u", assistantTurn: "a", model: "custom-model-name" })
  assert.equal(usedModel, "custom-model-name")
})

test("defaultNlJudge: truncates very long turns to 1500 chars each", async () => {
  _resetNlJudgeClient()
  let captured: string = ""
  _setNlJudgeClient(
    fakeClient(async (req) => {
      const r = req as { messages: Array<{ role: string; content: string }> }
      captured = r.messages.find((m) => m.role === "user")?.content ?? ""
      return { choices: [{ message: { content: "yes" } }] }
    })
  )
  const longInput = "x".repeat(5000)
  await defaultNlJudge({ prompt: "Q", userTurn: longInput, assistantTurn: longInput })
  // Each turn capped to 1500 chars; total user-msg body well under model limit.
  assert.ok(captured.length < 5000, `expected truncation; got len=${captured.length}`)
})
