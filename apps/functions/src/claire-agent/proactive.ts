/**
 * proactive.ts — WS-proactive owns this file.
 *
 * OUTBOUND-INITIATED turns (cron/event, not an inbound message): post-match
 * retention, daily job-rec push, proactive follow-ups. SAME agent + tools; only the
 * trigger differs. Wraps the existing post-match-retention.ts + proactive-turn.ts +
 * daily batch CF behind a `runProactiveTurn(userId, kind)` entry that:
 *   - GATES deterministically (opt-out / cooldown / idempotency) BEFORE any LLM,
 *   - DEDUPS already-sent jobs (daily_job_rec) against pa-user-job-recommendations,
 *   - builds the SAME Agent with a proactive system-prompt directive,
 *   - emits via the SAME delivery transport (status/text),
 *   - is idempotent (a retry never double-sends — keyed marker doc).
 * Multi-bubble split = a prompt instruction ("split into ≤2 short bubbles") or repeated
 * send, NOT probabilistic-split.ts.
 *
 * KEYSTONE: the LLM only COMPOSES the outbound copy. Every gate (opt-out, cooldown,
 * idempotency, dedup) is a deterministic reducer over Firestore state. A retry NEVER
 * double-sends because the idempotency marker is committed transactionally before the
 * LLM runs (claim-then-send), and re-claiming an existing key no-ops.
 *
 * Reuse map (wrap, do not rebuild):
 *   - opt-out global pause  → @pa/pa-persistence readOutreachStopControl (scope "global")
 *   - daily opt-out         → pa-users.dailyJobRecSubscribe.optedIn (post-match-retention writes this)
 *   - global opted_out      → pa-users.candidateLifecycleState / outreach.status === "opted_out"|"paused"
 *   - cooldown              → pa-users.proactiveOutbox.lastSentAt per kind
 *   - daily dedup           → pa-user-job-recommendations/{userId}/jobs (recommendation-state.ts)
 *   - copy step             → buildClaireAgent (agent.ts) + run() — injectable for eval
 *   - delivery              → ClaireTransport (transport.ts in prod; recording stub in eval)
 *
 * WS-proactive: implement runProactiveTurn + its L3 side-effect eval.
 */
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS, isYcPeopleUser } from "@pa/core-types"
import { readOutreachStopControl } from "@pa/pa-persistence"
import { USER_JOB_RECOMMENDATIONS_COLLECTION, userHasOpenPrescreen } from "@pa/job-rec"
import type { ClaireTransport } from "./types.js"
// NOTE: `agent.ts` (→ @openai/agents) is imported DYNAMICALLY inside
// defaultComposeCopy only. The deterministic gate path (opt-out / cooldown /
// idempotency / dedup) must never pay the SDK load cost, and evals that inject
// their own composer must not transitively pull @openai/agents.

export type ProactiveKind = "post_match_retention" | "daily_job_rec" | "follow_up"

/** Where the per-user proactive bookkeeping (cooldown + idempotency markers) lives. */
const PROACTIVE_MARKERS_COLLECTION = "pa-proactive-markers"

/** Default cooldown window — one kind cannot re-fire for the same user inside this. */
const DEFAULT_COOLDOWN_MS = 20 * 60 * 60 * 1000 // 20h (daily cadence, allows clock drift)

/** Max bubbles a proactive turn may emit (prompt instruction enforces ≤2; this caps the loop). */
const MAX_BUBBLES = 2

/** A fresh candidate job for the daily push (id is required for dedup). */
export interface ProactiveCandidateJob {
  id: string
  /** formatted preview line "Title @ Company\n<url>" (optional — used to ground the copy). */
  line?: string
}

/**
 * Compose the outbound copy. Default impl builds the SAME Claire Agent (agent.ts)
 * with a proactive directive and runs it; eval injects a deterministic fake so the
 * GATES (the load-bearing asserts) stay model-free. Returns ≤2 short bubbles.
 */
