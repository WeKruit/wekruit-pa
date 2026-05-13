/**
 * Wave C Block E1 — `agent-prompt.ts` deterministic builder tests.
 *
 * Covers:
 *  - Deterministic snapshot against `tests/fixtures/external-supply/agent-
 *    prompt.golden.txt` (multi-candidate aggregation with distinct
 *    missingInfo lists).
 *  - promptVersion + expectedJsonSchemaVersion appear in the output.
 *  - PII safety: emails / phones in candidate fields are stripped from the
 *    rendered prompt.
 *  - Required guardrail strings present.
 *  - Empty missingInfo list renders the "(none — please confirm ...)" fallback.
 *  - Same input twice → byte-identical output (no Date.now / Math.random
 *    leakage).
 */

import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  AGENT_PROMPT_VERSION,
  buildAgentResearchPrompt,
  type AgentResearchPromptInput,
} from "./agent-prompt.js"
import { AGENT_RESULT_SCHEMA_VERSION } from "./agent-parse.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, "../../..")
const GOLDEN_PATH = path.join(REPO_ROOT, "tests/fixtures/external-supply/agent-prompt.golden.txt")

function goldenInput(): AgentResearchPromptInput {
  return {
    candidates: [
      {
        recordId: "rec-001",
        candidateId: "cand-aaa",
        name: "Alice Johnson",
        canonicalLinkedInUrl: "https://linkedin.com/in/alice",
        currentTitle: "Senior Software Engineer",
        currentCompany: "Stripe",
      },
      {
        recordId: "rec-002",
        name: "Bob",
        canonicalLinkedInUrl: "https://linkedin.com/in/bob-bui",
        currentCompany: "Plaid",
      },
      {
        recordId: "rec-003",
        candidateId: "cand-ccc",
        name: "Charlie Park",
      },
    ],
    missingInfoByCandidate: {
      "rec-001": ["yearsExperience", "currentSalary"],
      "rec-002": ["seniorityLevel"],
      "cand-ccc": ["industrySector", "graduationYear", "skills"],
    },
    companyJobContext: {
      companyId: "co-acme",
      companyName: "Acme Fintech",
      industrySector: ["financial_technology", "payments"],
      competitorCompanies: ["Stripe", "Plaid", "Square"],
      jobId: "job-swe-senior",
      jobTitle: "Senior Software Engineer",
      jobRoleFunction: ["software_engineering"],
      seniorityLevel: "senior",
    },
  }
}

// ---------------------------------------------------------------------------
// Golden snapshot — 3 candidates, distinct missingInfo
// ---------------------------------------------------------------------------

test("buildAgentResearchPrompt — matches golden fixture (multi-candidate)", () => {
  const out = buildAgentResearchPrompt(goldenInput())
  const expected = fs.readFileSync(GOLDEN_PATH, "utf8")
  assert.equal(out.prompt, expected, "prompt body must match golden fixture exactly")
  assert.equal(out.promptVersion, AGENT_PROMPT_VERSION)
  assert.equal(out.expectedJsonSchemaVersion, AGENT_RESULT_SCHEMA_VERSION)
})

// ---------------------------------------------------------------------------
// Version constants surfaced in output
// ---------------------------------------------------------------------------

test("buildAgentResearchPrompt — promptVersion and schemaVersion appear in body", () => {
  const out = buildAgentResearchPrompt(goldenInput())
  assert.ok(
    out.prompt.includes(`promptVersion: ${AGENT_PROMPT_VERSION}`),
    "rendered prompt must surface promptVersion line",
  )
  assert.ok(
    out.prompt.includes(`expectedJsonSchemaVersion: ${AGENT_RESULT_SCHEMA_VERSION}`),
    "rendered prompt must surface expectedJsonSchemaVersion line",
  )
  assert.ok(
    out.prompt.includes(`"schemaVersion": "${AGENT_RESULT_SCHEMA_VERSION}"`),
    "output contract must reference the schemaVersion the parser expects",
  )
})

// ---------------------------------------------------------------------------
// Determinism — same input twice → byte-identical output
// ---------------------------------------------------------------------------

test("buildAgentResearchPrompt — deterministic across runs", () => {
  const first = buildAgentResearchPrompt(goldenInput()).prompt
  const second = buildAgentResearchPrompt(goldenInput()).prompt
  assert.equal(first, second)
})

// ---------------------------------------------------------------------------
// PII safety — emails + phones never reach the prompt body
// ---------------------------------------------------------------------------

