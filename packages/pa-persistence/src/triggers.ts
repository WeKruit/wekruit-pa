/**
 * Phase 30 — Downstream Eval Connectors (P9-Connectors).
 *
 * Per-turn eval that judges conversation state and POSTs to an external
 * service when its condition fires. Connector-style — PA orchestrator
 * stays pure-text; partner integrations live in Firestore docs.
 *
 * Collections:
 *   `pa-downstream-triggers/{triggerId}` — trigger config
 *   `pa-trigger-fires/{triggerId}_{userId}` — last-fire log per (trigger,user)
 *                                              for cooldown enforcement
 *   `pa-audit-events/{auditId}` — audit row for save/update/fire/error
 *
 * Schema (locked):
 *   triggerId, name, description,
 *   enabled: boolean,
 *   condition: { kind: "keyword"|"llm-judge", config }
 *     - keyword: { pattern: string, flags?: string }
 *     - llm-judge: { judgePrompt: string, judgeModel?: string }
 *   endpoint: { url: string, method: "POST", headers?, hmacSecretRef? }
 *   payloadTemplate: string  // {{userId}} {{lastUserTurn}} {{lastAssistantTurn}}
 *   cooldownSec: number,
 *   createdAt, updatedAt, updatedBy, version
 *
 * Eval pipeline is fire-and-forget: never throws into the chat path.
 * Failures only log + write audit row. See `evaluateTriggers` + `firePostHook`.
 */

import { createHash, createHmac, randomUUID } from "node:crypto"
import { Timestamp, type Firestore } from "firebase-admin/firestore"

export const TRIGGERS_COLLECTION = "pa-downstream-triggers"
export const TRIGGER_FIRES_COLLECTION = "pa-trigger-fires"
export const AUDIT_COLLECTION = "pa-audit-events"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TriggerConditionKind = "keyword" | "llm-judge"

export interface KeywordConditionConfig {
  pattern: string
  flags?: string
}

export interface LlmJudgeConditionConfig {
  judgePrompt: string
  judgeModel?: string
}

export interface TriggerCondition {
  kind: TriggerConditionKind
  config: KeywordConditionConfig | LlmJudgeConditionConfig
}

export interface TriggerEndpoint {
  url: string
  method?: "POST"
  headers?: Record<string, string>
  /** Secret Manager ref id; secret resolved at fire-time (NEVER stored inline). */
  hmacSecretRef?: string
}

export interface Trigger {
  triggerId: string
  name: string
  description?: string
  enabled: boolean
  condition: TriggerCondition
  endpoint: TriggerEndpoint
  payloadTemplate: string
  cooldownSec: number
  createdAt?: string
  updatedAt?: string
  updatedBy?: string
  version?: number
}

export interface TriggerFireRow {
  triggerId: string
  userId: string
  firedAt: string
  httpStatus: number | null
  errorMsg: string | null
  conversationId?: string
}

export interface EvalCtx {
  userId: string
  conversationId?: string
  lastUserTurn: string
  lastAssistantTurn: string
  /** Optional async judge invoker (kind=llm-judge). Returns yes/no string. */
  llmJudge?: (input: { prompt: string; model?: string; userTurn: string; assistantTurn: string }) => Promise<string>
}

export interface MatchedTrigger {
  trigger: Trigger
  matchedSnippet: string
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString()
}

/** List all triggers (enabled + disabled). Caller filters as needed. */
export async function listTriggers(db: Firestore): Promise<Trigger[]> {
  const snap = await db.collection(TRIGGERS_COLLECTION).get()
  return snap.docs.map((d) => ({ triggerId: d.id, ...d.data() } as Trigger))
}

/** Get a single trigger by id, or null if missing. */
export async function getTrigger(db: Firestore, triggerId: string): Promise<Trigger | null> {
  const snap = await db.collection(TRIGGERS_COLLECTION).doc(triggerId).get()
  if (!snap.exists) return null
  return { triggerId: snap.id, ...snap.data() } as Trigger
}

export interface SaveTriggerOpts {
  actor: string
  reason?: string
}

/**
 * Upsert a trigger. Bumps `version`, writes a `trigger.update` (or
 * `trigger.create`) audit row in the same transaction.
 */
