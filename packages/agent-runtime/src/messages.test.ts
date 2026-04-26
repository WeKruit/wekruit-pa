import assert from "node:assert/strict"
import test from "node:test"
import { stripLeadingIsoTimestamp, toOpenAIMessages } from "./messages.js"

test("toOpenAIMessages does not prefix history with [ISO timestamp] (model was echoing it back)", () => {
  const messages = toOpenAIMessages("Be helpful.", null, [
    { role: "user", body: "hello", createdAt: "2026-01-01T00:00:00.000Z" },
    { role: "assistant", body: "hi", createdAt: "2026-01-01T00:00:02.000Z" },
  ])

  assert.equal(messages[0].role, "system")
  assert.match(String(messages[0].content), /You may use the visible recent transcript/)
  assert.match(String(messages[0].content), /Never prefix replies with timestamps/)
  assert.deepEqual(messages.slice(1), [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
  ])
})

test("toOpenAIMessages strips a [ISO] prefix that may already be persisted in pa_messages", () => {
  const messages = toOpenAIMessages("Be helpful.", null, [
    { role: "assistant", body: "[2026-04-26T03:53:44.112Z] 吃完饭再做作业也不错" },
    { role: "user", body: "[2026-04-26T03:54:00Z] 谢谢" },
  ])
  assert.equal(messages[1].content, "吃完饭再做作业也不错")
  assert.equal(messages[2].content, "谢谢")
})

test("stripLeadingIsoTimestamp removes only the leading marker, preserves body", () => {
  assert.equal(stripLeadingIsoTimestamp("[2026-04-26T03:53:44.112Z] hello"), "hello")
  assert.equal(stripLeadingIsoTimestamp("[2026-04-26T03:53:44Z]  hi  there"), "hi  there")
  assert.equal(stripLeadingIsoTimestamp("hello [2026-04-26T03:53:44Z]"), "hello [2026-04-26T03:53:44Z]")
  assert.equal(stripLeadingIsoTimestamp("plain text"), "plain text")
})
