export {
  loadRecentMessages,
  loadPersonalizationContext,
  afterAssistantTurn,
  isMem0EnvConfigured,
  type MemoryStackDeps,
} from "./stacked.js"
export { mem0Add, mem0Search, type Mem0AddOptions, type Mem0Config } from "./mem0.js"
export { rerankAndTrim, defaultLlmRerank } from "./mem0-rerank.js"
export {
  FirestoreCanonicalMemoryStore,
  Mem0SemanticMemoryProvider,
  NoopSemanticMemoryProvider,
  type CanonicalMemoryStore,
  type SemanticMemoryProvider,
} from "./providers.js"
export { findMatchingFacts, parseMemoryCommand, shouldRejectMemoryFact } from "./commands.js"
export {
  createConfirmedMemoryFact,
  listConfirmedMemoryFacts,
  markMemoryFactsDeleted,
  recordMemoryAction,
} from "./facts.js"
export { archiveMonth, buildArchivePath, toArchiveJsonLine, type ArchivedMessageJson } from "./archive.js"
export {
  clearUserMemory,
  isResetCommand,
  summarizeClearResult,
  RESET_PATTERNS,
  type ClearUserMemoryDeps,
  type ClearUserMemoryOptions,
  type ClearUserMemoryResult,
} from "./admin.js"
export type {
  LoadContextInput,
  LoadContextResult,
  AfterTurnInput,
  AfterTurnResult,
  Mem0DegradedReason,
} from "./types.js"
export type { FactLike, MemoryCommand } from "./commands.js"
export { buildPersonaCard, buildPersonaCardWithVoice } from "./persona-card.js"
export {
  readStylePreference,
  writeStylePreference,
  setVoiceStyleStore,
  createInMemoryVoiceStyleStore,
  createFirestoreVoiceStyleStore,
  snapshotToPreference,
  renderStylePreferenceLine,
  type VoiceStylePreference,
  type VoiceStyleStore,
} from "./voice-style-preference.js"
export {
  resolveMem0PartitionKey,
  recordDriftIfAny,
  type ResolverUser,
  type DriftSurface,
  type RecordDriftDeps,
  type RecordDriftInput,
} from "./identity.js"

// v1.8 Phase 74.5 — Memory Compaction Layer
export {
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
  type CompactionResult,
  type CompactionTurn,
  type TagSnapshot,
} from "./compaction.js"