export async function saveTrigger(
  db: Firestore,
  trigger: Trigger,
  opts: SaveTriggerOpts
): Promise<void> {
  if (!trigger.triggerId) throw new Error("saveTrigger: triggerId required")
  if (!trigger.name) throw new Error("saveTrigger: name required")
  if (!trigger.endpoint?.url) throw new Error("saveTrigger: endpoint.url required")
  if (!/^https:\/\//.test(trigger.endpoint.url)) {
    throw new Error("saveTrigger: endpoint.url must be https://")
  }
  if (typeof trigger.cooldownSec !== "number" || trigger.cooldownSec < 0) {
    throw new Error("saveTrigger: cooldownSec must be a non-negative number")
  }

  const ref = db.collection(TRIGGERS_COLLECTION).doc(trigger.triggerId)
  const auditRef = db.collection(AUDIT_COLLECTION).doc()
  const ts = nowIso()
  await db.runTransaction(async (t) => {
    const cur = await t.get(ref)
    const prev = cur.exists ? (cur.data() as Trigger) : null
    const version = (prev?.version ?? 0) + 1
    const action = prev ? "trigger.update" : "trigger.create"
    const next: Trigger = {
      ...trigger,
      createdAt: prev?.createdAt ?? ts,
      updatedAt: ts,
      updatedBy: opts.actor,
      version,
    }
    t.set(ref, next)
    t.set(auditRef, {
      actor: opts.actor,
      action,
      key: trigger.triggerId,
      newValue: next,
      oldValue: prev,
      reason: opts.reason ?? null,
      ts,
    })
  })
}

/** Delete a trigger + audit. */
export async function deleteTrigger(
  db: Firestore,
  triggerId: string,
  opts: SaveTriggerOpts
): Promise<void> {
  const ref = db.collection(TRIGGERS_COLLECTION).doc(triggerId)
  const auditRef = db.collection(AUDIT_COLLECTION).doc()
  const ts = nowIso()
  await db.runTransaction(async (t) => {
    const cur = await t.get(ref)
    const prev = cur.exists ? (cur.data() as Trigger) : null
    if (!prev) return
    t.delete(ref)
    t.set(auditRef, {
      actor: opts.actor,
      action: "trigger.delete",
      key: triggerId,
      oldValue: prev,
      reason: opts.reason ?? null,
      ts,
    })
  })
}

// ---------------------------------------------------------------------------
// Eval pipeline
// ---------------------------------------------------------------------------

/**
 * Run all enabled triggers' conditions against the eval ctx.
 *
 * - keyword: regex match against `lastUserTurn + "\n" + lastAssistantTurn`.
 * - llm-judge: invokes `ctx.llmJudge` with `judgePrompt`; matches when the
 *              response (lower-cased, trimmed first token) === "yes".
 *
 * Returns matched triggers (NOT yet fired). Fire-and-forget — never throws.
 */
export async function evaluateTriggers(
  db: Firestore,
  ctx: EvalCtx
): Promise<MatchedTrigger[]> {
  const matches: MatchedTrigger[] = []
  let triggers: Trigger[]
  try {
    triggers = await listTriggers(db)
  } catch {
    return matches
  }
  const haystack = `${ctx.lastUserTurn}\n${ctx.lastAssistantTurn}`
  for (const trig of triggers) {
    if (!trig.enabled) continue
    try {
      if (trig.condition.kind === "keyword") {
        const cfg = trig.condition.config as KeywordConditionConfig
        if (!cfg.pattern) continue
        const re = new RegExp(cfg.pattern, cfg.flags ?? "i")
        const m = haystack.match(re)
        if (m) {
          matches.push({ trigger: trig, matchedSnippet: m[0].slice(0, 200) })
        }
      } else if (trig.condition.kind === "llm-judge") {
        if (!ctx.llmJudge) continue
        const cfg = trig.condition.config as LlmJudgeConditionConfig
        if (!cfg.judgePrompt) continue
        const raw = await ctx.llmJudge({
          prompt: cfg.judgePrompt,
          model: cfg.judgeModel,
          userTurn: ctx.lastUserTurn,
          assistantTurn: ctx.lastAssistantTurn,
        })
        const first = String(raw ?? "").trim().toLowerCase().split(/\W+/)[0]
        if (first === "yes") {
          matches.push({ trigger: trig, matchedSnippet: ctx.lastUserTurn.slice(0, 200) })
        }
      }
    } catch {
      // never throw on a single trigger; skip it.
    }
  }
  return matches
}

// ---------------------------------------------------------------------------
// Cooldown
// ---------------------------------------------------------------------------

function fireDocId(triggerId: string, userId: string): string {
  // Doc id MUST be filesystem-safe — hash userId in case it has weird chars.
  const u = createHash("sha1").update(userId).digest("hex").slice(0, 16)
  return `${triggerId}_${u}`
}

/**
 * Returns true when the trigger may fire for this user (no recent fire), and
 * false when the cooldown is still active.
 */
export async function checkCooldown(
  db: Firestore,
  triggerId: string,
  userId: string,
  cooldownSec: number,
  now: () => number = Date.now
): Promise<{ allowed: boolean; lastFiredAt: string | null }> {
  if (!cooldownSec || cooldownSec <= 0) return { allowed: true, lastFiredAt: null }
  const ref = db.collection(TRIGGER_FIRES_COLLECTION).doc(fireDocId(triggerId, userId))
  const snap = await ref.get()
  if (!snap.exists) return { allowed: true, lastFiredAt: null }
  const data = snap.data() as { lastFiredAt?: string }
  if (!data.lastFiredAt) return { allowed: true, lastFiredAt: null }
  const last = Date.parse(data.lastFiredAt)
  if (Number.isNaN(last)) return { allowed: true, lastFiredAt: data.lastFiredAt }
  const ageSec = (now() - last) / 1000
  return { allowed: ageSec >= cooldownSec, lastFiredAt: data.lastFiredAt }
}

