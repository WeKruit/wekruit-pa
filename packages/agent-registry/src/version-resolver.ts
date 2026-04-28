/**
 * Phase 26 T4 — agent-registry version pinning (P9-Prod-Ops).
 *
 * Resolves which agent version to load at orchestrator init. Order:
 *   1. `getFlag('agentRegistryVersion')` — string flag (live overrides)
 *   2. `process.env.PA_AGENT_REGISTRY_VERSION` — operator escape hatch
 *   3. seed.json default (the agent doc with `isDefault: true`)
 *
 * Format:
 *   - bare string ("7.0", "rc-2026-04-28") → matched against
 *     `seed.json[].version` then `seed.json[].id`.
 *   - `firestore:agents/{slug}/versions/{v}` → fetched from Firestore at
 *     `pa-agents/{slug}` (the registry's own agents collection) with the
 *     `version` field as discriminator.
 *
 * Returns the resolved spec ready to feed into runAgentTurn (`AgentDef`)
 * or null when no match — callers should fall back to `getDefaultAgent`.
 */

import type { Firestore } from "firebase-admin/firestore"
import type { AgentDef } from "@pa/core-types"
import { loadSeedAgents } from "./seed.js"
import { parseAgentDef } from "./parse.js"

export interface ResolveOpts {
  /**
   * Flag SDK accessor. Production wires this to
   * `(key) => getFlag(db, key, ctx, "")` from `@pa/pa-persistence`.
   * Tests pass an in-memory map.
   */
  getFlag?: (key: string) => Promise<string | null | undefined>
  /** Caller-supplied env so the resolver doesn't read process.env directly. */
  env?: Record<string, string | undefined>
}

const FIRESTORE_PREFIX = "firestore:"

export interface ResolvedVersion {
  source: "flag" | "env" | "default"
  raw: string
  agent: AgentDef | null
}

function resolveFromSeed(version: string): AgentDef | null {
  const agents = loadSeedAgents()
  const byVersion = agents.find((a) => a.version === version)
  if (byVersion) return byVersion
  const byId = agents.find((a) => a.id === version)
  return byId ?? null
}

async function resolveFromFirestore(
  db: Firestore,
  raw: string
): Promise<AgentDef | null> {
  // Format: firestore:agents/{slug}/versions/{v}
  const path = raw.slice(FIRESTORE_PREFIX.length)
  const parts = path.split("/")
  // Expect: ["agents", slug, "versions", v] OR ["agents", slug] (latest)
  if (parts[0] !== "agents" || !parts[1]) return null
  const slug = parts[1]
  const targetVersion = parts[2] === "versions" ? parts[3] : null

  const snap = await db.collection("pa-agents").doc(slug).get()
  if (!snap.exists) return null
  const data = snap.data() as Record<string, unknown>
  if (targetVersion && data.version !== targetVersion) return null
  try {
    return parseAgentDef({ id: slug, ...data })
  } catch {
    return null
  }
}

export async function resolveAgentVersion(
  db: Firestore,
  opts: ResolveOpts = {}
): Promise<ResolvedVersion> {
  // 1. flag override
  const flagVal = opts.getFlag ? await opts.getFlag("agentRegistryVersion") : null
  if (typeof flagVal === "string" && flagVal.trim()) {
    const raw = flagVal.trim()
    const agent = raw.startsWith(FIRESTORE_PREFIX)
      ? await resolveFromFirestore(db, raw)
      : resolveFromSeed(raw)
    return { source: "flag", raw, agent }
  }
  // 2. env override
  const envVal = opts.env?.PA_AGENT_REGISTRY_VERSION
  if (typeof envVal === "string" && envVal.trim()) {
    const raw = envVal.trim()
    const agent = raw.startsWith(FIRESTORE_PREFIX)
      ? await resolveFromFirestore(db, raw)
      : resolveFromSeed(raw)
    return { source: "env", raw, agent }
  }
  // 3. seed.json default (`isDefault: true`)
  const agents = loadSeedAgents()
  const def = agents.find((a) => a.isDefault) ?? null
  return {
    source: "default",
    raw: def?.version ?? def?.id ?? "default",
    agent: def,
  }
}
