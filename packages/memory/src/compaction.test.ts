/**
 * v1.8 Phase 74.5 — Memory Compaction Layer tests.
 *
 * Covers:
 *   - Type-safe normalization (drop malformed facts, clamp confidence)
 *   - utcDateKey + snapshotDocId helpers
 *   - Cost cap pure function
 *   - GC retention window
 *   - Confidence partition
 *   - Feature flag env parsing
 *   - runCompactionTurn full flow with stubbed deps:
 *       feature_disabled / no_turns / cost_cap / llm_error / completed
 *   - Snapshot fires BEFORE LLM call
 *   - mergeAndWriteTags receives only high-confidence facts
 *   - mem0AddFacts receives ALL facts (high + low conf)
 *   - Superseded delete by id
 *   - Ledger entries written on every outcome
 */
import test from "node:test"
import assert from "node:assert/strict"

import {
  DAILY_COMPACTION_CAP,
  FACT_TAG_CONFIDENCE_THRESHOLD,
  SNAPSHOT_RETENTION_DAYS,
  isMemoryCompactionEnabled,
  isOverCap,
  normalizeCompactionOutput,
  normalizeFact,
  partitionFactsByConfidence,
  runCompactionTurn,
  shouldGcSnapshot,
  snapshotDocId,
  utcDateKey,
  type CompactedFact,
  type CompactionCostEntry,
  type CompactionDeps,
  type CompactionLlmCaller,
  type CompactionOutput,
  type CompactionTurn,
  type TagSnapshot,
} from "./compaction.js"

// ════════════════════════════════════════════════════════════════════════════
// Pure helpers
// ════════════════════════════════════════════════════════════════════════════

test("Phase 74.5: utcDateKey extracts YYYY-MM-DD", () => {
  assert.equal(utcDateKey("2026-05-11T18:30:00.123Z"), "2026-05-11")
  assert.equal(utcDateKey("2026-12-31T00:00:00Z"), "2026-12-31")
})

test("Phase 74.5: utcDateKey rejects malformed ISO", () => {
  assert.throws(() => utcDateKey("not-an-iso"))
  assert.throws(() => utcDateKey(""))
})

test("Phase 74.5: snapshotDocId compresses timestamp", () => {
  assert.equal(snapshotDocId("2026-05-11T18:30:00Z"), "20260511T183000Z")
  assert.equal(snapshotDocId("2026-05-11T18:30:00.123Z"), "20260511T183000Z")
})

test("Phase 74.5: isOverCap respects DAILY_COMPACTION_CAP=5", () => {
  assert.equal(isOverCap(0), false)
  assert.equal(isOverCap(4), false)
  assert.equal(isOverCap(5), true)
  assert.equal(isOverCap(100), true)
  assert.equal(DAILY_COMPACTION_CAP, 5)
})

test("Phase 74.5: shouldGcSnapshot uses 30d retention", () => {
  const now = Date.now()
  const oldTs = new Date(now - (SNAPSHOT_RETENTION_DAYS + 1) * 86400000).toISOString()
  const recentTs = new Date(now - 1 * 86400000).toISOString()
  assert.equal(shouldGcSnapshot(oldTs, now), true)
  assert.equal(shouldGcSnapshot(recentTs, now), false)
  assert.equal(shouldGcSnapshot("garbage", now), false)
})

// ════════════════════════════════════════════════════════════════════════════
// Fact normalization
// ════════════════════════════════════════════════════════════════════════════

test("Phase 74.5: normalizeFact accepts well-formed fact + lowercases value", () => {
  const result = normalizeFact({
    kind: "skill",
    value: "TypeScript",
    confidence: 0.85,
    sourceTurn: "t_42",
  })
  assert.deepEqual(result, {
    kind: "skill",
    value: "typescript",
    confidence: 0.85,
    sourceTurn: "t_42",
  })
})

test("Phase 74.5: normalizeFact clamps confidence to [0,1]", () => {
  assert.equal(normalizeFact({ kind: "skill", value: "rust", confidence: 1.7, sourceTurn: "t" })?.confidence, 1)
  assert.equal(normalizeFact({ kind: "skill", value: "rust", confidence: -0.5, sourceTurn: "t" })?.confidence, 0)
})

test("Phase 74.5: normalizeFact rejects unknown kinds", () => {
  assert.equal(normalizeFact({ kind: "made_up", value: "x", confidence: 0.9, sourceTurn: "t" }), null)
})

