/**
 * Deterministic sha256 hex via Node `crypto`. Kept in its own module so
 * the Python port (`wekruit_shared_tags.sha256_id`) can mirror the same
 * exact byte-for-byte input → output mapping.
 */
import { createHash } from "node:crypto"

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex")
}
