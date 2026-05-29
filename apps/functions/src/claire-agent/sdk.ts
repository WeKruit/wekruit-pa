/**
 * sdk.ts — the SINGLE @openai/agents + zod source for claire-agent.
 *
 * WHY (BLOCKER #1): apps/functions pins zod@3, but @openai/agents-core@0.8.5
 * needs zod@4 (z.discriminatedUnion crashes under zod@3). A static
 * `import { tool } from "@openai/agents"` gets esbuild-inlined against build-time
 * zod@3 → runtime crash in the deployed functions bundle. The repo's proven
 * sidestep (apps/functions/src/prescreen-agentic-turn.ts) is to load the SDK
 * dynamically via createRequire from @pa/agent-runtime's graph, where zod@4 is
 * installed. The deploy bundle's runtime package.json also pins zod@^4.3.6 +
 * @openai/agents@^0.8.5 so Cloud Run installs the zod@4 build at the function root.
 *
 * Values are loaded DYNAMICALLY (no zod-3 crash); TYPES are imported type-only
 * (fully erased at runtime) so `tool`'s generic inference + Agent/run types survive.
 * Every claire-agent module imports tool/Agent/run/z FROM HERE — never from
 * "@openai/agents" or "zod" directly — so the whole agent uses ONE zod@4 SDK instance.
 */
import { createRequire } from "node:module"
import OpenAI from "openai"
// TYPE-ONLY: erased at runtime — keeps the real generic signatures without a runtime import.
import type * as Agents from "@openai/agents"

// ONE consistent resolution anchor for ALL environments (prod bundle, esbuild evals, AND tsx unit
// tests): resolve @openai/agents + zod from @pa/agent-runtime's node_modules, where zod@4 lives.
// This is the SAME mechanism prescreen-agentic-turn.ts uses (the proven prod pattern).
//
// WHY anchor at @pa/agent-runtime and not import.meta.url: apps/functions pins zod@3, so a require
// anchored at THIS module (functions graph) resolves zod@3 → @openai/agents-core@0.8.5's
// z.discriminatedUnion crashes at load. That crash is invisible in prod (the deploy bundle's
// runtime package.json pins zod@4) and in evals (symlinked zod@4), but it FIRES under tsx — which
// is what the predeploy `npm test` gate uses — for every test whose imports reach this file
// (webhook.test.ts → coalescer → cutover → agent → sdk, the reducer tests, etc). Anchoring at the
// agent-runtime package gives zod@4 in tsx too → the gate is consistent with prod.
//
// We resolve agent-runtime's package.json FILE (always resolvable) rather than `req("@pa/agent-
// runtime")` (its exports map exposes no require-resolvable main — the trap a prior attempt hit),
// then build a require anchored at that path so @openai/agents + zod resolve from agent-runtime's
// own (zod@4) subtree.
// Resolve the SDK + zod@4 in BOTH environments, because they store zod@4 in different places:
//   - PROD bundle: build.mjs INLINES @pa/* workspace deps (so @pa/agent-runtime is NOT a
//     node_modules entry — resolving it throws), and writes a runtime package.json pinning
//     zod@^4.3.6 + @openai/agents at the FUNCTION ROOT. So the function-root require gets zod@4.
//   - tsx unit tests / dev: the function root (apps/functions) pins zod@3, so we must instead
//     resolve from @pa/agent-runtime's own node_modules (zod@^4.3.6 there).
// Try the agent-runtime anchor first (dev/test); if it isn't installed (prod bundle), fall back
// to the function-root require, which the runtime package.json has stocked with zod@4. This is
// what makes the gate (tsx) and the deployed container BOOT consistently on one zod@4.
const baseRequire = createRequire(import.meta.url)
let req: NodeJS.Require
try {
  req = createRequire(baseRequire.resolve("@pa/agent-runtime/package.json"))
} catch {
  req = baseRequire
}
const sdk = req("@openai/agents") as Record<string, unknown>

/** zod@4 — the SAME instance @openai/agents-core uses. Use this for ALL tool param schemas. */
export const z = req("zod") as typeof import("zod").z

export const Agent = sdk.Agent as typeof Agents.Agent
export const run = sdk.run as typeof Agents.run
export const tool = sdk.tool as typeof Agents.tool
export const InputGuardrailTripwireTriggered =
  sdk.InputGuardrailTripwireTriggered as typeof Agents.InputGuardrailTripwireTriggered
/** in-memory Session (eval/test stand-in for FirestoreSession). */
export const MemorySession = sdk.MemorySession as typeof Agents.MemorySession

let configured = false
/**
 * Point the SDK at the PA OpenAI client (responses API). Idempotent. No-op if the
 * SDK build lacks the setters (older shapes). Call once before run().
 */
export function configureClaireSdk(): void {
  if (configured) return
  const apiKey =
    process.env.PA_OPENAI_AGENT_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim() || ""
  const baseURL = process.env.PA_OPENAI_AGENT_BASE_URL?.trim() || "https://api.openai.com/v1"
  try {
    const client = new OpenAI({ apiKey, baseURL })
    ;(sdk.setDefaultOpenAIClient as ((c: unknown) => void) | undefined)?.(client)
    ;(sdk.setOpenAIAPI as ((api: string) => void) | undefined)?.("responses")
    if (apiKey) (sdk.setDefaultOpenAIKey as ((k: string) => void) | undefined)?.(apiKey)
  } catch {
    // fail-open: best-effort; the SDK falls back to env-derived defaults.
  }
  configured = true
}
