/**
 * v1.8 Phase 77 — TriggerRouter + PrescreenTrigger + CompactTrigger tests.
 *
 * Exercises:
 *   - TriggerRouter: priority order, first-match-wins, no-match short-circuit
 *   - TriggerRouter: match() throw is swallowed; next trigger tried
 *   - TriggerRouter: handle() throw is caught and routed to error outcome
 *   - PrescreenTrigger: regex matching, jobId/userId extraction, char-class
 *   - PrescreenTrigger: idempotency 60-min window
 *   - PrescreenTrigger: media → unauthorized
 *   - PrescreenTrigger: phone unresolved / wrong phone → same-thread notice
 *   - PrescreenTrigger: self vs admin authorization
 *   - PrescreenTrigger: idempotency stamp BEFORE dispatch
 *   - CompactTrigger: admin-only check, target= override
 */
import test from "node:test"
import assert from "node:assert/strict"

import {
  CompactTrigger,
  extractInitialPrescreenReply,
  PrescreenTrigger,
  PRESCREEN_ACCESS_ISSUE_NOTICE,
  PRESCREEN_ALREADY_COMPLETED_NOTICE,
  PRESCREEN_IDEMPOTENCY_WINDOW_MS,
  PRESCREEN_IDENTITY_CONFLICT_NOTICE,
  TriggerRouter,
  type CompactTriggerDeps,
  type PrescreenTriggerDeps,
  type Trigger,
  type TriggerContext,
} from "../index.js"

// ════════════════════════════════════════════════════════════════════════════
// Fixtures
// ════════════════════════════════════════════════════════════════════════════

function makeCtx(text: string, opts: Partial<TriggerContext> = {}): TriggerContext {
  return {
    text,
    fromNumber: opts.fromNumber ?? "+15551234",
    toNumber: opts.toNumber,
    messageHandle: opts.messageHandle ?? "h1",
    receivedAtIso: opts.receivedAtIso ?? "2026-05-12T00:00:00Z",
    log: opts.log ?? (() => {}),
    hasMedia: opts.hasMedia ?? false,
  }
}

class StubTrigger implements Trigger {
  constructor(
    readonly name: string,
    private readonly pattern: RegExp,
    private readonly onHandle: () => Promise<{ kind: "handled"; action: string }>
  ) {}
  match(text: string): boolean {
    return this.pattern.test(text)
  }
  handle = (_: TriggerContext) => this.onHandle()
}

// ════════════════════════════════════════════════════════════════════════════
// TriggerRouter
// ════════════════════════════════════════════════════════════════════════════

test("Phase 77: router returns handled=false when no trigger matches", async () => {
  const router = new TriggerRouter({
    triggers: [new StubTrigger("a", /AAA/, async () => ({ kind: "handled" as const, action: "a" }))],
  })
  const r = await router.dispatch(makeCtx("hello"))
  assert.equal(r.handled, false)
})

test("Phase 77: router fires first-match-wins (priority order)", async () => {
  let aFired = 0
  let bFired = 0
  const router = new TriggerRouter({
    triggers: [
      new StubTrigger("a", /TOKEN/, async () => {
        aFired++
        return { kind: "handled" as const, action: "a_action" }
      }),
      new StubTrigger("b", /TOKEN/, async () => {
        bFired++
        return { kind: "handled" as const, action: "b_action" }
      }),
    ],
  })
  const r = await router.dispatch(makeCtx("contains TOKEN"))
  assert.equal(r.handled, true)
  assert.equal(r.triggerName, "a")
  assert.equal(aFired, 1)
  assert.equal(bFired, 0, "second trigger MUST NOT fire on first-match")
})

test("Phase 77: router catches handle() throws and routes to error outcome", async () => {
  const router = new TriggerRouter({
    triggers: [
      new StubTrigger("boom", /BOOM/, async () => {
        throw new Error("kaboom")
      }),
    ],
  })
  const r = await router.dispatch(makeCtx("BOOM"))
  assert.equal(r.handled, true)
  assert.equal(r.outcome?.kind, "error")
  if (r.outcome?.kind === "error") assert.equal(r.outcome.reason, "kaboom")
})

test("Phase 77: router swallows match() throw and tries next trigger", async () => {
  const evil: Trigger = {
    name: "evil",
    match() {
      throw new Error("regex blew up")
    },
    async handle() {
      return { kind: "handled" as const, action: "should_not_reach" }
    },
  }
  const router = new TriggerRouter({
    triggers: [
      evil,
      new StubTrigger("ok", /OK/, async () => ({ kind: "handled" as const, action: "ok_action" })),
    ],
  })
  const r = await router.dispatch(makeCtx("OK ping"))
  assert.equal(r.triggerName, "ok")
})

