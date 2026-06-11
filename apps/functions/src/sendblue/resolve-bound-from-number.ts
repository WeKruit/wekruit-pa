/**
 * resolveBoundFromNumber — the SINGLE source of truth for "which Sendblue line
 * does this user's outbound thread come FROM".
 *
 * THE BUG THIS FIXES (audited 2026-06-02):
 *   The binding is stateful on `pa-users/{userId}.senderNumber`, but the hot
 *   send path used to IGNORE it: every send re-derived the line with
 *   `pickFromNumber(pool, userId)` = `hash(userId) % activeCount`. When the pool
 *   grows 1→2 active numbers, `activeCount` changes and ~50% of users reshuffle
 *   to a DIFFERENT number → outbound thread continuity breaks (a candidate's
 *   reply thread silently splits across two iMessage senders).
 *
 * THE FIX:
 *   A bound user is NEVER re-hashed. The reducer is a cheap READ of the
 *   already-loaded `user` doc (zero extra Firestore read on the send critical
 *   path) plus a pure selectability check against the in-memory pool:
 *
 *     1. `user.senderNumber` set AND still selectable (status active/warmup, not
 *        paused/dead, user-accessible)  → RETURN it. No re-hash. No write.
 *     2. `user.senderNumber` set but now paused/dead/removed → REBIND: capacity-
 *        mint a replacement, persist (source='rebind_paused'), return it.
 *        (HOLD/rebind per the binding doc — never silently drop a send by
 *        returning the dead line.)
 *     3. `user.senderNumber` unset → MINT: capacity-aware pick
 *        (`requireNewUserCapacity:true`), persist (+ source tag), return it.
 *
 * Deploy ordering (LOUD):
 *   This honor-binding behavior is SAFE TO DEPLOY ONLY AFTER the backfill-pin
 *   has run (`scripts/backfill-sendblue-binding-pin.mjs --apply`). Before the
 *   pin, every existing user has NO `senderNumber`, so deploying this would mint
 *   a fresh capacity-aware binding for everyone at once — reshuffling the whole
 *   base ONCE (the very thing we are trying to prevent). Pin first, then deploy.
 */

import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import {
  findSendbluePoolNumber,
  loadSendbluePoolWithCounters,
  pickFromNumber,
  sendblueGroupId,
  type SendbluePoolConfig,
  type SendbluePoolNumber,
} from "./pool.js"

/**
 * Canonical provenance of a user↔number binding. The full enum is intentionally
 * open-ended at the type level (string) for forward-compat, but these are the
 * tags this reducer + its callers stamp.
 */
export type SenderAssignedSource =
  | "inbound_first" // text-only provisional user, minted at first inbound create
  | "qr_scan" // QR opener scan-time sticky pick (index.ts createProvisionalUser)
  | "candidate_identity" // candidate identity/magic-link assignment
  | "rebind_paused" // previous binding's line went paused/dead → minted replacement
  | "backfill_pin_2026_06" // backfill froze the user's current hash-derived line
  | "send_path_mint" // unset binding minted lazily on a send path

export type ResolveBoundFromNumberResult = {
  /**
   * The line the send MUST go from. `undefined` only when the pool has zero
   * eligible lines (caller then falls back to its own policy — env line or skip).
   */
  fromNumber?: string
  /** Group of the resolved line (when resolvable from the pool). */
  groupId?: string
  /** How the binding was decided this call. */
  source: SenderAssignedSource | "bound" | "unresolved"
  /** True when the reducer persisted a NEW/changed binding to pa-users. */
  persisted: boolean
}

type UserLike = {
  senderNumber?: unknown
  senderGroupId?: unknown
} & Record<string, unknown>

function cleanNumber(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed && trimmed.length <= 32 ? trimmed : undefined
}

/**
 * Is `senderNumber` STILL a line we may keep routing a bound user to?
 *
 * Selectable = present in the pool AND status ∈ {active, warmup} AND
 * user-accessible (not admin/internal/developer, not adminOnly). A paused /
 * throttled / degraded / dead / removed line is NOT selectable → triggers
 * rebind. We deliberately accept `warmup` here: a bound user mid-conversation on
 * a warming line keeps thread continuity (warmup is a NEW-assignment gate, not a
 * keep-existing-thread gate).
 *
 * NOTE: when the pool is unconfigured/empty we cannot prove the line is bad, so
 * we KEEP the binding (return true). This is the safe choice — never reshuffle a
 * bound user just because we momentarily failed to load the pool.
 */
export function isBoundNumberStillSelectable(
  pool: SendbluePoolConfig | null,
  senderNumber: string
): boolean {
  if (!pool) return true // pool unknown → do not punish a bound user
  const entry: SendbluePoolNumber | null = findSendbluePoolNumber(pool, senderNumber)
  if (!entry) return false // line was removed from the pool → rebind
  const status = entry.status
  if (status !== "active" && status !== "warmup") return false // paused/dead/etc
  if (entry.adminOnly === true) return false
  const audience = typeof entry.audience === "string" ? entry.audience.trim().toLowerCase() : ""
  if (audience === "admin" || audience === "internal" || audience === "developer") return false
  return true
}

