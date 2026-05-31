/**
 * iter30 WS1 — post-turn hook: detect Claire asking for resume → open gate.
 *
 * Runs AFTER Claire's reply is generated. If the reply matches a "send me
 * your resume" pattern (zh + en bank), we set
 * `pa-users/{userId}.resumeAccepted = { at, expiresAt: at + 24h, triggerHash }`.
 *
 * Idempotent: latest write wins (re-asking extends the window).
 *
 * NEVER throws — wrapped fire-and-forget at the call-site so a Firestore
 * failure in this hook doesn't block reply delivery.
 */

import type { Firestore } from "firebase-admin/firestore"
import { createHash } from "node:crypto"

const PA_USERS_COLLECTION = "pa-users"

// Helper-only regex bank. Adam directive 2026-05-03 (regex is allowed only as
// a fallback helper, never the primary path): the PRIMARY gate-open path for
// the onboarding `ask_q_resume` step is now deterministic — `applyOnboardingStep`
// in onboarding.ts writes `resumeAccepted` directly when it dispatches the
// step. This regex bank stays as a *fallback helper* for OTHER skills
// (cv_followup, headhunter mid-conversation, etc) where the orchestrator
// doesn't have first-class signal that Claire just asked for a CV.
const GATE_REGEX_EN = [
  /\bsend\s+(?:me\s+)?your\s+(?:resume|cv)\b/i,
  /\bshare\s+(?:your\s+)?(?:resume|cv)\b/i,
  /\bemail\s+(?:me\s+)?your\s+(?:resume|cv)\b/i,
  /\bcan\s+you\s+send\s+(?:your\s+|me\s+)?(?:resume|cv)\b/i,
  /\bdrop\s+(?:me\s+)?your\s+(?:resume|cv)\b/i,
]

export const GATE_TTL_MS = (() => {
  const env = parseInt(process.env.PA_RESUME_GATE_TTL_HOURS ?? "24", 10)
  const hours = Number.isFinite(env) && env > 0 ? env : 24
  return hours * 60 * 60 * 1000
})()

export function detectsCvAsk(assistantText: string): boolean {
  if (typeof assistantText !== "string" || assistantText.length === 0) return false
  for (const re of GATE_REGEX_EN) if (re.test(assistantText)) return true
  return false
}

export type MaybeOpenGateArgs = {
  db: Firestore
  userId: string
  assistantText: string
  nowIso: string
}

export type MaybeOpenGateResult = {
  opened: boolean
  expiresAt?: string
  triggerHash?: string
}

/**
 * Post-turn writer. Always also writes `lastAssistantTurnAt` +
 * `lastAssistantTurnAskedResume` so the cv-ingest grace-window check (§5.2
 * Race A) has a reliable last-turn signal even when this very turn opens
 * the gate concurrent with a fast user upload.
 *
 * NEVER throws — caller wraps in try/catch only for telemetry.
 */
export async function maybeOpenResumeGate(
  args: MaybeOpenGateArgs
): Promise<MaybeOpenGateResult> {
  const matched = detectsCvAsk(args.assistantText)
  // Even if no resume-ask, still update the last-turn timestamp so the
  // grace-window heuristic in cv-gate.ts has fresh data.
  const baseFields: Record<string, unknown> = {
    lastAssistantTurnAt: args.nowIso,
    lastAssistantTurnAskedResume: matched,
  }
  if (!matched) {
    try {
      await args.db
        .collection(PA_USERS_COLLECTION)
        .doc(args.userId)
        .set(baseFields, { merge: true })
    } catch {
      /* swallow */
    }
    return { opened: false }
  }
  const at = args.nowIso
  const expiresAt = new Date(new Date(at).getTime() + GATE_TTL_MS).toISOString()
  const triggerHash = createHash("sha256")
    .update(args.assistantText)
    .digest("hex")
    .slice(0, 16)
  try {
    await args.db
      .collection(PA_USERS_COLLECTION)
      .doc(args.userId)
      .set(
        {
          ...baseFields,
          resumeAccepted: { at, expiresAt, triggerHash },
        },
        { merge: true }
      )
  } catch {
    return { opened: false }
  }
  return { opened: true, expiresAt, triggerHash }
}