test("RULE-1 evidence: matchesAny(text) mirrors dispatch matching without side effects", () => {
  let fired = 0
  const router = new TriggerRouter({
    triggers: [
      new StubTrigger("a", /TOKEN/, async () => {
        fired++
        return { kind: "handled" as const, action: "a_action" }
      }),
    ],
  })
  assert.equal(router.matchesAny("contains TOKEN"), true)
  assert.equal(router.matchesAny("nothing here"), false)
  assert.equal(fired, 0, "matchesAny must never invoke handle()")
})

test("RULE-1 evidence: matchesAny swallows match() throws and still finds a later match", () => {
  const evil: Trigger = {
    name: "evil",
    match() {
      throw new Error("regex blew up")
    },
    async handle() {
      return { kind: "handled" as const, action: "should_not_reach" }
    },
  }
  const router = new TriggerRouter({
    triggers: [
      evil,
      new StubTrigger("ok", /OK/, async () => ({ kind: "handled" as const, action: "ok_action" })),
    ],
  })
  assert.equal(router.matchesAny("OK ping"), true)
  assert.equal(router.matchesAny("no match"), false)
})

// ════════════════════════════════════════════════════════════════════════════
// PrescreenTrigger
// ════════════════════════════════════════════════════════════════════════════

function makePrescreenDeps(opts: {
  phoneToUser?: Record<string, string | null>
  adminIds?: string[]
  lastFired?: Record<string, number>
  now?: number
} = {}): PrescreenTriggerDeps & {
  runs: Array<{ jobId: string; userId: string; toE164: string; initialReplyText?: string }>
  audits: Record<string, unknown>[]
  identityNotices: Array<{
    targetUserId: string
    jobId: string
    toE164: string
    fromNumber?: string
    messageHandle: string
    content: string
    conflictCode: string
  }>
  setLastCalls: Array<{ jobId: string; userId: string; messageHandle: string; ms: number }>
} {
  const runs: Array<{ jobId: string; userId: string; toE164: string; initialReplyText?: string }> = []
  const audits: Record<string, unknown>[] = []
  const identityNotices: Array<{
    targetUserId: string
    jobId: string
    toE164: string
    fromNumber?: string
    messageHandle: string
    content: string
    conflictCode: string
  }> = []
  const setLastCalls: Array<{ jobId: string; userId: string; messageHandle: string; ms: number }> = []
  const lastFired: Record<string, number> = { ...(opts.lastFired ?? {}) }
  return {
    runs,
    audits,
    identityNotices,
    setLastCalls,
    async lookupUserByPhone(phone) {
      return (opts.phoneToUser ?? {})[phone] ?? null
    },
    async isAdmin(uid) {
      return (opts.adminIds ?? []).includes(uid)
    },
    async getLastFiredMs(jobId, userId, messageHandle) {
      return lastFired[`${jobId}:${userId}:${messageHandle}`] ?? null
    },
    async setLastFiredMs(jobId, userId, messageHandle, ms) {
      lastFired[`${jobId}:${userId}:${messageHandle}`] = ms
      setLastCalls.push({ jobId, userId, messageHandle, ms })
    },
    async runPreScreen(args) {
      runs.push(args)
    },
    async sendIdentityConflictNotice(args) {
      identityNotices.push(args)
    },
    async audit(e) {
      audits.push(e)
    },
    now: () => opts.now ?? 1_000_000_000,
  }
}

test("Phase 77: PrescreenTrigger.match matches valid pattern", () => {
  const trig = new PrescreenTrigger(makePrescreenDeps())
  assert.equal(trig.match("WeKruit_jobABC_user123_Job"), true)
  assert.equal(trig.match("hey WeKruit_j1_u1_Job please"), true)
  assert.equal(trig.match("Wekruit_j1_u1_Job"), true)
  // Char-class limited to alnum + _ + -
  assert.equal(trig.match("WeKruit_j-1_u-1_Job"), true)
})

test("Phase 77: PrescreenTrigger.match rejects non-matching tokens", () => {
  const trig = new PrescreenTrigger(makePrescreenDeps())
  assert.equal(trig.match("WeKruit_Job"), false)
  assert.equal(trig.match("WeKruit_/_/_Job"), false) // invalid char
  assert.equal(trig.match("nothing here"), false)
})

