/**
 * Phase 19 Adaptive Mirror — orchestrator integration helpers.
 *
 * Pulls the user-only window from a ChatMessage[] history (D-05 — assistant
 * turns are NOT considered) and produces the mirror snippet, honoring the
 * `PA_VOICE_MIRROR_DISABLED` kill switch (D-07).
 *
 * Why a separate file: keeps `index.ts` thin and lets the snippet
 * computation be unit-tested without spinning up the whole turn pipeline.
 */
import type { ChatMessage } from "@pa/core-types"
import { analyzeUserStyle, type StyleSnapshot } from "./style-analyzer.js"
import { buildMirrorSnippet } from "./mirror-snippet.js"

const WINDOW_USER_TURNS = 5

function truthyDisabled(v: string | undefined): boolean {
  return v != null && v.trim().toLowerCase() === "true"
}

/** True when Phase 19 mirror is disabled by env (D-07 kill switch). */
export function isVoiceMirrorDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return truthyDisabled(env.PA_VOICE_MIRROR_DISABLED)
}

/**
 * Extract the last N user turns from history + the current event body.
 * Order: oldest → newest, with the current event body appended last so the
 * analyzer sees the freshest signal at the window tail.
 *
 * `currentUserText` is the user's just-arrived message (event.body). It is
 * NOT yet in history at the call site (orchestrator appends it before the
 * model call but the snippet is computed against the same conceptual window).
 */
export function extractUserTurnWindow(
  history: ChatMessage[],
  currentUserText: string,
  windowSize = WINDOW_USER_TURNS
): string[] {
  const userOnly = history
    .filter((m) => m.role === "user" && typeof m.body === "string" && m.body.length > 0)
    .map((m) => m.body)
  // Avoid double-counting if appendMessage already wrote the current turn.
  const tail =
    userOnly.length > 0 && userOnly[userOnly.length - 1] === currentUserText
      ? userOnly
      : [...userOnly, currentUserText]
  return tail.slice(-windowSize)
}

export interface MirrorComputation {
  snapshot: StyleSnapshot | null
  snippet: string | null
  /** Telemetry-friendly summary; never includes raw user text. */
  audit: { sample_size: number; register_score: number; zh_char_ratio: number } | null
}

/**
 * Compute the mirror snippet for this turn, or return all-nulls when the
 * kill switch is on (D-07: skips analyzer + snippet + caller skips mem0
 * write — see writeStylePreference call site).
 */
export function computeMirrorForTurn(
  history: ChatMessage[],
  currentUserText: string,
  env: NodeJS.ProcessEnv = process.env
): MirrorComputation {
  if (isVoiceMirrorDisabled(env)) {
    return { snapshot: null, snippet: null, audit: null }
  }
  const window = extractUserTurnWindow(history, currentUserText)
  if (window.length === 0) {
    return { snapshot: null, snippet: null, audit: null }
  }
  const snapshot = analyzeUserStyle(window)
  const snippet = buildMirrorSnippet(snapshot)
  const audit = snippet
    ? {
        sample_size: snapshot.sample_size,
        register_score: snapshot.register_score,
        zh_char_ratio: snapshot.zh_char_ratio,
      }
    : null
  return { snapshot, snippet, audit }
}
