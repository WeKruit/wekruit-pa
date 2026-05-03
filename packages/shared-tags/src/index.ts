/**
 * @wekruit/shared-tags — public barrel.
 *
 * iter30 WS2 Wave-1 surface. PA + scraping repos consume the same
 * canonical-tag schema + idempotent event-write contract.
 */

export * from "./types.js"
export * from "./schemas.js"
export * from "./record-tag-event.js"
export { sha256Hex } from "./sha256.js"
