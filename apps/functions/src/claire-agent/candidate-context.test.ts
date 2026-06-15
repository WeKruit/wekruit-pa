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

// ── Adam 2026-06-12: state-aware prescreen context directives (Invoko PM live failure) ───────────
import { renderPrescreenContextText, terminalLabel, type CandidateScreenSession } from "./candidate-context.js"

function screen(partial: Partial<CandidateScreenSession>): CandidateScreenSession {
  return {
    sessionId: "s",
    jobId: "j",
    terminal: null,
    pendingReview: false,
    staleClosed: false,
    retentionStage: null,
    endedAtMs: null,
    ...partial,
  }
}

test("renderPrescreenContextText: an ACTIVE screen owns the turn — no matching offer directive", () => {
  const text = renderPrescreenContextText([
    screen({ sessionId: "a", jobTitle: "Product Manager", company: "Invoko", terminal: null }),
  ])
  assert.match(text, /AN ACTIVE SCREEN IS IN PROGRESS \(Product Manager @ Invoko\)/)
  assert.match(text, /Do NOT offer job matching/)
  assert.match(text, /say not yet and continue with the pending question/)
  assert.match(text, /it is Product Manager @ Invoko/)
  // the post-terminal matching-offer directive must NOT render while a screen is open.
  assert.doesNotMatch(text, /matching is back on the table/)
})

test("renderPrescreenContextText: a timed-out PAUSE gets the restart directive and NO matching offer", () => {
  const text = renderPrescreenContextText([
    screen({
      sessionId: "t",
      jobTitle: "Product Manager",
      company: "Invoko",
      terminal: "PAUSE",
      terminalReason: "expired_inactive_prescreen_session",
      staleClosed: true,
      endedAtMs: 10,
    }),
  ])
  assert.match(text, /TIMED OUT \(auto-closed after inactivity/)
  assert.match(text, /THEIR MOST RECENT SCREEN TIMED OUT/)
  assert.match(text, /reply 'restart screen'/)
  assert.match(text, /Do NOT offer job matching or 'want me to pull roles\?'/)
  assert.doesNotMatch(text, /matching is back on the table/)
  // status honesty: never under review, never "human review".
  assert.match(text, /never say it is under review/)
  assert.match(text, /Never use the words 'human review'/)
})

test("renderPrescreenContextText: a settled FAIL re-enables the natural matching offer", () => {
  const text = renderPrescreenContextText(
    [
      screen({
        sessionId: "f",
        jobTitle: "UI/UX Designer",
        company: "Acme",
        terminal: "FAIL",
        endedAtMs: 10,
      }),
    ],
    { profileSignalOnFile: true },
  )
  assert.match(text, /matching is back on the table/)
  assert.match(text, /find OTHER/)
  assert.match(text, /I can use your resume\/LinkedIn to find better-fit roles/)
  assert.doesNotMatch(text, /They have NO resume or LinkedIn on file/)
})

test("renderPrescreenContextText: rejection with NO profile signal asks for resume/LinkedIn first", () => {
  const text = renderPrescreenContextText(
    [screen({ sessionId: "f", terminal: "HARD_STOP", endedAtMs: 10 })],
    { profileSignalOnFile: false },
  )
  assert.match(text, /They have NO resume or LinkedIn on file/)
  assert.match(text, /instead of repeating screens/)
  assert.match(text, /ask if they want recommendations/)
})

test("renderPrescreenContextText: a settled terminal makes matching OPT-IN — courtesy ack is NOT a match request (Adam 2026-06-15)", () => {
  const text = renderPrescreenContextText(
    [screen({ sessionId: "f", terminal: "PASS", endedAtMs: 10 })],
    { profileSignalOnFile: true },
  )
  assert.match(text, /matching is OPT-IN/)
  assert.match(text, /ONLY when the candidate EXPLICITLY asks/)
  assert.match(text, /COURTESY ACKNOWLEDGMENT/)
  assert.match(text, /looking forward to the update.*is NOT a matching request|is NOT a matching request/)
  assert.match(text, /do NOT call\s+find_match/i)
})

test("renderPrescreenContextText: a PASS still UNDER WEKRUIT TEAM REVIEW does NOT offer matching — courtesy ack gets a warm hold", () => {
  const text = renderPrescreenContextText(
    [screen({ sessionId: "p", terminal: "PASS", pendingReview: true, endedAtMs: 10 })],
    { profileSignalOnFile: true },
  )
  // Pending-review branch suppresses the matching offer entirely.
  assert.match(text, /Do NOT offer job matching or call find_match this turn/)
  assert.match(text, /that is an ACK/)
  assert.match(text, /Matching only resumes if they LATER explicitly ask/)
  // The non-pending "matching is back on the table" offer must NOT render while pending review.
  assert.doesNotMatch(text, /matching is back on the table/)
})

test("terminalLabel: stale PAUSE is timed out / not under review; user-exit PAUSE stays paused", () => {
  assert.match(
    terminalLabel(screen({ terminal: "PAUSE", staleClosed: true })),
    /TIMED OUT[\s\S]*NOT under review/i,
  )
  assert.match(
    terminalLabel(screen({ terminal: "PAUSE", terminalReason: "user_exit" })),
    /PAUSED[\s\S]*not under review/i,
  )
})