function groupIdForNumber(pool: SendbluePoolConfig | null, senderNumber: string): string {
  return sendblueGroupId(findSendbluePoolNumber(pool, senderNumber) ?? { number: senderNumber, status: "active" })
}

/**
 * PURE reducer core — no Firestore. Given the already-loaded user doc + the
 * in-memory pool, decide the line and whether a (re)bind write is needed.
 *
 * This is the cheap, hot-path-safe heart: zero awaits, zero reads. The async
 * wrapper below adds ONLY the persist write (and, when the caller did not supply
 * a user doc, a single user read — paths that already hold the doc pass it in
 * and stay read-free).
 */
export function decideBoundFromNumber(
  pool: SendbluePoolConfig | null,
  userId: string,
  user: UserLike | null | undefined
): {
  fromNumber?: string
  groupId?: string
  source: ResolveBoundFromNumberResult["source"]
  needsPersist: boolean
} {
  const bound = cleanNumber(user?.senderNumber)

  // (1) Honor an existing, still-selectable binding. Never re-hash. No write.
  if (bound && isBoundNumberStillSelectable(pool, bound)) {
    const existingGroup = cleanNumber(user?.senderGroupId)
    return {
      fromNumber: bound,
      groupId: existingGroup ?? groupIdForNumber(pool, bound),
      source: "bound",
      needsPersist: false,
    }
  }

  // (2) Bound but the line is now paused/dead/removed → rebind (capacity-mint).
  // (3) Unset → mint. Both go through the same capacity-aware pick; only the
  // source tag differs so the audit trail says WHY we wrote.
  const minted = pickFromNumber(pool, userId, { requireNewUserCapacity: true })
  if (!minted) {
    // No eligible line — let the caller's fallback policy take over. Do NOT
    // clear an existing (paused) binding: when the pool recovers it stays valid.
    return { source: "unresolved", needsPersist: false }
  }
  return {
    fromNumber: minted,
    groupId: groupIdForNumber(pool, minted),
    source: bound ? "rebind_paused" : "send_path_mint",
    needsPersist: true,
  }
}

/**
 * RULE 3 (2026-06-11 incident) — one user ↔ one Sendblue number; bind from the
 * inbound thread. Live violation: a user texted IN on 717 (identity notices
 * replied from 717), then a cold opener MINTED a fresh capacity-pick binding →
 * went out from 614. One human, two numbers.
 *
 * Find the line the user's LATEST inbound message arrived ON
 * (`pa-inbound-events` where userId ==, latest by createdAt in memory —
 * equality-only query, no composite index; `rawPayload.toNumber` is the pool
 * line that received it). Fail-soft undefined on any error → capacity pick.
 */
const INBOUND_THREAD_SCAN_LIMIT = 100

export async function findLatestInboundThreadLine(
  db: Firestore,
  userId: string,
  log?: (event: string, payload?: Record<string, unknown>) => void
): Promise<string | undefined> {
  try {
    const snap = await db
      .collection(PA_COLLECTIONS.inboundEvents)
      .where("userId", "==", userId)
      .limit(INBOUND_THREAD_SCAN_LIMIT)
      .get()
    let best: { createdAt: string; toNumber: string } | null = null
    for (const doc of snap.docs) {
      const data = (doc.data() ?? {}) as { createdAt?: unknown; rawPayload?: unknown }
      const raw = (data.rawPayload ?? {}) as Record<string, unknown>
      const toNumber = typeof raw.toNumber === "string" ? raw.toNumber.trim() : ""
      if (!toNumber) continue
      const createdAt = typeof data.createdAt === "string" ? data.createdAt : ""
      if (!best || createdAt > best.createdAt) best = { createdAt, toNumber }
    }
    return best?.toNumber || undefined
  } catch (err) {
    log?.("sendblue.bind.inbound_thread_lookup_failed", {
      userId,
      err: err instanceof Error ? err.message : String(err),
    })
    return undefined
  }
}

export type ResolveBoundFromNumberOptions = {
  /**
   * Already-loaded user doc. Pass this on the send critical path (outbox.ts has
   * it) so the reducer does ZERO extra Firestore reads. Omit only on paths that
   * genuinely don't hold the doc; then we do exactly ONE read.
   */
  user?: UserLike | null
  /**
   * Pre-loaded pool. When omitted, loaded via `loadSendbluePoolWithCounters`
   * (60s TTL cache — effectively free on the hot path). Pass it to share one
   * load across multiple sends in a turn.
   */
  pool?: SendbluePoolConfig | null
  /**
   * Source tag to stamp when MINTING a fresh binding (unset → new). Rebind
   * always stamps 'rebind_paused' regardless. Defaults to 'send_path_mint'.
   */
  mintSource?: SenderAssignedSource
  /** Inject for tests. Defaults to the live counter-overlaid pool loader. */
  loadPool?: (db: Firestore) => Promise<SendbluePoolConfig | null>
  log?: (event: string, payload?: Record<string, unknown>) => void
}