test("Phase 74.5: normalizeFact rejects missing required fields", () => {
  assert.equal(normalizeFact(null), null)
  assert.equal(normalizeFact({ kind: "skill" }), null)
  assert.equal(normalizeFact({ kind: "skill", value: "", confidence: 0.5, sourceTurn: "t" }), null)
  assert.equal(normalizeFact({ kind: "skill", value: "ok", confidence: NaN, sourceTurn: "t" }), null)
})

test("Phase 74.5: normalizeCompactionOutput drops malformed, keeps good facts", () => {
  const out = normalizeCompactionOutput({
    facts: [
      { kind: "skill", value: "Go", confidence: 0.9, sourceTurn: "t1" },
      { kind: "garbage" },
      { kind: "industry", value: "fintech", confidence: 0.7, sourceTurn: "t2" },
      null,
    ],
    summary: "candidate uses Go in fintech",
    superseded: ["mem_old_1", "mem_old_2", "", 42],
  })
  assert.equal(out.facts.length, 2)
  assert.equal(out.facts[0].value, "go")
  assert.equal(out.facts[1].value, "fintech")
  assert.equal(out.summary, "candidate uses Go in fintech")
  // empty string + non-string filtered:
  assert.deepEqual(out.superseded, ["mem_old_1", "mem_old_2"])
})

test("Phase 74.5: normalizeCompactionOutput throws on non-object root", () => {
  assert.throws(() => normalizeCompactionOutput("not an object"))
  assert.throws(() => normalizeCompactionOutput(null))
})

test("Phase 74.5: normalizeCompactionOutput truncates long summary", () => {
  const long = "x".repeat(500)
  const out = normalizeCompactionOutput({ facts: [], summary: long, superseded: [] })
  assert.equal(out.summary.length, 240)
})

test("Phase 74.5: partitionFactsByConfidence honors threshold", () => {
  const facts: CompactedFact[] = [
    { kind: "skill", value: "a", confidence: 0.9, sourceTurn: "t1" },
    { kind: "skill", value: "b", confidence: FACT_TAG_CONFIDENCE_THRESHOLD, sourceTurn: "t2" },
    { kind: "skill", value: "c", confidence: 0.4, sourceTurn: "t3" },
  ]
  const { toTags, toMem0Only } = partitionFactsByConfidence(facts)
  assert.equal(toTags.length, 2)
  assert.equal(toMem0Only.length, 1)
  assert.equal(toMem0Only[0].value, "c")
})

// ════════════════════════════════════════════════════════════════════════════
// Feature flag
// ════════════════════════════════════════════════════════════════════════════

test("Phase 74.5: isMemoryCompactionEnabled defaults false", () => {
  assert.equal(isMemoryCompactionEnabled({}), false)
})

test("Phase 74.5: isMemoryCompactionEnabled true on '1' or 'true'", () => {
  assert.equal(isMemoryCompactionEnabled({ MEMORY_COMPACTION_ENABLED: "true" } as NodeJS.ProcessEnv), true)
  assert.equal(isMemoryCompactionEnabled({ MEMORY_COMPACTION_ENABLED: "1" } as NodeJS.ProcessEnv), true)
})

test("Phase 74.5: isMemoryCompactionEnabled false on other values", () => {
  assert.equal(isMemoryCompactionEnabled({ MEMORY_COMPACTION_ENABLED: "false" } as NodeJS.ProcessEnv), false)
  assert.equal(isMemoryCompactionEnabled({ MEMORY_COMPACTION_ENABLED: "yes" } as NodeJS.ProcessEnv), false)
})

// ════════════════════════════════════════════════════════════════════════════
// runCompactionTurn — stubbed deps
// ════════════════════════════════════════════════════════════════════════════

