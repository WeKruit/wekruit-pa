/**
 * v1.9 Phase 86 — ATS adapter registry.
 */
import type { AtsAdapter, AtsSource } from "./types.js"
import { handshakeAdapter } from "./handshake.js"
import { greenhouseAdapter, leverAdapter, linkedinAdapter } from "./stubs.js"

const REGISTRY: Record<AtsSource, AtsAdapter> = {
  handshake: handshakeAdapter,
  greenhouse: greenhouseAdapter,
  lever: leverAdapter,
  linkedin: linkedinAdapter,
}

export function getAdapter(source: string): AtsAdapter | null {
  if (source !== "handshake" && source !== "greenhouse" && source !== "lever" && source !== "linkedin") {
    return null
  }
  return REGISTRY[source as AtsSource]
}

export type { AtsAdapter, AtsSource, CanonicalApplicant } from "./types.js"
