import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS, PA_REMOTE_CONFIG_DOC } from "@pa/core-types"

export type PlatformFlags = {
  llmKillSwitch: boolean
  /** If set, overrides `AgentDef.model` for this turn (gateway / traffic management). */
  defaultModelOverride: string | null
}

const TTL_MS = 60_000
let cache: { flags: PlatformFlags; at: number } | null = null

const defaultFlags: PlatformFlags = {
  llmKillSwitch: false,
  defaultModelOverride: null,
}

export async function getPlatformFlags(db: Firestore): Promise<PlatformFlags> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.flags
  try {
    const d = await db.collection(PA_COLLECTIONS.remoteConfig).doc(PA_REMOTE_CONFIG_DOC).get()
    const data = d.data() as { llmKillSwitch?: boolean; defaultModelOverride?: string | null } | undefined
    const flags: PlatformFlags = {
      llmKillSwitch: data?.llmKillSwitch === true,
      defaultModelOverride:
        typeof data?.defaultModelOverride === "string" && data.defaultModelOverride.length > 0
          ? data.defaultModelOverride
          : null,
    }
    cache = { flags, at: Date.now() }
    return flags
  } catch {
    return defaultFlags
  }
}

export function resetPlatformFlagsCache() {
  cache = null
}
