/**
 * Wave C Block E2 — `agent-parse.ts` defensive parser tests.
 *
 * Covers:
 *  - Fenced ```json ... ``` block extraction.
 *  - Unfenced `{...}` substring fallback (prose surrounding the JSON).
 *  - Empty input → `empty_input` error.
 *  - Truncated / malformed JSON → `parse_failed` error.
 *  - Envelope shape mismatch → `envelope_invalid` error.
 *  - Per-finding validation errors collected positionally; valid findings
 *    still admitted.
 *  - Out-of-range `confidence` rejected.
 *  - Non-URL `evidenceUrls` rejected.
 *  - Missing `field` rejected.
 *  - Schema version mismatch flagged but findings still parsed.
 *  - Every admitted finding gets a fresh `findingId` (UUID) and
 *    `approved: false`.
 *  - Round-trip: build prompt → write a compliant agent reply → parse it.
 */

import assert from "node:assert/strict"
import test from "node:test"
import {
  AGENT_RESULT_SCHEMA_VERSION,
  parseAgentResearchResult,
} from "./agent-parse.js"

// ---------------------------------------------------------------------------
// Empty / missing input
// ---------------------------------------------------------------------------

test("parseAgentResearchResult — empty string returns empty_input error", () => {
  const out = parseAgentResearchResult("")
  assert.deepEqual(out.parsedFindings, [])
  assert.deepEqual(out.parseErrors, ["empty_input"])
  assert.equal(out.schemaVersionMismatch, false)
})

test("parseAgentResearchResult — whitespace-only returns empty_input error", () => {
  const out = parseAgentResearchResult("   \n  \t  ")
  assert.deepEqual(out.parseErrors, ["empty_input"])
})

// ---------------------------------------------------------------------------
// Fenced JSON
// ---------------------------------------------------------------------------

test("parseAgentResearchResult — fenced ```json block extracts cleanly", () => {
  const raw = [
    "Sure! Here is the analysis:",
    "```json",
    JSON.stringify({
      schemaVersion: AGENT_RESULT_SCHEMA_VERSION,
      findings: [
        {
          candidateId: "cand-1",
          field: "yearsExperience",
          value: 7,
          confidence: 0.85,
          evidenceUrls: ["https://linkedin.com/in/jane"],
        },
      ],
    }),
    "```",
    "Hope that helps!",
  ].join("\n")

  const out = parseAgentResearchResult(raw)
  assert.deepEqual(out.parseErrors, [])
  assert.equal(out.parsedFindings.length, 1)
  assert.equal(out.parsedFindings[0]!.field, "yearsExperience")
  assert.equal(out.parsedFindings[0]!.confidence, 0.85)
  assert.deepEqual(out.parsedFindings[0]!.evidenceUrls, ["https://linkedin.com/in/jane"])
})

test("parseAgentResearchResult — fenced ``` block without json hint also works", () => {
  const raw = "```\n" + JSON.stringify({
    schemaVersion: AGENT_RESULT_SCHEMA_VERSION,
    findings: [
      {
        recordId: "rec-1",
        field: "currentCompany",
        value: "Acme",
        confidence: 0.7,
        evidenceUrls: ["https://example.com/a"],
      },
    ],
  }) + "\n```"

  const out = parseAgentResearchResult(raw)
  assert.deepEqual(out.parseErrors, [])
  assert.equal(out.parsedFindings.length, 1)
})

// ---------------------------------------------------------------------------
// Unfenced JSON substring fallback
// ---------------------------------------------------------------------------

test("parseAgentResearchResult — substring fallback when no fence", () => {
  const raw = `Sure thing. ${JSON.stringify({
    schemaVersion: AGENT_RESULT_SCHEMA_VERSION,
    findings: [
      {
        recordId: "rec-2",
        field: "currentCompany",
        value: "Plaid",
        confidence: 0.9,
        evidenceUrls: ["https://plaid.com/team/jane"],
      },
    ],
  })} Let me know if you need more.`

  const out = parseAgentResearchResult(raw)
  assert.deepEqual(out.parseErrors, [])
  assert.equal(out.parsedFindings.length, 1)
  assert.equal(out.parsedFindings[0]!.value, "Plaid")
})

// ---------------------------------------------------------------------------
// Malformed JSON
// ---------------------------------------------------------------------------

test("parseAgentResearchResult — malformed JSON yields json_parse_failed error", () => {
  // Balanced braces so the locator picks the block, but invalid JSON inside.
  const raw = `{"schemaVersion": "${AGENT_RESULT_SCHEMA_VERSION}", "findings": [,,,], }`
  const out = parseAgentResearchResult(raw)
  assert.deepEqual(out.parsedFindings, [])
  assert.equal(out.parseErrors.length, 1)
  assert.match(out.parseErrors[0]!, /json_parse_failed/)
})

