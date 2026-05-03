/**
 * Phase 53 — Crisis hotline guard runner (cold-start hole fix).
 *
 * BACKGROUND
 * ----------
 * Phase 51 (commit d6b683d) shipped `guardCrisisHotline` as the deterministic
 * P0 safety net for crisis_ideation users — but the call site lived ONLY in
 * the runAgentTurn main path (post-rewrite, ~line 1428). The onboarding
 * branch in `processInboundEvent` returns earlier (~line 840) BEFORE that
 * hook, so a cold-start user (onboardingState=undefined) whose first message
 * is crisis-shaped received the bare Adam-locked greeting with NO hotline.
 * Runner-local proved this on 2026-05-02 (Bug A in local-runner-report.md).
 *
 * SCOPE
 * -----
 * This module extracts the flag-read + guard-call + telemetry/audit
 * scaffolding into a single helper, so BOTH the onboarding branch and
 * the main runAgentTurn path can call it. Single source of truth for:
 *
 *   - Reading `paCrisisHotlineInjectionEnabled` flag (default true, P0).
 *   - Honoring `PA_CRISIS_HOTLINE_DISABLED=true` env emergency disable.
 *   - Invoking `guardCrisisHotline` (pure, sync — append-only).
 *   - Emitting `pa.safety.crisis_detected` telemetry on detection.
 *   - Writing `kind=safety_block` audit row when injection actually fires.
 *   - Defense-in-depth try/catch — guard failure NEVER breaks a turn.
 *
 * DESIGN NOTES
 * ------------
 * - Pure helper signature — caller passes `userInput` + `reply`, gets back
 *   the (possibly hotline-appended) reply. NO mutation of orchestrator state.
 * - `store.db` is optional; when absent (test runners, runner-local fakeStore),
 *   the audit-append step is silently skipped — telemetry log still runs
 *   (store.log is contractually noop-safe).
 * - Helper is async ONLY because flag read + audit append are async; the
 *   guard itself is sync. Callers who can't await must short-circuit before
 *   reaching this helper.
 * - This helper does NOT handle empty-reply or empty-input — `guardCrisisHotline`
 *   already short-circuits those cases internally.
 */

import type { Firestore } from "firebase-admin/firestore"
import type { InboundEvent } from "@pa/core-types"
import { guardCrisisHotline } from "@pa/pa-safety"
import { getFlag } from "@pa/pa-persistence"
import { appendAuditEvent } from "@pa/pa-broker"

/** Minimal store surface we need — subset of OrchestratorStore. */
export interface CrisisGuardStore {
  db?: Firestore
  log(...args: unknown[]): void
}

export interface RunCrisisHotlineGuardInput {
  store: CrisisGuardStore
  event: Pick<InboundEvent, "userId" | "body">
  turnId: string
  /** The user's raw input message (typically `event.body`). */
  userInput: string
  /** The reply text BEFORE iMessage normalization. */
  reply: string
  /**
   * Where the call was made from — used in the `detectedFrom` telemetry
   * field so we can dashboard cold-start vs main-path injection rates.
   * Allowed values: "main" (post-rewrite path) | "onboarding" (cold-start).
   */
  callSite: "main" | "onboarding"
}

export interface RunCrisisHotlineGuardResult {
  /** Reply after possible hotline append — pass this to normalize. */
  reply: string
  /** True iff trailer was appended this call. */
  injected: boolean
  /** True iff input matched the crisis bank (regardless of injection outcome). */
  detected: boolean
}

/**
 * Run the Phase 51 deterministic crisis-ideation hotline guard.
 *
 * Returns the (possibly modified) reply. NEVER throws — defense-in-depth
 * try/catch logs and falls through with the un-modified reply on any error.
 */
export async function runCrisisHotlineGuard(
  input: RunCrisisHotlineGuardInput
): Promise<RunCrisisHotlineGuardResult> {
  const { store, event, turnId, userInput, reply, callSite } = input

  try {
    // Flag plumbing — exact same posture as the original main-path inline
    // logic at index.ts:1406-1427 (Phase 51). Default ON. Env disable wins.
    const envDisabled = process.env.PA_CRISIS_HOTLINE_DISABLED === "true"
    let crisisFlagOn = !envDisabled
    if (!envDisabled && store.db) {
      try {
        const v = await getFlag(
          store.db,
          "paCrisisHotlineInjectionEnabled",
          { userId: event.userId, env: process.env },
          true // default true — P0 safety
        )
        crisisFlagOn = v === true
      } catch (flagErr) {
        // Fail-OPEN: if flag read errors, keep the safety net active.
        store.log("pa.safety.crisis_flag_read_error", {
          userId: event.userId,
          turnId,
          callSite,
          error: flagErr instanceof Error ? flagErr.message : String(flagErr),
        })
      }
    }

    if (!crisisFlagOn) {
      return { reply, injected: false, detected: false }
    }

    const guardResult = guardCrisisHotline({ userInput, reply })

    if (guardResult.detection.detected) {
      store.log("pa.safety.crisis_detected", {
        userId: event.userId,
        turnId,
        callSite,
        detectedFrom: guardResult.injected
          ? "input_and_output_missing_hotline"
          : "input_only",
        language: guardResult.detection.language,
        confidence: guardResult.detection.confidence,
        inputHash: guardResult.inputHash,
        inputLength: guardResult.inputLength,
        signalCount: guardResult.detection.signals.length,
        injected: guardResult.injected,
        reason: guardResult.reason,
      })
      if (guardResult.injected && store.db) {
        try {
          await appendAuditEvent(store.db, {
            actor: "orchestrator",
            kind: "safety_block",
            userId: event.userId,
            message:
              "Crisis-ideation deterministic hotline trailer appended",
            meta: {
              crisis: true,
              turnId,
              callSite,
              language: guardResult.detection.language,
              confidence: guardResult.detection.confidence,
              inputHash: guardResult.inputHash,
            },
          })
        } catch (auditErr) {
          store.log("pa.safety.crisis_audit_error", {
            userId: event.userId,
            turnId,
            callSite,
            error:
              auditErr instanceof Error
                ? auditErr.message
                : String(auditErr),
          })
        }
      }
    }

    return {
      reply: guardResult.reply,
      injected: guardResult.injected,
      detected: guardResult.detection.detected,
    }
  } catch (err) {
    // Defense-in-depth: NEVER let the crisis guard itself break the turn.
    // Log + fall through with the un-modified reply.
    const msg = err instanceof Error ? err.message : String(err)
    store.log("pa.safety.crisis_guard_error", {
      userId: event.userId,
      turnId,
      callSite,
      error: msg,
    })
    return { reply, injected: false, detected: false }
  }
}