function makeStubDeps(opts: {
  countToday?: number
  llmOutput?: CompactionOutput
  llmThrows?: Error
  tagsBefore?: unknown
} = {}): CompactionDeps & {
  calls: {
    snapshot: TagSnapshot<unknown>[]
    mergedFacts: CompactedFact[][]
    mem0Added: CompactedFact[][]
    mem0Deleted: string[][]
    summary: string[]
    consumed: string[][]
    ledger: CompactionCostEntry[]
  }
} {
  const calls = {
    snapshot: [] as TagSnapshot<unknown>[],
    mergedFacts: [] as CompactedFact[][],
    mem0Added: [] as CompactedFact[][],
    mem0Deleted: [] as string[][],
    summary: [] as string[],
    consumed: [] as string[][],
    ledger: [] as CompactionCostEntry[],
  }
  const llm: CompactionLlmCaller = {
    async compact() {
      if (opts.llmThrows) throw opts.llmThrows
      return opts.llmOutput ?? { facts: [], summary: "", superseded: [] }
    },
  }
  return {
    llm,
    async getCountToday() {
      return opts.countToday ?? 0
    },
    async recordCostEntry(entry) {
      calls.ledger.push(entry)
      return `ledger_${calls.ledger.length}`
    },
    async writeSnapshot(snap) {
      calls.snapshot.push(snap as TagSnapshot<unknown>)
      return `snap_${calls.snapshot.length}`
    },
    async fetchUserTags() {
      return opts.tagsBefore ?? null
    },
    async mergeAndWriteTags(_uid, facts) {
      calls.mergedFacts.push(facts)
    },
    async writeContextSummary(_uid, s) {
      calls.summary.push(s)
    },
    async mem0AddFacts(_uid, facts) {
      calls.mem0Added.push(facts)
    },
    async mem0DeleteIds(_uid, ids) {
      calls.mem0Deleted.push(ids)
    },
    async markTurnsConsumed(_uid, ids) {
      calls.consumed.push(ids)
    },
    calls,
  }
}

const sampleTurns: CompactionTurn[] = [
  { id: "t1", role: "user", body: "I love Rust", ts: "2026-05-11T18:00:00Z" },
  { id: "t2", role: "assistant", body: "cool", ts: "2026-05-11T18:00:30Z" },
  { id: "t3", role: "user", body: "yeah I shipped a Rust service at last role", ts: "2026-05-11T18:01:00Z" },
]

