/**
 * v2.2 — PrescreenSessionFinder.
 *
 * Channel-agnostic lookup of active / expired / recent-terminal prescreen
 * sessions. Hoisted from apps/functions/src/prescreen-turn-handler.ts so
 * SMS and voice paths share one source of truth for session lifecycle
 * facts.
 *
 * Two lookup modes:
 *   - findForUser(userId) — SMS path (inbound reply has no sessionId yet).
 *   - loadById(sessionId)  — voice path (bookingId already known from room
 *     metadata; cheaper than a per-user query).
 *
 * The finder MAY mark an active-but-stale session as PAUSE (terminalReason
 * "expired_inactive_prescreen_session") as a side effect of findForUser —
 * this matches the SMS handler's pre-refactor behavior.
 */
import type { Firestore } from "firebase-admin/firestore"

/** Active-session inactivity timeout (21 days). */
export const ACTIVE_PRESCREEN_TIMEOUT_MS = 21 * 24 * 60 * 60 * 1000

/**
 * Absolute age cap for a non-terminal prescreen session, keyed on `createdAt` (24h).
 *
 * Why a SECOND, createdAt-keyed bound on top of the updatedAt inactivity timeout
 * (Adam 2026-06-21, "zombie prescreen" live failure +19196415056 /
 * ps_hs-10996795-invoko-product-manager_JQct3rmfvUkCDsHypkss_…): the inactivity
 * timeout keys on `updatedAt`, but EVERY captured turn bumps `updatedAt` (clarify
 * loops, status questions, the generic turn write). A session that gets stuck on
 * Q1 in a clarify loop therefore refreshes its OWN updatedAt every time it
 * captures an unrelated future inbound (job-rec "yes", etc.) → the inactivity
 * clock never advances → the screen captures turns FOREVER. The live zombie was
 * createdAt 06-18 / updatedAt 06-21, currentQId stuck on q_consumer_product_experience,
 * never scored, hijacking job-rec replies into prescreen probes days later.
 *
 * `createdAt` is the ONE timestamp NOT refreshed by a captured turn, so an
 * absolute age cap on it CANNOT be poisoned by the clarify-loop self-refresh. A
 * real prescreen is a single sitting (minutes); 24h is a generous ceiling for the
 * whole interview. Past it, the session is swept to a stale-closed terminal and
 * stops capturing turns — the inbound falls through to normal triage/matching.
 */
export const ACTIVE_PRESCREEN_MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * Is a non-terminal session past its absolute age cap (createdAt-keyed)?
 * Returns false when createdAt is missing/unparseable (fail-open → keep active;
 * the inactivity timeout remains the backstop). `nowMs`/`createdAtMs` in epoch ms.
 */
export function isPrescreenSessionPastMaxAge(createdAtMs: number | null, nowMs: number): boolean {
  if (createdAtMs === null || !Number.isFinite(createdAtMs)) return false
  return nowMs - createdAtMs > ACTIVE_PRESCREEN_MAX_AGE_MS
}

/** Window in which a recently-terminated session still suppresses Claire. */
export const RECENT_TERMINAL_PRESCREEN_GUARD_MS = 60 * 60 * 1000

export type SessionFinderResult =
  | { kind: "none" }
  | { kind: "active"; sessionId: string; jobId: string; activeQId: string | null }
  | { kind: "expired"; sessionId: string; jobId: string }
  | {
      kind: "recent_terminal"
      sessionId: string
      jobId: string
      terminal: string
      alreadyAcked: boolean
    }

export interface SessionByIdRecord {
  sessionId: string
  userId: string
  jobId: string
  terminal: string | null
  activeQId: string | null
  postTerminalFollowupAckAt?: string
}

export interface PrescreenSessionFinder {
  findForUser(
    userId: string,
    opts?: {
      nowMs?: number
      log?: (event: string, payload: Record<string, unknown>) => void
    },
  ): Promise<SessionFinderResult>

  loadById(sessionId: string): Promise<SessionByIdRecord | null>
}

/* ────────────────────────────────────────────────────────────────────────── */
/* In-memory impl (tests + parity runner)                                     */
/* ────────────────────────────────────────────────────────────────────────── */

export interface InMemorySessionDoc {
  sessionId: string
  userId: string
  jobId: string
  terminal: string | null
  currentQId: string | null
  updatedAtMs: number
  createdAtMs?: number
  endedAtMs?: number
  workSessionKind?: string
  postTerminalFollowupAckAt?: string
}

/** In-memory finder for tests + parity runner. */
export class InMemorySessionFinder implements PrescreenSessionFinder {
  private docs = new Map<string, InMemorySessionDoc>()

  add(doc: InMemorySessionDoc): void {
    this.docs.set(doc.sessionId, { ...doc })
  }