/**
 * Resolve (and, when needed, persist) a user's bound Sendblue from-number.
 *
 * Hot-path contract:
 *   - If `options.user` is supplied AND already has a selectable `senderNumber`,
 *     this performs ZERO Firestore reads and ZERO writes — a pure in-memory
 *     decision over the loaded doc + cached pool.
 *   - A read happens ONLY when `options.user` is omitted (one `get`).
 *   - A write happens ONLY when minting/rebinding (the rare, one-time path).
 *
 * Never throws — pool/persist failures fall back to "best effort" and surface
 * via `log`. The returned `fromNumber` may be undefined when no eligible line
 * exists; the caller decides whether to use its env fallback or skip the send.
 */
export async function resolveBoundFromNumber(
  db: Firestore,
  userId: string,
  options: ResolveBoundFromNumberOptions = {}
): Promise<ResolveBoundFromNumberResult> {
  const log = options.log
  const loadPool = options.loadPool ?? loadSendbluePoolWithCounters

  let pool: SendbluePoolConfig | null = options.pool ?? null
  if (options.pool === undefined) {
    try {
      pool = await loadPool(db)
    } catch {
      pool = null
    }
  }

  let user = options.user
  if (user === undefined) {
    try {
      const snap = await db.collection(PA_COLLECTIONS.users).doc(userId).get()
      user = snap.exists ? (snap.data() as UserLike) : null
    } catch {
      user = null
    }
  }

  // ── RULE 3 (2026-06-11) — MINT arm: bind from the inbound thread FIRST. ──
  // When the user has NO persisted binding, the line their latest inbound
  // arrived on IS their thread — bind to it (when it's still an eligible pool
  // line) BEFORE any capacity selection. Capacity pick is the fallback for
  // users with no inbound evidence. Bound users never reach this (zero extra
  // reads on the hot path); rebind-of-paused keeps capacity selection.
  let decision: ReturnType<typeof decideBoundFromNumber> | null = null
  const existingBound = cleanNumber(user?.senderNumber)
  const isMintArm = !existingBound
  if (isMintArm) {
    const threadLine = await findLatestInboundThreadLine(db, userId, log)
    if (threadLine && pool && isBoundNumberStillSelectable(pool, threadLine)) {
      decision = {
        fromNumber: threadLine,
        groupId: groupIdForNumber(pool, threadLine),
        source: "send_path_mint",
        needsPersist: true,
      }
      log?.("sendblue.bind.mint_from_inbound_thread", { userId, fromNumber: threadLine })
    }
  }
  if (!decision) {
    decision = decideBoundFromNumber(pool, userId, user)
    if (isMintArm && decision.needsPersist && decision.fromNumber) {
      log?.("sendblue.bind.mint_by_capacity", { userId, fromNumber: decision.fromNumber })
    }
  }

  if (!decision.needsPersist || !decision.fromNumber) {
    return {
      ...(decision.fromNumber ? { fromNumber: decision.fromNumber } : {}),
      ...(decision.groupId ? { groupId: decision.groupId } : {}),
      source: decision.source,
      persisted: false,
    }
  }

  // Stamp the source. Rebind keeps its own tag; a fresh mint uses the caller's
  // mintSource (or the default).
  const source: SenderAssignedSource =
    decision.source === "rebind_paused"
      ? "rebind_paused"
      : options.mintSource ?? "send_path_mint"

  const nowIso = new Date().toISOString()
  try {
    await db
      .collection(PA_COLLECTIONS.users)
      .doc(userId)
      .set(
        {
          senderNumber: decision.fromNumber,
          ...(decision.groupId ? { senderGroupId: decision.groupId } : {}),
          senderAssignedAt: nowIso,
          senderAssignedSource: source,
          updatedAt: nowIso,
        },
        { merge: true }
      )
  } catch (err) {
    // Persist is best-effort: we STILL return the resolved line so the send
    // proceeds on the right thread this turn; the next turn re-mints + retries
    // the write. Continuity is preserved deterministically by the hash anyway
    // (the mint is hash-derived), so a dropped write does not split the thread.
    log?.("sendblue.bind.persist_failed", {
      userId,
      err: err instanceof Error ? err.message : String(err),
    })
    return {
      fromNumber: decision.fromNumber,
      ...(decision.groupId ? { groupId: decision.groupId } : {}),
      source,
      persisted: false,
    }
  }

  log?.("sendblue.bind.persisted", { userId, fromNumber: decision.fromNumber, source })
  return {
    fromNumber: decision.fromNumber,
    ...(decision.groupId ? { groupId: decision.groupId } : {}),
    source,
    persisted: true,
  }
}
