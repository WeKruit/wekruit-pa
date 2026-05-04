/**
 * iter30 WS4-A — invariants test (lint-as-test).
 *
 * Adam-lock: iter30 MUST NOT introduce sub-agent handoffs. SDK gotcha
 * `@openai/agents-core/dist/run.d.ts:211` — only the first agent's input
 * guardrails run; sub-agent handoffs would silently bypass the crisis +
 * PII guardrails. The skill-stacker design works around this entirely
 * by stacking addenda into a single Claire agent.
 *
 * This test grep-asserts that:
 *   1. `index.ts` has no `handoffs: [...]` declarations (or only an empty
 *      array literal / commented-out line)
 *   2. No `Agent.handoff` import surface bleeds into pa-orchestrator
 *
 * If a future iter genuinely needs sub-agent handoffs, follow the
 * migration path in ws-4a-detail.md §8.2:
 *   - manual IG re-run wrapper at the handoff target's first turn, OR
 *   - keep architecture flat — sub-agent calls become tool calls
 *     (agent-as-tool pattern; tool calls re-enter WS6 OutputGuardrail).
 */
import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

test("iter30 invariant: pa-orchestrator/index.ts does not declare non-empty handoffs", () => {
  const indexPath = join(__dirname, "index.ts")
  const src = readFileSync(indexPath, "utf-8")

  // Find any non-comment line containing `handoffs:` followed by a non-empty array.
  // Acceptable: `handoffs: [],` `// handoffs: [foo]` (commented).
  // Reject: `handoffs: [Agent.foo]` `handoffs: [...]`
  const lines = src.split("\n")
  const violations: string[] = []
  for (const [i, line] of lines.entries()) {
    const trimmed = line.trim()
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue
    const match = trimmed.match(/handoffs\s*:\s*\[([^\]]*)\]/)
    if (match) {
      const inside = match[1].trim()
      if (inside.length > 0) {
        violations.push(`line ${i + 1}: ${trimmed}`)
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    `iter30 forbids sub-agent handoffs in index.ts. If you genuinely need a handoff post-iter30, also wire input-guardrail re-entry per ws-4a-detail.md §8.2.\nViolations:\n${violations.join("\n")}`
  )
})
