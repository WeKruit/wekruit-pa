/**
 * v1.8 Phase 74.5 — Memory Compaction Layer.
 *
 * Closes the gap flagged by Adam 2026-05-11: "memory 怎么管理呢? 不能一直加，
 * 我们的 agent 也需要 compact 记忆; 每次 compact 也需要用我们 mem0 系统和
 * tagging system 更新对吧."
 *
 * Until v1.8, the only memory pruning was `voice/context-window.ts` sliding-
 * window TURN truncation. Old turns were DROPPED, not DISTILLED. mem0 wrote
 * per-turn but never coordinated with `pa-users.tags`. Onboarding's
 * `persistUserTagsFromResumeDiscussionData` ran once at CV-ingest then never
 * again — chat facts ("我刚学了 Rust") never propagated to tags.
 *
 * This layer adds:
 *   1. LLM distillation of raw_turns → {facts, summary, superseded}
 *   2. Mandatory write through `mergeUserTags` (D8 sole-writer invariant)
 *   3. mem0Add for new facts + mem0Delete-by-id for superseded ones
 *   4. Pre-compaction snapshot to `pa-users-tag-snapshots/{uid}/{ts}` for
 *      rollback safety (30-day retention, GC'd later)
 *   5. Cost cap: ≤5 compactions/user/day enforced + cost-ledger logging
 *   6. Feature flag `memoryCompactionEnabled` (default off, gradual rollout)
 *
 * This file contains the pure-functional core (types, normalizers, cost-cap,
 * snapshot writer). The actual LLM caller wiring is via the injectable
 * `CompactionLlmCaller` interface — see `runCompactionTurn` below — so tests
 * can stub the LLM without pulling agent-runtime/openai into this layer.
 *
 * Trigger glue (turn-count threshold, session-end, __PA_COMPACT__ admin
 * trigger) is wired in Phase 76 (pipeline) + Phase 77 (webhook router).
 */

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

/** A single chat turn fed into the compaction LLM. */
export interface CompactionTurn {
  /** Stable id (Firestore message doc id, etc) — used to mark turns as
   *  consumed after compaction. */
  id: string
  role: "user" | "assistant"
  body: string
  /** ISO timestamp. */
  ts: string
}

/** A single extracted fact emitted by the compaction LLM. */
export interface CompactedFact {
  /** Semantic kind — guides which tag field receives the value.
   *  Closed enum: extend in `applyFactToUserTags` when adding new kinds. */
  kind:
    | "skill"
    | "industry"
    | "role_function"
    | "career_stage"
    | "visa"
    | "location"
    | "preference"
    | "experience"
    | "education"
    | "other"
  /** Canonical value (lowercased, may match shared-tags vocab). */
  value: string
  /** [0,1] — LLM confidence in this fact. */
  confidence: number
  /** Source turn id from `CompactionTurn[]` for traceability. */
  sourceTurn: string
}

/** Output schema from the compaction LLM. JSON-mode validated. */
export interface CompactionOutput {
  /** New facts surfaced from the turn window. */
  facts: CompactedFact[]
  /** Rolling natural-language summary (≤200 chars) for `pa-users.contextSummary`. */
  summary: string
  /** mem0 memory IDs that the new facts SUPERSEDE — must be deleted by id. */
  superseded: string[]
}

/** Result of one compaction run for downstream metrics/auditing. */
export interface CompactionResult {
  ok: boolean
  reason?: "feature_disabled" | "cost_cap" | "no_turns" | "llm_error" | "completed"
  factsWritten: number
  supersededDeleted: number
  snapshotId?: string
  costLedgerEntryId?: string
  /** When ok=false reason=llm_error: the underlying error message. */
  errorMessage?: string
}

// ────────────────────────────────────────────────────────────────────────────
// Cost cap
// ────────────────────────────────────────────────────────────────────────────

/** Per-user-per-day compaction count cap (PS14). */
export const DAILY_COMPACTION_CAP = 5

/** Cost-ledger entry written for every compaction attempt (success or cap-hit). */
export interface CompactionCostEntry {
  userId: string
  ts: string
  /** UTC date stamp (YYYY-MM-DD) — used as the cap-check key. */
  dateKey: string
  outcome: "completed" | "cap_hit" | "feature_disabled" | "llm_error"
  /** ISO duration string for the LLM call (e.g. "PT2.3S"). */
  llmLatencyMs?: number
  /** Number of facts emitted (0 on failure). */
  factsEmitted?: number
}

/**
 * Derive the UTC YYYY-MM-DD key from an ISO timestamp. Used as Firestore doc
 * key for the per-day cost-cap counter (`pa-compaction-cost-ledger/{uid_dateKey}`).
 */
