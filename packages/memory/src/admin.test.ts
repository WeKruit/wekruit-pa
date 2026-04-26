import assert from "node:assert/strict"
import test from "node:test"
import { isResetCommand, RESET_PATTERNS, summarizeClearResult } from "./admin.js"

test("isResetCommand matches all canonical patterns and ignores surrounding whitespace", () => {
  for (const p of RESET_PATTERNS) {
    assert.equal(isResetCommand(p), true, `should match canonical: ${p}`)
    assert.equal(isResetCommand(`  ${p}  `), true, `should match with whitespace: ${p}`)
  }
})

test("isResetCommand is case-insensitive for ASCII patterns only", () => {
  assert.equal(isResetCommand("__pa_reset__"), true)
  assert.equal(isResetCommand("__Pa_Reset__"), true)
  assert.equal(isResetCommand("/PA-RESET"), true)
  // Chinese pattern is exact-match only (no case folding for CJK)
  assert.equal(isResetCommand("重置我的记忆"), true)
})

test("isResetCommand rejects partial / surrounding text (must be full body)", () => {
  assert.equal(isResetCommand("hello __PA_RESET__"), false)
  assert.equal(isResetCommand("__PA_RESET__ now"), false)
  assert.equal(isResetCommand("请重置我的记忆吧"), false)
  assert.equal(isResetCommand("normal user message"), false)
  assert.equal(isResetCommand(""), false)
  assert.equal(isResetCommand("   "), false)
})

test("summarizeClearResult produces a tester-readable line for live runs", () => {
  const out = summarizeClearResult({
    userId: "u1",
    dryRun: false,
    qdrant: { collection: "pa_memory", matched: 7, deleted: true },
    firestore: { pa_memory_facts: 2, pa_messages: 18, pa_memory_actions: 0 },
  })
  assert.match(out, /✓ 测试记忆已清空/)
  assert.match(out, /pa_memory=7/)
  assert.match(out, /pa_memory_facts=2/)
  assert.match(out, /pa_messages=18/)
  assert.doesNotMatch(out, /pa_memory_actions=0/)
})

test("summarizeClearResult flags dry-run results distinctly", () => {
  const out = summarizeClearResult({
    userId: "u1",
    dryRun: true,
    qdrant: { collection: "pa_memory", matched: 0, deleted: false },
    firestore: {},
  })
  assert.match(out, /\[DRY-RUN\]/)
  assert.match(out, /all empty/)
})