test("buildAgentResearchPrompt — strips email-shaped strings from candidate fields", () => {
  // Operator typo: somebody pasted an email into the name field.
  const input: AgentResearchPromptInput = {
    candidates: [
      {
        recordId: "rec-001",
        name: "alice.johnson@example.com",
        currentTitle: "Engineer, contact me at alice@example.com",
        currentCompany: "Stripe",
      },
    ],
    missingInfoByCandidate: { "rec-001": ["yearsExperience"] },
    companyJobContext: { companyId: "co", jobId: "job" },
  }
  const out = buildAgentResearchPrompt(input)
  // No email substring should appear anywhere in the rendered prompt.
  assert.equal(
    /[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/i.test(out.prompt),
    false,
    "rendered prompt must not contain any email-shaped substring",
  )
  // The name field collapsed to nothing — firstName line should be absent.
  assert.equal(out.prompt.includes("firstName:"), false)
  // The currentTitle had the email scrubbed but kept the "Engineer, contact me at" remainder.
  assert.ok(out.prompt.includes("currentTitle: Engineer, contact me at"))
})

test("buildAgentResearchPrompt — strips phone-shaped strings from candidate fields", () => {
  const input: AgentResearchPromptInput = {
    candidates: [
      {
        recordId: "rec-001",
        name: "Alice",
        currentTitle: "+1-415-555-0123 SWE",
        currentCompany: "Stripe",
      },
    ],
    missingInfoByCandidate: { "rec-001": ["yearsExperience"] },
    companyJobContext: { companyId: "co", jobId: "job" },
  }
  const out = buildAgentResearchPrompt(input)
  // No phone-shaped substring should appear.
  assert.equal(
    /\+?\d{10,}|\d{3}[\s.\-]\d{3}[\s.\-]\d{4}/.test(out.prompt),
    false,
    "rendered prompt must not contain any phone-shaped substring",
  )
})

// ---------------------------------------------------------------------------
// Required guardrail strings
// ---------------------------------------------------------------------------

test("buildAgentResearchPrompt — guardrail lines present verbatim", () => {
  const out = buildAgentResearchPrompt(goldenInput())
  assert.ok(out.prompt.includes("Do NOT include personal email"))
  assert.ok(out.prompt.includes("Cite at least one public web URL"))
  assert.ok(out.prompt.includes("no_public_data_found"))
  assert.ok(out.prompt.includes("strict JSON only"))
  assert.ok(out.prompt.includes("Do not fabricate"))
})

// ---------------------------------------------------------------------------
// Empty missingInfo fallback
// ---------------------------------------------------------------------------

test("buildAgentResearchPrompt — empty missingInfo renders the confirm fallback", () => {
  const input: AgentResearchPromptInput = {
    candidates: [
      {
        recordId: "rec-x",
        name: "Drew",
        currentTitle: "Engineer",
        currentCompany: "Stripe",
      },
    ],
    missingInfoByCandidate: {},
    companyJobContext: { companyId: "co", jobId: "job" },
  }
  const out = buildAgentResearchPrompt(input)
  assert.ok(out.prompt.includes("(none — please confirm any of the public-profile claims above)"))
})

// ---------------------------------------------------------------------------
// candidateId-keyed missingInfo also resolved
// ---------------------------------------------------------------------------

test("buildAgentResearchPrompt — missingInfo keyed by candidateId resolves correctly", () => {
  const input: AgentResearchPromptInput = {
    candidates: [
      {
        recordId: "rec-x",
        candidateId: "cand-y",
        name: "Drew",
      },
    ],
    // Keyed on candidateId rather than recordId.
    missingInfoByCandidate: { "cand-y": ["yoe", "seniority"] },
    companyJobContext: { companyId: "co", jobId: "job" },
  }
  const out = buildAgentResearchPrompt(input)
  assert.ok(out.prompt.includes("- yoe"))
  assert.ok(out.prompt.includes("- seniority"))
})

// ---------------------------------------------------------------------------
// Optional fields are absent when undefined (no `undefined` leakage)
// ---------------------------------------------------------------------------

test("buildAgentResearchPrompt — never renders undefined for absent optional fields", () => {
  const input: AgentResearchPromptInput = {
    candidates: [
      {
        recordId: "rec-only-id",
      },
    ],
    missingInfoByCandidate: { "rec-only-id": ["everything"] },
    companyJobContext: { companyId: "co", jobId: "job" },
  }
  const out = buildAgentResearchPrompt(input)
  assert.equal(out.prompt.includes("undefined"), false)
  assert.equal(out.prompt.includes("null"), false)
})

// ---------------------------------------------------------------------------
// Caller-supplied version override
// ---------------------------------------------------------------------------

test("buildAgentResearchPrompt — caller-supplied promptVersion/schemaVersion echo", () => {
  const out = buildAgentResearchPrompt({
    ...goldenInput(),
    promptVersion: "agent-prompt-test-X",
    expectedJsonSchemaVersion: "agent-result-test-X",
  })
  assert.equal(out.promptVersion, "agent-prompt-test-X")
  assert.equal(out.expectedJsonSchemaVersion, "agent-result-test-X")
  assert.ok(out.prompt.includes("promptVersion: agent-prompt-test-X"))
  assert.ok(out.prompt.includes("expectedJsonSchemaVersion: agent-result-test-X"))
})
