/**
 * Phase 36 — position constraint enforcer.
 *
 * Per D3 + Pinguet 2023: hesitation markers MUST land at turn-onset
 * (before the first sentence). Mid-clause injection reduces perceived
 * confidence and breaks Claire's voice.
 *
 * This module is the single enforcement point for the "turn-onset only"
 * rule. All injection paths route through `injectAtTurnOnset`. By
 * construction the marker only ever appears at index 0 of the returned
 * string (after optional whitespace trim).
 *
 * Anti-stutter (D-36-5): if `text` already starts with our marker (or
 * any policy marker — caller can pass `additionalMarkers` to widen), we
 * refuse injection (ok=false) so we don't double-stack `嗯… 嗯…` across
 * consecutive turns.
 *
 * Latency: pure string ops, < 1ms.
 */

/**
 * Trim leading whitespace and BOM-style invisibles. NOT a full trim — we
 * want to preserve trailing whitespace for separator handling.
 */
function trimLeading(text: string): string {
  return text.replace(/^[\s​﻿]+/, "")
}

/**
 * Returns true if `text` already starts with `marker` (case-sensitive).
 * Compares after stripping leading whitespace from text. Used as the
 * anti-stutter probe.
 */
export function startsWithMarker(text: string, marker: string): boolean {
  if (!text || !marker) return false
  const trimmed = trimLeading(text)
  return trimmed.startsWith(marker)
}

/**
 * Returns true if `text` starts with ANY of the given markers. Cheap
 * O(N) scan — N is typically the policy bank size (≤ 10 per lang).
 */
export function startsWithAnyMarker(text: string, markers: readonly string[]): boolean {
  if (!text || markers.length === 0) return false
  const trimmed = trimLeading(text)
  for (const m of markers) {
    if (m && trimmed.startsWith(m)) return true
  }
  return false
}

/** Result of an attempted turn-onset injection. */
export interface InjectAtTurnOnsetResult {
  /** True iff `injected` differs from input `text`. */
  ok: boolean
  /** Final text (equals input when `ok=false`). */
  injected: string
  /** Reason for skip (only set when `ok=false`). */
  reason?: string
}

/**
 * Prepend `marker` + `separator` to the start of `text`, enforcing
 * turn-onset rules.
 *
 * Position rule: marker MUST appear at the very start of the returned
 * string (after we strip leading whitespace from input). We never insert
 * mid-clause.
 *
 * Skip conditions (returns `{ ok:false, injected: text, reason }`):
 * - empty text or empty marker
 * - text already starts with `marker` (anti-stutter)
 * - text already starts with one of `existingMarkers` (anti-stutter for
 *   prev-turn marker drift across the policy bank)
 *
 * The caller (the injector orchestrator) is responsible for:
 * - choosing which marker / separator / lang
 * - passing the previous-turn-derived `existingMarkers` set if anti-
 *   stutter across turns is desired
 *
 * This function is purely about the SINGLE-TURN position guarantee.
 *
 * @returns `{ ok, injected, reason? }`
 */
export function injectAtTurnOnset(
  text: string,
  marker: string,
  separator: string,
  opts: { existingMarkers?: readonly string[] } = {}
): InjectAtTurnOnsetResult {
  if (typeof text !== "string" || text.length === 0) {
    return { ok: false, injected: text ?? "", reason: "empty_text" }
  }
  if (typeof marker !== "string" || marker.length === 0) {
    return { ok: false, injected: text, reason: "empty_marker" }
  }
  // Anti-stutter — same marker already at start.
  if (startsWithMarker(text, marker)) {
    return { ok: false, injected: text, reason: "already_starts_with_marker" }
  }
  // Anti-stutter — any policy marker already at start.
  if (opts.existingMarkers && startsWithAnyMarker(text, opts.existingMarkers)) {
    return { ok: false, injected: text, reason: "already_starts_with_policy_marker" }
  }
  const sep = typeof separator === "string" ? separator : ""
  // Strip leading whitespace from text; marker becomes char[0].
  const body = trimLeading(text)
  return { ok: true, injected: `${marker}${sep}${body}` }
}

/**
 * Verify (post-injection) that `injected` actually has `marker` at index
 * 0. Defense-in-depth invariant check; tests assert on this.
 */
export function isAtTurnOnset(injected: string, marker: string): boolean {
  if (!injected || !marker) return false
  return injected.startsWith(marker)
}
