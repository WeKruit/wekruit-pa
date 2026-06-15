/**
 * shared-keys.ts — the GLOBAL registry of authored cross-job prescreen `sharedKey`s.
 *
 * SPEC §5a (cross-session prescreen answer reuse). A `sharedKey` is the explicit,
 * authored identity that ties the SAME generic question across two different jobs'
 * prescreen configs. When two configs use the same `sharedKey`, an answer to one is
 * reused for the other (skip + carry — re-judged against THIS job's rubric).
 *
 * Both prescreen runtimes — the deterministic FSM (`prescreen/pipeline.ts`) and the
 * agentic Claire (`apps/functions/src/claire-agent/*`) — read this SAME registry, so
 * they agree on the same keys (SPEC §8.3). Adding a key is a coordinated, deliberate
 * change: append to `PRESCREEN_SHARED_KEYS` below.
 *
 * NOT a tagging vocabulary — these are question identities, not enum classifications
 * of candidate text. The no-regex-in-tagging rule does not apply.
 *
 * Pure + dependency-free — L1-testable.
 */

/**
 * Authored shared-question keys, in registry order. Start with the AI-usage question
 * (Adam 2026-06-14: "start with the AI-usage question"). Extend deliberately.
 *
 * Token shape MUST match the config regex `^[a-z0-9_]+$` (1..64 chars).
 */
export const PRESCREEN_SHARED_KEYS = [
  /** "right now, how are you using AI to speed up your day-to-day work?" (informational). */
  "ai_usage",
] as const

export type PrescreenSharedKey = (typeof PRESCREEN_SHARED_KEYS)[number]

const SHARED_KEY_SET: ReadonlySet<string> = new Set(PRESCREEN_SHARED_KEYS)

/** True when `key` is a registered authored sharedKey. */
export function isRegisteredSharedKey(key: string | null | undefined): key is PrescreenSharedKey {
  return typeof key === "string" && SHARED_KEY_SET.has(key)
}

/**
 * The canonical sharedKey for the default AI-acceleration question. This is the
 * migration target for the bespoke `q_ai_acceleration` / `tags.aiAccelerationUsage`
 * MVP (commit 2ddabecc) — ONE authoritative store keyed here.
 */
export const AI_USAGE_SHARED_KEY: PrescreenSharedKey = "ai_usage"