test("TEST 6 — router.matchesAny + PrescreenTrigger.match recognize ALL THREE job-token forms (job-only, bindCode, legacy uid)", () => {
  const trig = new PrescreenTrigger(makePrescreenDeps())
  const router = new TriggerRouter({ triggers: [trig], log: () => {} })

  const jobOnly = "WeKruit_hs-10996795-invoko-product-manager_Job"
  const bindCode = "WeKruit_hs-10996795-invoko-product-manager_ABCDEF23_Job"
  const legacyUid = "WeKruit_photon-macos-devops_aBcD1eFgH2iJkLmNoPqR_Job"

  for (const token of [jobOnly, bindCode, legacyUid]) {
    assert.equal(trig.match(token), true, `match() must recognize: ${token}`)
    assert.equal(router.matchesAny(token), true, `matchesAny() must recognize: ${token}`)
  }
  // matchesAny gates the RULE-1 inbound-evidence write; if it missed the
  // job-only/bindCode forms the trigger's Q1 would be blocked_no_inbound (the
  // dead-silence class). Confirm a non-token stays false.
  assert.equal(router.matchesAny("just saying hi"), false)
})

test("Phase 77: PrescreenTrigger refuses media-attached messages", async () => {
  const deps = makePrescreenDeps({ phoneToUser: { "+15551234": "user123" } })
  const trig = new PrescreenTrigger(deps)
  const r = await trig.handle(makeCtx("WeKruit_j1_user123_Job", { hasMedia: true }))
  assert.equal(r.kind, "unauthorized")
  if (r.kind === "unauthorized") assert.equal(r.reason, "media_attached_pre_screen_text_only")
  assert.equal(deps.runs.length, 0)
})

test("Phase 77: PrescreenTrigger notifies instead of silently rejecting when phone unresolved", async () => {
  const deps = makePrescreenDeps({ phoneToUser: { "+15551234": null } })
  const trig = new PrescreenTrigger(deps)
  const r = await trig.handle(makeCtx("WeKruit_j1_user123_Job", {
    toNumber: "+15557654321",
    messageHandle: "msg-unresolved-1",
  }))
  assert.deepEqual(r, { kind: "handled", action: "prescreen_access_issue_notified" })
  assert.equal(deps.runs.length, 0)
  assert.equal(deps.setLastCalls.length, 0)
  assert.equal(deps.audits[0].type, "trigger_unauthorized")
  assert.equal(deps.audits[0].reason, "phone_not_resolved")
  // FIX 2 (2026-06-13) — phone resolved to NO account; notice keyed to the raw
  // inbound phone, never the token uid (which may be corrupt → user-not-found drop).
  assert.deepEqual(deps.identityNotices[0], {
    targetUserId: "+15551234",
    jobId: "j1",
    toE164: "+15551234",
    fromNumber: "+15557654321",
    messageHandle: "msg-unresolved-1",
    content: "I can't start this WeKruit interview from this phone yet. Reopen the job page from the phone you want Claire to text, or continue in the original Claire thread.",
    conflictCode: "phone_not_resolved",
  })
})

test("Phase 77: PrescreenTrigger notifies instead of silently rejecting when sender is neither self nor admin and the job is not startable", async () => {
  // isStartableJob is unwired in makePrescreenDeps → FIX 1 phone-is-auth-start is
  // NOT taken → falls through to the graceful reject. FIX 2: the notice is keyed
  // to the PHONE-resolved real account ("different_user"), never the token uid.
  const deps = makePrescreenDeps({ phoneToUser: { "+15551234": "different_user" }, adminIds: [] })
  const trig = new PrescreenTrigger(deps)
  const r = await trig.handle(makeCtx("WeKruit_j1_user123_Job", {
    toNumber: "+15557654321",
    messageHandle: "msg-wrong-user-1",
  }))
  assert.deepEqual(r, { kind: "handled", action: "prescreen_access_issue_notified" })
  assert.equal(deps.runs.length, 0)
  assert.equal(deps.setLastCalls.length, 0)
  assert.equal(deps.audits[0].type, "trigger_unauthorized")
  assert.equal(deps.audits[0].reason, "not_self_or_admin")
  assert.deepEqual(deps.identityNotices[0], {
    targetUserId: "different_user",
    jobId: "j1",
    toE164: "+15551234",
    fromNumber: "+15557654321",
    messageHandle: "msg-wrong-user-1",
    content: "I can't start this WeKruit interview from this phone yet. Reopen the job page from the phone you want Claire to text, or continue in the original Claire thread.",
    conflictCode: "job_not_startable",
  })
})

