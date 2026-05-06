/**
 * Phase 19 Adaptive Mirror — barrel export for the voice/ module.
 *
 * Consumers (orchestrator + memory persona-card) should import from
 * `./voice/index.js` (or via deep paths in tests). The module set:
 *   - slang-lexicon: Phase 18 VOICE-07 lexicon (D-08 reuse)
 *   - style-analyzer: deterministic 5-feature snapshot
 *   - mirror-snippet: positive-framing snippet builder (D-03)
 */
export { analyzeUserStyle, WEIGHTS_VERSION, type StyleSnapshot } from "./style-analyzer.js"
export { buildMirrorSnippet } from "./mirror-snippet.js"
export { ZH_SLANG, EN_SLANG, countSlangHits } from "./slang-lexicon.js"
// iter34 sprint A.4 — role canonical → industryEnum bucket mapper.
export { roleToIndustryBuckets, type IndustryEnumBucket } from "./role-to-industry.js"
