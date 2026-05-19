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

export function frameConnectorResult(
  connectorName: ConnectorName,
  lang: "en" | "zh",
  count: number
): string | null {
  const def = connectorRegistry[connectorName] as ConnectorDef<unknown, unknown>
  const frame = def.narration?.frameResult[lang]
  return frame ? frame({ count }) : null
}

export async function runConnectorWithNarration(
  input: RunConnectorWithNarrationInput
): Promise<RunConnectorWithNarrationResult> {
  const def = connectorRegistry[input.connectorName] as ConnectorDef<unknown, unknown>
  const latencyMinMs = Number(process.env.PA_CONNECTOR_NARRATION_LATENCY_MIN_MS ?? "1500")
  const narrationOn = await isConnectorNarrationEnabled(input.db, input.ctx.userId)
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

  if (narrationOn && def.narration && (def.expectedLatencyMs ?? 0) >= latencyMinMs) {
    const pre = def.narration.preCall[lang]
    try {
      await input.outbound.sendPreCallBubble(pre)
      preCallSent = true
      input.log?.("pa.choreo.pre_call_bubble.fired", {
        connector: input.connectorName,
        source: input.source,
      })
    } catch (err) {
      input.log?.("pa.choreo.pre_call_bubble.skipped", {
        connector: input.connectorName,
        reason: "send_failed",
        error: err instanceof Error ? err.message : String(err),
      })
    }

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