  update(sessionId: string, patch: Partial<InMemorySessionDoc>): void {
    const existing = this.docs.get(sessionId)
    if (!existing) return
    this.docs.set(sessionId, { ...existing, ...patch })
  }

  async findForUser(
    userId: string,
    opts: { nowMs?: number; log?: (event: string, payload: Record<string, unknown>) => void } = {},
  ): Promise<SessionFinderResult> {
    const nowMs = opts.nowMs ?? Date.now()
    const log = opts.log ?? (() => {})

    const userDocs = [...this.docs.values()].filter((d) => d.userId === userId)
    if (userDocs.length === 0) return { kind: "none" }

    // First: any terminal=null session?
    const active = userDocs
      .filter((d) => d.terminal === null)
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
    if (active.length > 0) {
      const top = active[0]!
      const createdAtMs = top.createdAtMs ?? null
      const pastMaxAge = isPrescreenSessionPastMaxAge(createdAtMs, nowMs)
      // Either bound expires the session: updatedAt inactivity OR createdAt absolute age.
      // The createdAt cap is immune to the clarify-loop updatedAt self-refresh (zombie fix).
      if (nowMs - top.updatedAtMs > ACTIVE_PRESCREEN_TIMEOUT_MS || pastMaxAge) {
        // Expire it.
        this.update(top.sessionId, {
          terminal: "PAUSE",
          currentQId: null,
          updatedAtMs: nowMs,
          endedAtMs: nowMs,
        })
        log("prescreen.session_finder.expired_inactive", {
          userId,
          sessionId: top.sessionId,
          lastActiveAt: new Date(top.updatedAtMs).toISOString(),
          reason: pastMaxAge ? "max_age" : "inactivity",
          ...(createdAtMs !== null ? { createdAt: new Date(createdAtMs).toISOString() } : {}),
        })
        return { kind: "expired", sessionId: top.sessionId, jobId: top.jobId }
      }
      return {
        kind: "active",
        sessionId: top.sessionId,
        jobId: top.jobId,
        activeQId: top.currentQId,
      }
    }

    // Second: recent-terminal guard (within 1hr).
    let latest:
      | { id: string; jobId: string; terminal: string; atMs: number; acked: boolean }
      | null = null
    for (const d of userDocs) {
      if (d.terminal === null) continue
      if (d.workSessionKind && d.workSessionKind !== "job_prescreen") continue
      const endedAtMs = d.endedAtMs ?? d.updatedAtMs
      if (nowMs - endedAtMs > RECENT_TERMINAL_PRESCREEN_GUARD_MS) continue
      if (latest && endedAtMs <= latest.atMs) continue
      latest = {
        id: d.sessionId,
        jobId: d.jobId,
        terminal: d.terminal,
        atMs: endedAtMs,
        acked: typeof d.postTerminalFollowupAckAt === "string",
      }
    }
    if (latest) {
      log("prescreen.session_finder.recent_terminal", {
        userId,
        sessionId: latest.id,
        terminal: latest.terminal,
      })
      return {
        kind: "recent_terminal",
        sessionId: latest.id,
        jobId: latest.jobId,
        terminal: latest.terminal,
        alreadyAcked: latest.acked,
      }
    }

    return { kind: "none" }
  }

