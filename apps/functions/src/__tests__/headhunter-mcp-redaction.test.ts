/**
 * Rule-#6 gate test: passed-candidate PII must be redacted for the EMPLOYER
 * scope when consent is not granted, preserved when granted, and never touched
 * for INTERNAL operators. Highest-stakes line in the headhunter MCP.
 */
import test from "node:test"
import assert from "node:assert/strict"

import { maybeRedactPassed } from "../headhunter-mcp/redact.js"

type Row = Record<string, unknown>
function fixture() {
  return {
    summary: { totalPassedSnapshots: 2, withConsent: 1, missingConsent: 1 },
    rows: [
      {
        id: "s1",
        candidateId: "c1",
        displayName: "Jane Doe",
        email: "jane@example.com",
        resumeSummary: "Jane Doe, jane@example.com, senior eng",
        passReason: "strong signal",
        matchReason: "fit",
        profile: { consentStatus: "granted" },
        transcript: { turns: [{ role: "user", body: "hi" }] },
      },
      {
        id: "s2",
        candidateId: "c2",
        displayName: "John Roe",
        email: "john@example.com",
        resumeSummary: "John Roe, john@example.com",
        passReason: "ok",
        matchReason: "ok",
        profile: { consentStatus: "missing" },
        transcript: { turns: [{ role: "user", body: "secret transcript" }] },
      },
    ] as Row[],
  }
}
const rowsOf = (v: unknown) => (v as { rows: Row[] }).rows

test("internal scope is dashboard-parity — no redaction, same object returned", () => {
  const snap = fixture()
  const out = maybeRedactPassed(snap, { uid: "u1", scope: "internal" })
  assert.equal(out, snap) // identity: internal short-circuits before cloning
  assert.equal(rowsOf(out)[1].displayName, "John Roe")
  assert.equal(rowsOf(out)[1].email, "john@example.com")
})

test("employer scope redacts the un-consented row", () => {
  const snap = fixture()
  const out = maybeRedactPassed(snap, { uid: "e1", scope: "employer" })
  const redacted = rowsOf(out)[1]
  assert.equal(redacted.displayName, "[redacted — consent pending]")
  assert.equal(redacted.email, "[redacted]")
  assert.equal(redacted.consentRedacted, true)
  assert.deepEqual(redacted.transcript, { redacted: true, reason: "pii_consent_pending", turns: [] })
  // free-text scrubbed: the candidate's email must not survive in the summary
  assert.ok(!String(redacted.resumeSummary).includes("john@example.com"))
})

test("employer scope preserves the consented row", () => {
  const snap = fixture()
  const out = maybeRedactPassed(snap, { uid: "e1", scope: "employer" })
  const kept = rowsOf(out)[0]
  assert.equal(kept.displayName, "Jane Doe")
  assert.equal(kept.email, "jane@example.com")
  assert.equal((kept.transcript as { turns: unknown[] }).turns.length, 1)
  assert.equal(kept.consentRedacted, undefined)
})

test("employer redaction does not mutate the caller's snapshot (JSON clone)", () => {
  const snap = fixture()
  maybeRedactPassed(snap, { uid: "e1", scope: "employer" })
  assert.equal(snap.rows[1].displayName, "John Roe") // original untouched
  assert.equal((snap.rows[1].transcript as { turns: unknown[] }).turns.length, 1)
})
