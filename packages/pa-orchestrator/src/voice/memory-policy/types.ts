/**
 * Phase 38 — Memory Policy types.
 *
 * Single source-of-truth for the cross-session advice tracker + Mem0 fact
 * contradiction detector + Phase 3 prompt-injection.
 *
 * Hard constraints (per .planning/phases/38-memory-policy/CONTEXT.md):
 * - 0 net new LLM calls in production (BGE-M3 = embedding tier free; Mem0
 *   fact extract uses EXISTING Qwen call from `stacked.ts:applyAfterTurn`)
 * - < 200ms per turn (warm path) for advice query + contradiction check
 * - BGE-M3 graceful degrade on missing API key (skip embed-based axes,
 *   never throw)
 * - S3 sync: persona-locked contradiction (Type 10) MUST read from
 *   `pa-personas/{slug}` Firestore (not inline strings)
 * - Bilingual zh + en + mixed code-switch supported throughout
 *
 * Reused from Phase 35 detectors (algorithm parity audited):
 * - `cosineSim` re-exported from `../detectors/f4-advice-repeat.ts`
 * - BGE-M3 SiliconFlow POST + LRU cache pattern mirrored
 *
 * Reused from Phase 32 W3 personas:
 * - `getPersona` (`pa-personas/{slug}` Firestore) for Type 10 contradiction
 *
 * Reused from `packages/memory/src/mem0.ts`:
 * - `mem0Search` for read-only fact retrieval (no new extracts triggered)
 */

import type { Firestore } from "firebase-admin/firestore"

// ---------------------------------------------------------------------------
// Advice tracker
// ---------------------------------------------------------------------------

/**
 * One persisted advice tracker entry.
 *
 * Schema (`pa-advice-tracker/{userId}/items/{turnId}`) — D-38-1:
 * - `embedding` is `null` when no API key was available at write time
 *   (graceful degrade — the entry is still queryable for text-only
 *   anti-repeat heuristics).
 * - `strategy` + `uxState` are populated from Phase 37 FsmResult by the
 *   wire-in caller; pre-FSM-wire-in they remain null.
 * - `schemaVersion` allows future migrations.
 */
export interface AdviceTrackerEntry {
  userId: string
  turnId: string
  text: string
  lang: "zh" | "en" | "mixed"
  /** 1024-dim Float32; serialized as plain number[] in Firestore. */
  embedding: number[] | null
  embeddedAt: string | null
  strategy: string | null
  uxState: string | null
  ts: string
  schemaVersion: 1
}

/** `repeatScore` output. Mirrors Phase 35 F4 detector shape. */
export interface RepeatScoreResult {
  triggered: boolean
  /** null when degraded (no embed API key or all-empty history). */
  maxSim: number | null
  /** Index in `recent[]` array (-1 when none). */
  mostSimilarIdx: number
  /** Per-history cos-sim values (empty when degraded). */
  sims: number[]
  /** Active threshold (env or default 0.85). */
  threshold: number
  /** Human-readable trace (`cos_sim_X_>=_Y` or skip reason). */
  reason: string
  latencyMs: number
}

// ---------------------------------------------------------------------------
// Contradiction detector
// ---------------------------------------------------------------------------

/**
 * 10 contradiction types covered by the seeded fixture set (D-38-3).
 * Type priority on overlap: persona_locked > allergy > health > dietary >
 *   preference_negation > pet > location > relationship > profession > language.
 */
export type ContradictionType =
  | "dietary"
  | "allergy"
  | "pet"
  | "location"
  | "relationship"
  | "profession"
  | "preference_negation"
  | "health"
  | "language"
  | "persona_locked"

export interface ContradictionResult {
  violated: boolean
  type: ContradictionType | null
  /** The matched offending term in Claire's reply (e.g. "steak"). */
  violatedTerm: string | null
  /** The user-stated fact that the reply contradicts (truncated to 200ch). */
  factSnippet: string | null
  /** The reply substring that contradicts (truncated to 200ch). */
  replySnippet: string | null
  /** 0..1 — 1.0 for direct lexicon hit, 0.5 for fuzzy. */
  confidence: number
  latencyMs: number
}

// ---------------------------------------------------------------------------
// Orchestrator I/O
// ---------------------------------------------------------------------------

/**
 * Input for `runMemoryPolicy`.
 *
 * - `claireReply` — Claire's draft reply (post-rewriter; pre-emit)
 * - `userLang` — directive `note:` gloss language hint
 * - `currentStrategy` / `currentUxState` — populated from Phase 37 FsmResult
 *   by wire-in caller; null pre-FSM-wire-in
 * - `factsCache` — optional pre-fetched user facts (skips Mem0 search when
 *   provided; lets caller dedupe across detector + memory-policy passes)
 */
export interface MemoryPolicyContext {
  userId: string
  turnId: string
  claireReply: string
  userLang?: "zh" | "en" | "mixed"
  currentStrategy?: string
  currentUxState?: string
  factsCache?: string[]
}

/**
 * Output of `runMemoryPolicy`. Wire-in caller (Adam-owed via
 * WIRE-IN-PATCH.md) consumes:
 *
 * - `advice.injection` — appended to Phase 3 system prompt; empty string
 *                       when `recent.length === 0`
 * - `advice.repeatScore.triggered` — drives reject+resample loop in
 *                                    rewriter (alongside Phase 35 F4)
 * - `contradiction.violated` — drives optional retry/log; v1.4 = log only
 * - `latencyMs` — instrumented; asserted < 200ms p95 in smoke
 */
export interface MemoryPolicyResult {
  advice: {
    recent: AdviceTrackerEntry[]
    repeatScore: RepeatScoreResult
    injection: string
  }
  contradiction: ContradictionResult
  latencyMs: number
}

// ---------------------------------------------------------------------------
// Dependency injection — single hook surface for tests + wire-in
// ---------------------------------------------------------------------------

/**
 * Persona snapshot used by Type 10 (persona_locked) contradiction.
 * Wire-in caller injects `getPersona` returning this shape from Phase 32 W3
 * `pa-personas/{slug}` Firestore. NEVER reads inline persona strings.
 */
export interface PersonaSnapshot {
  soul: string
  style: string
  examples: string
}

/**
 * Single-bag dep injection — every external surface routes through here.
 * Tests pass mocks; wire-in caller passes real implementations.
 *
 * - `db` — Firestore instance for `pa-advice-tracker/...` reads + writes
 * - `embedFn` — BGE-M3 batch embed (text[] → Float32Array[]); returns
 *               `null` when API key absent
 * - `mem0Search` — read-only Mem0 fact lookup (`mem0Search(query, userId)`)
 *                  returning natural-language fact strings; uses the
 *                  EXISTING Qwen extract call (no new LLM calls)
 * - `getPersona` — `pa-personas/{slug}` Firestore reader for S3 sync
 *                  (Phase 32 W3 — `composePersonaPromptFromDoc` source)
 */
export interface AdviceTrackerDeps {
  db?: Firestore
  embedFn?: (texts: string[]) => Promise<(Float32Array | null)[] | null>
  mem0Search?: (query: string, userId: string) => Promise<string[]>
  getPersona?: (slug: string) => Promise<PersonaSnapshot | null>
}