test("Phase 77: PrescreenTrigger queues a clear notice when token phone binding conflicts", async () => {
  const deps = makePrescreenDeps()
  deps.lookupUserByPhone = async () => {
    throw new Error("identity_conflict:pa_users_phone_mismatch:user123:existing_+15550000000_attempted_+15551234")
  }
  const trig = new PrescreenTrigger(deps)
  const r = await trig.handle(makeCtx("WeKruit_j1_user123_Job", {
    fromNumber: "+15551234",
    toNumber: "+15557654321",
    messageHandle: "msg-conflict-1",
  }))

  assert.equal(r.kind, "handled")
  if (r.kind === "handled") assert.equal(r.action, "prescreen_identity_conflict_notified")
  assert.equal(deps.runs.length, 0)
  assert.equal(deps.audits[0].type, "trigger_unauthorized")
  assert.equal(deps.audits[0].reason, "identity_conflict")
  // FIX 2 (2026-06-13) — lookup threw identity_conflict (no clean resolvedUserId);
  // notice keyed to the raw inbound phone, never the token uid.
  assert.deepEqual(deps.identityNotices[0], {
    targetUserId: "+15551234",
    jobId: "j1",
    toE164: "+15551234",
    fromNumber: "+15557654321",
    messageHandle: "msg-conflict-1",
    content: PRESCREEN_IDENTITY_CONFLICT_NOTICE,
    conflictCode: "pa_users_phone_mismatch",
  })
})

test("Phase 77: PrescreenTrigger fires for self (sender matches target userId)", async () => {
  const deps = makePrescreenDeps({ phoneToUser: { "+15551234": "user123" } })
  const trig = new PrescreenTrigger(deps)
  const r = await trig.handle(makeCtx("WeKruit_j1_user123_Job", { fromNumber: "+15551234" }))
  assert.equal(r.kind, "handled")
  if (r.kind === "handled") assert.equal(r.action, "prescreen_triggered")
  assert.equal(deps.runs.length, 1)
  // STRING-TOKEN START self-authorizes → allowMatchedBypass:true (Adam 2026-06-03 string→start=everyone).
  assert.deepEqual(deps.runs[0], { jobId: "j1", userId: "user123", toE164: "+15551234", allowMatchedBypass: true })
})

test("Phase 77: PrescreenTrigger passes text after token as the initial prescreen reply", async () => {
  const deps = makePrescreenDeps({ phoneToUser: { "+15551234": "user123" } })
  const trig = new PrescreenTrigger(deps)
  const r = await trig.handle(makeCtx(
    "WeKruit_j1_user123_Job\n\nI have shipped production Swift automation for macOS fleet health checks.",
    { fromNumber: "+15551234" },
  ))
  assert.equal(r.kind, "handled")
  assert.equal(deps.runs.length, 1)
  assert.equal(
    deps.runs[0].initialReplyText,
    "I have shipped production Swift automation for macOS fleet health checks.",
  )
  const fired = deps.audits.find((a) => a.type === "trigger_fired")
  assert.equal(fired!.initialReplyCaptured, true)
})

test("Phase 77: extractInitialPrescreenReply ignores bare trigger bodies", () => {
  assert.equal(extractInitialPrescreenReply("WeKruit_j1_u1_Job", "WeKruit_j1_u1_Job", 0), null)
  assert.equal(
    extractInitialPrescreenReply(
      "WeKruit_j1_u1_Job: Built launchd-based monitors.",
      "WeKruit_j1_u1_Job",
      0,
    ),
    "Built launchd-based monitors.",
  )
})

test("Phase 77: PrescreenTrigger fires for admin (sender != target but is admin)", async () => {
  const deps = makePrescreenDeps({
    phoneToUser: { "+15551234": "admin_adam" },
    adminIds: ["admin_adam"],
  })
  const trig = new PrescreenTrigger(deps)
  const r = await trig.handle(makeCtx("WeKruit_j1_user123_Job"))
  assert.equal(r.kind, "handled")
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(deps.runs[0].userId, "user123")
  assert.equal(deps.audits[0].role, "admin")
})

test("Phase 77: PrescreenTrigger idempotency dedupes within 60-min window", async () => {
  const now = 1_000_000_000
  const deps = makePrescreenDeps({
    phoneToUser: { "+15551234": "user123" },
    lastFired: { "j1:user123:h1": now - 30 * 60 * 1000 }, // 30 min ago
    now,
  })
  const trig = new PrescreenTrigger(deps)
  const r = await trig.handle(makeCtx("WeKruit_j1_user123_Job"))
  assert.equal(r.kind, "handled")
  if (r.kind === "handled") assert.equal(r.action, "prescreen_deduped")
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(deps.runs.length, 0)
  assert.equal(deps.audits[0].type, "trigger_deduped")
})

