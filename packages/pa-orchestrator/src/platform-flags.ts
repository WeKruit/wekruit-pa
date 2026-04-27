import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS, PA_REMOTE_CONFIG_DOC } from "@pa/core-types"
import { isVoiceV1Disabled as isVoiceV1DisabledEnv } from "./voice-reminder.js"

/** Env rollback for Phase 18 Voice v1 — same as `isVoiceV1Disabled` in `voice-reminder.ts`. */
export function isVoiceV1Disabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isVoiceV1DisabledEnv(env)
}

export type PlatformFlags = {
  llmKillSwitch: boolean
  defaultModelOverride: string | null
}

export async function getPlatformFlags(db: Firestore): Promise<PlatformFlags> {
  try {
    const d = await db.collection(PA_COLLECTIONS.remoteConfig).doc(PA_REMOTE_CONFIG_DOC).get()
    const data = d.data() as { llmKillSwitch?: boolean; defaultModelOverride?: string | null } | undefined
    return {
      llmKillSwitch: data?.llmKillSwitch === true,
      defaultModelOverride:
        typeof data?.defaultModelOverride === "string" && data.defaultModelOverride.length > 0
          ? data.defaultModelOverride
          : null,
    }
  } catch {
    return { llmKillSwitch: false, defaultModelOverride: null }
  }
}
