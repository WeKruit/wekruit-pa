/**
 * Unit tests for few-shot.ts helpers.
 * Phase 24 T1B — verifies buildFewShotTurns + prefixFewShotToHistory + fs_* filter.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { buildFewShotTurns, prefixFewShotToHistory } from "./few-shot.js"
import type { FewShotTurn } from "./few-shot.js"

const SAMPLE_TURNS: FewShotTurn[] = [
  { role: "user", content: "我又被拒了 emo 中" },
  { role: "assistant", content: "拒得快说明他们没准备好你. next." },
]

test("buildFewShotTurns returns [] when agent.fewShotMessages undefined", () => {
  const agent = { id: "test", systemPrompt: "s", name: "a", model: "m", provider: "openai" } as never
  const result = buildFewShotTurns(agent)
  assert.deepEqual(result, [])
})

test("buildFewShotTurns returns the array unchanged when fewShotMessages present", () => {
  const agent = {
    id: "test", systemPrompt: "s", name: "a", model: "m", provider: "openai",
    fewShotMessages: SAMPLE_TURNS,
  } as never
  const result = buildFewShotTurns(agent)
  assert.deepEqual(result, SAMPLE_TURNS)
})

test("prefixFewShotToHistory with 2 fewshot turns + 1 real turn returns length 3 with fs_0 fs_1 ids", () => {
  const history = [{ id: "real_001", role: "user", body: "hello", sessionId: "s1", userId: "u1", createdAt: "" }]
  const result = prefixFewShotToHistory(SAMPLE_TURNS, history)
  assert.equal(result.length, 3)
  assert.equal(result[0]!.id, "fs_0")
  assert.equal(result[1]!.id, "fs_1")
  assert.equal(result[2]!.id, "real_001")
})

test("prefixFewShotToHistory with empty fewshot array returns history unchanged in length", () => {
  const history = [
    { id: "real_001", role: "user", body: "msg1", sessionId: "s1", userId: "u1", createdAt: "" },
    { id: "real_002", role: "assistant", body: "msg2", sessionId: "s1", userId: "u1", createdAt: "" },
  ]
  const result = prefixFewShotToHistory([], history)
  assert.equal(result.length, history.length)
  assert.deepEqual(result, history)
})

test("filtering messages where !id.startsWith('fs_') on 2-real + 2-synthetic yields 2-real", () => {
  const mixed = [
    { role: "user", content: "synthetic 1", id: "fs_0" },
    { role: "assistant", content: "synthetic 2", id: "fs_1" },
    { role: "user", content: "real msg 1", id: "real_001" },
    { role: "assistant", content: "real msg 2", id: "real_002" },
  ]
  const real = mixed.filter((m) => !m.id?.startsWith("fs_"))
  assert.equal(real.length, 2)
  assert.equal(real[0]!.id, "real_001")
  assert.equal(real[1]!.id, "real_002")
})
