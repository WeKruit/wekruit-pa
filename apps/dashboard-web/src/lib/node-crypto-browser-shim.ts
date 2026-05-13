/**
 * v2.0 External Supply V1 — Wave D — Browser shim for `node:crypto`.
 *
 * `packages/core-types/src/external-supply.ts` (Executor A) statically
 * imports `randomUUID` from `node:crypto` at module init for the
 * `createOutreachEventId` helper. Vite aliases `node:crypto` to this file
 * (see `vite.config.ts`) so the dashboard bundle resolves cleanly.
 *
 * Web Crypto API ships `crypto.randomUUID()` natively in every browser the
 * dashboard targets — we just hoist it under the Node-style name. The
 * dashboard does not invoke the doc-id helpers itself; they are server-only.
 */
export function randomUUID(): string {
  return crypto.randomUUID()
}

// Re-export under the default-import shape some bundles emit, just in case.
export default { randomUUID }
