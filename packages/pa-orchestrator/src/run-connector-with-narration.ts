import type { Firestore } from "firebase-admin/firestore"
import {
  connectorRegistry,
  runConnector,
  type ConnectorName,
  type ConnectorContext,
  type ConnectorDef,
} from "@pa/pa-connectors"
import {
  assertConnectorCooldown,
  parseCooldownSec,
  recordConnectorCooldown,
} from "@pa/pa-safety"
import { getFlag } from "@pa/pa-persistence"
import {
  composeFindMatchPreCall,
  composeMatchCollabPreCall,
} from "./job-match-narration.js"

export type NarrationOutbound = {
  sendPreCallBubble: (text: string) => Promise<void>
  pulseTyping: () => Promise<void>
  stopTyping?: () => void
}

export type RunConnectorWithNarrationInput = {
  db: Firestore
  ctx: ConnectorContext
  connectorName: ConnectorName
  args: unknown
  lang: "en" | "zh"
  source: string
  outbound: NarrationOutbound
  log?: (event: string, payload: Record<string, unknown>) => void
}

export type RunConnectorWithNarrationResult = {
  result: unknown
  preCallSent: boolean
}

export async function isConnectorNarrationEnabled(
  db: Firestore | undefined,
  userId: string
): Promise<boolean> {
  if (process.env.PA_CONNECTOR_NARRATION_DISABLED === "true") return false
  if (!db) return false
  try {
    return (await getFlag(db, "paConnectorNarrationEnabled", { userId, env: process.env })) === true
  } catch {
    return false
  }
}

/**
 * P2 Tier-1 reflex flag. DEFAULT OFF. When ON, the quick-ack BEFORE a known-slow
 * tool fires as a deterministic reflex for ANY connector whose expectedLatencyMs
 * crosses the threshold — independent of the Tier-2 narration flag. (find-match /
 * match-against-collab-jobs already always-pre-call; this generalizes the reflex.)
 */
export async function isReflexQuickAckEnabled(
  db: Firestore | undefined,
  userId: string
): Promise<boolean> {
  if (!db) return false
  try {
    return (await getFlag(db, "paReflexQuickAckEnabled", { userId, env: process.env })) === true
  } catch {
    return false
  }
}

export function frameConnectorResult(
  connectorName: ConnectorName,
  lang: "en" | "zh",
  count: number
): string | null {
  const def = connectorRegistry[connectorName] as ConnectorDef<unknown, unknown>
  const frame = def.narration?.frameResult[lang]
  return frame ? frame({ count }) : null
}

const ALWAYS_PRE_CALL_CONNECTORS: ConnectorName[] = [
  "find-match",
  "match-against-collab-jobs",
]

function pickConnectorPreCall(
  connectorName: ConnectorName,
  lang: "en" | "zh",
  seed: string,
  fallback: string,
): string {
  if (connectorName === "find-match") return composeFindMatchPreCall(lang, seed)
  if (connectorName === "match-against-collab-jobs") {
    return composeMatchCollabPreCall(lang, seed)
  }
  return fallback
}

export async function runConnectorWithNarration(
  input: RunConnectorWithNarrationInput
): Promise<RunConnectorWithNarrationResult> {
  const def = connectorRegistry[input.connectorName] as ConnectorDef<unknown, unknown>
  const latencyMinMs = Number(process.env.PA_CONNECTOR_NARRATION_LATENCY_MIN_MS ?? "1500")
  const narrationOn = await isConnectorNarrationEnabled(input.db, input.ctx.userId)
  // P2 Tier-1 reflex (default OFF): generalize the slow-tool quick-ack to fire as
  // a deterministic reflex regardless of the Tier-2 narration flag.
  const reflexQuickAckOn = await isReflexQuickAckEnabled(input.db, input.ctx.userId)
  const lang = input.lang === "zh" ? "zh" : "en"
  let preCallSent = false

  const cooldownSec = parseCooldownSec(process.env.PA_FIND_MATCH_COOLDOWN_SEC, 3600)
  const cooldown = await assertConnectorCooldown(
    input.db,
    input.ctx.userId,
    input.connectorName,
    cooldownSec
  )
  if (!cooldown.allow) {
    input.log?.("pa.choreo.pre_call_bubble.skipped", {
      connector: input.connectorName,
      reason: "cooldown",
      remainingMs: cooldown.remainingMs,
    })
    throw new Error(`connector_cooldown:${input.connectorName}`)
  }

  const alwaysPreCall = ALWAYS_PRE_CALL_CONNECTORS.includes(input.connectorName)
  const shouldSendPreCall =
    Boolean(def.narration) &&
    (alwaysPreCall || ((narrationOn || reflexQuickAckOn) && (def.expectedLatencyMs ?? 0) >= latencyMinMs))

  if (shouldSendPreCall && def.narration) {
    const pre = pickConnectorPreCall(
      input.connectorName,
      lang,
      `${input.ctx.userId}:${input.ctx.turnId}`,
      def.narration.preCall[lang],
    )
    try {
      await input.outbound.sendPreCallBubble(pre)
      preCallSent = true
      input.log?.("pa.choreo.pre_call_bubble.fired", {
        connector: input.connectorName,
        source: input.source,
        alwaysPreCall,
      })
    } catch (err) {
      input.log?.("pa.choreo.pre_call_bubble.skipped", {
        connector: input.connectorName,
        reason: "send_failed",
        error: err instanceof Error ? err.message : String(err),
      })
    }

    if (narrationOn && (def.expectedLatencyMs ?? 0) >= latencyMinMs) {
      const pulseMs = Math.min(def.expectedLatencyMs ?? 2000, 8000)
      const pulses = Math.max(1, Math.ceil(pulseMs / 2000))
      for (let i = 0; i < pulses; i++) {
        try {
          await input.outbound.pulseTyping()
        } catch {
          /* typing pulse is best-effort */
        }
        await new Promise((r) => setTimeout(r, 1800))
      }
    }
  }

  const result = await runConnector(input.connectorName, input.args, input.ctx)
  await recordConnectorCooldown(
    input.db,
    input.ctx.userId,
    input.connectorName,
    input.source,
    new Date().toISOString()
  )
  return { result, preCallSent }
}
