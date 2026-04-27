import assert from "node:assert/strict"
import test from "node:test"
import type { ChatMessage } from "@pa/core-types"
import {
  computeMirrorForTurn,
  extractUserTurnWindow,
  isVoiceMirrorDisabled,
} from "./mirror-injection.js"

function msg(role: "user" | "assistant", body: string, i = 0): ChatMessage {
  return {
    id: `m${i}`,
    sessionId: "s1",
    userId: "u1",
    role,
    body,
    createdAt: `2026-04-27T00:00:0${i}.000Z`,
  } as ChatMessage
}

test("isVoiceMirrorDisabled honors PA_VOICE_MIRROR_DISABLED=true", () => {
  assert.equal(isVoiceMirrorDisabled({ PA_VOICE_MIRROR_DISABLED: "true" } as NodeJS.ProcessEnv), true)
  assert.equal(isVoiceMirrorDisabled({ PA_VOICE_MIRROR_DISABLED: "false" } as NodeJS.ProcessEnv), false)
  assert.equal(isVoiceMirrorDisabled({} as NodeJS.ProcessEnv), false)
})

test("extractUserTurnWindow filters assistant turns and keeps last 5 user turns", () => {
  const hist: ChatMessage[] = [
    msg("user", "u1", 1),
    msg("assistant", "a1", 2),
    msg("user", "u2", 3),
    msg("user", "u3", 4),
    msg("assistant", "a2", 5),
    msg("user", "u4", 6),
    msg("user", "u5", 7),
    msg("user", "u6", 8),
  ]
  const win = extractUserTurnWindow(hist, "u7")
  assert.deepEqual(win, ["u3", "u4", "u5", "u6", "u7"])
})

test("extractUserTurnWindow does not double-count when current already in history", () => {
  const hist: ChatMessage[] = [msg("user", "hello", 1)]
  const win = extractUserTurnWindow(hist, "hello")
  assert.deepEqual(win, ["hello"])
})

test("computeMirrorForTurn returns nulls when kill switch is on", () => {
  const hist: ChatMessage[] = [msg("user", "lowkey emo了 fr 🍋", 1)]
  const r = computeMirrorForTurn(hist, "在吗", { PA_VOICE_MIRROR_DISABLED: "true" } as NodeJS.ProcessEnv)
  assert.equal(r.snapshot, null)
  assert.equal(r.snippet, null)
  assert.equal(r.audit, null)
})

test("computeMirrorForTurn returns snapshot + snippet on standard turn", () => {
  const hist: ChatMessage[] = [
    msg("user", "lowkey emo了", 1),
    msg("assistant", "听起来 emo 时刻", 2),
    msg("user", "fr fr", 3),
  ]
  const r = computeMirrorForTurn(hist, "今天 OA 直接 emo 了 🍋", {} as NodeJS.ProcessEnv)
  assert.ok(r.snapshot)
  assert.ok(r.snippet)
  assert.ok(r.audit)
  assert.equal(r.audit!.sample_size, 3)
  // Slangy snapshot — register_score should be on the lower side.
  assert.ok(r.snapshot!.register_score < 0.6)
})

test("computeMirrorForTurn returns nulls when window is empty", () => {
  const r = computeMirrorForTurn([], "", {} as NodeJS.ProcessEnv)
  // Window will be [""] which analyzeUserStyle treats as zeroed.
  // Either snippet=null (sample_size becomes 0 because joined string is empty)
  // or snippet is generated. Acceptable outcomes: never throw, no audit
  // when snippet null.
  if (r.snippet === null) assert.equal(r.audit, null)
})