test("parseAgentResearchResult — truncated JSON (unmatched braces) yields no_json_block_found", () => {
  // `{...` with no closing brace → locator returns null.
  const raw = `{"schemaVersion":"${AGENT_RESULT_SCHEMA_VERSION}","findings":[{`
  const out = parseAgentResearchResult(raw)
  assert.deepEqual(out.parsedFindings, [])
  // The locator falls back to substring `{...}` matching; with no closing brace
  // we land on `no_json_block_found`.
  assert.equal(out.parseErrors.length, 1)
})

test("parseAgentResearchResult — pure prose with no JSON returns no_json_block_found", () => {
  const out = parseAgentResearchResult("Sorry I could not find anything.")
  assert.deepEqual(out.parseErrors, ["no_json_block_found"])
})

// ---------------------------------------------------------------------------
// Envelope shape
// ---------------------------------------------------------------------------

test("parseAgentResearchResult — missing schemaVersion fails envelope", () => {
  const raw = JSON.stringify({ findings: [] })
  const out = parseAgentResearchResult(raw)
  assert.equal(out.parseErrors.length, 1)
  assert.match(out.parseErrors[0]!, /envelope_invalid/)
})

test("parseAgentResearchResult — schemaVersion mismatch flagged but parsing continues", () => {
  const raw = JSON.stringify({
    schemaVersion: "agent-result-2099-future",
    findings: [
      {
        candidateId: "cand-9",
        field: "industrySector",
        value: ["fintech"],
        confidence: 0.9,
        evidenceUrls: ["https://example.com/a"],
      },
    ],
  })
  const out = parseAgentResearchResult(raw, AGENT_RESULT_SCHEMA_VERSION)
  assert.equal(out.schemaVersionMismatch, true)
  assert.equal(out.parseErrors.length, 1)
  assert.match(out.parseErrors[0]!, /schema_version_mismatch/)
  // Findings still parsed.
  assert.equal(out.parsedFindings.length, 1)
})

// ---------------------------------------------------------------------------
// Per-finding errors collected
// ---------------------------------------------------------------------------

test("parseAgentResearchResult — invalid findings produce positional errors and skip", () => {
  const raw = JSON.stringify({
    schemaVersion: AGENT_RESULT_SCHEMA_VERSION,
    findings: [
      // [0] valid
      {
        candidateId: "cand-1",
        field: "yoe",
        value: 5,
        confidence: 0.6,
        evidenceUrls: ["https://example.com/a"],
      },
      // [1] confidence out of range
      {
        candidateId: "cand-2",
        field: "yoe",
        value: 5,
        confidence: 2.0,
        evidenceUrls: ["https://example.com/b"],
      },
      // [2] missing required `field`
      {
        candidateId: "cand-3",
        value: "x",
        confidence: 0.5,
        evidenceUrls: ["https://example.com/c"],
      },
      // [3] non-URL evidence
      {
        candidateId: "cand-4",
        field: "currentCompany",
        value: "Acme",
        confidence: 0.5,
        evidenceUrls: ["not-a-url"],
      },
      // [4] neither candidateId nor recordId
      {
        field: "currentCompany",
        value: "Plaid",
        confidence: 0.6,
        evidenceUrls: ["https://example.com/d"],
      },
      // [5] valid with recordId only
      {
        recordId: "rec-z",
        field: "school",
        value: "Harvard",
        confidence: 0.4,
        evidenceUrls: ["https://example.com/e"],
      },
    ],
  })

  const out = parseAgentResearchResult(raw)
  // Two valid findings (positions 0 and 5).
  assert.equal(out.parsedFindings.length, 2)
  // Four errors with positional prefixes.
  const errors = out.parseErrors
  assert.equal(errors.length, 4)
  assert.match(errors[0]!, /^finding\[1\]/)
  assert.match(errors[1]!, /^finding\[2\]/)
  assert.match(errors[2]!, /^finding\[3\]/)
  assert.match(errors[3]!, /^finding\[4\]/)
  // Confirm finding[1] complains about confidence range.
  assert.match(errors[0]!, /confidence/)
  // Confirm finding[3] complains about URL shape.
  assert.match(errors[2]!, /evidenceUrls/)
})

// ---------------------------------------------------------------------------
// findingId uniqueness + approved default
// ---------------------------------------------------------------------------

