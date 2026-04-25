import assert from "node:assert/strict"
import test from "node:test"
import { toOpenAIMessages } from "./messages.js"

test("toOpenAIMessages tells the model to use visible transcript and includes timestamps", () => {
  const messages = toOpenAIMessages("Be helpful.", null, [
    { role: "user", body: "hello", createdAt: "2026-01-01T00:00:00.000Z" },
    { role: "assistant", body: "hi", createdAt: "2026-01-01T00:00:02.000Z" },
  ])

  assert.equal(messages[0].role, "system")
  assert.match(String(messages[0].content), /You may use the visible recent transcript/)
  assert.deepEqual(messages.slice(1), [
    { role: "user", content: "[2026-01-01T00:00:00.000Z] hello" },
    { role: "assistant", content: "[2026-01-01T00:00:02.000Z] hi" },
  ])
})
