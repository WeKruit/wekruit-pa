import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS, type AgentDef } from "@pa/core-types"
import { appendAuditEvent } from "@pa/pa-broker"
import { parseAgentDef } from "./parse.js"

function nowIso() {
  return new Date().toISOString()
}

export function buildAgentSystemPrompt(agent: AgentDef): string {
  const persona = agent.persona
  const parts = [agent.systemPrompt.trim()]
  if (persona?.tone) parts.push(`Tone: ${persona.tone}`)
  if (persona?.style?.length) parts.push(`Style: ${persona.style.join(", ")}`)
  if (persona?.boundaries?.length) parts.push(`Boundaries:\n${persona.boundaries.map((b) => `- ${b}`).join("\n")}`)
  if (persona?.goals?.length) parts.push(`Goals:\n${persona.goals.map((g) => `- ${g}`).join("\n")}`)
  return parts.filter(Boolean).join("\n\n")
}

export async function setDefaultAgent(db: Firestore, agentId: string, actor = "operator") {
  const target = await db.collection(PA_COLLECTIONS.agents).doc(agentId).get()
  if (!target.exists) throw new Error(`agent not found: ${agentId}`)
  const agent = parseAgentDef({ id: target.id, ...target.data() })
  if (agent.modelProbe?.status === "failed") {
    throw new Error(`model probe failed for ${agent.model}`)
  }

  const defaults = await db.collection(PA_COLLECTIONS.agents).where("isDefault", "==", true).get()
  await Promise.all(
    defaults.docs
      .filter((d) => d.id !== agentId)
      .map((d) => db.collection(PA_COLLECTIONS.agents).doc(d.id).set({ isDefault: false, updatedAt: nowIso() }, { merge: true }))
  )
  await db.collection(PA_COLLECTIONS.agents).doc(agentId).set({ isDefault: true, updatedAt: nowIso() }, { merge: true })
  await appendAuditEvent(db, {
    actor: "operator",
    kind: "agent_default_changed",
    message: `Default agent changed to ${agentId}`,
    meta: { agentId, actor },
  })
}

export async function publishAgentVersion(db: Firestore, agentId: string, actor = "operator") {
  const ref = db.collection(PA_COLLECTIONS.agents).doc(agentId)
  const snap = await ref.get()
  if (!snap.exists) throw new Error(`agent not found: ${agentId}`)
  const agent = parseAgentDef({ id: snap.id, ...snap.data() })
  const version = String(Number(agent.version || "0") + 1)
  const publishedAt = nowIso()
  await db.collection(PA_COLLECTIONS.agentVersions).doc(`${agentId}_v${version}`).set({
    id: `${agentId}_v${version}`,
    agentId,
    version,
    snapshot: { ...agent, version, status: "published", publishedAt, publishedBy: actor },
    createdAt: publishedAt,
    createdBy: actor,
  })
  await ref.set({ status: "published", version, publishedAt, publishedBy: actor, updatedAt: publishedAt }, { merge: true })
  await appendAuditEvent(db, {
    actor: "operator",
    kind: "agent_published",
    message: `Agent ${agentId} published as v${version}`,
    meta: { agentId, version, actor },
  })
  return version
}

export async function rollbackAgentVersion(db: Firestore, agentId: string, version: string, actor = "operator") {
  const snap = await db.collection(PA_COLLECTIONS.agentVersions).doc(`${agentId}_v${version}`).get()
  if (!snap.exists) throw new Error(`agent version not found: ${agentId} v${version}`)
  const data = snap.data() as { snapshot?: Record<string, unknown> }
  await db.collection(PA_COLLECTIONS.agents).doc(agentId).set(
    {
      ...data.snapshot,
      id: agentId,
      version,
      status: "published",
      updatedAt: nowIso(),
    },
    { merge: true }
  )
  await appendAuditEvent(db, {
    actor: "operator",
    kind: "agent_rollback",
    message: `Agent ${agentId} rolled back to v${version}`,
    meta: { agentId, version, actor },
  })
}