/** Persist last-fire row + audit. Idempotent on (triggerId, userId). */
export async function recordFire(
  db: Firestore,
  row: TriggerFireRow
): Promise<void> {
  const ref = db.collection(TRIGGER_FIRES_COLLECTION).doc(fireDocId(row.triggerId, row.userId))
  // Stream H9 TD1 — Timestamp-typed `expiresAtTs` (30d) so the pa-trigger-fires
  // TTL policy can GC stale cooldown rows. Firestore TTL only fires on
  // Timestamp fields, NOT ISO strings, so `lastFiredAt` (string) cannot be
  // used as a TTL anchor. Sliding window — refreshed on every fire.
  const expiresAtTs = Timestamp.fromDate(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000))
  await ref.set(
    {
      triggerId: row.triggerId,
      userId: row.userId,
      lastFiredAt: row.firedAt,
      httpStatus: row.httpStatus,
      errorMsg: row.errorMsg,
      conversationId: row.conversationId ?? null,
      expiresAtTs,
    },
    { merge: true }
  )
  // Append an audit row for the fire (separate collection so cooldown row
  // remains a single small doc with deterministic id).
  const auditRef = db.collection(AUDIT_COLLECTION).doc()
  await auditRef.set({
    actor: "pa_orchestrator",
    action: "trigger.fire",
    key: row.triggerId,
    userId: row.userId,
    httpStatus: row.httpStatus,
    errorMsg: row.errorMsg,
    ts: row.firedAt,
  })
}

/** List most-recent fire rows for a trigger (for dashboard drawer). */
export async function listFiresForTrigger(
  db: Firestore,
  triggerId: string,
  limit = 50
): Promise<TriggerFireRow[]> {
  const snap = await db
    .collection(TRIGGER_FIRES_COLLECTION)
    .where("triggerId", "==", triggerId)
    .limit(limit)
    .get()
  return snap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>
    return {
      triggerId: String(data.triggerId ?? triggerId),
      userId: String(data.userId ?? ""),
      firedAt: String(data.lastFiredAt ?? ""),
      httpStatus: typeof data.httpStatus === "number" ? data.httpStatus : null,
      errorMsg: typeof data.errorMsg === "string" ? data.errorMsg : null,
      conversationId: typeof data.conversationId === "string" ? data.conversationId : undefined,
    }
  })
}

// ---------------------------------------------------------------------------
// Payload rendering + dispatch
// ---------------------------------------------------------------------------

/**
 * Mustache-lite: `{{key}}` → ctx[key]. Unknown keys render to empty string.
 * No conditional / loop logic — keep templates trivial.
 */
export function renderPayload(template: string, ctx: Record<string, string>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => {
    const key = String(k).trim()
    return ctx[key] ?? ""
  })
}

/**
 * Compute hex sha256 HMAC of `body` with `secret`. Hex (not b64) so that
 * the header value is URL-safe and matches existing Sendblue HMAC format
 * used elsewhere in the repo.
 */
export function hmacSign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex")
}

export interface FirePostHookOptions {
  /** Override for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Total timeout in ms (default 30s). */
  timeoutMs?: number
}

export interface FirePostHookResult {
  ok: boolean
  status: number | null
  errorMsg: string | null
}

/**
 * POST `payload` to `trigger.endpoint.url` with optional HMAC-SHA256 signature
 * in `x-hmac-sha256` header. Never throws — returns `{ok,status,errorMsg}`.
 *
 * Total timeout 30s; caller should not await beyond own budget.
 */
export async function firePostHook(
  trigger: Trigger,
  payload: string,
  secret: string | null,
  opts: FirePostHookOptions = {}
): Promise<FirePostHookResult> {
  const f = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? 30_000
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(trigger.endpoint.headers ?? {}),
  }
  if (secret) {
    headers["x-hmac-sha256"] = hmacSign(payload, secret)
  }
  try {
    const resp = await f(trigger.endpoint.url, {
      method: "POST",
      headers,
      body: payload,
      signal: ctrl.signal,
    })
    return { ok: resp.ok, status: resp.status, errorMsg: resp.ok ? null : `http_${resp.status}` }
  } catch (e) {
    return {
      ok: false,
      status: null,
      errorMsg: e instanceof Error ? e.message : String(e),
    }
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Defensive helpers (used by tests + dashboard)
// ---------------------------------------------------------------------------

export function newTriggerId(): string {
  return `trig_${randomUUID().replace(/-/g, "").slice(0, 16)}`
}
