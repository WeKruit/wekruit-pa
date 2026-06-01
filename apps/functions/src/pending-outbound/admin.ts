/**
 * `paPendingOutboundAdmin` — admin-only callable backing the
 * `/admin/pending-outbound` dashboard (batch human-approve-then-send queue).
 *
 * Actions (one callable, dispatched on `action`):
 *  - `list`    — read queue rows (optionally filtered by status), pure read.
 *  - `update`  — edit a row's `draftBody` (operator correction before send).
 *  - `approve` — flip `pending` → `approved`, stamp approver + timestamp.
 *  - `skip`    — flip any non-terminal row → `skipped`.
 *  - `send`    — GATED dispatch of an `approved` row through Sendblue. This is
 *               the ONLY action that talks to the outside world, and it is
 *               wired so that it CANNOT fire automatically:
 *                 1. only an `approved` row may be sent;
 *                 2. `suppressed === true` rows are hard-blocked;
 *                 3. the LIVE pa-users handle + opt-out is re-validated at send
 *                    time (a stale denormalized `toE164` never sends);
 *                 4. the actual Sendblue call is an INJECTED `sendImpl` seam.
 *                    The production wrapper does NOT inject one yet, so a
 *                    production `send` returns `{ ok:false, blocked:true,
 *                    reason:"send_not_wired" }` instead of dispatching. Live
 *                    Sendblue dispatch is intentionally left for a follow-up
 *                    that wires `sendImpl` behind an explicit human click +
 *                    Adam sign-off (CLAUDE.md: real iMessage to non-test
 *                    recipients is an Adam-gated action).
 *
 * Architecture mirrors `paAdminMatchDebug` / `paPromoteSandboxTag`: the handler
 * logic lives in `runPendingOutboundAdmin` (pure, deps-injected) so unit tests
 * drive it without booting firebase-admin; the `onCall` wrapper at the bottom
 * is a thin shim wiring production deps + the admin auth gate.
 */
import { onCall, HttpsError } from "firebase-functions/v2/https"
import { defineSecret } from "firebase-functions/params"
import { getFirestore } from "firebase-admin/firestore"
import type { Firestore } from "firebase-admin/firestore"
import { z } from "zod"
import {
  PA_COLLECTIONS,
  PendingOutboundSchema,
  type PendingOutbound,
  type PendingOutboundStatus,
} from "@pa/core-types"
import { authorizeAdminCallable } from "../promote-sandbox-tag.js"
import { isSuppressed, type SuppressionResult } from "./suppression.js"
import { sendImessage } from "../sendblue/sendblue-client.js"

const PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN")

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const ListInputSchema = z.object({
  action: z.literal("list"),
  /** Filter by status; `null` returns all rows. Defaults to "pending". */
  status: PendingOutboundSchema.shape.status.nullable().optional(),
  limit: z.number().int().min(1).max(500).default(200),
  adminToken: z.string().optional(),
})

const UpdateInputSchema = z.object({
  action: z.literal("update"),
  id: z.string().min(1),
  /** New draft copy (operator correction). English-only, grounded. */
  draftBody: z.string().min(1).max(2000),
  adminToken: z.string().optional(),
})

const ApproveInputSchema = z.object({
  action: z.literal("approve"),
  id: z.string().min(1),
  adminToken: z.string().optional(),
})

const SkipInputSchema = z.object({
  action: z.literal("skip"),
  id: z.string().min(1),
  adminToken: z.string().optional(),
})

const SendInputSchema = z.object({
  action: z.literal("send"),
  id: z.string().min(1),
  adminToken: z.string().optional(),
})

export const PendingOutboundAdminInputSchema = z.discriminatedUnion("action", [
  ListInputSchema,
  UpdateInputSchema,
  ApproveInputSchema,
  SkipInputSchema,
  SendInputSchema,
])
export type PendingOutboundAdminInput = z.infer<
  typeof PendingOutboundAdminInputSchema
>

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export type PendingOutboundListResult = {
  action: "list"
  rows: PendingOutbound[]
}

export type PendingOutboundMutationResult = {
  action: "update" | "approve" | "skip"
  ok: boolean
  doc: PendingOutbound
}

export type PendingOutboundSendResult = {
  action: "send"
  /** True only when an actual dispatch succeeded. */
  ok: boolean
  /** True when the send was deliberately NOT dispatched (gate / not wired). */
  blocked: boolean
  reason: string
  doc: PendingOutbound
}

export type PendingOutboundAdminResult =
  | PendingOutboundListResult
  | PendingOutboundMutationResult
  | PendingOutboundSendResult

