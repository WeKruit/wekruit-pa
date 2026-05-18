/**
 * Phase 22 — Firestore-backed ProactiveTurnStore adapter.
 *
 * Bridges the proactive-turn module's injectable store interface with
 * Firestore + the existing orchestrator infrastructure.
 */
import { randomUUID } from "node:crypto"
import { type Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import { appendAuditEvent } from "@pa/pa-broker"
import { normalizeForIMessage } from "@pa/pa-orchestrator"
import type { ProactiveTurnStore } from "@pa/pa-orchestrator"

export function createFirestoreProactiveTurnStore(db: Firestore): ProactiveTurnStore {
  const nowIso = () => new Date().toISOString()

  return {
    async runTurn(userId, input) {
      // Dynamically import orchestrator internals to avoid circular top-level deps
      const { getDefaultAgent } = await import("@pa/agent-registry")
      const { runAgentTurn, stripLeadingIsoTimestamp } = await import("@pa/agent-runtime")

      // Use the built dist path for orchestrator internals that aren't re-exported
      // These modules are available at runtime since we're inside apps/functions
      let systemPrompt: string
      let systemInputs: string[] = []

      try {
        // Import voice reminder (Phase 18 Voice v1)
        const vocMod = await import("../../../packages/pa-orchestrator/dist/voice-reminder.js")
        const voiceReminder = typeof vocMod.buildVoiceReminder === "function"
          ? vocMod.buildVoiceReminder()
          : null
        const voiceV1Disabled = typeof vocMod.isVoiceV1Disabled === "function"
          ? vocMod.isVoiceV1Disabled()
          : false

        const legacyMod = await import("../../../packages/pa-orchestrator/dist/legacy-voice-prompt.js")
        const agent = await getDefaultAgent(db)
        if (!agent) throw new Error("[proactive-turn-store] No default agent configured")

        systemPrompt = voiceV1Disabled
          ? (legacyMod.LEGACY_V0_SYSTEM_PROMPT ?? "")
          : agent.systemPrompt

        if (voiceReminder) systemInputs = [voiceReminder]
      } catch {
        // Fallback: if voice-reminder module not available, get system prompt directly
        const agent = await getDefaultAgent(db)
        if (!agent) throw new Error("[proactive-turn-store] No default agent configured")
        systemPrompt = agent.systemPrompt
      }

      const { text, usage } = await runAgentTurn({
        agent: (await (await import("@pa/agent-registry")).getDefaultAgent(db))!,
        systemPrompt,
        userMessage: input.content,
        history: [],
        session: undefined as any,
        systemInputs,
        tools: [],
      })

      return { text: stripLeadingIsoTimestamp(text.trim()), usage }
    },

    normalizeOutput(text) {
      const result = normalizeForIMessage(text, { maxLength: 600 })
      return {
        text: result.text,
        chunks: result.chunks && result.chunks.length > 1 ? result.chunks : [result.text],
      }
    },

    async enqueueOutbound(userId, body, opts) {
      const id = randomUUID()
      const phone = opts?.toNumber as string | undefined
      await db.collection(PA_COLLECTIONS.outbound).doc(id).set({
        id,
        userId,
        toE164: phone ?? "",
        body,
        status: "pending",
        createdAt: nowIso(),
        attempts: 0,
        runtimeApproved: true,
        runtimeSource: "pa_proactive_turn",
        source: "proactive",
        proactiveJobId: opts?.proactiveJobId,
        ...(opts?.sessionId ? { sessionId: opts.sessionId } : {}),
      })
      return { outboundId: id }
    },

    async writeAuditEvent(row) {
      // Phase 22 D-09: write proactive_send audit with fireWindowHash as a top-level field
      // so the idempotency query in checkFireWindowExists can match it directly.
      // appendAuditEvent only persists known fields (id, kind, message, meta, etc.) —
      // we write the doc directly to include jobId, triggerType, fireWindowHash, outboundId
      // at the top level for Firestore queries.
      const id = randomUUID()
      await db.collection(PA_COLLECTIONS.auditEvents).doc(id).set({
        id,
        createdAt: nowIso(),
        kind: row["kind"] as "proactive_send",
        message: `proactive_send: job ${row["jobId"]} type ${row["triggerType"]}`,
        userId: row["userId"] as string,
        actor: "orchestrator",
        jobId: row["jobId"],
        triggerType: row["triggerType"],
        fireWindowHash: row["fireWindowHash"],
        outboundId: row["outboundId"],
      })
    },

    async updateJobStatus(jobId, patch) {
      await db.collection(PA_COLLECTIONS.scheduledJobs).doc(jobId).set(
        { ...patch, updatedAt: nowIso() },
        { merge: true }
      )
    },

    async rearmJob(jobId, nextFireAt) {
      await db.collection(PA_COLLECTIONS.scheduledJobs).doc(jobId).set(
        {
          status: "pending",
          nextFireAt,
          dueAt: nextFireAt, // Phase 7 compat
          updatedAt: nowIso(),
        },
        { merge: true }
      )
    },

    async getUserPhoneE164(userId) {
      const snap = await db.collection(PA_COLLECTIONS.users).doc(userId).get()
      if (!snap.exists) return ""
      const data = snap.data() as { phoneE164?: string } | undefined
      return data?.phoneE164 ?? ""
    },

    log: (...args) => console.log(nowIso(), "[proactive-turn-store]", ...args),
    // Phase 24.5 — Firestore handle for flag-backed PA_PROACTIVE_DISABLED check.
    db,
  }
}