test("Phase 77: PrescreenTrigger starts a new work session for a new message handle inside the old job window", async () => {
  const now = 1_000_000_000
  const deps = makePrescreenDeps({
    phoneToUser: { "+15551234": "user123" },
    lastFired: { "j1:user123": now - 30 * 60 * 1000 },
    now,
  })
  const trig = new PrescreenTrigger(deps)
  const r = await trig.handle(makeCtx("WeKruit_j1_user123_Job", { messageHandle: "h-new" }))
  assert.equal(r.kind, "handled")
  if (r.kind === "handled") assert.equal(r.action, "prescreen_triggered")
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(deps.runs.length, 1)
})

test("Phase 77: PrescreenTrigger fires after window expires", async () => {
  const now = 1_000_000_000
  const deps = makePrescreenDeps({
    phoneToUser: { "+15551234": "user123" },
    lastFired: { "j1:user123:h1": now - (PRESCREEN_IDEMPOTENCY_WINDOW_MS + 1) },
    now,
  })
  const trig = new PrescreenTrigger(deps)
  const r = await trig.handle(makeCtx("WeKruit_j1_user123_Job"))
  assert.equal(r.kind, "handled")
  if (r.kind === "handled") assert.equal(r.action, "prescreen_triggered")
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(deps.runs.length, 1)
})

test("Phase 77: PrescreenTrigger stamps idempotency BEFORE dispatch (anti-double-fire)", async () => {
  const deps = makePrescreenDeps({ phoneToUser: { "+15551234": "user123" } })
  let dispatched = false
  const origRun = deps.runPreScreen
  deps.runPreScreen = async (args) => {
    // By the time runPreScreen executes, setLastFiredMs must already have
    // recorded the stamp.
    assert.equal(deps.setLastCalls.length, 1, "setLastFiredMs must run before runPreScreen")
    dispatched = true
    return origRun(args)
  }
  const trig = new PrescreenTrigger(deps)
  await trig.handle(makeCtx("WeKruit_j1_user123_Job"))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(dispatched, true)
})

// ════════════════════════════════════════════════════════════════════════════
// CompactTrigger
// ════════════════════════════════════════════════════════════════════════════

function makeCompactDeps(opts: {
  phoneToUser?: Record<string, string | null>
  adminIds?: string[]
} = {}): CompactTriggerDeps & {
  runs: Array<{ userId: string }>
  audits: Record<string, unknown>[]
} {
  const runs: Array<{ userId: string }> = []
  const audits: Record<string, unknown>[] = []
  return {
    runs,
    audits,
    async lookupUserByPhone(phone) {
      return (opts.phoneToUser ?? {})[phone] ?? null
    },
    async isAdmin(uid) {
      return (opts.adminIds ?? []).includes(uid)
    },
    async runCompaction({ userId }) {
      runs.push({ userId })
    },
    async audit(e) {
      audits.push(e)
    },
  }
}

test("Phase 77: CompactTrigger.match detects token", () => {
  const trig = new CompactTrigger(makeCompactDeps())
  assert.equal(trig.match("__PA_COMPACT__"), true)
  assert.equal(trig.match("please run __PA_COMPACT__ target=u1"), true)
  assert.equal(trig.match("PA_COMPACT"), false)
})

test("Phase 77: CompactTrigger unauthorized for non-admin", async () => {
  const deps = makeCompactDeps({ phoneToUser: { "+15551234": "regular_user" }, adminIds: [] })
  const trig = new CompactTrigger(deps)
  const r = await trig.handle(makeCtx("__PA_COMPACT__"))
  assert.equal(r.kind, "unauthorized")
  if (r.kind === "unauthorized") assert.equal(r.reason, "not_admin")
  assert.equal(deps.runs.length, 0)
})

test("Phase 77: CompactTrigger fires for admin sender's own memory by default", async () => {
  const deps = makeCompactDeps({
    phoneToUser: { "+15551234": "admin_adam" },
    adminIds: ["admin_adam"],
  })
  const trig = new CompactTrigger(deps)
  const r = await trig.handle(makeCtx("__PA_COMPACT__"))
  assert.equal(r.kind, "handled")
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(deps.runs[0].userId, "admin_adam")
  assert.equal(deps.audits[0].mode, "self")
})

test("Phase 77: CompactTrigger fires with target= override", async () => {
  const deps = makeCompactDeps({
    phoneToUser: { "+15551234": "admin_adam" },
    adminIds: ["admin_adam"],
  })
  const trig = new CompactTrigger(deps)
  const r = await trig.handle(makeCtx("__PA_COMPACT__ target=user123"))
  assert.equal(r.kind, "handled")
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(deps.runs[0].userId, "user123")
  assert.equal(deps.audits[0].mode, "admin_target")
})

