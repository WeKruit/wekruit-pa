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
// Phase 32 W3 — Playbooks Firestore CRUD (replaces inline HEADHUNTER_TRIGGER_RE).
export {
  PLAYBOOKS_COLLECTION,
  PLAYBOOK_AUDIT_PREFIX,
  PlaybookSchema,
  HEADHUNTER_DEFAULT_TRIGGERS,
  HEADHUNTER_DEFAULT_ADDENDUM,
  compileTriggers,
  composePlaybooks,
  getPlaybook,
  listPlaybooks,
  matchPlaybooks,
  revertPlaybook,
  seedDefaultPlaybooks,
  upsertPlaybook,
} from "./playbooks.js"
export type {
  Playbook,
  SavePlaybookInput,
  SavePlaybookOpts,
} from "./playbooks.js"
// iter30 WS4-A — Skill V2 schema (7+1 fields, backward-compat with V1 Playbook).
export {
  SKILL_KEYS,
  SkillKeyEnum,
  SkillSchemaV2,
  RequiresCtxStateSchema,
  fromSkillSnap,
} from "./skill-schema.js"
export type {
  Skill,
  SkillKey,
  SkillV2,
  RequiresCtxState,
} from "./skill-schema.js"
export {
  EXISTING_6_METADATA,
  getExistingSkillMetadata,
} from "./skill-defaults.js"
export type { SkillMetadataV2 } from "./skill-defaults.js"
// Phase 32 W3 — Personas Firestore CRUD (soul.md three-file pattern).
export {
  PERSONAS_COLLECTION,
  PERSONA_AUDIT_PREFIX,
  PersonaSchema,
  DEFAULT_PERSONAS,
  composePersonaPrompt,
  composePersonaPromptFromDoc,
  getPersona,
  listPersonas,
  revertPersona,
  seedDefaultPersonas,
  upsertPersona,
} from "./personas.js"
export type {
  Persona,
  SavePersonaInput,
  SavePersonaOpts,
} from "./personas.js"