test("parseAgentResearchResult — every admitted finding has fresh UUID + approved=false", () => {
  const raw = JSON.stringify({
    schemaVersion: AGENT_RESULT_SCHEMA_VERSION,
    findings: [
      {
        candidateId: "cand-a",
        field: "yoe",
        value: 5,
        confidence: 0.5,
        evidenceUrls: ["https://example.com/a"],
      },
      {
        candidateId: "cand-b",
        field: "yoe",
        value: 6,
        confidence: 0.6,
        evidenceUrls: ["https://example.com/b"],
      },
    ],
  })
  const out = parseAgentResearchResult(raw)
  assert.equal(out.parsedFindings.length, 2)
  const ids = new Set(out.parsedFindings.map((f) => f.findingId))
  assert.equal(ids.size, 2, "findingIds must be unique")
  for (const f of out.parsedFindings) {
    assert.equal(f.approved, false)
    assert.equal(typeof f.findingId, "string")
    // UUID v4 shape.
    assert.match(f.findingId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    assert.equal(f.approvedBy, undefined)
    assert.equal(f.approvedAt, undefined)
  }
})

// ---------------------------------------------------------------------------
// Optional `uncertainty` and `recordId` carry through; mapping
// ---------------------------------------------------------------------------

test("parseAgentResearchResult — uncertainty and recordId carry through", () => {
  const raw = JSON.stringify({
    schemaVersion: AGENT_RESULT_SCHEMA_VERSION,
    findings: [
      {
        candidateId: "cand-1",
        recordId: "rec-1",
        field: "currentCompany",
        value: "Plaid",
        confidence: 0.0,
        uncertainty: "no_public_data_found",
        evidenceUrls: [],
      },
    ],
  })
  const out = parseAgentResearchResult(raw)
  assert.equal(out.parsedFindings.length, 1)
  const f = out.parsedFindings[0]!
  assert.equal(f.candidateId, "cand-1")
  assert.equal(f.recordId, "rec-1")
  assert.equal(f.uncertainty, "no_public_data_found")
  assert.equal(f.confidence, 0)
  assert.deepEqual(f.evidenceUrls, [])
})

test("parseAgentResearchResult — recordId-only finding gets candidateId = recordId", () => {
  // When candidateId is absent the parser uses recordId as the candidateId
  // slot so the approval flow has something to bind to (E's `AgentResearchFinding`
  // requires candidateId per A's schema).
  const raw = JSON.stringify({
    schemaVersion: AGENT_RESULT_SCHEMA_VERSION,
    findings: [
      {
        recordId: "rec-only",
        field: "yoe",
        value: 4,
        confidence: 0.5,
        evidenceUrls: ["https://example.com/x"],
      },
    ],
  })
  const out = parseAgentResearchResult(raw)
  assert.equal(out.parsedFindings.length, 1)
  assert.equal(out.parsedFindings[0]!.candidateId, "rec-only")
  assert.equal(out.parsedFindings[0]!.recordId, "rec-only")
})

// ---------------------------------------------------------------------------
// Extra unknown keys in findings are silently dropped (Zod default mode).
// ---------------------------------------------------------------------------

test("parseAgentResearchResult — extra unknown keys silently dropped", () => {
  const raw = JSON.stringify({
    schemaVersion: AGENT_RESULT_SCHEMA_VERSION,
    findings: [
      {
        candidateId: "cand-1",
        field: "yoe",
        value: 5,
        confidence: 0.5,
        evidenceUrls: ["https://example.com/a"],
        // Unknown keys
        extraneous: "ignored",
        bogus: { foo: 1 },
      },
    ],
  })
  const out = parseAgentResearchResult(raw)
  assert.deepEqual(out.parseErrors, [])
  assert.equal(out.parsedFindings.length, 1)
  const persisted = out.parsedFindings[0]! as Record<string, unknown>
  assert.equal(persisted.extraneous, undefined)
})

// ---------------------------------------------------------------------------
// Round-trip: golden prompt's contract -> compliant reply -> parse
// ---------------------------------------------------------------------------

test("parseAgentResearchResult — round-trip from golden prompt's output contract", async () => {
  // Synthesize a reply matching the published contract from the prompt.
  const reply = [
    "Here you go:",
    "```json",
    JSON.stringify(
      {
        schemaVersion: AGENT_RESULT_SCHEMA_VERSION,
        findings: [
          {
            candidateId: "cand-aaa",
            recordId: "rec-001",
            field: "yearsExperience",
            value: 8,
            confidence: 0.82,
            evidenceUrls: ["https://linkedin.com/in/alice"],
          },
          {
            recordId: "rec-002",
            field: "seniorityLevel",
            value: "senior",
            confidence: 0.75,
            evidenceUrls: ["https://plaid.com/about"],
          },
          {
            candidateId: "cand-ccc",
            field: "industrySector",
            value: ["financial_technology"],
            confidence: 0.6,
            evidenceUrls: ["https://crunchbase.com/charlie"],
          },
        ],
      },
      null,
      2,
    ),
    "```",
    "Let me know if you need deeper sourcing.",
  ].join("\n")

  const out = parseAgentResearchResult(reply, AGENT_RESULT_SCHEMA_VERSION)
  assert.deepEqual(out.parseErrors, [])
  assert.equal(out.parsedFindings.length, 3)
  assert.equal(out.schemaVersionMismatch, false)
  // Field types preserved.
  const yoe = out.parsedFindings.find((f) => f.field === "yearsExperience")!
  assert.equal(yoe.value, 8)
  const industry = out.parsedFindings.find((f) => f.field === "industrySector")!
  assert.deepEqual(industry.value, ["financial_technology"])
})

// ---------------------------------------------------------------------------
// Non-string input
// ---------------------------------------------------------------------------

test("parseAgentResearchResult — non-string input returns empty_input", () => {
  // @ts-expect-error testing runtime defense
  const out = parseAgentResearchResult(null)
  assert.deepEqual(out.parseErrors, ["empty_input"])
})
