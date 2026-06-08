/**
 * tracing.test.ts — the per-turn OpenAI trace anchor (T1/T2, Adam 2026-06-06 "add tracing so it's easier
 * to debug ONE conversation/session"). makeTurnTraceId produces the printable, deterministic `trace_<32hex>`
 * id that the `trace_exported {traceId, groupId, userId, mode}` log line emits — the bridge from a Cloud
 * Logging row to the exact OpenAI trace. groupId=sessionId groups the whole conversation in the UI.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { makeTurnTraceId } from "./agent.js"

test("makeTurnTraceId: valid OpenAI trace id shape — trace_ + 32 lowercase hex", () => {
  const id = makeTurnTraceId("sess-1", "user-1", "2026-06-06T00:00:00.000Z")
  assert.match(id, /^trace_[0-9a-f]{32}$/, "must be the SDK-accepted trace_<32 hex> shape")
})

test("makeTurnTraceId: deterministic for the same (sessionId, userId, turn stamp) — dedupes a webhook replay", () => {
  const a = makeTurnTraceId("sess-1", "user-1", "2026-06-06T00:00:00.000Z")
  const b = makeTurnTraceId("sess-1", "user-1", "2026-06-06T00:00:00.000Z")
  assert.equal(a, b, "same inputs → same id (a redelivered Sendblue webhook within the turn stamp reuses it)")
})

test("makeTurnTraceId: distinct per turn (different stamp) and per session/user", () => {
  const base = makeTurnTraceId("sess-1", "user-1", "2026-06-06T00:00:00.000Z")
  assert.notEqual(base, makeTurnTraceId("sess-1", "user-1", "2026-06-06T00:00:01.000Z"), "different turn → different id")
  assert.notEqual(base, makeTurnTraceId("sess-2", "user-1", "2026-06-06T00:00:00.000Z"), "different session → different id")
  assert.notEqual(base, makeTurnTraceId("sess-1", "user-2", "2026-06-06T00:00:00.000Z"), "different user → different id")
})
