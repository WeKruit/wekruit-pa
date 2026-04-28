/**
 * Phase 30 T2 — Downstream Eval Connector orchestrator hookup (P9-Connectors).
 *
 * `runDownstreamConnector(db, ctx)` is invoked AFTER the assistant reply has
 * been persisted (and ideally after enqueueOutbound). It is fire-and-forget:
 * never throws into the chat path. Any failure is logged + swallowed.
 *
 * Pipeline:
 *   1. listTriggers (read all enabled triggers)
 *   2. evaluateTriggers — keyword regex or llm-judge (yes/no parse)
 *   3. for each match: checkCooldown — skip when recently fired
 *   4. resolveSecret(hmacSecretRef) → render payload → firePostHook
 *   5. recordFire (persists last-fire row + audit)
 *
 * Cooldown semantics: per-(triggerId, userId), persisted in
 * `pa-trigger-fires/{triggerId}_{sha1(userId).slice(0,16)}` with `lastFiredAt`.
 *
 * The chat path MUST NOT block on this helper for more than `softTimeoutMs`
 * (default 2000ms). The orchestrator caller should `Promise.race` accordingly,
 * letting remaining trigger work continue in background after the budget
 * elapses without ever cancelling — fire-and-forget is the design.
 */

import type { Firestore } from "firebase-admin/firestore"
import {
  checkCooldown,
  evaluateTriggers,
  firePostHook,
  recordFire,
  renderPayload,
  type EvalCtx,
  type FirePostHookResult,
  type Trigger,
} from "@pa/pa-persistence"

export interface RunDownstreamConnectorInput {
  userId: string
  conversationId?: string
  lastUserTurn: string
  lastAssistantTurn: string
}

export interface RunDownstreamConnectorOptions {
  /** Optional NL judge invoker used for kind=llm-judge triggers. */
  llmJudge?: EvalCtx["llmJudge"]
  /**
   * Resolve the HMAC secret for a given `hmacSecretRef`. Production wiring
   * reads from Secret Manager; tests can pass `() => "fake"` or undefined.
   * When undefined / returning null, the dispatcher omits the HMAC header.
   */
  resolveSecret?: (ref: string) => Promise<string | null> | string | null
  /** Override fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Per-trigger HTTP timeout (default 30s). */
  dispatchTimeoutMs?: number
  /** Soft budget for the full pipeline (default 2s); not a hard cap. */
  softTimeoutMs?: number
  /** Optional logger for fire events. Falls back to console.log. */
  log?: (msg: string, fields?: Record<string, unknown>) => void
}

export interface DownstreamFireRecord {
  triggerId: string
  fired: boolean
  reason: "matched" | "cooldown" | "no-match" | "error"
  status?: number | null
  errorMsg?: string | null
}

export interface RunDownstreamConnectorResult {
  evaluated: number
  matched: number
  fired: number
  records: DownstreamFireRecord[]
}

/**
 * Run all enabled downstream triggers against the given turn. Always
 * resolves; never throws. Logs errors via `opts.log` (or console.log).
 */
export async function runDownstreamConnector(
  db: Firestore,
  ctx: RunDownstreamConnectorInput,
  opts: RunDownstreamConnectorOptions = {}
): Promise<RunDownstreamConnectorResult> {
  const log = opts.log ?? ((m, f) => console.log(`[downstream] ${m}`, f ?? ""))
  const records: DownstreamFireRecord[] = []
  const result: RunDownstreamConnectorResult = { evaluated: 0, matched: 0, fired: 0, records }
  let matches: Awaited<ReturnType<typeof evaluateTriggers>> = []
  try {
    matches = await evaluateTriggers(db, {
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      lastUserTurn: ctx.lastUserTurn,
      lastAssistantTurn: ctx.lastAssistantTurn,
      llmJudge: opts.llmJudge,
    })
  } catch (e) {
    log("evaluateTriggers failed", { error: e instanceof Error ? e.message : String(e) })
    return result
  }
  result.evaluated = matches.length // matches list reflects only triggers actually run + matched

  for (const m of matches) {
    result.matched += 1
    const rec: DownstreamFireRecord = { triggerId: m.trigger.triggerId, fired: false, reason: "matched" }
    try {
      // Cooldown check
      const cd = await checkCooldown(db, m.trigger.triggerId, ctx.userId, m.trigger.cooldownSec)
      if (!cd.allowed) {
        rec.reason = "cooldown"
        records.push(rec)
        continue
      }

      // Resolve HMAC secret (optional).
      let secret: string | null = null
      if (m.trigger.endpoint.hmacSecretRef && opts.resolveSecret) {
        try {
          const r = await opts.resolveSecret(m.trigger.endpoint.hmacSecretRef)
          secret = r ?? null
        } catch (e) {
          log("resolveSecret failed", {
            triggerId: m.trigger.triggerId,
            ref: m.trigger.endpoint.hmacSecretRef,
            error: e instanceof Error ? e.message : String(e),
          })
        }
      }

      // Render payload via mustache-lite ({{var}}). The renderer treats
      // unknown keys as empty string — defensive against template typos.
      const body = renderPayload(m.trigger.payloadTemplate ?? "{}", {
        userId: ctx.userId,
        conversationId: ctx.conversationId ?? "",
        lastUserTurn: ctx.lastUserTurn,
        lastAssistantTurn: ctx.lastAssistantTurn,
        matchedSnippet: m.matchedSnippet,
        triggerId: m.trigger.triggerId,
        triggerName: m.trigger.name,
      })

      // Fire HTTP POST. firePostHook never throws (returns FirePostHookResult).
      const res: FirePostHookResult = await firePostHook(m.trigger, body, secret, {
        fetchImpl: opts.fetchImpl,
        timeoutMs: opts.dispatchTimeoutMs,
      })
      rec.status = res.status
      rec.errorMsg = res.errorMsg
      rec.fired = true
      result.fired += 1

      // Always record a fire row — even on http error — so the cooldown
      // window opens and the dashboard surfaces the failure.
      await recordFire(db, {
        triggerId: m.trigger.triggerId,
        userId: ctx.userId,
        firedAt: new Date().toISOString(),
        httpStatus: res.status,
        errorMsg: res.errorMsg,
        conversationId: ctx.conversationId,
      })
      log("trigger fired", {
        triggerId: m.trigger.triggerId,
        userId: ctx.userId,
        status: res.status,
        errorMsg: res.errorMsg,
      })
    } catch (e) {
      rec.reason = "error"
      rec.errorMsg = e instanceof Error ? e.message : String(e)
      log("trigger fire failed", { triggerId: m.trigger.triggerId, error: rec.errorMsg })
    }
    records.push(rec)
  }
  return result
}

/**
 * Soft-budget wrapper. Never cancels the underlying work, but the chat path
 * can `await` the returned race promise to bound its waiting time. After
 * the budget elapses, the inner work continues in the background until it
 * resolves — Cloud Functions keeps the instance alive until the trailing
 * promise resolves (or the instance recycles).
 */
export function withSoftBudget<T>(
  work: Promise<T>,
  ms: number,
  fallback: T
): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ])
}

/** Re-exported for tests + the admin CF wiring. */
export type { Trigger }
