/**
 * Browser-safe re-export of canonical vocabs.
 *
 * The main `@wekruit/shared-tags` barrel transitively imports `node:crypto`
 * (via `sha256.ts`) which Vite cannot bundle for browser targets. The
 * dashboard only needs the vocab arrays + validation + overlay schema, so
 * this sub-path export gives it a Node-free bundle.
 *
 * Usage:
 *   import { ROLE_FUNCTION_VOCAB } from '@wekruit/shared-tags/canonical'
 */

export * from "./role-function.js"
export * from "./industry-sector.js"
export * from "./major.js"
export * from "./visa.js"
export * from "./job-type.js"
export * from "./career-stage.js"
export * from "./location.js"
export * from "./relevant-tags.js"
export * from "./skills.js"
export * from "./validation.js"
export * from "./overlay.js"
export * from "./registry.js"
