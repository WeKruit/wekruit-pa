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

const GATE_REGEX_ZH = [
  /发[简我][历给]我/,
  /发简历给我/,
  /把简历发给我/,
  /把你?简历发[给]?我/,
  /发份简历/,
  /你可以发我简历/,
  /把你的简历发[给]?我/,
  /简历发[给]?我看[一下]?/,
  /把简历[甩贴]给我/,
  // iter30 closure — ask_q_resume Adam-locked phrase variants. The
  // proactive 6Q chain ends with "对了, 简历方便发我一份不?" (Q_PROMPTS
  // .ask_q_resume.zh in onboarding.ts). Without this, the gate stays
  // closed even though Claire just asked for the CV — and a user uploading
  // 5min later would hit a "haven't asked yet" rejection. The pattern is
  // intentionally narrow: "简历...发(我|给我)" (request shape, not
  // confirmation shape). Caveman tone variants ("简历给我看看",
  // "简历贴一下") collapse into the existing 简历发[给]?我看 line.
  /简历(?:方便)?发(?:我|给我)/,
  // Imperative variant ("发我份简历" / "发份简历给我看")
  /发(?:我)?份?\s*简历/,
]

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
  for (const re of GATE_REGEX_ZH) if (re.test(assistantText)) return true
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
