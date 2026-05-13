/**
 * v2.0 External Supply V1 — Wave C Block E2 — Defensive parser for the
 * ChatGPT Agent Mode research result.
 *
 * The operator pastes the agent's raw text reply into the dashboard. The
 * agent is instructed to emit strict JSON (see `agent-prompt.ts` output
 * contract), but in practice models drift — we defend against:
 *   - Markdown ```json ... ``` fences.
 *   - Surrounding prose ("Sure! Here you go: { ... }").
 *   - Trailing commentary after the final `}`.
 *   - Per-finding validation errors (out-of-range confidence, non-URL
 *     evidence). Valid findings are still returned; bad ones surface in
 *     `parseErrors`.
 *   - Schema version drift — `schemaVersionMismatch` flag is raised but the
 *     parser still tries to extract findings (operator can re-import after
 *     fixing).
 *
 * Lead resolutions (EXECUTOR-PLANS.md §E):
 *  - E Q2 → Partial-success on `parsedFindings`. Each valid finding lands;
 *    each invalid finding contributes a positional error string.
 *  - E Q4 → `AGENT_RESULT_SCHEMA_VERSION = "agent-result-2026-05-A"` —
 *    referenced from `agent-prompt.ts` so the contract is exposed once.
 *
 * Output:
 *  - `parsedFindings: AgentResearchFinding[]` — every entry has a fresh
 *    `findingId = crypto.randomUUID()`, `approved: false`, no approver
 *    metadata. Caller (F's approval callable) stamps `approvedBy/At` later.
 *  - `parseErrors: string[]` — empty on full success; populated with
 *    human-readable per-issue strings.
 *  - `schemaVersionMismatch: boolean` — true when the caller supplied an
 *    `expectedSchemaVersion` that doesn't match the agent's `schemaVersion`.
 */

import { randomUUID } from "node:crypto"
import { z } from "zod"
import type { AgentResearchFinding } from "@pa/core-types"

/**
 * Bump on any structural agent output schema change.
 */
export const AGENT_RESULT_SCHEMA_VERSION = "agent-result-2026-05-A"

// ---------------------------------------------------------------------------
// Internal Zod envelope
// ---------------------------------------------------------------------------

const AgentResultFindingSchema = z.object({
  candidateId: z.string().min(1).optional(),
  recordId: z.string().min(1).optional(),
  field: z.string().min(1),
  value: z.unknown(),
  confidence: z.number().min(0).max(1),
  uncertainty: z.string().max(2_000).optional(),
  evidenceUrls: z.array(z.string().url()).default([]),
})

const AgentResultEnvelopeSchema = z.object({
  schemaVersion: z.string().min(1),
  findings: z.array(z.unknown()).default([]),
})

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface AgentResearchParseResult {
  parsedFindings: AgentResearchFinding[]
  parseErrors: string[]
  schemaVersionMismatch: boolean
}

/**
 * Parse the raw agent reply into structured findings.
 *
 * @param raw The exact text the operator pasted.
 * @param expectedSchemaVersion Optional — when set and the agent's
 *   `schemaVersion` differs, `schemaVersionMismatch` is raised but parsing
 *   still proceeds.
 * @param now Optional ISO timestamp factory (kept for future audit hooks —
 *   currently unused but mirrors B/C/D's deps injection style).
 */
export function parseAgentResearchResult(
  raw: string,
  expectedSchemaVersion?: string,
  _now?: () => string,
): AgentResearchParseResult {
  const errors: string[] = []
  const findings: AgentResearchFinding[] = []
  let mismatch = false

  if (typeof raw !== "string" || raw.trim().length === 0) {
    return {
      parsedFindings: [],
      parseErrors: ["empty_input"],
      schemaVersionMismatch: false,
    }
  }

  // Step 1 — locate a JSON candidate block.
  const candidate = locateJsonBlock(raw)
  if (!candidate) {
    return {
      parsedFindings: [],
      parseErrors: ["no_json_block_found"],
      schemaVersionMismatch: false,
    }
  }

  // Step 2 — JSON.parse.
  let parsed: unknown
  try {
    parsed = JSON.parse(candidate)
  } catch (err) {
    return {
      parsedFindings: [],
      parseErrors: [`json_parse_failed: ${err instanceof Error ? err.message : String(err)}`],
      schemaVersionMismatch: false,
    }
  }

  // Step 3 — envelope validation.
  const envelope = AgentResultEnvelopeSchema.safeParse(parsed)
  if (!envelope.success) {
    return {
      parsedFindings: [],
      parseErrors: [
        `envelope_invalid: ${envelope.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`,
      ],
      schemaVersionMismatch: false,
    }
  }

  // Step 4 — schemaVersion drift.
  if (
    expectedSchemaVersion &&
    envelope.data.schemaVersion !== expectedSchemaVersion
  ) {
    mismatch = true
    errors.push(
      `schema_version_mismatch: expected ${expectedSchemaVersion}, got ${envelope.data.schemaVersion}`,
    )
  }

  // Step 5 — per-finding validation. Invalid findings contribute an error
  // and are skipped; valid findings are admitted.
  for (let i = 0; i < envelope.data.findings.length; i += 1) {
    const raw = envelope.data.findings[i]
    const finding = AgentResultFindingSchema.safeParse(raw)
    if (!finding.success) {
      const detail = finding.error.issues
        .map((iss) => `${iss.path.join(".") || "(root)"}: ${iss.message}`)
        .join("; ")
      errors.push(`finding[${i}]: ${detail}`)
      continue
    }
    // Require AT LEAST one of candidateId / recordId per finding so the
    // approval flow has something to bind to.
    if (!finding.data.candidateId && !finding.data.recordId) {
      errors.push(`finding[${i}]: requires either candidateId or recordId`)
      continue
    }
    const candidateId = finding.data.candidateId ?? finding.data.recordId!
    const recordId = finding.data.recordId
    const persisted: AgentResearchFinding = {
      findingId: randomUUID(),
      candidateId,
      field: finding.data.field,
      value: finding.data.value,
      confidence: finding.data.confidence,
      evidenceUrls: finding.data.evidenceUrls,
      approved: false,
    }
    if (recordId) persisted.recordId = recordId
    if (finding.data.uncertainty) persisted.uncertainty = finding.data.uncertainty
    findings.push(persisted)
  }

  return {
    parsedFindings: findings,
    parseErrors: errors,
    schemaVersionMismatch: mismatch,
  }
}

// ---------------------------------------------------------------------------
// JSON block extraction
// ---------------------------------------------------------------------------

const FENCED_JSON_RE = /```(?:json)?\s*([\s\S]*?)```/i

/**
 * Try to find a JSON-shaped block inside the raw agent output.
 *
 * Order:
 *  1. ```json ... ``` fenced block → take inner.
 *  2. ``` ... ``` generic fenced → take inner if it parses-shapes as JSON.
 *  3. Substring from first `{` to last `}` — handles "Here you go: { ... }
 *     Hope that helps!" style trailers.
 *
 * Returns `null` if no plausible JSON block is found.
 */
function locateJsonBlock(raw: string): string | null {
  const fenced = FENCED_JSON_RE.exec(raw)
  if (fenced && typeof fenced[1] === "string" && fenced[1].trim().length > 0) {
    return fenced[1].trim()
  }
  const firstBrace = raw.indexOf("{")
  const lastBrace = raw.lastIndexOf("}")
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null
  }
  return raw.slice(firstBrace, lastBrace + 1)
}
