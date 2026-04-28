/**
 * Phase 24 T1B — Few-shot messages-array relocation.
 *
 * Migrates 12 mes_examples from systemPrompt block to messages-array
 * alternating user/assistant turns. Backed by arxiv 2401.06766 evidence
 * that messages-array placement yields ~3x better style transfer than
 * system-block concatenation for chat models.
 *
 * Pitfall 4 (24-RESEARCH.md): Synthetic turns are assigned ids with
 * "fs_" prefix so the persistence layer can filter them before any
 * Firestore write — they MUST NOT appear in pa_messages.
 */
import type { AgentDef } from "@pa/core-types"

export type FewShotTurn = { role: "user" | "assistant"; content: string }

/**
 * Load few-shot turns from the agent definition's fewShotMessages field.
 * Returns empty array when fewShotMessages is absent — safe for agents
 * still in Firestore before Bible v6 seed push.
 */
export function buildFewShotTurns(
  agent: AgentDef & { fewShotMessages?: FewShotTurn[] }
): FewShotTurn[] {
  return agent.fewShotMessages ?? []
}

/**
 * Prepend few-shot turns to conversation history as alternating
 * user/assistant messages. Each synthetic turn receives a "fs_N" id
 * so the persistence write-back can filter:
 *   `id.startsWith("fs_")` → skip Firestore write  (Pitfall 4)
 *
 * The returned array is MODEL INPUT ONLY. The original `history`
 * variable (without fs_* prefix) must remain the source-of-truth for
 * all persistence paths.
 *
 * The synthetic stubs carry the minimum fields required by ChatMessage:
 * sessionId/userId/createdAt are empty sentinels — these rows never
 * reach Firestore (fs_* filter in pa-persistence defends against that).
 */
export function prefixFewShotToHistory<T extends { id: string; role: string; body: string; sessionId: string; userId: string; createdAt: string }>(
  fewShotTurns: FewShotTurn[],
  history: T[]
): T[] {
  const synthetic = fewShotTurns.map((t, i) => ({
    id: `fs_${i}`,
    role: t.role,
    body: t.content,
    sessionId: "",
    userId: "",
    createdAt: "",
  })) as unknown as T[]
  return [...synthetic, ...history]
}