export type ProactiveComposer = (input: {
  userId: string
  kind: ProactiveKind
  lang: "en" | "zh"
  /** fresh jobs to ground a daily_job_rec push (already deduped). */
  jobs: ProactiveCandidateJob[]
  transport: ClaireTransport
}) => Promise<string[]>

export interface RunProactiveTurnDeps {
  db: Firestore
  log?: (event: string, payload?: Record<string, unknown>) => void
  /** Override the clock (eval/determinism). */
  nowMs?: () => number
  /**
   * The fire window this trigger belongs to (e.g. a YYYYMMDD daily stamp or a cron
   * tick id). Combined with userId+kind into the idempotency key so a retry inside
   * the same window no-ops. Defaults to the UTC day stamp.
   */
  fireWindow?: string
  /** Per-kind cooldown override (ms). */
  cooldownMs?: number
  /** Delivery seam. Prod = Sendblue/pa-outbound transport; eval = recording stub. */
  transport: ClaireTransport
  /**
   * Candidate-job source for daily_job_rec. Prod wires the daily-batch matcher
   * (queryMatchingJobsV16); eval injects a fixed list. Ignored for other kinds.
   */
  fetchCandidateJobs?: (userId: string) => Promise<ProactiveCandidateJob[]>
  /** Copy composer. Defaults to the real Agent run; eval injects a deterministic fake. */
  composeCopy?: ProactiveComposer
  /** Preferred language. Default "en" (beta iMessage output is English-only). */
  lang?: "en" | "zh"
}

export interface ProactiveTurnOutcome {
  sent: boolean
  reason?:
    | "opted_out"
    | "cooldown"
    | "duplicate"
    | "no_fresh_jobs"
    | "empty_copy"
    | "active_prescreen"
    | "sent"
  outboundCount: number
}

function defaultFireWindow(nowMs: number): string {
  const d = new Date(nowMs)
  const y = d.getUTCFullYear().toString().padStart(4, "0")
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0")
  const day = d.getUTCDate().toString().padStart(2, "0")
  return `${y}${m}${day}`
}

function idempotencyKey(userId: string, kind: ProactiveKind, fireWindow: string): string {
  return `${userId}:${kind}:${fireWindow}`
}

/** Sanitize a key into a safe Firestore doc id (no "/"). */
function markerDocId(key: string): string {
  return key.replace(/[/]/g, "_")
}

