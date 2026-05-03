/**
 * v1.5 §3.8 — OpenAI Moderation runner (orchestrator-side).
 *
 * BACKGROUND
 * ----------
 * §3.8 (`illegal_content`) shipped in Phase 46 with a 12-pattern bilingual
 * regex bank gated on `paSafetyIllegalContentEnabled` (default OFF). The
 * flag was never flipped in production → CSAM / weapons / drug-synthesis
 * solicitation flowed straight into the LLM. Adam decision (2026-05-02):
 * replace with OpenAI Moderation API (`omni-moderation-latest`, free tier).
 *
 * SCOPE
 * -----
 * Pattern mirrors `crisis-guard-runner.ts` (Phase 53). Single helper that
 * owns:
 *   - Reading `paOpenaiModerationEnabled` flag (default ON, P0 safety).
 *   - Honoring `PA_OPENAI_MODERATION_DISABLED=true` env emergency disable.
 *   - Calling `checkOpenAIModeration` with the real OpenAI key from env.
 *   - Emitting `pa.safety.moderation_call` telemetry (count + latency +
 *     verdict — used as the "moderationCalls" cost-ledger field per task spec).
 *   - Persisting `pa_abuse_events` row + audit on BLOCK / ESCALATE_NCMEC.
 *   - Defense-in-depth try/catch — moderation failure NEVER breaks a turn.
 *
 * AUTH
 * ----
 * Uses `PA_OPENAI_AGENT_API_KEY` (real OpenAI key, GCP secret). The default
 * `OPENAI_API_KEY` env in production is mapped to SiliconFlow which does
 * NOT expose `/v1/moderations`.
 *
 * NCMEC STUB (v1.5)
 * -----------------
 * `routedAction === "ESCALATE_NCMEC"` writes a `pa_abuse_events` row with
 * `kind="csam_detected"` + audit `meta.csam=true, meta.ncmec_pending=true`.
 * Real NCMEC CyberTipline submission ships in v1.6 (legal + privacy +
 * retention requirements need a separate phase). Caller short-circuits the
 * reply to silent_drop to avoid tip-off.
 */

import { randomUUID } from "node:crypto"
import type { Firestore } from "firebase-admin/firestore"
import type { Channel, InboundEvent } from "@pa/core-types"
import { PA_COLLECTIONS } from "@pa/core-types"
import {
  checkOpenAIModeration,
  type ModerationVerdict,
} from "@pa/pa-safety"
import { getFlag } from "@pa/pa-persistence"
import { appendAuditEvent } from "@pa/pa-broker"

/** Subset of OrchestratorStore needed by this runner. */
export interface ModerationRunnerStore {
  db?: Firestore
  log(...args: unknown[]): void
}

export interface RunOpenaiModerationInput {
  store: ModerationRunnerStore
  event: Pick<InboundEvent, "userId" | "channel" | "body" | "id">
  /** sha256 hash from earlier safety surfaces, optional. */
  inboundEventId?: string
}

export interface RunOpenaiModerationResult {
  /** True if no further safety action needed (ALLOW / WARN / module disabled). */
  allow: boolean
  /** Final routed action. Caller maps BLOCK/ESCALATE_NCMEC to the canned-reply path. */
  routedAction: ModerationVerdict["routedAction"]
  /** Reason code (telemetry-friendly enum). */
  reason?: string
  /** Original verdict (for downstream telemetry / audit reuse). */
  verdict?: ModerationVerdict
  /** True iff module short-circuited because the flag was OFF. */
  skipped: boolean
}

/**
 * Run OpenAI Moderation as part of `checkInboundSafety`. Returns a structured
 * decision the caller can map to {allow, action} on the existing safety branch.
 *
 * Posture:
 *   - Flag OFF / env-disabled → return `{allow: true, skipped: true}`.
 *   - Network/API error      → fail-OPEN inside `checkOpenAIModeration`,
 *                               returning `{allow: true, routedAction: "ALLOW",
 *                               reason: "moderation_unavailable"}`.
 *   - WARN                   → `{allow: true}` (log only, do not BLOCK).
 *   - BLOCK                  → `{allow: false, routedAction: "BLOCK"}`.
 *   - ESCALATE_NCMEC         → `{allow: false, routedAction: "ESCALATE_NCMEC"}`.
 *
 * Defense-in-depth: any uncaught error (flag read, audit write, etc.) is
 * caught and converted to `{allow: true, skipped: true, reason: <error>}`
 * so a runner outage NEVER breaks Claire.
 */
