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
// LAZY, memoized SDK acquisition. The resolve below MUST NOT run at module load:
// apps/functions pins zod@3 and the zod@4 source (@pa/agent-runtime) is NOT present
// in the deployed Cloud Run bundle, so a top-level `require.resolve(@pa/agent-
// runtime/package.json)` threw at import → crashed the WHOLE functions container at
// boot (every function, since the codebase bundles to one index.js — even with
// paThinClaireEnabled OFF, because the crash was at import, not call). Deferring it
// (the same pattern prescreen-agentic-turn.ts uses) means importing claire-agent is
// inert; the SDK loads only when claire-agent actually runs (flag-gated) or in tests,
// where @pa/agent-runtime (zod@4) IS resolvable. Wave C still needs agent-runtime
// resolvable in the deploy bundle before the flag goes ON in prod. The try/catch
// fallback to baseRequire (from origin/main) keeps it resolvable in the deploy
// bundle even when agent-runtime's package.json isn't (graceful, still lazy).
let _sdk: Record<string, unknown> | null = null
let _z: unknown = null
function loadSdk(): Record<string, unknown> {
  if (_sdk) return _sdk
  const baseRequire = createRequire(import.meta.url)
  let req: NodeJS.Require
  try {
    req = createRequire(baseRequire.resolve("@pa/agent-runtime/package.json"))
  } catch {
    req = baseRequire
  }
  _sdk = req("@openai/agents") as Record<string, unknown>
  _z = req("zod")
  return _sdk
}

/**
 * zod@4 — lazy. First property touch (z.object, z.string, …) resolves the SDK.
 *
 * TYPE anchor MUST be zod@4, NOT bare `import("zod")`. apps/functions pins zod@3
 * (`import("zod")` = the nested 3.25.76 → `z.object()` yields a zod-3 `ZodObject<…,"strip">`),
 * but `tool()` (typed from `@openai/agents`, which resolves zod from the ROOT node_modules =
 * zod@4.3.6) wants a zod-4 `ZodObjectLike` (`$strip`). The split tree (top-level zod@4 for agents
 * + nested zod@3 for the v3 workspaces) surfaced this as ~49 TS2322 errors in the tool files.
 * We anchor the TYPE DIRECTLY to the ROOT zod@4.3.6 — the EXACT same package `@openai/agents`
 * (line 21) uses — via the `zod4-agent-sdk` tsconfig paths alias (→ root node_modules/zod), so
 * `z.object()` and `tool()` share one zod-4 type instance. (A re-export indirection through
 * `@pa/agent-runtime` instead made tsc expand zod's recursive types unboundedly → OOM; a DIRECT
 * package reference is cached and cheap. A bare relative path tripped NodeNext's
 * explicit-extension rule, hence the paths alias.) Type-only, erased at runtime; the runtime value
 * still loads lazily from agent-runtime's graph above. See package.json `//zod-split` +
 * apps/functions/tsconfig.json `paths`.
 */
export const z = new Proxy({} as Record<PropertyKey, unknown>, {
  get(_t, prop) {
    if (!_z) loadSdk()
    return (_z as Record<PropertyKey, unknown>)[prop]
  },
}) as unknown as typeof import("zod4-agent-sdk").z

class LazyAgent {
  constructor(...args: unknown[]) {
    const Real = loadSdk().Agent as new (...a: unknown[]) => unknown
    return new Real(...args) as object
  }
}
export const Agent = LazyAgent as unknown as typeof Agents.Agent

export const run = ((...args: unknown[]) =>
  (loadSdk().run as (...a: unknown[]) => unknown)(...args)) as unknown as typeof Agents.run

export const tool = ((...args: unknown[]) =>
  (loadSdk().tool as (...a: unknown[]) => unknown)(...args)) as unknown as typeof Agents.tool

/** instanceof works lazily via Symbol.hasInstance against the real class. */
export const InputGuardrailTripwireTriggered = {
  [Symbol.hasInstance](inst: unknown): boolean {
    const Real = loadSdk().InputGuardrailTripwireTriggered as (new (...a: unknown[]) => unknown) | undefined
    return Real ? inst instanceof Real : false
  },
} as unknown as typeof Agents.InputGuardrailTripwireTriggered

/** in-memory Session (eval/test stand-in for FirestoreSession). */
export const MemorySession = new Proxy(function () {} as unknown as object, {
  construct(_t, args) {
    const Real = loadSdk().MemorySession as new (...a: unknown[]) => unknown
    return new Real(...args) as object
  },
}) as unknown as typeof Agents.MemorySession

let configured = false
/**
 * Point the SDK at the PA OpenAI client (responses API). Idempotent. Lazily loads
 * the SDK (first call). No-op if the SDK build lacks the setters. Call before run().
 */
export function configureClaireSdk(): void {
  if (configured) return
  const apiKey =
    process.env.PA_OPENAI_AGENT_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim() || ""
  const baseURL = process.env.PA_OPENAI_AGENT_BASE_URL?.trim() || "https://api.openai.com/v1"
  try {
    const sdk = loadSdk()
    const client = new OpenAI({ apiKey, baseURL })
    ;(sdk.setDefaultOpenAIClient as ((c: unknown) => void) | undefined)?.(client)
    ;(sdk.setOpenAIAPI as ((api: string) => void) | undefined)?.("responses")
    if (apiKey) (sdk.setDefaultOpenAIKey as ((k: string) => void) | undefined)?.(apiKey)
    // TRACING EXPORT (de-blackbox): the SDK builds the full per-turn span tree (generation /
    // function / guardrail spans) by default, but configureClaireSdk only set the run-time key —
    // never the TRACING export key — so the BatchTraceProcessor logs "No API key provided for
    // OpenAI tracing exporter. Exports will be skipped." and drops every span. Reuse the SAME
    // resolved apiKey so the trace exporter authenticates with the same project. Optional-chained
    // through `undefined` so an SDK build lacking the setter is a silent no-op (fail-open).
    if (apiKey) (sdk.setTracingExportApiKey as ((k: string) => void) | undefined)?.(apiKey)
    // T3 (health, Adam 2026-06-06): the exporter silently SKIPS every span when no key is resolved
    // ("No API key provided for OpenAI tracing exporter"). Surface ONE warning so a missing
    // PA_OPENAI_AGENT_API_KEY/OPENAI_API_KEY is observable instead of an invisible trace black hole.
    else console.warn("[claire-sdk] tracing_export_key_missing: no OpenAI key resolved — trace export skipped (set PA_OPENAI_AGENT_API_KEY or OPENAI_API_KEY)")
  } catch {
    // fail-open: best-effort; the SDK falls back to env-derived defaults.
  }
  configured = true
}

/**
 * Flush any buffered trace spans NOW (de-blackbox). @openai/agents' BatchTraceProcessor flushes on
 * an unref'd 5s timer; a short Cloud Function invocation can return before that fires, so the
 * generation / function / guardrail spans for the turn never POST. Awaiting this at the end of a
 * turn forces the export. Fully fail-open: lazily loads the SDK, no-ops if the SDK build lacks
 * getGlobalTraceProvider / forceFlush, and never throws into the turn.
 */
export async function forceFlushTraces(): Promise<void> {
  try {
    const sdk = loadSdk()
    const provider = (sdk.getGlobalTraceProvider as (() => unknown) | undefined)?.()
    await (provider as { forceFlush?: () => unknown } | undefined)?.forceFlush?.()
  } catch {
    // fail-open: a missing export / flush error must never break the turn.
  }
}