test("Phase 77: CompactTrigger refuses media attachments", async () => {
  const deps = makeCompactDeps({ phoneToUser: { "+15551234": "admin_adam" }, adminIds: ["admin_adam"] })
  const trig = new CompactTrigger(deps)
  const r = await trig.handle(makeCtx("__PA_COMPACT__", { hasMedia: true }))
  assert.equal(r.kind, "unauthorized")
  assert.equal(deps.runs.length, 0)
})

// ════════════════════════════════════════════════════════════════════════════
// v1.9 hotfix 2026-05-13 — pending-invite binding (public job page candidate flow)
// ════════════════════════════════════════════════════════════════════════════

function makePrescreenDepsWithPending(opts: {
  phoneToUser?: Record<string, string | null>
  adminIds?: string[]
  pendingInvites?: Record<string, { jobId: string; createdAt: string }>
  now?: number
  ttlMs?: number
} = {}) {
  const base = makePrescreenDeps({
    phoneToUser: opts.phoneToUser,
    adminIds: opts.adminIds,
    now: opts.now,
  })
  const pending: Record<string, { jobId: string; createdAt: string }> = {
    ...(opts.pendingInvites ?? {}),
  }
  const consumed: string[] = []
  const augmented = {
    ...base,
    consumed,
    pendingState: pending,
    async getPendingInvite(reqUserId: string) {
      return pending[reqUserId] ?? null
    },
    async consumePendingInvite(reqUserId: string) {
      consumed.push(reqUserId)
      delete pending[reqUserId]
    },
    pendingInviteTtlMs: opts.ttlMs ?? 24 * 60 * 60 * 1000,
  }
  return augmented
}

test("v1.9 hotfix: pending-invite binds session to phone-resolved real userId (not wkr_uid)", async () => {
  // Scenario: public job page generates wkr_uid 'wkrAAA' for jobId 'j1'.
  // Stamps pa-prescreen-pending-invites/wkrAAA = {jobId:'j1', createdAt:now}.
  // Candidate SMSes 'WeKruit_j1_wkrAAA_Job' from phone +15551234.
  // Phone resolves to real userId 'realUser456' (different from wkrAAA).
  // Trigger MUST bind session to 'realUser456' so Q1-reply lookup hits.
  const nowMs = 1_700_000_000_000
  const createdAt = new Date(nowMs - 5 * 60 * 1000).toISOString() // 5 min ago, within TTL
  const deps = makePrescreenDepsWithPending({
    phoneToUser: { "+15551234": "realUser456" },
    adminIds: [], // candidate is NOT admin
    pendingInvites: { wkrAAA: { jobId: "j1", createdAt } },
    now: nowMs,
  })
  const trig = new PrescreenTrigger(deps)
  const r = await trig.handle(makeCtx("WeKruit_j1_wkrAAA_Job", { fromNumber: "+15551234" }))
  assert.equal(r.kind, "handled")
  if (r.kind === "handled") assert.equal(r.action, "prescreen_triggered")

  assert.equal(deps.runs.length, 1, "exactly one runPreScreen call")
  assert.equal(deps.runs[0].userId, "realUser456", "session keyed by phone-resolved real userId")
  assert.equal(deps.runs[0].jobId, "j1")
  assert.equal((deps.runs[0] as { sourceRequestedUserId?: string }).sourceRequestedUserId, "wkrAAA", "attribution carries wkr_uid")

  // Pending invite consumed
  assert.deepEqual(deps.consumed, ["wkrAAA"])
  assert.equal(deps.pendingState.wkrAAA, undefined)

  // Idempotency stamped against SESSION userId (real), not wkr_uid
  assert.equal(deps.setLastCalls[0].userId, "realUser456")
  assert.equal(deps.setLastCalls[0].jobId, "j1")

  // Audit role
  const fired = deps.audits.find((a) => a.type === "trigger_fired")
  assert.ok(fired, "trigger_fired audit emitted")
  assert.equal(fired!.role, "public_page")
  assert.equal(fired!.sourceRequestedUserId, "wkrAAA")
})