export async function runOpenaiModeration(
  input: RunOpenaiModerationInput
): Promise<RunOpenaiModerationResult> {
  const { store, event } = input

  try {
    const envDisabled = process.env.PA_OPENAI_MODERATION_DISABLED === "true"
    let flagOn = !envDisabled
    if (!envDisabled && store.db) {
      try {
        const v = await getFlag(
          store.db,
          "paOpenaiModerationEnabled",
          { userId: event.userId, env: process.env },
          true // default true — P0 safety
        )
        flagOn = v === true
      } catch (flagErr) {
        // Fail-OPEN posture choice: if flag read errors, KEEP module OFF
        // (safer than spamming a key-missing OpenAI endpoint while flag
        // plumbing is broken). The `crisis-guard-runner.ts` chose the
        // opposite (fail-on-flag-error → keep safety net active) because
        // it's a pure-regex check; we do an external API call so the
        // posture inverts.
        store.log("pa.safety.moderation_flag_read_error", {
          userId: event.userId,
          eventId: event.id,
          error: flagErr instanceof Error ? flagErr.message : String(flagErr),
        })
        flagOn = false
      }
    }

    if (!flagOn) {
      return {
        allow: true,
        routedAction: "ALLOW",
        reason: envDisabled ? "env_disabled" : "flag_off",
        skipped: true,
      }
    }

    const verdict = await checkOpenAIModeration(event.body, {
      // checkOpenAIModeration reads PA_OPENAI_AGENT_API_KEY internally;
      // pass nothing so the env path is the canonical source of truth.
    })

    // Telemetry — emitted on EVERY call (the "moderationCalls" cost-ledger
    // field per task spec). `pa.spend.daily` aggregator filter on this key
    // gives us the call count + flagged rate dashboard for free.
    store.log("pa.safety.moderation_call", {
      "pa.metric": "pa.safety.moderation_call",
      moderationCalls: 1,
      userId: event.userId,
      eventId: event.id,
      flagged: verdict.flagged,
      routedAction: verdict.routedAction,
      reason: verdict.reason ?? null,
      latencyMs: verdict.latencyMs,
      inputHash: verdict.inputHash,
      inputLength: verdict.inputLength,
      triggeredCategories: verdict.triggeredCategories ?? [],
    })

    if (verdict.routedAction === "ALLOW" || verdict.routedAction === "WARN") {
      // WARN logs at the call level above; we don't add a second log entry.
      return {
        allow: true,
        routedAction: verdict.routedAction,
        reason: verdict.reason,
        verdict,
        skipped: false,
      }
    }

    // BLOCK or ESCALATE_NCMEC — write the abuse row + audit. Both branches
    // share the persistence shape; the `kind` field differs.
    if (store.db) {
      const isCsam = verdict.routedAction === "ESCALATE_NCMEC"
      try {
        await recordModerationBlock(store.db, {
          userId: event.userId,
          channel: event.channel,
          eventId: event.id,
          verdict,
          isCsam,
        })
      } catch (auditErr) {
        store.log("pa.safety.moderation_audit_error", {
          userId: event.userId,
          eventId: event.id,
          error:
            auditErr instanceof Error ? auditErr.message : String(auditErr),
        })
        // Do NOT swallow the BLOCK decision on audit failure — still BLOCK.
      }
    }

    return {
      allow: false,
      routedAction: verdict.routedAction,
      reason: verdict.reason,
      verdict,
      skipped: false,
    }
  } catch (err) {
    // Defense-in-depth: NEVER let the moderation runner itself break a turn.
    const msg = err instanceof Error ? err.message : String(err)
    store.log("pa.safety.moderation_runner_error", {
      userId: event.userId,
      eventId: event.id,
      error: msg,
    })
    return {
      allow: true,
      routedAction: "ALLOW",
      reason: "moderation_runner_threw",
      skipped: true,
    }
  }
}

// ---------------------------------------------------------------------------
// Persistence — pa_abuse_events + audit row.
// ---------------------------------------------------------------------------

/**
 * Write a `pa_abuse_events` row + audit on a moderation BLOCK / ESCALATE_NCMEC.
 *
 * For ESCALATE_NCMEC (sexual/minors hit):
 *   - kind = "csam_detected" (NEW)
 *   - severity = "critical"
 *   - audit.meta.csam = true
 *   - audit.meta.ncmec_pending = true (v1.6 will flip this when real CyberTipline
 *     submission lands)
 *   - NO raw text persisted — only inputHash + triggered category.
 *
 * For BLOCK:
 *   - kind = "moderation_block"
 *   - severity matches verdict scoring (high)
 */
async function recordModerationBlock(
  db: Firestore,
  input: {
    userId: string
    channel: Channel
    eventId: string
    verdict: ModerationVerdict
    isCsam: boolean
  }
): Promise<void> {
  const now = new Date().toISOString()
  const abuseId = randomUUID()
  const kind = input.isCsam ? "csam_detected" : "moderation_block"
  const severity = "critical"

  const triggered = input.verdict.triggeredCategories ?? []
  const topScore = triggered[0] ? input.verdict.scores[triggered[0]] ?? null : null

  await db.collection(PA_COLLECTIONS.abuseEvents).doc(abuseId).set({
    id: abuseId,
    kind,
    severity,
    createdAt: now,
    userId: input.userId,
    channel: input.channel,
    inboundEventId: input.eventId,
    triggeredCategories: triggered,
    topScore,
    inputHash: input.verdict.inputHash,
    inputLength: input.verdict.inputLength,
    routedAction: input.verdict.routedAction,
    reason: input.verdict.reason ?? null,
    latencyMs: input.verdict.latencyMs,
    message: input.isCsam
      ? "OpenAI Moderation: sexual/minors detected — escalated for NCMEC review (v1.6 wires real CyberTipline submission)"
      : `OpenAI Moderation BLOCK (${triggered.join(", ")})`,
  })

  await appendAuditEvent(db, {
    actor: "orchestrator",
    kind: "safety_block",
    userId: input.userId,
    message: input.isCsam
      ? "Inbound silently dropped: CSAM detected (NCMEC stub — v1.6 submits)"
      : "Inbound blocked: OpenAI Moderation",
    meta: {
      channel: input.channel,
      moderation: true,
      csam: input.isCsam,
      ncmec_pending: input.isCsam, // flip when real submit lands
      routedAction: input.verdict.routedAction,
      triggeredCategories: triggered,
      inputHash: input.verdict.inputHash,
    },
  })
}
