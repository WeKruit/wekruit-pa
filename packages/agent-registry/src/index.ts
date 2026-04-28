export { getAgentById, getDefaultAgent, listAgents, ensureSeedAgents, loadSeedAgents } from "./firestore.js"
export { buildAgentSystemPrompt, publishAgentVersion, rollbackAgentVersion, setDefaultAgent } from "./lifecycle.js"
export { parseAgentDef } from "./parse.js"
export { resolveAgentVersion } from "./version-resolver.js"
export type { ResolveOpts, ResolvedVersion } from "./version-resolver.js"
export {
  HANDBOOK_AUDIT_PREFIX,
  HANDBOOK_DEFAULT_ORDER,
  HANDBOOK_SECTIONS_COLLECTION,
  composeSystemPrompt,
  loadHandbook,
  migrateBibleV7,
  parseBibleV7,
  revertSection,
  saveSection,
} from "./handbook.js"
export type {
  HandbookSection,
  SaveSectionInput,
  SaveSectionOpts,
} from "./handbook.js"
