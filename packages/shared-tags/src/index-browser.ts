/**
 * @wekruit/shared-tags — browser-safe barrel.
 *
 * Identical to the main `index.ts` barrel except:
 *  - drops `sha256.ts` re-export (uses Node `crypto.createHash` which Vite
 *    cannot bundle for browser targets)
 *  - drops `record-tag-event.ts` re-export (transitively pulls sha256;
 *    only needed by Cloud Functions backend code, not the dashboard)
 *
 * Vite resolves the `browser` condition in `package.json#exports[.]` to
 * this file when bundling for the browser. Cloud Functions and Node-side
 * scripts continue to import the full surface from `index.ts`.
 */

export * from "./types.js"
export * from "./schemas.js"

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

// ─── SOFT-vs-HARD preference model (2026-05-28) ───────────────────
export * from "./canonical/preference-hardness.js"
