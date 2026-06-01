/**
 * @wekruit/shared-tags — public barrel.
 *
 * iter30 WS2 Wave-1 surface. PA + scraping repos consume the same
 * canonical-tag schema + idempotent event-write contract.
 *
 * v1.6 Phase 52 (TAG-01..TAG-12) adds per-axis canonical vocab files
 * under `./canonical/` — `roleFunction`, `industrySector`, `major`, `visa`,
 * `jobType`, `careerStage`, `location` (closed enums), `relevantTags`
 * (open vocab + 12 cap), `skills` (bucketed open vocab + per-skill weight),
 * shared validation, Firestore overlay (sandbox→promote), and
 * `ALL_CANONICAL_VOCABS` registry.
 */

export * from "./types.js"
export * from "./schemas.js"
export * from "./record-tag-event.js"
export { sha256Hex } from "./sha256.js"

// ─── Phase 52 canonical vocabs ────────────────────────────────────
export * from "./canonical/role-function.js"
export * from "./canonical/industry-sector.js"
export * from "./canonical/major.js"
export * from "./canonical/visa.js"
export * from "./canonical/job-type.js"
export * from "./canonical/career-stage.js"
export * from "./canonical/location.js"
export * from "./canonical/relevant-tags.js"
export * from "./canonical/skills.js"
export * from "./canonical/validation.js"
export * from "./canonical/overlay.js"
export * from "./canonical/registry.js"

// ─── Phase A2 (post-v1.7) company axes ────────────────────────────
export * from "./canonical/company-stage.js"
export * from "./canonical/company-size.js"
export * from "./canonical/company-tag.js"

// ─── SOFT-vs-HARD preference model (2026-05-28) ───────────────────
export * from "./canonical/preference-hardness.js"

// ─── Match-feedback vocab (2026-05-30, no-regex LLM extraction) ────
export * from "./canonical/feedback.js"
