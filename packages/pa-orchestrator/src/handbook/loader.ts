/**
 * Phase 29 T1 — Orchestrator handbook loader.
 *
 * Thin wrapper that re-exports the persistence-layer SDK + a single
 * `composeSystemPrompt` function. Lives under
 * `packages/pa-orchestrator/src/handbook/loader.ts` per PLAN.md spec so
 * orchestrator code never reaches across into `@pa/pa-persistence/handbook`
 * directly — the wrapper is the public API the orchestrator uses.
 *
 * Re-exporting (instead of re-implementing) keeps the compose logic + cache
 * statistics single-source. Same shape Phase 24.5 used for feature flags.
 */
export {
  composeHandbookV2SystemPrompt as composeSystemPrompt,
  loadHandbookV2 as loadHandbook,
  saveHandbookV2 as saveHandbook,
  revertHandbookV2 as revertHandbook,
  listHandbookVersions as listVersions,
  getHandbookVersion as getVersion,
  emptyHandbookSections,
  normalizeHandbookSections,
  HANDBOOKS_COLLECTION,
  HANDBOOK_VERSIONS_SUBCOLLECTION,
  HANDBOOK_TTL_MS,
  HANDBOOK_RENDER_ORDER,
  DEFAULT_HANDBOOK_SLUG,
  _clearHandbookCache,
  _getHandbookCacheStats,
} from "@pa/pa-persistence"
export type {
  HandbookDoc,
  HandbookSections,
  PlaybookSpec,
  SaveHandbookOpts,
} from "@pa/pa-persistence"
