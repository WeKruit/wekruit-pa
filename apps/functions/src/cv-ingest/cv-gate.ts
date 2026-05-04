/**
 * iter30 WS1 — CV resume-gate read at ingest entry.
 *
 * Gate state lives at `pa-users/{userId}.resumeAccepted = { at, expiresAt,
 * triggerHash } | null`. It's set by the post-turn hook when Claire's
 * reply matches a "send me your resume" pattern (zh+en bank).
 *
 * Why this lives here (not in the orchestrator): the orchestrator-side
 * post-turn hook in `packages/pa-orchestrator/src/post-turn-hooks/cv-gate-detector.ts`
 * handles WRITE; this module handles READ at the cv-ingest entry point so
 * we never accept an unsolicited PDF (per Adam's 4-limit lock).
 */

import type { Firestore } from "firebase-admin/firestore"

export type ResumeAcceptedFlag = {
  at: string
  expiresAt: string
  triggerHash: string
} | null

const PA_USERS_COLLECTION = "pa-users"

export const GATE_GRACE_WINDOW_MS = (() => {
  const env = parseInt(process.env.PA_RESUME_GATE_GRACE_MS ?? "5000", 10)
  return Number.isFinite(env) && env >= 0 ? env : 5000
})()

export type GateReadResult = {
  /** Final decision: open or rejected. */
  open: boolean
  /** Source of openness — "gate", "kill_switch", "grace_window", or "rejected". */
  reason: "gate_open" | "kill_switch" | "grace_window" | "expired" | "not_set"
  flag: ResumeAcceptedFlag
}

export function gateKillSwitchOn(): boolean {
  const v = (process.env.PA_RESUME_GATE_DISABLED ?? "").trim().toLowerCase()
  return v === "true" || v === "1" || v === "on" || v === "yes"
}

export function isGateOpen(flag: ResumeAcceptedFlag, nowIso: string): boolean {
  if (!flag || !flag.expiresAt) return false
  return new Date(flag.expiresAt).getTime() > new Date(nowIso).getTime()
}

/**
 * Read raw `pa-users/{userId}` doc and project the gate-relevant fields.
 * Returns nulls when the doc is missing or fields absent.
 */
export async function readResumeGate(
  db: Firestore,
  userId: string
): Promise<{
  flag: ResumeAcceptedFlag
  lastAssistantTurnAt: string | null
  lastAssistantTurnAsk: boolean | null
}> {
  try {
    const snap = await db.collection(PA_USERS_COLLECTION).doc(userId).get()
    if (!snap.exists) return { flag: null, lastAssistantTurnAt: null, lastAssistantTurnAsk: null }
    const data = (snap.data() ?? {}) as Record<string, unknown>
    const flag = (data["resumeAccepted"] as ResumeAcceptedFlag) ?? null
    const last =
      typeof data["lastAssistantTurnAt"] === "string"
        ? (data["lastAssistantTurnAt"] as string)
        : null
    const lastAsk =
      typeof data["lastAssistantTurnAskedResume"] === "boolean"
        ? (data["lastAssistantTurnAskedResume"] as boolean)
        : null
    return { flag, lastAssistantTurnAt: last, lastAssistantTurnAsk: lastAsk }
  } catch {
    return { flag: null, lastAssistantTurnAt: null, lastAssistantTurnAsk: null }
  }
}

/**
 * Race-A mitigation (per ws-1-detail.md §5.2): if `resumeAccepted` is null
 * but the most-recent assistant turn was within `GRACE_WINDOW_MS` AND the
 * orchestrator flagged that turn as a resume-ask, treat as gate-open.
 */
export function withinGraceWindow(
  lastAssistantTurnAt: string | null,
  lastAssistantTurnAsk: boolean | null,
  nowIso: string
): boolean {
  if (lastAssistantTurnAsk !== true) return false
  if (!lastAssistantTurnAt) return false
  const ageMs = new Date(nowIso).getTime() - new Date(lastAssistantTurnAt).getTime()
  return ageMs >= 0 && ageMs <= GATE_GRACE_WINDOW_MS
}

/**
 * Combined entry-point check: gate open OR kill-switch OR grace window.
 * Returns { open, reason } for caller logging.
 */
export async function checkResumeGate(
  db: Firestore,
  userId: string,
  nowIso: string
): Promise<GateReadResult> {
  if (gateKillSwitchOn()) {
    return { open: true, reason: "kill_switch", flag: null }
  }
  const { flag, lastAssistantTurnAt, lastAssistantTurnAsk } = await readResumeGate(db, userId)
  if (isGateOpen(flag, nowIso)) {
    return { open: true, reason: "gate_open", flag }
  }
  if (withinGraceWindow(lastAssistantTurnAt, lastAssistantTurnAsk, nowIso)) {
    return { open: true, reason: "grace_window", flag }
  }
  return {
    open: false,
    reason: flag ? "expired" : "not_set",
    flag,
  }
}
