/**
 * Phase 13 T13.5 — pure-logic tests for the dashboard's
 * `renderToolCallSummary` helper. Run via:
 *
 *   node --import tsx --test apps/dashboard-web/src/pages/Operations.test.ts
 *
 * The dashboard package has no `test` script today (Vite-only), so this
 * file is opt-in. The helper itself is exercised by typecheck on the
 * dashboard build, but these assertions cover the rendering semantics
 * for both happy and degraded paths.
 */
import test from "node:test"
import assert from "node:assert/strict"
import { renderToolCallSummary } from "./toolCallSummary.js"

test("renderToolCallSummary: passes through non-matching connector rows untouched", () => {
  const row = {
    connectorName: "remember-fact",
    resultSummary: '{"ok":true,"factId":"f1"}',
  }
  assert.equal(renderToolCallSummary(row), '{"ok":true,"factId":"f1"}')
})

test("renderToolCallSummary: degraded mode surfaces (degraded:reason) tag", () => {
  const row = {
    connectorName: "wekruit-matching",
    resultSummary: JSON.stringify({
      ok: false,
      source: "wekruit-matching",
      reason: "matching_service_not_configured",
      summary: "暂时无法获取匹配结果，请稍后再试。",
      roles: null,
    }),
  }
  const out = renderToolCallSummary(row)
  assert.match(out, /\(degraded:matching_service_not_configured\)/)
  assert.match(out, /暂时无法获取匹配结果/)
})

test("renderToolCallSummary: happy path renders rank + title + fitScore", () => {
  const row = {
    connectorName: "wekruit-matching",
    resultSummary: JSON.stringify({
      ok: true,
      source: "wekruit-matching",
      reason: null,
      summary: "matched 2",
      roles: [
        { roleId: "r1", title: "Frontend Engineer", company: "WeKruit", fitScore: 0.92, applyUrl: null, summary: "" },
        { roleId: "r2", title: "Full-Stack Engineer", company: "Acme", fitScore: 0.81, applyUrl: null, summary: "" },
      ],
    }),
  }
  const out = renderToolCallSummary(row)
  assert.match(out, /#1 Frontend Engineer \(0\.92\)/)
  assert.match(out, /#2 Full-Stack Engineer \(0\.81\)/)
  assert.match(out, /\|/, "rows joined by pipe")
})

test("renderToolCallSummary: empty/null roles falls back to summary", () => {
  const row = {
    connectorName: "wekruit-matching",
    resultSummary: JSON.stringify({
      ok: true,
      source: "wekruit-matching",
      reason: null,
      summary: "暂时没有合适的岗位推荐。",
      roles: null,
    }),
  }
  assert.equal(renderToolCallSummary(row), "暂时没有合适的岗位推荐。")
})

test("renderToolCallSummary: malformed JSON falls back to raw text (legacy/regression safe)", () => {
  const row = {
    connectorName: "wekruit-matching",
    resultSummary: "not even json",
  }
  assert.equal(renderToolCallSummary(row), "not even json")
})

test("renderToolCallSummary: missing resultSummary returns empty string", () => {
  const row = { connectorName: "wekruit-matching" }
  assert.equal(renderToolCallSummary(row), "")
})

test("renderToolCallSummary: legacy wekruit-matching row from old schema (no roles key) renders summary cleanly", () => {
  // Pre-Phase-13 the connector returned just {ok, source, summary}. The
  // dashboard must still render those rows without crashing.
  const row = {
    connectorName: "wekruit-matching",
    resultSummary: JSON.stringify({
      ok: false,
      source: "wekruit-matching",
      summary: "PA_MATCHING_URL is not configured; connector policy/audit path executed only.",
    }),
  }
  const out = renderToolCallSummary(row)
  // Legacy row has ok:false but no `reason`; helper falls back to "unknown".
  assert.match(out, /degraded:unknown/)
  assert.match(out, /PA_MATCHING_URL is not configured/)
})