// ---------------------------------------------------------------------------
// GATE 1 — opt-out (deterministic, no LLM override; product rule: opted_out
// only reactivates on explicit opt-in).
// ---------------------------------------------------------------------------
async function isOptedOut(
  db: Firestore,
  userId: string,
  kind: ProactiveKind,
  log: (event: string, payload?: Record<string, unknown>) => void
): Promise<boolean> {
  // Global outreach kill-switch (HITL / ops "pause everything").
  try {
    const control = await readOutreachStopControl(db, { scope: "global" })
    if (control.paused) {
      log("pa.proactive.gate.global_paused", { userId, kind })
      return true
    }
  } catch (err) {
    log("pa.proactive.gate.stop_control_read_failed", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // Per-user candidate state + daily subscription opt-out.
  try {
    const snap = await db.collection(PA_COLLECTIONS.users).doc(userId).get()
    const data = snap.exists ? (snap.data() ?? {}) : {}

    // Global lifecycle opted_out / deleted → never proactively contact.
    // Canonical field is the top-level `candidateLifecycleState` string
    // (CandidateProfileMarketplaceFieldsSchema). `candidateLifecycle.state`
    // is also accepted as a defensive alias.
    const lifecycle = data.candidateLifecycle as { state?: string } | undefined
    const state =
      (typeof data.candidateLifecycleState === "string"
        ? (data.candidateLifecycleState as string)
        : undefined) ?? lifecycle?.state
    if (state === "opted_out" || state === "deleted") {
      log("pa.proactive.gate.lifecycle_opted_out", { userId, kind, state })
      return true
    }

    // Outreach status enum (allowed | cooldown | paused | opted_out) — a
    // paused/opted_out outreach channel blocks proactive sends.
    const outreach = data.outreach as { status?: string } | undefined
    if (outreach?.status === "opted_out" || outreach?.status === "paused") {
      log("pa.proactive.gate.outreach_status", { userId, kind, status: outreach.status })
      return true
    }

    // YC PEOPLE LANE — ZERO job-related proactive contact (Adam-LOCKED 2026-07-24: "we don't
    // wanna ask anything about the job including daily ask for users from YC"). This gate had NO
    // YC check at all: it only looked at lifecycle, outreach status and the daily-subscription
    // toggle, so a YC user reaching this path would get a daily_job_rec push. Blocks the whole
    // job-rec proactive lane (daily_job_rec AND post_match_retention, both job-grounded);
    // `follow_up` is content-neutral and stays allowed so the people lane can still be nudged.
    if (kind === "daily_job_rec" || kind === "post_match_retention") {
      if (isYcPeopleUser(data)) {
        log("pa.proactive.gate.yc_people_no_job_content", { userId, kind })
        return true
      }
    }

    // Daily push respects the explicit daily subscription toggle.
    if (kind === "daily_job_rec") {
      const sub = data.dailyJobRecSubscribe as { optedIn?: boolean } | undefined
      if (sub && sub.optedIn === false) {
        log("pa.proactive.gate.daily_unsubscribed", { userId })
        return true
      }
    }
  } catch (err) {
    log("pa.proactive.gate.user_read_failed", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  return false
}

// ---------------------------------------------------------------------------
// GATE 2 — cooldown (deterministic): one proactive send of this kind per window.
// ---------------------------------------------------------------------------
async function isWithinCooldown(
  db: Firestore,
  userId: string,
  kind: ProactiveKind,
  nowMs: number,
  cooldownMs: number,
  log: (event: string, payload?: Record<string, unknown>) => void
): Promise<boolean> {
  try {
    const snap = await db.collection(PA_COLLECTIONS.users).doc(userId).get()
    const data = snap.exists ? (snap.data() ?? {}) : {}
    const outbox = data.proactiveOutbox as
      | Record<string, { lastSentAt?: string }>
      | undefined
    const lastSentAt = outbox?.[kind]?.lastSentAt
    if (typeof lastSentAt === "string") {
      const lastMs = Date.parse(lastSentAt)
      if (Number.isFinite(lastMs) && nowMs - lastMs < cooldownMs) {
        log("pa.proactive.gate.cooldown", { userId, kind, lastSentAt })
        return true
      }
    }
  } catch (err) {
    log("pa.proactive.gate.cooldown_read_failed", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  return false
}

// ---------------------------------------------------------------------------
// GATE 3 — idempotency CLAIM (deterministic, transactional). Claim the key
// BEFORE composing/sending so a concurrent retry inside the same fire window
// loses the race and no-ops. Returns true iff THIS call won the claim.
// ---------------------------------------------------------------------------
async function claimIdempotencyKey(
  db: Firestore,
  key: string,
  meta: { userId: string; kind: ProactiveKind; fireWindow: string; nowIso: string }
): Promise<boolean> {
  const ref = db.collection(PROACTIVE_MARKERS_COLLECTION).doc(markerDocId(key))
  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref)
      if (snap.exists) return false // already fired this window → retry no-ops
      tx.set(ref, {
        idempotencyKey: key,
        userId: meta.userId,
        kind: meta.kind,
        fireWindow: meta.fireWindow,
        status: "claimed",
        claimedAt: meta.nowIso,
      })
      return true
    })
  } catch {
    // Transactions retry internally; a hard failure means we couldn't safely
    // claim → treat as "do not send" (fail closed; a later window retries).
    return false
  }
}

// ---------------------------------------------------------------------------
// DEDUP (daily_job_rec) — exclude jobs already recorded in
// pa-user-job-recommendations/{userId}/jobs (recommendation-state.ts is the
// sole writer). Returns only fresh jobs.
// ---------------------------------------------------------------------------
async function dedupAgainstSent(
  db: Firestore,
  userId: string,
  jobs: ProactiveCandidateJob[],
  log: (event: string, payload?: Record<string, unknown>) => void
): Promise<ProactiveCandidateJob[]> {
  if (jobs.length === 0) return []
  const sent = new Set<string>()
  try {
    const snap = await db
      .collection(USER_JOB_RECOMMENDATIONS_COLLECTION)
      .doc(userId)
      .collection("jobs")
      .get()
    for (const d of snap.docs) sent.add(d.id)
  } catch (err) {
    log("pa.proactive.dedup.read_failed", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  const fresh = jobs.filter((j) => j.id && !sent.has(j.id))
  log("pa.proactive.dedup", { userId, candidates: jobs.length, fresh: fresh.length })
  return fresh
}

/**
 * Default copy composer — builds the SAME Claire Agent (agent.ts) with a
 * proactive directive and runs it. Imported lazily so the deterministic gate
 * path never pays the @openai/agents cost in eval (which injects its own
 * composer). The proactive directive instructs ≤2 short bubbles; we split the
 * model's prose on blank lines and cap at MAX_BUBBLES.
 */
async function defaultComposeCopy(input: {
  userId: string
  kind: ProactiveKind
  lang: "en" | "zh"
  jobs: ProactiveCandidateJob[]
  transport: ClaireTransport
  db: Firestore
}): Promise<string[]> {
  const { run } = await import("./sdk.js")
  const { buildClaireAgent, CLAIRE_MODEL, resolveClaireMaxTurns } = await import("./agent.js")
  const directive = proactiveDirective(input.kind, input.lang, input.jobs)
  const agent = buildClaireAgent(
    {
      db: input.db,
      userId: input.userId,
      sessionId: `proactive:${input.userId}:${input.kind}`,
      lang: input.lang,
      transport: input.transport,
      judgeModel: CLAIRE_MODEL,
      log: () => {},
      nowIso: () => new Date().toISOString(),
    },
    { mode: "triage", lang: input.lang },
  )
  const res = await run(agent, directive, { maxTurns: resolveClaireMaxTurns() })
  const text = String((res as { finalOutput?: unknown }).finalOutput ?? "").trim()
  return splitBubbles(text)
}

/** Proactive system directive (kind-specific). The LLM only COMPOSES copy. */
function proactiveDirective(
  kind: ProactiveKind,
  lang: "en" | "zh",
  jobs: ProactiveCandidateJob[]
): string {
  const bubbleRule =
    "Write at most 2 short bubbles (separate them with a blank line), like texting a friend. No markdown."
  switch (kind) {
    case "post_match_retention":
      return `Proactively check in with the candidate: ask how the roles you sent earlier felt. ${bubbleRule}`
    case "daily_job_rec": {
      const lines = jobs.map((j) => j.line ?? j.id).join("\n")
      return `Proactively send the candidate today's fresh matched roles. Roles:\n${lines}\n${bubbleRule}`
    }
    case "follow_up":
      return `Send the candidate a gentle proactive follow-up to see if they're still looking. ${bubbleRule}`
  }
}

/** Split prose into ≤2 short bubbles on blank lines (NOT probabilistic-split). */
function splitBubbles(text: string): string[] {
  if (!text) return []
  const parts = text
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  return (parts.length > 0 ? parts : [text]).slice(0, MAX_BUBBLES)
}

/**
 * Run one outbound-initiated (proactive) turn. Deterministic gates run BEFORE
 * any LLM; the idempotency key is claimed transactionally so a retry never
 * double-sends. Returns the outcome with an exact outboundCount.
 */
export async function runProactiveTurn(
  userId: string,
  kind: ProactiveKind,
  deps: RunProactiveTurnDeps
): Promise<ProactiveTurnOutcome> {
  const { db, transport } = deps
  const log = deps.log ?? (() => {})
  const nowMs = (deps.nowMs ?? (() => Date.now()))()
  const nowIso = new Date(nowMs).toISOString()
  const lang = deps.lang ?? "en"
  const fireWindow = deps.fireWindow ?? defaultFireWindow(nowMs)
  const cooldownMs = deps.cooldownMs ?? DEFAULT_COOLDOWN_MS
  const key = idempotencyKey(userId, kind, fireWindow)

  log("pa.proactive.begin", { userId, kind, fireWindow })

  // GATE 1 — opt-out.
  if (await isOptedOut(db, userId, kind, log)) {
    return { sent: false, reason: "opted_out", outboundCount: 0 }
  }

  // GATE 2 — cooldown.
  if (await isWithinCooldown(db, userId, kind, nowMs, cooldownMs, log)) {
    return { sent: false, reason: "cooldown", outboundCount: 0 }
  }

  // GATE 2b — "prescreen owns the thread" (2026-06-10 trust audit, fix 8).
  // A proactive push must never land between a prescreen opener and the
  // candidate's answer (live evidence: rec batches buried the screen). ONE
  // pa-users read over the workSession mirror; fail-open on read error.
  if (await userHasOpenPrescreen(db, userId, nowMs, log)) {
    log("pa.proactive.gate.active_prescreen", { userId, kind })
    return { sent: false, reason: "active_prescreen", outboundCount: 0 }
  }

  // DEDUP (daily_job_rec only) — must run before claiming the key so a
  // no-fresh-jobs day doesn't consume the idempotency slot.
  let freshJobs: ProactiveCandidateJob[] = []
  if (kind === "daily_job_rec") {
    const candidates = deps.fetchCandidateJobs
      ? await deps.fetchCandidateJobs(userId)
      : []
    freshJobs = await dedupAgainstSent(db, userId, candidates, log)
    if (freshJobs.length === 0) {
      log("pa.proactive.no_fresh_jobs", { userId })
      return { sent: false, reason: "no_fresh_jobs", outboundCount: 0 }
    }
  }

  // GATE 3 — idempotency CLAIM (transactional, before any send). A concurrent
  // retry inside the same fire window loses the claim and no-ops.
  const claimed = await claimIdempotencyKey(db, key, {
    userId,
    kind,
    fireWindow,
    nowIso,
  })
  if (!claimed) {
    log("pa.proactive.duplicate", { userId, kind, key })
    return { sent: false, reason: "duplicate", outboundCount: 0 }
  }

  // COMPOSE copy (LLM proposes; default builds the SAME Agent). Eval injects a
  // deterministic composer so the gates stay the load-bearing asserts.
  let bubbles: string[]
  try {
    bubbles = deps.composeCopy
      ? await deps.composeCopy({ userId, kind, lang, jobs: freshJobs, transport })
      : await defaultComposeCopy({ userId, kind, lang, jobs: freshJobs, transport, db })
  } catch (err) {
    log("pa.proactive.compose_failed", {
      userId,
      kind,
      error: err instanceof Error ? err.message : String(err),
    })
    // Release the claim so a later window can retry (compose failure is not a send).
    await releaseClaim(db, key, log)
    return { sent: false, reason: "empty_copy", outboundCount: 0 }
  }

  bubbles = bubbles.map((b) => b.trim()).filter((b) => b.length > 0).slice(0, MAX_BUBBLES)
  if (bubbles.length === 0) {
    log("pa.proactive.empty_copy", { userId, kind })
    await releaseClaim(db, key, log)
    return { sent: false, reason: "empty_copy", outboundCount: 0 }
  }

  // EMIT — one transport.sendText per bubble (≤2). Same delivery seam as inbound.
  let outboundCount = 0
  for (const bubble of bubbles) {
    try {
      await transport.sendText(bubble)
      outboundCount += 1
    } catch (err) {
      log("pa.proactive.send_failed", {
        userId,
        kind,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Record the daily recs as sent (feeds the dedup store) so the NEXT window
  // excludes them. recordRecommendedJobs is the sole writer; we mirror its
  // doc shape directly to avoid a second cross-app dependency in the hot path.
  if (kind === "daily_job_rec" && outboundCount > 0) {
    await recordSentJobs(db, userId, freshJobs, nowIso, log)
  }

  // Finalize the marker + stamp the cooldown clock (best-effort; the claim
  // already guarantees single-send for this window).
  await finalizeMarker(db, key, userId, kind, outboundCount, nowIso, log)
  await stampCooldown(db, userId, kind, nowIso, log)

  log("pa.proactive.sent", { userId, kind, outboundCount, bubbles: bubbles.length })
  return { sent: outboundCount > 0, reason: "sent", outboundCount }
}

/** Release a claimed-but-unsent marker so a later window can retry. */
async function releaseClaim(
  db: Firestore,
  key: string,
  log: (event: string, payload?: Record<string, unknown>) => void
): Promise<void> {
  try {
    await db.collection(PROACTIVE_MARKERS_COLLECTION).doc(markerDocId(key)).delete()
  } catch (err) {
    log("pa.proactive.release_claim_failed", {
      key,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/** Mark the idempotency marker as sent (terminal). */
async function finalizeMarker(
  db: Firestore,
  key: string,
  userId: string,
  kind: ProactiveKind,
  outboundCount: number,
  nowIso: string,
  log: (event: string, payload?: Record<string, unknown>) => void
): Promise<void> {
  try {
    await db
      .collection(PROACTIVE_MARKERS_COLLECTION)
      .doc(markerDocId(key))
      .set(
        { status: "sent", outboundCount, sentAt: nowIso, userId, kind },
        { merge: true }
      )
  } catch (err) {
    log("pa.proactive.finalize_marker_failed", {
      key,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/** Stamp the per-kind cooldown clock on pa-users.proactiveOutbox. */
async function stampCooldown(
  db: Firestore,
  userId: string,
  kind: ProactiveKind,
  nowIso: string,
  log: (event: string, payload?: Record<string, unknown>) => void
): Promise<void> {
  try {
    await db
      .collection(PA_COLLECTIONS.users)
      .doc(userId)
      .set(
        { proactiveOutbox: { [kind]: { lastSentAt: nowIso } } },
        { merge: true }
      )
  } catch (err) {
    log("pa.proactive.stamp_cooldown_failed", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Record the pushed jobs into pa-user-job-recommendations/{userId}/jobs so the
 * next daily window dedups them. Mirrors recordRecommendedJobs' doc shape
 * (recommendation-state.ts) — incremented count + lastRecommendedAt + source.
 */
async function recordSentJobs(
  db: Firestore,
  userId: string,
  jobs: ProactiveCandidateJob[],
  nowIso: string,
  log: (event: string, payload?: Record<string, unknown>) => void
): Promise<void> {
  await Promise.all(
    jobs.map(async (job) => {
      if (!job.id) return
      const ref = db
        .collection(USER_JOB_RECOMMENDATIONS_COLLECTION)
        .doc(userId)
        .collection("jobs")
        .doc(job.id)
      try {
        const snap = await ref.get()
        const existing = snap.exists ? (snap.data() ?? {}) : {}
        const prev =
          typeof existing.recommendationCount === "number" &&
          existing.recommendationCount > 0
            ? existing.recommendationCount
            : 0
        await ref.set(
          {
            userId,
            jobId: job.id,
            recommendationCount: prev + 1,
            lastRecommendedAt: nowIso,
            lastRecommendedSource: "proactive_daily_job_rec",
            updatedAt: nowIso,
            ...(prev === 0 ? { firstRecommendedAt: nowIso } : {}),
          },
          { merge: true }
        )
      } catch (err) {
        log("pa.proactive.record_sent_failed", {
          userId,
          jobId: job.id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })
  )
}
