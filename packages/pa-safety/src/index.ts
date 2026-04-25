import { randomUUID } from "node:crypto"
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS, type AgentDef, type Channel } from "@pa/core-types"
import { appendAuditEvent } from "@pa/pa-broker"

export type SafetyDecision = {
  allow: boolean
  reason?: string
  signals?: string[]
}

const INJECTION_PATTERNS = [
  /ignore (all )?(previous|prior|above) instructions/i,
  /disregard (all )?(previous|prior|above) instructions/i,
  /reveal (your )?(system|developer) prompt/i,
  /print (your )?(system|developer) prompt/i,
  /tool[_\s-]?call/i,
  /bypass (policy|safety|guardrails)/i,
  /exfiltrate/i,
]

export function checkPromptInjection(text: string): SafetyDecision {
  const signals = INJECTION_PATTERNS.filter((p) => p.test(text)).map((p) => p.source)
  if (signals.length === 0) return { allow: true, signals: [] }
  return {
    allow: false,
    reason: "prompt_injection_signal",
    signals,
  }
}

export async function enforceRateLimit(
  db: Firestore,
  input: {
    userId: string
    channel: Channel
    limit?: number
    windowMs?: number
  }
): Promise<SafetyDecision> {
  const limit = input.limit ?? Number(process.env.PA_RATE_LIMIT_PER_WINDOW || "20")
  const windowMs = input.windowMs ?? Number(process.env.PA_RATE_LIMIT_WINDOW_MS || "60000")
  const started = Math.floor(Date.now() / windowMs) * windowMs
  const id = `${input.channel}_${input.userId}_${started}`
  const ref = db.collection(PA_COLLECTIONS.rateLimits).doc(id)
  const now = new Date().toISOString()
  const decision = await db.runTransaction(async (t) => {
    const snap = await t.get(ref)
    const cur = snap.exists ? (snap.data() as { count?: number }) : null
    const nextCount = (cur?.count ?? 0) + 1
    t.set(
      ref,
      {
        id,
        userId: input.userId,
        channel: input.channel,
        windowKey: String(started),
        windowStartedAt: new Date(started).toISOString(),
        count: nextCount,
        updatedAt: now,
      },
      { merge: true }
    )
    return nextCount > limit
  })

  if (!decision) return { allow: true }
  const abuseId = randomUUID()
  await db.collection(PA_COLLECTIONS.abuseEvents).doc(abuseId).set({
    id: abuseId,
    kind: "rate_limited",
    createdAt: now,
    userId: input.userId,
    channel: input.channel,
    message: `Rate limit exceeded (${limit}/${windowMs}ms)`,
  })
  await appendAuditEvent(db, {
    actor: "orchestrator",
    kind: "rate_limit",
    userId: input.userId,
    message: "Rate limit blocked inbound event",
    meta: { channel: input.channel, limit, windowMs },
  })
  return { allow: false, reason: "rate_limited" }
}

export function canUseConnector(
  agent: AgentDef,
  connectorName: string,
  alreadyUsedThisTurn = 0
): SafetyDecision {
  if (agent.toolPolicy === "none") {
    return { allow: false, reason: "agent_tool_policy_none" }
  }
  const budget = agent.toolBudgetPerTurn ?? 3
  if (alreadyUsedThisTurn >= budget) {
    return { allow: false, reason: "tool_budget_exhausted" }
  }
  const allowlist = agent.allowedConnectors ?? []
  if (agent.toolPolicy === "allowlist" || agent.toolPolicy === "restricted") {
    if (!allowlist.includes(connectorName)) {
      return { allow: false, reason: "connector_not_allowlisted" }
    }
  }
  return { allow: true }
}

const UNSAFE_MEMORY_PATTERNS = [
  /ignore (all )?(previous|prior|above) instructions/i,
  /reveal (your )?(system|developer) prompt/i,
  /password|api[_\s-]?key|secret|token/i,
  /call .*connector/i,
  /always approve/i,
]

export function filterMemoryWrite(input: {
  userText: string
  assistantText: string
}): SafetyDecision {
  const text = `${input.userText}\n${input.assistantText}`
  const signals = UNSAFE_MEMORY_PATTERNS.filter((p) => p.test(text)).map((p) => p.source)
  if (signals.length === 0) return { allow: true, signals: [] }
  return { allow: false, reason: "unsafe_memory_write", signals }
}
