/**
 * v2.0 External Supply V1 — Wave D — Browser shim for `node:crypto`.
 *
 * `packages/core-types/src/external-supply.ts` (Executor A) statically
 * imports `randomUUID` AND `createHash` from `node:crypto` at module
 * init for the doc-id helpers. `createOutreachEventId` now hashes the
 * provider event id via sha256; `randomUUID` still backs the uuid
 * fallback path. Vite aliases `node:crypto` to this file
 * (see `vite.config.ts`) so the dashboard bundle resolves cleanly even
 * though these helpers are SERVER-ONLY at runtime.
 *
 * The dashboard never actually invokes the doc-id helpers — the
 * callable + Firestore client paths it uses live behind the admin
 * gate. We provide a working `randomUUID` (the Web Crypto API ships
 * `crypto.randomUUID()` natively in every browser the dashboard
 * targets) and a `createHash` shim whose `.digest()` throws loudly so
 * any accidental browser-side invocation is impossible to ignore.
 */

export function randomUUID(): string {
  return crypto.randomUUID()
}

interface HashLike {
  update(data: string | Uint8Array): HashLike
  digest(encoding: "hex"): string
}

/**
 * Server-only sha256 surface kept here only so the bundle can resolve
 * the import from `external-supply.ts`. Throws if anything ever calls
 * `.digest()` from the dashboard runtime.
 */
export function createHash(algorithm: string): HashLike {
  let bufferedLen = 0
  const hash: HashLike = {
    update(data) {
      bufferedLen += typeof data === "string" ? data.length : data.byteLength
      return hash
    },
    digest(_encoding) {
      throw new Error(
        `node-crypto-browser-shim: createHash('${algorithm}').digest() is server-only; ` +
          `external-supply doc-id helpers (createOutreachEventId / createCandidateHandleId) ` +
          `must not run in the dashboard bundle. Buffered input length: ${bufferedLen}.`
      )
    },
  }
  return hash
}

// Default export covers bundles that emit `import crypto from "node:crypto"`.
export default { randomUUID, createHash }