export function utcDateKey(iso: string): string {
  // Defensive: extract YYYY-MM-DD without locale dependence.
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) throw new Error(`utcDateKey: invalid ISO timestamp: ${iso}`)
  return `${m[1]}-${m[2]}-${m[3]}`
}

/**
 * Returns true when the user is over the daily cap. Pure function — caller
 * fetches the count from `pa-compaction-cost-ledger` and passes it in.
 */
export function isOverCap(countToday: number): boolean {
  return countToday >= DAILY_COMPACTION_CAP
}

// ────────────────────────────────────────────────────────────────────────────
// Snapshot
// ────────────────────────────────────────────────────────────────────────────

/**
 * Build the Firestore doc id for a tag snapshot. Format keeps snapshots
 * lexicographically sorted by time, scoped per user.
 *   ts → "2026-05-11T18:30:00Z" → "20260511T183000Z"
 */
export function snapshotDocId(ts: string): string {
  return ts.replace(/[-:]/g, "").replace(/\.\d+/, "")
}

/**
 * Snapshot payload — exactly the pa-users.tags shape before compaction +
 * the metadata caller will read on rollback.
 */
export interface TagSnapshot<TUserTags = unknown> {
  userId: string
  ts: string
  reason: "pre_compaction" | "manual" | "migration"
  /** Whatever `pa-users/{uid}.tags` looked like before write. */
  tagsBefore: TUserTags | null
  /** Compaction context — which turn window triggered this snapshot. */
  triggeredBy?: {
    turnCount: number
    firstTurnTs: string
    lastTurnTs: string
  }
}

/** GC threshold: 30-day retention (PS13). */
export const SNAPSHOT_RETENTION_DAYS = 30

/**
 * Returns true when the snapshot is older than the retention window and
 * should be deleted by the GC sweep. Caller passes the snapshot ts + "now"
 * so this stays a pure function.
 */
export function shouldGcSnapshot(snapshotTs: string, nowMs: number): boolean {
  const snapMs = new Date(snapshotTs).getTime()
  if (!Number.isFinite(snapMs)) return false
  const ageMs = nowMs - snapMs
  return ageMs > SNAPSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000
}

// ────────────────────────────────────────────────────────────────────────────
// Fact validation + normalization
// ────────────────────────────────────────────────────────────────────────────

const ALLOWED_FACT_KINDS: ReadonlyArray<CompactedFact["kind"]> = [
  "skill",
  "industry",
  "role_function",
  "career_stage",
  "visa",
  "location",
  "preference",
  "experience",
  "education",
  "other",
]

/**
 * Validate a single LLM-emitted fact. Returns null when the fact is
 * malformed (drop silently — LLMs sometimes hallucinate fields). Returns
 * a normalized copy on success.
 *
 * Lowercases value, clamps confidence to [0,1], rejects unknown kinds.
 */
export function normalizeFact(raw: unknown): CompactedFact | null {
  if (typeof raw !== "object" || raw === null) return null
  const o = raw as Record<string, unknown>
  if (typeof o.kind !== "string") return null
  if (!ALLOWED_FACT_KINDS.includes(o.kind as CompactedFact["kind"])) return null
  if (typeof o.value !== "string" || o.value.length === 0) return null
  if (typeof o.confidence !== "number" || !Number.isFinite(o.confidence)) return null
  if (typeof o.sourceTurn !== "string" || o.sourceTurn.length === 0) return null

  const confidence = Math.max(0, Math.min(1, o.confidence))
  const value = o.value.trim().toLowerCase()
  if (value.length === 0) return null
  return {
    kind: o.kind as CompactedFact["kind"],
    value,
    confidence,
    sourceTurn: o.sourceTurn,
  }
}

/**
 * Validate the full LLM JSON response. Drops malformed facts silently;
 * returns a normalized CompactionOutput. Throws when the top-level shape is
 * unparseable (caller should treat as llm_error).
 */
export function normalizeCompactionOutput(raw: unknown): CompactionOutput {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("normalizeCompactionOutput: top-level is not an object")
  }
  const o = raw as Record<string, unknown>
  const factsRaw = Array.isArray(o.facts) ? o.facts : []
  const facts = factsRaw
    .map(normalizeFact)
    .filter((f): f is CompactedFact => f !== null)
  const summary = typeof o.summary === "string" ? o.summary.slice(0, 240) : ""
  const supersededRaw = Array.isArray(o.superseded) ? o.superseded : []
  const superseded = supersededRaw
    .filter((id): id is string => typeof id === "string" && id.length > 0)
  return { facts, summary, superseded }
}