test("v1.9 hotfix: pending-invite TTL expiry notifies without binding a session", async () => {
  const nowMs = 1_700_000_000_000
  const createdAt = new Date(nowMs - 25 * 60 * 60 * 1000).toISOString() // 25h ago, expired
  const deps = makePrescreenDepsWithPending({
    phoneToUser: { "+15551234": "realUser456" },
    adminIds: [],
    pendingInvites: { wkrAAA: { jobId: "j1", createdAt } },
    now: nowMs,
  })
  const trig = new PrescreenTrigger(deps)
  const r = await trig.handle(makeCtx("WeKruit_j1_wkrAAA_Job", {
    fromNumber: "+15551234",
    toNumber: "+15557654321",
    messageHandle: "msg-expired-pending",
  }))
  assert.deepEqual(r, { kind: "handled", action: "prescreen_access_issue_notified" })
  assert.equal(deps.runs.length, 0)
  assert.equal(deps.setLastCalls.length, 0)
  assert.equal(deps.consumed.length, 0, "do not consume expired pending invite")
  assert.equal(deps.audits[0].reason, "not_self_or_admin")
  // FIX 2 (2026-06-13) — the reject NOTICE is now keyed to the PHONE-resolved
  // real account (never the token/wkr_uid) so the outbox can resolve a user and
  // can't user-not-found-drop the notice. isStartableJob is unwired here →
  // job_not_startable → the graceful notice. (TTL expiry: no startable bypass.)
  assert.deepEqual(deps.identityNotices[0], {
    targetUserId: "realUser456",
    jobId: "j1",
    toE164: "+15551234",
    fromNumber: "+15557654321",
    messageHandle: "msg-expired-pending",
    content: PRESCREEN_ACCESS_ISSUE_NOTICE,
    conflictCode: "job_not_startable",
  })
})

test("v1.9 hotfix: pending-invite jobId mismatch notifies without binding a session", async () => {
  const nowMs = 1_700_000_000_000
  const createdAt = new Date(nowMs - 60 * 1000).toISOString()
  const deps = makePrescreenDepsWithPending({
    phoneToUser: { "+15551234": "realUser456" },
    adminIds: [],
    pendingInvites: { wkrAAA: { jobId: "DIFFERENT_JOB", createdAt } },
    now: nowMs,
  })
  const trig = new PrescreenTrigger(deps)
  const r = await trig.handle(makeCtx("WeKruit_j1_wkrAAA_Job", {
    fromNumber: "+15551234",
    toNumber: "+15557654321",
    messageHandle: "msg-mismatch-pending",
  }))
  assert.deepEqual(r, { kind: "handled", action: "prescreen_access_issue_notified" })
  assert.equal(deps.runs.length, 0)
  assert.equal(deps.setLastCalls.length, 0)
  assert.equal(deps.consumed.length, 0)
  assert.equal(deps.audits[0].reason, "not_self_or_admin")
  // FIX 2 (2026-06-13) — notice keyed to the PHONE-resolved real account, never
  // the token/wkr_uid (the Maximiliano user-not-found dead-silence class).
  assert.deepEqual(deps.identityNotices[0], {
    targetUserId: "realUser456",
    jobId: "j1",
    toE164: "+15551234",
    fromNumber: "+15557654321",
    messageHandle: "msg-mismatch-pending",
    content: PRESCREEN_ACCESS_ISSUE_NOTICE,
    conflictCode: "job_not_startable",
  })
})

test("v1.9 hotfix: admin sender with public-page pending-invite uses phone-resolved (not body) userId", async () => {
  // Adam-as-tester case: admin sends from his own phone with body containing
  // a wkr_uid from his public-page visit. Pending-invite binds session to
  // admin's REAL userId, not the random wkr_uid.
  const nowMs = 1_700_000_000_000
  const createdAt = new Date(nowMs - 60 * 1000).toISOString()
  const deps = makePrescreenDepsWithPending({
    phoneToUser: { "+15551234": "adam_admin_real" },
    adminIds: ["adam_admin_real"],
    pendingInvites: { wkrAAA: { jobId: "j1", createdAt } },
    now: nowMs,
  })
  const trig = new PrescreenTrigger(deps)
  const r = await trig.handle(makeCtx("WeKruit_j1_wkrAAA_Job", { fromNumber: "+15551234" }))
  assert.equal(r.kind, "handled")
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(deps.runs[0].userId, "adam_admin_real", "admin's REAL userId binds, not wkr_uid")
  const fired = deps.audits.find((a) => a.type === "trigger_fired")
  // pendingMatch wins over isAdmin → role = public_page
  assert.equal(fired!.role, "public_page")
})

test("v1.9 hotfix: admin testing other user (no pending-invite) uses body userId (legacy admin path)", async () => {
  // Original admin-test-other-user case. body userId = target candidate userId,
  // no pending-invite. Trigger keeps body userId for session (driving target's session).
  const deps = makePrescreenDepsWithPending({
    phoneToUser: { "+15551234": "adam_admin_real" },
    adminIds: ["adam_admin_real"],
    // no pendingInvites
  })
  const trig = new PrescreenTrigger(deps)
  const r = await trig.handle(makeCtx("WeKruit_j1_targetCandidate_Job", { fromNumber: "+15551234" }))
  assert.equal(r.kind, "handled")
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(deps.runs[0].userId, "targetCandidate", "admin override keeps body userId")
  const fired = deps.audits.find((a) => a.type === "trigger_fired")
  assert.equal(fired!.role, "admin")
})

