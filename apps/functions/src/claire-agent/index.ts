/**
 * claire-agent — thin Claire barrel.
 *
 * Stable public surface for the inbound handler (Wave B cutover) and the proactive
 * triggers. See README.md for the file-ownership map and the KEYSTONE.
 */
export { buildClaireAgent, runClaireTurn, CLAIRE_MODEL } from "./agent.js"
export { makeClaireSession } from "./session.js"
export {
  isThinClaireEnabled,
  THIN_CLAIRE_FLAG_KEY,
  THIN_CLAIRE_FLAG_SEED,
  THIN_CLAIRE_CANARY_UIDS,
} from "./flags.js"
export { runProactiveTurn } from "./proactive.js"
export {
  reduceMatchingPreferences,
  type MatchingPreferenceProposal,
  type MatchingTagsSlice,
  type MatchingReducerResult,
} from "./reducers/matching-profile-reducer.js"
export type {
  ClaireLang,
  ClaireMode,
  ClaireReaction,
  ClaireTransport,
  ClaireTurnInput,
  ClaireToolContext,
  ClaireRunResult,
  FindMatchResult,
} from "./types.js"
