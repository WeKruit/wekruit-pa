import assert from "node:assert/strict"
import test from "node:test"
import { findMatchingFacts, parseMemoryCommand, shouldRejectMemoryFact } from "./commands.js"

test("parseMemoryCommand recognizes iMessage memory controls", () => {
  assert.deepEqual(parseMemoryCommand("记住 我喜欢喝冰美式"), {
    kind: "remember",
    content: "我喜欢喝冰美式",
  })
  assert.deepEqual(parseMemoryCommand("我的记忆"), { kind: "list" })
  assert.deepEqual(parseMemoryCommand("忘记 冰美式"), {
    kind: "forget",
    query: "冰美式",
  })
  assert.deepEqual(parseMemoryCommand("清空记忆"), { kind: "clear_request" })
  assert.deepEqual(parseMemoryCommand("确认清空记忆"), { kind: "clear_confirm" })
  assert.equal(parseMemoryCommand("今天怎么样？"), null)
})

test("shouldRejectMemoryFact blocks sensitive facts by default", () => {
  assert.equal(shouldRejectMemoryFact("我的 OpenAI API key 是 sk-abc123").reject, true)
  assert.equal(shouldRejectMemoryFact("我的 SSN 是 123-45-6789").reject, true)
  assert.equal(shouldRejectMemoryFact("我的信用卡号是 4242 4242 4242 4242").reject, true)
  assert.equal(shouldRejectMemoryFact("我喜欢周二下午练系统设计").reject, false)
})

test("findMatchingFacts returns exact and ambiguous matches", () => {
  const facts = [
    { id: "f1", content: "我喜欢喝冰美式" },
    { id: "f2", content: "我周二下午练系统设计" },
    { id: "f3", content: "我喜欢短回复" },
  ]
  assert.deepEqual(findMatchingFacts(facts, "系统设计").map((f) => f.id), ["f2"])
  assert.deepEqual(findMatchingFacts(facts, "喜欢").map((f) => f.id), ["f1", "f3"])
  assert.deepEqual(findMatchingFacts(facts, "不存在"), [])
})