  async loadById(sessionId: string): Promise<SessionByIdRecord | null> {
    const d = this.docs.get(sessionId)
    if (!d) return null
    return {
      sessionId: d.sessionId,
      userId: d.userId,
      jobId: d.jobId,
      terminal: d.terminal,
      activeQId: d.currentQId,
      ...(d.postTerminalFollowupAckAt ? { postTerminalFollowupAckAt: d.postTerminalFollowupAckAt } : {}),
    }
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Firestore impl                                                             */
/* ────────────────────────────────────────────────────────────────────────── */

function timestampMs(value: unknown): number | null {
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (value && typeof value === "object") {
    const maybe = value as { toMillis?: () => number; toDate?: () => Date }
    if (typeof maybe.toMillis === "function") {
      const ms = maybe.toMillis()
      return Number.isFinite(ms) ? ms : null
    }
    if (typeof maybe.toDate === "function") {
      const ms = maybe.toDate().getTime()
      return Number.isFinite(ms) ? ms : null
    }
  }
  return null
}

/** Firestore-backed finder reading `pa-prescreen-sessions`. */
export class FirestoreSessionFinder implements PrescreenSessionFinder {
  constructor(private readonly db: Firestore) {}

  async findForUser(
    userId: string,
    opts: { nowMs?: number; log?: (event: string, payload: Record<string, unknown>) => void } = {},
  ): Promise<SessionFinderResult> {
    const nowMs = opts.nowMs ?? Date.now()
    const log = opts.log ?? (() => {})

    // First — any active (terminal=null) session?
    const activeSnap = await this.db
      .collection("pa-prescreen-sessions")
      .where("userId", "==", userId)
      .where("terminal", "==", null)
      .get()

    if (!activeSnap.empty) {
      const docs = [...activeSnap.docs].sort((a, b) => {
        const aData = a.data() as Record<string, unknown>
        const bData = b.data() as Record<string, unknown>
        const aMs = timestampMs(aData.updatedAt) ?? timestampMs(aData.createdAt) ?? 0
        const bMs = timestampMs(bData.updatedAt) ?? timestampMs(bData.createdAt) ?? 0
        return bMs - aMs
      })
      const top = docs[0]!
      const data = top.data() as Record<string, unknown>
      const lastActiveMs = timestampMs(data.updatedAt) ?? timestampMs(data.createdAt)
      const createdAtMs = timestampMs(data.createdAt)
      const jobId = typeof data.jobId === "string" ? data.jobId : ""
      const activeQId = typeof data.currentQId === "string" ? data.currentQId : null

      const inactivityExpired = lastActiveMs !== null && nowMs - lastActiveMs > ACTIVE_PRESCREEN_TIMEOUT_MS
      const pastMaxAge = isPrescreenSessionPastMaxAge(createdAtMs, nowMs)
      if (inactivityExpired || pastMaxAge) {
        const nowIso = new Date(nowMs).toISOString()
        await top.ref.set(
          {
            terminal: "PAUSE",
            terminalReason: "expired_inactive_prescreen_session",
            currentQId: null,
            updatedAt: nowIso,
            workSession: {
              kind: "job_prescreen",
              status: "ended",
              endedAt: nowIso,
              boundary: "timeout",
            },
          },
          { merge: true },
        )
        log("prescreen.session_finder.expired_inactive", {
          userId,
          sessionId: top.id,
          lastActiveAt: lastActiveMs !== null ? new Date(lastActiveMs).toISOString() : null,
          timeoutMinutes: ACTIVE_PRESCREEN_TIMEOUT_MS / 60_000,
          reason: pastMaxAge ? "max_age" : "inactivity",
          ...(createdAtMs !== null ? { createdAt: new Date(createdAtMs).toISOString() } : {}),
        })
        return { kind: "expired", sessionId: top.id, jobId }
      }

      return { kind: "active", sessionId: top.id, jobId, activeQId }
    }

    // Second — recent terminal guard.
    const allSnap = await this.db
      .collection("pa-prescreen-sessions")
      .where("userId", "==", userId)
      .get()

    let latest:
      | { id: string; jobId: string; terminal: string; atMs: number; acked: boolean }
      | null = null

    for (const doc of allSnap.docs) {
      const data = doc.data() as Record<string, unknown>
      const terminal = typeof data.terminal === "string" ? data.terminal : null
      if (!terminal) continue
      const workSession = data.workSession as Record<string, unknown> | undefined
      if (workSession && workSession.kind !== "job_prescreen") continue
      const endedAtMs =
        timestampMs(workSession?.endedAt) ??
        timestampMs(data.updatedAt) ??
        timestampMs(data.completedAt) ??
        timestampMs(data.createdAt)
      if (endedAtMs === null) continue
      if (nowMs - endedAtMs > RECENT_TERMINAL_PRESCREEN_GUARD_MS) continue
      if (latest && endedAtMs <= latest.atMs) continue
      latest = {
        id: doc.id,
        jobId: typeof data.jobId === "string" ? data.jobId : "",
        terminal,
        atMs: endedAtMs,
        acked: typeof data.postTerminalFollowupAckAt === "string",
      }
    }

    if (latest) {
      log("prescreen.session_finder.recent_terminal", {
        userId,
        sessionId: latest.id,
        terminal: latest.terminal,
      })
      return {
        kind: "recent_terminal",
        sessionId: latest.id,
        jobId: latest.jobId,
        terminal: latest.terminal,
        alreadyAcked: latest.acked,
      }
    }

    return { kind: "none" }
  }

  async loadById(sessionId: string): Promise<SessionByIdRecord | null> {
    const snap = await this.db.collection("pa-prescreen-sessions").doc(sessionId).get()
    if (!snap.exists) return null
    const data = snap.data() as Record<string, unknown> | undefined
    if (!data) return null
    return {
      sessionId,
      userId: typeof data.userId === "string" ? data.userId : "",
      jobId: typeof data.jobId === "string" ? data.jobId : "",
      terminal: typeof data.terminal === "string" ? data.terminal : null,
      activeQId: typeof data.currentQId === "string" ? data.currentQId : null,
      ...(typeof data.postTerminalFollowupAckAt === "string"
        ? { postTerminalFollowupAckAt: data.postTerminalFollowupAckAt }
        : {}),
    }
  }
}