// ────────────────────────────────────────────────────────────────────────────
// Confidence gate (PS12)
// ────────────────────────────────────────────────────────────────────────────

/** Facts under this confidence are NOT propagated to mergeUserTags. */
export const FACT_TAG_CONFIDENCE_THRESHOLD = 0.6

/** Split the fact list into (tag-bound, mem0-only) per confidence. */
export function partitionFactsByConfidence(facts: CompactedFact[]): {
  toTags: CompactedFact[]
  toMem0Only: CompactedFact[]
} {
  const toTags: CompactedFact[] = []
  const toMem0Only: CompactedFact[] = []
  for (const f of facts) {
    if (f.confidence >= FACT_TAG_CONFIDENCE_THRESHOLD) toTags.push(f)
    else toMem0Only.push(f)
  }
  return { toTags, toMem0Only }
}

// ────────────────────────────────────────────────────────────────────────────
// Feature flag
// ────────────────────────────────────────────────────────────────────────────

/**
 * Reads the per-environment compaction flag. Defaults FALSE (gradual rollout
 * per PS-ROLLOUT). Pre-screen pipeline + onboarding postCollect MUST consult
 * this before invoking `runCompactionTurn`.
 */
export function isMemoryCompactionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MEMORY_COMPACTION_ENABLED === "true" || env.MEMORY_COMPACTION_ENABLED === "1"
}

// ────────────────────────────────────────────────────────────────────────────
// LLM caller seam (injected — real wiring lands in Phase 75/76)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Injectable LLM caller. Phase 75 wires this to gpt-5.4-nano via
 * `agent-runtime` with JSON-mode + temperature=0 + Sonnet-4-6 fallback.
 * Until then, tests stub this and trigger sites pass a no-op.
 */
export interface CompactionLlmCaller {
  /**
   * Compact a window of turns into structured facts + summary + superseded.
   * Must return parsed-and-validated JSON. The caller is responsible for
   * timeout, retries, fallback chain, and JSON-mode enforcement.
   */
  compact(args: {
    turns: CompactionTurn[]
    userId: string
    /** Prior contextSummary so the LLM can produce a delta-aware summary. */
    priorSummary?: string
  }): Promise<CompactionOutput>
}

// ────────────────────────────────────────────────────────────────────────────
// Orchestrator: pure dispatcher
// ────────────────────────────────────────────────────────────────────────────

/**
 * Dependencies for one compaction run. Caller wires these from production
 * code paths; tests inject stubs.
 *
 * NOTE: tag writeback uses an injected `mergeAndWriteTags` callback rather
 * than importing `mergeUserTags` directly — keeps this layer in @pa/memory
 * without pulling in @pa/pa-orchestrator/tags. The trigger glue in Phase 76
 * wires the real `mergeUserTags` + Firestore writer.
 */
export interface CompactionDeps {
  llm: CompactionLlmCaller
  /** Returns how many compactions the user has run today (UTC). */
  getCountToday: (userId: string, dateKey: string) => Promise<number>
  /** Increments the user's daily counter + writes a ledger entry. */
  recordCostEntry: (entry: CompactionCostEntry) => Promise<string>
  /** Writes the pre-compaction snapshot. Returns the snapshot doc id. */
  writeSnapshot: <T>(snap: TagSnapshot<T>) => Promise<string>
  /** Fetches the user's current pa-users.tags. */
  fetchUserTags: (userId: string) => Promise<unknown | null>
  /** Apply new facts via `mergeUserTags` + write back. */
  mergeAndWriteTags: (userId: string, facts: CompactedFact[]) => Promise<void>
  /** Append the rolling summary to pa-users.contextSummary. */
  writeContextSummary: (userId: string, summary: string) => Promise<void>
  /** Write new mem0 entries (one per fact). */
  mem0AddFacts: (userId: string, facts: CompactedFact[]) => Promise<void>
  /** Delete superseded mem0 entries by id. */
  mem0DeleteIds: (userId: string, ids: string[]) => Promise<void>
  /** Mark consumed turns so they aren't re-compacted next round. */
  markTurnsConsumed?: (userId: string, turnIds: string[]) => Promise<void>
  /** Telemetry/logger. */
  log?: (event: string, payload: Record<string, unknown>) => void
}

