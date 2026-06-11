/**
 * candidate-context.test.ts — the employer-background one-liner (Adam 2026-06-10).
 *
 * `renderEmployerBackgroundLine` is the pure renderer of the derived employer-history signals
 * (employer-signals.ts seam → pa-users.tags) into ONE plain-English agent-context line. Legacy
 * users (no signals) MUST get "" so their context block stays byte-identical.
 *
 *   node --import tsx --test apps/functions/src/claire-agent/candidate-context.test.ts
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { renderEmployerBackgroundLine } from "./candidate-context.js"

test("renderEmployerBackgroundLine: no signals → empty string (legacy context byte-identical)", () => {
  assert.equal(renderEmployerBackgroundLine({}), "")
  assert.equal(
    renderEmployerBackgroundLine({ recentRoleTitle: "SWE", skills: [{ name: "python" }] }),
    "",
    "non-employer tags alone never produce the line",
  )
})

test("renderEmployerBackgroundLine: full signals render one plain-English line", () => {
  const line = renderEmployerBackgroundLine({
    founderRole: true,
    hasBigTechBackground: true,
    employerGrowthTier: "growth",
    scopeOfOwnership: { teamSize: 5, revenue: "$2M ARR", users: 5000 },
    selectivitySignals: ["Top 0.1% of 390K", "YC W23", "third honor (clipped)"],
  })
  assert.match(line, /^EMPLOYER BACKGROUND/)
  assert.match(line, /founder\/0→1 experience/)
  assert.match(line, /big-tech employer history/)
  assert.match(line, /growth-stage startup history/)
  assert.match(line, /led team of 5/)
  assert.match(line, /owned \$2M ARR/)
  assert.match(line, /served 5000 users/)
  assert.match(line, /honors: Top 0\.1% of 390K, YC W23/)
  assert.ok(!line.includes("third honor"), "honors clipped to 2 for a one-liner")
  assert.ok(!line.includes("\n"), "single line")
})

test("renderEmployerBackgroundLine: growth tiers map to plain English; junk values omitted", () => {
  assert.match(renderEmployerBackgroundLine({ employerGrowthTier: "early_stage" }), /early-stage startup history/)
  assert.match(renderEmployerBackgroundLine({ employerGrowthTier: "mature" }), /mature-company history/)
  // "unknown" / off-vocab tiers say nothing.
  assert.equal(renderEmployerBackgroundLine({ employerGrowthTier: "unknown" }), "")
  assert.equal(renderEmployerBackgroundLine({ employerGrowthTier: 42 as unknown as string }), "")
  // booleans must be literal true (never truthy strings)
  assert.equal(renderEmployerBackgroundLine({ founderRole: "yes" }), "")
})
