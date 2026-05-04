/**
 * IG-5: openaiModerationGuardrail — async OpenAI Moderation wrapper.
 *
 * Detail-plan ws-3-6-detail.md §5.1 IG-5. BLOCK → tripwire + canned;
 * ESCALATE_NCMEC → tripwire + silent_drop (orchestrator emits no text).
 * Fail-OPEN on any error (flag-off / API outage / timeout): legitimate
 * users do NOT get blocked when OpenAI moderation is unavailable.
 *
 * Note: this is a factory that returns a guardrail bound to the
 * orchestrator's `store` + `event`. The runner module passes those at
 * chain construction time — pure-fn wrappers can't reach the Firestore
 * handle / event id needed by `runOpenaiModeration`.
 */
import type { Firestore } from "firebase-admin/firestore"
import { runOpenaiModeration } from "../../safety/moderation-runner.js"
import { SAFETY_CANNED_REPLIES, pickLangForSafety } from "@pa/pa-safety"
import type { InputGuardrail } from "../types.js"
import { recordGuardrailHit } from "../types.js"
import type { InboundEvent } from "@pa/core-types"

export interface ModerationGuardrailDeps {
  store: { db?: Firestore; log: (...args: unknown[]) => void }
  event: Pick<InboundEvent, "userId" | "channel" | "body" | "id">
}

export function createOpenaiModerationGuardrail(
  deps: ModerationGuardrailDeps
): InputGuardrail {
  return {
    name: "openaiModeration",
    // SDK convention: parallel because it costs an extra round-trip and
    // we accept ≤1 wasted nano-call ($0.0001) on a late BLOCK (Adam Q).
    runInParallel: true,
    execute: async ({ input, ctx }) => {
      const t0 = Date.now()
      try {
        const result = await runOpenaiModeration({
          store: deps.store,
          event: deps.event,
        })
        const tripped =
          !result.allow &&
          (result.routedAction === "BLOCK" ||
            result.routedAction === "ESCALATE_NCMEC")
        const lang = pickLangForSafety(input ?? "")
        let cannedReply: string | undefined
        if (tripped && result.routedAction === "BLOCK") {
          cannedReply = SAFETY_CANNED_REPLIES.escalate[lang]
        } else if (tripped && result.routedAction === "ESCALATE_NCMEC") {
          // silent_drop — orchestrator handles by emitting no text.
          cannedReply = ""
        }
        const metadata = {
          flagged: result.verdict?.flagged ?? false,
          categories: result.verdict?.categories ?? [],
          routedAction: result.routedAction,
          reason: result.reason,
          skipped: result.skipped,
        }
        recordGuardrailHit(ctx, {
          name: "openaiModeration",
          type: "input",
          tripped,
          metadata,
          latencyMs: Date.now() - t0,
        })
        return {
          tripwireTriggered: tripped,
          outputInfo: { ...metadata, cannedReply },
        }
      } catch (err) {
        // Fail-OPEN. Never let an internal moderation error block the user.
        const msg = err instanceof Error ? err.message : String(err)
        recordGuardrailHit(ctx, {
          name: "openaiModeration",
          type: "input",
          tripped: false,
          metadata: { error: msg, posture: "fail_open" },
          latencyMs: Date.now() - t0,
        })
        return {
          tripwireTriggered: false,
          outputInfo: { error: msg, posture: "fail_open" },
        }
      }
    },
  }
}