/**
 * Run one compaction. Idempotent at the cost-cap layer — if the cap is hit
 * the function returns {ok:false, reason:"cost_cap"} without LLM call or
 * writes.
 *
 * Flow (PS11 + PS12 + PS13 + PS14):
 *   1. Feature-flag check → early-out
 *   2. Cost-cap check → early-out
 *   3. No-turn check → early-out
 *   4. Snapshot pa-users.tags
 *   5. LLM compact()
 *   6. Validate + partition facts
 *   7. mergeAndWriteTags (high-confidence facts only)
 *   8. mem0Add (ALL facts — low-conf go vector-only)
 *   9. mem0Delete superseded ids
 *  10. writeContextSummary
 *  11. markTurnsConsumed (optional)
 *  12. recordCostEntry
 */
export async function runCompactionTurn(args: {
  userId: string
  turns: CompactionTurn[]
  priorSummary?: string
  nowIso: string
  deps: CompactionDeps
  envForFlag?: NodeJS.ProcessEnv
}): Promise<CompactionResult> {
  const { userId, turns, priorSummary, nowIso, deps } = args
  const log = deps.log ?? (() => {})

  if (!isMemoryCompactionEnabled(args.envForFlag)) {
    log("memory.compaction.skip", { userId, reason: "feature_disabled" })
    return { ok: false, reason: "feature_disabled", factsWritten: 0, supersededDeleted: 0 }
  }

  if (turns.length === 0) {
    log("memory.compaction.skip", { userId, reason: "no_turns" })
    return { ok: false, reason: "no_turns", factsWritten: 0, supersededDeleted: 0 }
  }

  const dateKey = utcDateKey(nowIso)
  const countToday = await deps.getCountToday(userId, dateKey)
  if (isOverCap(countToday)) {
    const ledgerId = await deps.recordCostEntry({
      userId,
      ts: nowIso,
      dateKey,
      outcome: "cap_hit",
    })
    log("memory.compaction.cap_hit", { userId, countToday, cap: DAILY_COMPACTION_CAP })
    return {
      ok: false,
      reason: "cost_cap",
      factsWritten: 0,
      supersededDeleted: 0,
      costLedgerEntryId: ledgerId,
    }
  }

  // ── Snapshot ──────────────────────────────────────────────────────────────
  const tagsBefore = await deps.fetchUserTags(userId)
  const snapshotId = await deps.writeSnapshot({
    userId,
    ts: nowIso,
    reason: "pre_compaction",
    tagsBefore,
    triggeredBy: {
      turnCount: turns.length,
      firstTurnTs: turns[0].ts,
      lastTurnTs: turns[turns.length - 1].ts,
    },
  })

  // ── LLM ───────────────────────────────────────────────────────────────────
  const llmStart = Date.now()
  let raw: CompactionOutput
  try {
    raw = await deps.llm.compact({ turns, userId, priorSummary })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const ledgerId = await deps.recordCostEntry({
      userId,
      ts: nowIso,
      dateKey,
      outcome: "llm_error",
      llmLatencyMs: Date.now() - llmStart,
    })
    log("memory.compaction.llm_error", { userId, error: msg })
    return {
      ok: false,
      reason: "llm_error",
      factsWritten: 0,
      supersededDeleted: 0,
      snapshotId,
      costLedgerEntryId: ledgerId,
      errorMessage: msg,
    }
  }
  const llmLatencyMs = Date.now() - llmStart

  // ── Validate + partition ──────────────────────────────────────────────────
  const { toTags, toMem0Only } = partitionFactsByConfidence(raw.facts)

  // ── Writeback (D8 single tag writer) ──────────────────────────────────────
  if (toTags.length > 0) {
    await deps.mergeAndWriteTags(userId, toTags)
  }

  // ── mem0: add all facts, delete superseded ───────────────────────────────
  const allFacts = [...toTags, ...toMem0Only]
  if (allFacts.length > 0) {
    await deps.mem0AddFacts(userId, allFacts)
  }
  if (raw.superseded.length > 0) {
    await deps.mem0DeleteIds(userId, raw.superseded)
  }

  if (raw.summary.length > 0) {
    await deps.writeContextSummary(userId, raw.summary)
  }

  if (deps.markTurnsConsumed) {
    await deps.markTurnsConsumed(userId, turns.map((t) => t.id))
  }

  const ledgerId = await deps.recordCostEntry({
    userId,
    ts: nowIso,
    dateKey,
    outcome: "completed",
    llmLatencyMs,
    factsEmitted: raw.facts.length,
  })

  log("memory.compaction.completed", {
    userId,
    factsEmitted: raw.facts.length,
    factsToTags: toTags.length,
    factsMem0Only: toMem0Only.length,
    supersededCount: raw.superseded.length,
    llmLatencyMs,
    snapshotId,
  })

  return {
    ok: true,
    reason: "completed",
    factsWritten: toTags.length,
    supersededDeleted: raw.superseded.length,
    snapshotId,
    costLedgerEntryId: ledgerId,
  }
}
