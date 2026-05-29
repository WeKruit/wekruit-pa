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

// createRequire(import.meta.url) works in every ESM context: the deployed esm bundle
// (require shimmed by build.mjs banner), tsx (eval), and plain node. Anchor SDK resolution
// at @pa/agent-runtime so we always get the zod@4 copy regardless of which node_modules
// the importing file sits next to.
// Resolve @openai/agents + zod DIRECTLY from this module's location:
//   - PROD: the deploy bundle's runtime package.json pins zod@^4.3.6 + @openai/agents@^0.8.5,
//     so Cloud Run installs the zod@4 build at the function root → createRequire finds zod@4.
//   - EVAL: the eval harness symlinks node_modules/{@openai,zod} → agent-runtime's zod@4 dist,
//     and bundles via esbuild (NOT tsx) so the SDK's compiled .js (not .ts) is loaded.
// (Anchoring at @pa/agent-runtime fails: its `exports` map exposes no require-resolvable main.)
const req = createRequire(import.meta.url)
const sdk = req("@openai/agents") as Record<string, unknown>

/** zod@4 — the SAME instance @openai/agents-core uses. Use this for ALL tool param schemas. */
export const z = req("zod") as typeof import("zod").z

export const Agent = sdk.Agent as typeof Agents.Agent
export const run = sdk.run as typeof Agents.run
export const tool = sdk.tool as typeof Agents.tool
export const InputGuardrailTripwireTriggered =
  sdk.InputGuardrailTripwireTriggered as typeof Agents.InputGuardrailTripwireTriggered

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