test("v1.9 hotfix: self path unchanged when body userId matches phone-resolved userId", async () => {
  const deps = makePrescreenDepsWithPending({
    phoneToUser: { "+15551234": "user123" },
    adminIds: [],
  })
  const trig = new PrescreenTrigger(deps)
  const r = await trig.handle(makeCtx("WeKruit_j1_user123_Job", { fromNumber: "+15551234" }))
  assert.equal(r.kind, "handled")
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(deps.runs[0].userId, "user123")
  const fired = deps.audits.find((a) => a.type === "trigger_fired")
  assert.equal(fired!.role, "self")
})

test("STRING-TOKEN START bypasses the matched-gate (Adam 2026-06-03: string → start = everyone)", async () => {
  // A self copy-paste of the exact WeKruit_<jobId>_<userId>_Job string is self-authorizing — the
  // matched-gate (was this job recommended to them) must NOT block it. Regression for the live
  // 2026-06-03 ghost: a candidate pasted a token for a job never recommended to them → not_matched
  // → silent no-reply. The trigger must forward allowMatchedBypass:true so runPreScreenForUser starts.
  const deps = makePrescreenDepsWithPending({ phoneToUser: { "+15551234": "user123" }, adminIds: [] })
  const trig = new PrescreenTrigger(deps)
  const r = await trig.handle(makeCtx("WeKruit_j1_user123_Job", { fromNumber: "+15551234" }))
  assert.equal(r.kind, "handled")
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(deps.runs[0].userId, "user123")
  assert.equal((deps.runs[0] as { allowMatchedBypass?: boolean }).allowMatchedBypass, true, "self string-token start bypasses the matched-gate")
})

test("admin string-token start also forwards the bypass", async () => {
  const deps = makePrescreenDepsWithPending({
    phoneToUser: { "+15551234": "adam_admin_real" },
    adminIds: ["adam_admin_real"],
  })
  const trig = new PrescreenTrigger(deps)
  const r = await trig.handle(makeCtx("WeKruit_j1_targetCandidate_Job", { fromNumber: "+15551234" }))
  assert.equal(r.kind, "handled")
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal((deps.runs[0] as { allowMatchedBypass?: boolean }).allowMatchedBypass, true)
})

// ════════════════════════════════════════════════════════════════════════════
// RULE 2 (2026-06-11 incident) — already_completed / start_in_progress
// ════════════════════════════════════════════════════════════════════════════

test("RULE 2: runPreScreen already_completed → friendly status notice + handled (NO throw, NO restart)", async () => {
  const deps = makePrescreenDeps({ phoneToUser: { "+15551234": "user123" } })
  deps.runPreScreen = async () => ({ ok: false, reason: "already_completed" })
  const trig = new PrescreenTrigger(deps)
  const outcome = await trig.handle(makeCtx("WeKruit_job1_user123_Job", { toNumber: "+17174919939" }))
  assert.deepEqual(outcome, { kind: "handled", action: "prescreen_already_completed" })
  // Friendly status line rides the same notice seam (pa_identity_notice).
  assert.equal(deps.identityNotices.length, 1)
  assert.equal(deps.identityNotices[0].conflictCode, "already_completed")
  assert.equal(deps.identityNotices[0].content, PRESCREEN_ALREADY_COMPLETED_NOTICE)
  assert.equal(deps.identityNotices[0].toE164, "+15551234", "reply goes to the inbound sender")
  assert.equal(deps.identityNotices[0].fromNumber, "+17174919939", "same-thread reply line")
  const notice = deps.audits.find((a) => a.type === "trigger_notice")
  assert.equal(notice?.reason, "already_completed")
})

test("RULE 2: runPreScreen start_in_progress → handled no-op (concurrent start owns Q1)", async () => {
  const deps = makePrescreenDeps({ phoneToUser: { "+15551234": "user123" } })
  deps.runPreScreen = async () => ({ ok: false, reason: "start_in_progress" })
  const trig = new PrescreenTrigger(deps)
  const outcome = await trig.handle(makeCtx("WeKruit_job1_user123_Job"))
  assert.deepEqual(outcome, { kind: "handled", action: "prescreen_start_in_progress" })
  assert.equal(deps.identityNotices.length, 0, "no user-visible message — the winner sends Q1")
})