test("Phase 74.5: runCompactionTurn short-circuits when feature flag off", async () => {
  const deps = makeStubDeps()
  const result = await runCompactionTurn({
    userId: "u1",
    turns: sampleTurns,
    nowIso: "2026-05-11T18:30:00Z",
    deps,
    envForFlag: {} as NodeJS.ProcessEnv,
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, "feature_disabled")
  assert.equal(deps.calls.snapshot.length, 0)
  assert.equal(deps.calls.ledger.length, 0)
})

test("Phase 74.5: runCompactionTurn short-circuits when no turns", async () => {
  const deps = makeStubDeps()
  const result = await runCompactionTurn({
    userId: "u1",
    turns: [],
    nowIso: "2026-05-11T18:30:00Z",
    deps,
    envForFlag: { MEMORY_COMPACTION_ENABLED: "true" } as NodeJS.ProcessEnv,
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, "no_turns")
  assert.equal(deps.calls.snapshot.length, 0)
})

test("Phase 74.5: runCompactionTurn hits cap and writes ledger entry", async () => {
  const deps = makeStubDeps({ countToday: 5 })
  const result = await runCompactionTurn({
    userId: "u1",
    turns: sampleTurns,
    nowIso: "2026-05-11T18:30:00Z",
    deps,
    envForFlag: { MEMORY_COMPACTION_ENABLED: "1" } as NodeJS.ProcessEnv,
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, "cost_cap")
  assert.equal(deps.calls.ledger.length, 1)
  assert.equal(deps.calls.ledger[0].outcome, "cap_hit")
  // Cap hit MUST NOT call snapshot/llm/mergeAndWriteTags
  assert.equal(deps.calls.snapshot.length, 0)
  assert.equal(deps.calls.mergedFacts.length, 0)
})

test("Phase 74.5: runCompactionTurn writes snapshot BEFORE LLM call", async () => {
  let snapshotOrderFlag = false
  const deps = makeStubDeps({
    llmOutput: {
      facts: [{ kind: "skill", value: "rust", confidence: 0.9, sourceTurn: "t1" }],
      summary: "uses rust",
      superseded: [],
    },
  })
  const origLlm = deps.llm.compact
  deps.llm.compact = async (args) => {
    snapshotOrderFlag = deps.calls.snapshot.length === 1
    return origLlm(args)
  }
  await runCompactionTurn({
    userId: "u1",
    turns: sampleTurns,
    nowIso: "2026-05-11T18:30:00Z",
    deps,
    envForFlag: { MEMORY_COMPACTION_ENABLED: "1" } as NodeJS.ProcessEnv,
  })
  assert.equal(snapshotOrderFlag, true, "snapshot must be written before LLM call")
})

test("Phase 74.5: runCompactionTurn full happy path writes all artifacts", async () => {
  const deps = makeStubDeps({
    tagsBefore: { skills: ["python"] },
    llmOutput: {
      facts: [
        { kind: "skill", value: "rust", confidence: 0.92, sourceTurn: "t3" },
        { kind: "experience", value: "shipped rust service", confidence: 0.4, sourceTurn: "t3" },
      ],
      summary: "candidate uses Rust at last role",
      superseded: ["mem_old_1"],
    },
  })
  const result = await runCompactionTurn({
    userId: "u1",
    turns: sampleTurns,
    nowIso: "2026-05-11T18:30:00Z",
    deps,
    envForFlag: { MEMORY_COMPACTION_ENABLED: "true" } as NodeJS.ProcessEnv,
  })
  assert.equal(result.ok, true)
  assert.equal(result.reason, "completed")
  assert.equal(result.factsWritten, 1) // only high-conf
  assert.equal(result.supersededDeleted, 1)
  assert.equal(result.snapshotId, "snap_1")

  // Snapshot captured pre-write tags
  assert.deepEqual(deps.calls.snapshot[0].tagsBefore, { skills: ["python"] })
  assert.equal(deps.calls.snapshot[0].reason, "pre_compaction")

  // mergeAndWriteTags only got high-conf fact
  assert.equal(deps.calls.mergedFacts.length, 1)
  assert.equal(deps.calls.mergedFacts[0].length, 1)
  assert.equal(deps.calls.mergedFacts[0][0].value, "rust")

  // mem0Add got ALL facts (high + low)
  assert.equal(deps.calls.mem0Added[0].length, 2)

  // superseded deleted
  assert.deepEqual(deps.calls.mem0Deleted[0], ["mem_old_1"])

  // summary persisted + turns marked
  assert.equal(deps.calls.summary[0], "candidate uses Rust at last role")
  assert.deepEqual(deps.calls.consumed[0], ["t1", "t2", "t3"])

  // ledger recorded
  assert.equal(deps.calls.ledger.length, 1)
  assert.equal(deps.calls.ledger[0].outcome, "completed")
  assert.equal(deps.calls.ledger[0].factsEmitted, 2)
})

test("Phase 74.5: runCompactionTurn handles LLM throw cleanly", async () => {
  const deps = makeStubDeps({ llmThrows: new Error("upstream 500") })
  const result = await runCompactionTurn({
    userId: "u1",
    turns: sampleTurns,
    nowIso: "2026-05-11T18:30:00Z",
    deps,
    envForFlag: { MEMORY_COMPACTION_ENABLED: "1" } as NodeJS.ProcessEnv,
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, "llm_error")
  assert.equal(result.errorMessage, "upstream 500")
  // Snapshot still written (so rollback is available even after llm failure)
  assert.equal(deps.calls.snapshot.length, 1)
  // No tag/mem0 writes on llm fail
  assert.equal(deps.calls.mergedFacts.length, 0)
  assert.equal(deps.calls.mem0Added.length, 0)
  // Ledger entry recorded with llm_error outcome
  assert.equal(deps.calls.ledger.length, 1)
  assert.equal(deps.calls.ledger[0].outcome, "llm_error")
})

test("Phase 74.5: runCompactionTurn skips tag write when all facts low-conf", async () => {
  const deps = makeStubDeps({
    llmOutput: {
      facts: [
        { kind: "skill", value: "maybe-rust", confidence: 0.3, sourceTurn: "t3" },
      ],
      summary: "ambiguous",
      superseded: [],
    },
  })
  const result = await runCompactionTurn({
    userId: "u1",
    turns: sampleTurns,
    nowIso: "2026-05-11T18:30:00Z",
    deps,
    envForFlag: { MEMORY_COMPACTION_ENABLED: "1" } as NodeJS.ProcessEnv,
  })
  assert.equal(result.ok, true)
  assert.equal(result.factsWritten, 0)
  // No tag write fired (all facts under threshold)
  assert.equal(deps.calls.mergedFacts.length, 0)
  // mem0 still wrote (vector-only)
  assert.equal(deps.calls.mem0Added[0].length, 1)
})