// ---------------------------------------------------------------------------
// Deps (injected for tests + to keep the live Sendblue seam explicit)
// ---------------------------------------------------------------------------

/** Live recipient + opt-out facts re-read at send time (never trust the row). */
export type LiveRecipient = {
  /** Canonical reachable handle right now (null if unreachable). */
  toE164: string | null
  /** True if the candidate is opted out / do-not-contact / paused right now. */
  optedOut: boolean
  optedOutReason?: string | null
}

export type PendingOutboundAdminDeps = {
  db: Firestore
  /** Operator uid (for approvedBy / audit). */
  actorUid: string
  now?: () => string
  /**
   * Re-reads the LIVE recipient + opt-out state for a userId at send time.
   * Production wiring reads `pa-users/{userId}` (phoneE164 + doNotContact +
   * outreachPaused + candidateLifecycleState === "opted_out").
   */
  resolveLiveRecipient?: (userId: string) => Promise<LiveRecipient>
  /**
   * FULL outbound suppression re-check at click time. This is BROADER than
   * `resolveLiveRecipient` (which only reads the basic pa-users opt-out flags):
   * it also catches `outreach.status === "paused"` (the reversible STOP-keyword
   * pause), filed-but-unprocessed `stop_outreach`/`delete` privacy requests, the
   * global kill switch, and `dailyJobRecSubscribe.optedIn === false`. It is
   * fail-CLOSED for the `recovery` kind. A row that became paused/opted-out
   * AFTER it was queued is blocked here even though it was approved. Defaults to
   * the real `isSuppressed` in production.
   */
  checkSuppression?: (
    userId: string,
    kind: string
  ) => Promise<SuppressionResult>
  /**
   * The ACTUAL Sendblue dispatch seam. Intentionally optional: when absent the
   * `send` action returns `blocked` instead of dispatching, so no live send can
   * fire without an explicit, deliberate wiring of this function. Returns the
   * provider message id on success.
   */
  sendImpl?: (args: {
    toE164: string
    channel: PendingOutbound["channel"]
    body: string
    userId: string
    docId: string
  }) => Promise<{ providerMessageId: string }>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES: ReadonlySet<PendingOutboundStatus> = new Set([
  "sent",
  "skipped",
])

async function readRow(
  db: Firestore,
  id: string
): Promise<{ ref: FirebaseFirestore.DocumentReference; doc: PendingOutbound }> {
  const ref = db.collection(PA_COLLECTIONS.pendingOutbound).doc(id)
  const snap = await ref.get()
  if (!snap.exists) {
    throw new HttpsError("not-found", `pending-outbound row not found: ${id}`)
  }
  const parsed = PendingOutboundSchema.safeParse(snap.data())
  if (!parsed.success) {
    throw new HttpsError(
      "failed-precondition",
      `pending-outbound row ${id} failed schema validation`
    )
  }
  return { ref, doc: parsed.data }
}

// ---------------------------------------------------------------------------
// Pure handler
// ---------------------------------------------------------------------------

export async function runPendingOutboundAdmin(
  raw: unknown,
  deps: PendingOutboundAdminDeps
): Promise<PendingOutboundAdminResult> {
  const parsed = PendingOutboundAdminInputSchema.safeParse(raw)
  if (!parsed.success) {
    throw new HttpsError("invalid-argument", parsed.error.message)
  }
  const input = parsed.data
  const now = deps.now ?? (() => new Date().toISOString())

  // -------------------- list --------------------
  if (input.action === "list") {
    const status =
      input.status === undefined ? "pending" : input.status
    const col = deps.db.collection(PA_COLLECTIONS.pendingOutbound)
    let query: FirebaseFirestore.Query = col
    if (status !== null) {
      query = col.where("status", "==", status)
    }
    query = query.limit(input.limit)
    const snap = await query.get()
    const rows: PendingOutbound[] = []
    for (const docSnap of snap.docs) {
      const row = PendingOutboundSchema.safeParse(docSnap.data())
      if (row.success) rows.push(row.data)
    }
    rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    return { action: "list", rows }
  }

  // -------------------- update (edit draft) --------------------
  if (input.action === "update") {
    const { ref, doc } = await readRow(deps.db, input.id)
    if (TERMINAL_STATUSES.has(doc.status)) {
      throw new HttpsError(
        "failed-precondition",
        `cannot edit a ${doc.status} row`
      )
    }
    const next: PendingOutbound = PendingOutboundSchema.parse({
      ...doc,
      draftBody: input.draftBody,
    })
    await ref.set(next)
    return { action: "update", ok: true, doc: next }
  }

  // -------------------- approve --------------------
  if (input.action === "approve") {
    const { ref, doc } = await readRow(deps.db, input.id)
    if (doc.status !== "pending") {
      throw new HttpsError(
        "failed-precondition",
        `only pending rows can be approved (row is ${doc.status})`
      )
    }
    const next: PendingOutbound = PendingOutboundSchema.parse({
      ...doc,
      status: "approved",
      approvedBy: deps.actorUid,
      approvedAt: now(),
    })
    await ref.set(next)
    return { action: "approve", ok: true, doc: next }
  }

  // -------------------- skip --------------------
  if (input.action === "skip") {
    const { ref, doc } = await readRow(deps.db, input.id)
    if (TERMINAL_STATUSES.has(doc.status)) {
      throw new HttpsError(
        "failed-precondition",
        `row is already ${doc.status}`
      )
    }
    const next: PendingOutbound = PendingOutboundSchema.parse({
      ...doc,
      status: "skipped",
    })
    await ref.set(next)
    return { action: "skip", ok: true, doc: next }
  }

  // -------------------- send (GATED) --------------------
  // This is the only outward-facing path. Every gate below MUST pass, and
  // even then the actual dispatch only happens if `deps.sendImpl` is wired.
  const { ref, doc } = await readRow(deps.db, input.id)

  // Gate 1 — only approved rows are sendable.
  if (doc.status !== "approved") {
    return {
      action: "send",
      ok: false,
      blocked: true,
      reason: `row is ${doc.status}, not approved`,
      doc,
    }
  }

  // Gate 2 — suppression flag hard-blocks (opt-out / cooldown at queue time).
  if (doc.suppressed) {
    return {
      action: "send",
      ok: false,
      blocked: true,
      reason: doc.suppressedReason
        ? `suppressed: ${doc.suppressedReason}`
        : "suppressed",
      doc,
    }
  }

  // Gate 2.5 — FULL suppression re-check at click time, ALWAYS fail-CLOSED. This
  // is the gate that catches a row which became paused / opted-out /
  // privacy-stopped AFTER it was queued+approved. It reads every opt-out signal
  // in the system (incl. the reversible STOP-keyword pause on
  // outreach.status === "paused" and filed-but-unprocessed privacy requests),
  // which `resolveLiveRecipient` alone does NOT cover.
  //
  // A human-clicked send is the single highest-stakes outbound moment, so we
  // hard-pin the suppression read to the fail-CLOSED `recovery` kind regardless
  // of `doc.kind`: any transient read error here MUST suppress (better to make
  // the operator re-click than to text someone whose opt-out read just failed).
  // The recovery campaign already queues kind:"recovery"; this hardening keeps
  // the per-draft Send button safe if the queue is ever reused for ai_review /
  // rec / reengage kinds (which fail OPEN on their own bulk paths). We persist
  // the freshly discovered suppression onto the row so the queue reflects
  // reality.
  const checkSuppression =
    deps.checkSuppression ??
    ((userId: string) =>
      isSuppressed(deps.db, userId, { kind: "recovery" }))
  const suppression = await checkSuppression(doc.userId, doc.kind)
  if (suppression.suppressed) {
    const suppressed: PendingOutbound = PendingOutboundSchema.parse({
      ...doc,
      suppressed: true,
      suppressedReason: suppression.reason,
    })
    await ref.set(suppressed)
    return {
      action: "send",
      ok: false,
      blocked: true,
      reason: suppression.reason,
      doc: suppressed,
    }
  }

  // Gate 3 — re-validate the LIVE recipient + opt-out at send time. Never
  // trust the denormalized `toE164` on the row.
  const live = deps.resolveLiveRecipient
    ? await deps.resolveLiveRecipient(doc.userId)
    : { toE164: doc.toE164, optedOut: false }

  if (live.optedOut) {
    // Persist the freshly-discovered suppression so the queue reflects reality.
    const suppressed: PendingOutbound = PendingOutboundSchema.parse({
      ...doc,
      suppressed: true,
      suppressedReason: live.optedOutReason ?? "opted_out_at_send_time",
    })
    await ref.set(suppressed)
    return {
      action: "send",
      ok: false,
      blocked: true,
      reason: live.optedOutReason ?? "opted_out_at_send_time",
      doc: suppressed,
    }
  }

  if (!live.toE164) {
    return {
      action: "send",
      ok: false,
      blocked: true,
      reason: "no_reachable_handle_at_send_time",
      doc,
    }
  }

  // Gate 4 — the actual Sendblue dispatch seam. If it is not wired, we DO NOT
  // send; we report blocked. This is what keeps the production CF from ever
  // firing a live message without a deliberate follow-up wiring.
  if (!deps.sendImpl) {
    return {
      action: "send",
      ok: false,
      blocked: true,
      reason: "send_not_wired",
      doc,
    }
  }

  try {
    await deps.sendImpl({
      toE164: live.toE164,
      channel: doc.channel,
      body: doc.draftBody,
      userId: doc.userId,
      docId: doc.id,
    })
  } catch (e) {
    // NOTE (operator behavior): a thrown send is recorded as a terminal
    // `failed` row, so the operator must re-approve before re-sending. Some
    // throws are TRANSIENT (Sendblue 5xx / circuit-breaker-OPEN 60s cooldown /
    // network), where a simple re-click would have succeeded; others are
    // PERMANENT (4xx client errors). We intentionally keep the conservative
    // "one click = one durable outcome" semantics here (no auto-retry), but a
    // future hardening could leave transient failures as `approved`/retryable.
    const failed: PendingOutbound = PendingOutboundSchema.parse({
      ...doc,
      status: "failed",
      sendError: e instanceof Error ? e.message : String(e),
    })
    await ref.set(failed)
    return {
      action: "send",
      ok: false,
      blocked: false,
      reason: "send_failed",
      doc: failed,
    }
  }

  const sent: PendingOutbound = PendingOutboundSchema.parse({
    ...doc,
    status: "sent",
    sentAt: now(),
    sendError: null,
  })
  await ref.set(sent)
  return { action: "send", ok: true, blocked: false, reason: "sent", doc: sent }
}

// ---------------------------------------------------------------------------
// Production live-recipient resolver — reads pa-users/{userId} at send time.
// ---------------------------------------------------------------------------

export async function resolveLiveRecipientFromUsers(
  db: Firestore,
  userId: string
): Promise<LiveRecipient> {
  const snap = await db.collection("pa-users").doc(userId).get()
  if (!snap.exists) {
    return { toE164: null, optedOut: true, optedOutReason: "user_not_found" }
  }
  const data = snap.data() as Record<string, unknown>
  const optedOut =
    data.candidateLifecycleState === "opted_out" ||
    data.doNotContact === true ||
    data.outreachPaused === true
  const optedOutReason = optedOut
    ? data.candidateLifecycleState === "opted_out"
      ? "opted_out"
      : data.doNotContact === true
        ? "do_not_contact"
        : "outreach_paused"
    : null
  const toE164 =
    typeof data.phoneE164 === "string" && data.phoneE164.trim()
      ? data.phoneE164.trim()
      : null
  return { toE164, optedOut, optedOutReason }
}

// ---------------------------------------------------------------------------
// CF entry — admin-gated, deps-injected.
// ---------------------------------------------------------------------------

export const paPendingOutboundAdmin = onCall(
  {
    region: "us-central1",
    memory: "256MiB",
    timeoutSeconds: 60,
    secrets: [PA_ADMIN_TOKEN],
  },
  async (req): Promise<PendingOutboundAdminResult> => {
    const { uid } = authorizeAdminCallable(
      req as { auth?: { token?: { admin?: unknown } }; data?: unknown }
    )
    const db = getFirestore()
    return runPendingOutboundAdmin(req.data, {
      db,
      actorUid: uid,
      resolveLiveRecipient: (userId) =>
        resolveLiveRecipientFromUsers(db, userId),
      // Pin the click-time re-check to the fail-CLOSED `recovery` kind so a
      // transient opt-out read error blocks the human-clicked send (one click =
      // one message; re-clicking after a transient blip is the safe recovery).
      checkSuppression: (userId) =>
        isSuppressed(db, userId, { kind: "recovery" }),
      // sendImpl WIRED to the live Sendblue iMessage sender. This is reached
      // ONLY via the authenticated, admin-gated `action:"send"` path — i.e. one
      // operator click = one message — and ONLY after every gate above passes
      // (approved row + not flagged-suppressed + full isSuppressed re-check +
      // live-recipient re-validation). There is NO auto/bulk/scheduled caller of
      // this seam; the dashboard per-draft "Send" button is the sole trigger.
      // Pool-aware routing + thread continuity come from passing `userId`+`db`;
      // `allowEnvFromNumberFallback:false` keeps an empty public pool from
      // silently falling back to an admin/internal line.
      sendImpl: async ({ toE164, body, userId, docId }) => {
        const resp = await sendImessage({
          to: toE164,
          content: body,
          userId,
          db,
          allowEnvFromNumberFallback: false,
        })
        return { providerMessageId: resp.message_handle ?? resp.uuid ?? docId }
      },
    })
  }
)
