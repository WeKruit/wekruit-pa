/**
 * prescreen-phone-is-auth.test.ts — PHONE-IS-AUTH START + GRACEFUL-NOTICE-NEVER-SILENT.
 *
 * Live weekend bug family (3 victims on the Invoko PM job page): a candidate pastes
 * `WeKruit_<jobId>_<uid>_Job`; the token's embedded uid does NOT match the phone's real
 * pa-users account, so the old self-identity gate (`!isSelf && !isAdmin && !pendingMatch`)
 * REJECTED — and for a CORRUPT token uid (Maximiliano: digit `1` where his real uid had
 * lowercase `l`) the rejection NOTICE itself was keyed to the nonexistent token uid →
 * outbox `user not found` → DEAD SILENCE.
 *
 * Canonical rule (memory prescreen_string_start_everyone + CANONICAL-CANDIDATE-FLOW.md +
 * ENTRY-UX PRD §2.5): the PHONE is the auth. A STRING paste starts for EVERYONE, attributed
 * to the phone-resolved real account; the token only carries the JOB id.
 *
 * FIX 1 — when !isSelf/!isAdmin/!pendingMatch BUT the phone resolves to a real account AND the
 *         token jobId is a real startable job → START for the phone's account, sourceRequestedUserId
 *         = token uid, allowMatchedBypass. No notice.
 * FIX 2 — the remaining reject path (bogus job / unknown phone) keys the notice to the PHONE
 *         identity (never the token uid) so it can't user-not-found-drop. Never silent.
 *
 * Separate file (not router.test.ts) — that file is concurrently owned by another workstream.
 *
 * Run: node --import tsx --test apps/functions/src/sendblue/triggers/__tests__/prescreen-phone-is-auth.test.ts
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  PrescreenTrigger,
  PRESCREEN_ACCESS_ISSUE_NOTICE,
  type PrescreenTriggerDeps,
  type TriggerContext,
} from "../index.js"

function makeCtx(text: string, opts: Partial<TriggerContext> = {}): TriggerContext {
  return {
    text,
    fromNumber: opts.fromNumber ?? "+14086498808",
    toNumber: opts.toNumber ?? "+17174919939",
    messageHandle: opts.messageHandle ?? "h-paste",
    receivedAtIso: opts.receivedAtIso ?? "2026-06-13T00:00:00Z",
    log: opts.log ?? (() => {}),
    hasMedia: opts.hasMedia ?? false,
  }
}

type RunArgs = {
  jobId: string
  userId: string
  toE164: string
  initialReplyText?: string
  sourceRequestedUserId?: string
  allowMatchedBypass?: boolean
}

type Deps = PrescreenTriggerDeps & {
  audits: Record<string, unknown>[]
  notices: Record<string, unknown>[]
  runCalls: RunArgs[]
}

function makeDeps(opts: {
  /** phone → real pa-users id; null = phone resolves to nobody. */
  phoneUserId: string | null
  /** is the token jobId a real startable job? */
  startableJob: boolean
  isAdmin?: boolean
  /** throw identity_conflict from lookup. */
  lookupThrows?: Error
}): Deps {
  const audits: Record<string, unknown>[] = []
  const notices: Record<string, unknown>[] = []
  const runCalls: RunArgs[] = []
  return {
    audits,
    notices,
    runCalls,
    async lookupUserByPhone() {
      if (opts.lookupThrows) throw opts.lookupThrows
      return opts.phoneUserId
    },
    async isAdmin() {
      return Boolean(opts.isAdmin)
    },
    async getLastFiredMs() {
      return null
    },
    async setLastFiredMs() {},
    async clearLastFiredMs() {},
    async isStartableJob() {
      return opts.startableJob
    },
    async runPreScreen(args) {
      runCalls.push(args)
      return { ok: true }
    },
    async sendAccessIssueNotice(args) {
      notices.push(args as never)
    },
    async audit(e) {
      audits.push(e)
    },
    now: () => 1_700_000_000_000,
  }
}

// ── Case 1: token uid != phone uid, phone real, job real → STARTS (Noah repro) ──
test("token uid != phone uid, phone real, job real → STARTS for the phone's account, sourceRequestedUserId=token uid, NO notice", async () => {
  const deps = makeDeps({ phoneUserId: "phoneRealUid", startableJob: true })
  const trig = new PrescreenTrigger(deps)

  // Noah: token carries his WEBSITE uid, phone resolves to his SMS uid.
  const outcome = await trig.handle(makeCtx("WeKruit_invoko-pm_websiteUid_Job"))

  assert.deepEqual(outcome, { kind: "handled", action: "prescreen_triggered" })
  assert.equal(deps.notices.length, 0, "phone-is-auth start sends no access notice")
  assert.equal(deps.runCalls.length, 1)
  assert.equal(deps.runCalls[0].userId, "phoneRealUid", "session bound to the PHONE's real account")
  assert.equal(deps.runCalls[0].sourceRequestedUserId, "websiteUid", "token uid attributed for provenance")
  assert.equal(deps.runCalls[0].allowMatchedBypass, true)
  assert.ok(
    deps.audits.find((a) => a.type === "trigger_phone_is_auth_start"),
    "phone_is_auth_start audited",
  )
})

// ── Case 2: token uid corrupt/nonexistent, job real, phone real → STARTS (Maximiliano repro) ──
test("token uid corrupt/nonexistent, job real, phone real → STARTS (not the dead-silence reject)", async () => {
  const deps = makeDeps({ phoneUserId: "dJtUNFIh9uWlCWue9JcX", startableJob: true })
  const trig = new PrescreenTrigger(deps)

  // Maximiliano: job page emitted a CORRUPT uid (digit 1 for lowercase l) → exists nowhere.
  const outcome = await trig.handle(makeCtx("WeKruit_invoko-pm_dJtUNFIh9uW1CWue9JcX_Job"))

  assert.deepEqual(outcome, { kind: "handled", action: "prescreen_triggered" })
  assert.equal(deps.notices.length, 0)
  assert.equal(deps.runCalls.length, 1)
  assert.equal(deps.runCalls[0].userId, "dJtUNFIh9uWlCWue9JcX", "session bound to the real phone account, not the corrupt token uid")
  assert.equal(deps.runCalls[0].sourceRequestedUserId, "dJtUNFIh9uW1CWue9JcX")
})

// ── Case 3: bogus job → graceful notice TO PHONE, keyed to phone identity, never user-not-found ──
test("token uid foreign, job NOT startable → notice sent TO PHONE keyed to the phone-resolved identity (never the token uid)", async () => {
  const deps = makeDeps({ phoneUserId: "phoneRealUid", startableJob: false })
  const trig = new PrescreenTrigger(deps)

  const outcome = await trig.handle(makeCtx("WeKruit_bogus-job_foreignUid_Job"))

  assert.deepEqual(outcome, { kind: "handled", action: "prescreen_access_issue_notified" })
  assert.equal(deps.runCalls.length, 0, "no foreign-job start")
  assert.equal(deps.notices.length, 1)
  const notice = deps.notices[0] as { targetUserId: string; toE164: string; fromNumber?: string; content: string }
  assert.equal(notice.targetUserId, "phoneRealUid", "notice keyed to the REAL phone account → outbox can resolve a user, never user-not-found-drop")
  assert.notEqual(notice.targetUserId, "foreignUid", "NEVER keyed to the token uid")
  assert.equal(notice.toE164, "+14086498808", "goes to the texter (ctx.fromNumber)")
  assert.equal(notice.fromNumber, "+17174919939", "from the pool line (ctx.toNumber)")
  assert.equal(notice.content, PRESCREEN_ACCESS_ISSUE_NOTICE)
})

// ── Case 4: phone unresolved → phone_not_resolved notice unchanged (to raw phone) ──
test("phone unresolved → phone_not_resolved notice still sent, keyed to the raw inbound phone", async () => {
  const deps = makeDeps({ phoneUserId: null, startableJob: true })
  const trig = new PrescreenTrigger(deps)

  const outcome = await trig.handle(makeCtx("WeKruit_invoko-pm_someUid_Job"))

  assert.deepEqual(outcome, { kind: "handled", action: "prescreen_access_issue_notified" })
  assert.equal(deps.runCalls.length, 0)
  assert.equal(deps.notices.length, 1)
  const notice = deps.notices[0] as { targetUserId: string; toE164: string; content: string }
  assert.equal(notice.targetUserId, "+14086498808", "keyed to the raw phone, never the token uid")
  assert.equal(notice.toE164, "+14086498808")
  const audit = deps.audits.find((a) => a.reason === "phone_not_resolved")
  assert.ok(audit, "phone_not_resolved audited")
})

// ── Case 5: isSelf path unchanged ──
test("isSelf (token uid === phone uid) → STARTS as self, sessionUserId = self, no sourceRequestedUserId", async () => {
  const deps = makeDeps({ phoneUserId: "selfUid", startableJob: true })
  const trig = new PrescreenTrigger(deps)

  const outcome = await trig.handle(makeCtx("WeKruit_invoko-pm_selfUid_Job"))

  assert.deepEqual(outcome, { kind: "handled", action: "prescreen_triggered" })
  assert.equal(deps.notices.length, 0)
  assert.equal(deps.runCalls.length, 1)
  assert.equal(deps.runCalls[0].userId, "selfUid")
  assert.equal(deps.runCalls[0].sourceRequestedUserId, undefined, "self start carries no source attribution")
  const fired = deps.audits.find((a) => a.type === "trigger_fired") as { role?: string } | undefined
  assert.equal(fired?.role, "self")
})

// ── Case 6: pendingMatch (public-page) path unchanged ──
test("pendingMatch (public-page wkr_uid) → STARTS bound to phone account, role=public_page, sourceRequestedUserId=wkr_uid", async () => {
  const deps = makeDeps({ phoneUserId: "phoneRealUid", startableJob: true })
  // Public-page pending invite present for the wkr_uid in the token.
  deps.getPendingInvite = async (requestedUserId) =>
    requestedUserId === "wkrUid123"
      ? { jobId: "invoko-pm", createdAt: "2026-06-13T00:00:00Z" }
      : null
  const consumed: string[] = []
  deps.consumePendingInvite = async (u) => {
    consumed.push(u)
  }
  // isStartableJob must NOT be the deciding factor here — pendingMatch wins first.
  deps.isStartableJob = async () => {
    throw new Error("isStartableJob should not be consulted on the pendingMatch path")
  }
  const trig = new PrescreenTrigger(deps)

  const outcome = await trig.handle(
    makeCtx("WeKruit_invoko-pm_wkrUid123_Job", { now: undefined } as Partial<TriggerContext>),
  )

  assert.deepEqual(outcome, { kind: "handled", action: "prescreen_triggered" })
  assert.equal(deps.notices.length, 0)
  assert.equal(deps.runCalls.length, 1)
  assert.equal(deps.runCalls[0].userId, "phoneRealUid")
  assert.equal(deps.runCalls[0].sourceRequestedUserId, "wkrUid123")
  assert.deepEqual(consumed, ["wkrUid123"], "pending invite consumed after dispatch")
  const fired = deps.audits.find((a) => a.type === "trigger_fired") as { role?: string } | undefined
  assert.equal(fired?.role, "public_page")
})

// ── Case 7: JOB-ONLY token (no uid, 2026-06-13 corruption-proof mint) → STARTS for phone ──
test("JOB-ONLY token `WeKruit_<jobId>_Job` (no uid) → STARTS for the phone's account, no notice, no uid to corrupt", async () => {
  const deps = makeDeps({ phoneUserId: "phoneRealUid", startableJob: true })
  const trig = new PrescreenTrigger(deps)

  // The new mint: no uid in the token at all. Identity is the inbound phone.
  assert.equal(trig.match("WeKruit_invoko-pm_Job"), true, "job-only token still matches the trigger")
  const outcome = await trig.handle(makeCtx("WeKruit_invoko-pm_Job"))

  assert.deepEqual(outcome, { kind: "handled", action: "prescreen_triggered" })
  assert.equal(deps.notices.length, 0)
  assert.equal(deps.runCalls.length, 1)
  assert.equal(deps.runCalls[0].userId, "phoneRealUid", "session bound to the PHONE's real account")
  assert.equal(
    deps.runCalls[0].sourceRequestedUserId,
    undefined,
    "no token uid → no source attribution (phone is the only identity)",
  )
  assert.equal(deps.runCalls[0].allowMatchedBypass, true)
  assert.ok(deps.audits.find((a) => a.type === "trigger_phone_is_auth_start"))
})

// ── Case 8: JOB-ONLY token + bogus job → graceful notice to phone, never silent ──
test("JOB-ONLY token with a BOGUS jobId → graceful notice TO PHONE (never dead silence)", async () => {
  const deps = makeDeps({ phoneUserId: "phoneRealUid", startableJob: false })
  const trig = new PrescreenTrigger(deps)

  const outcome = await trig.handle(makeCtx("WeKruit_bogus-corrupted-job_Job"))

  assert.deepEqual(outcome, { kind: "handled", action: "prescreen_access_issue_notified" })
  assert.equal(deps.runCalls.length, 0)
  assert.equal(deps.notices.length, 1)
  const notice = deps.notices[0] as { targetUserId: string; toE164: string; content: string }
  assert.equal(notice.targetUserId, "phoneRealUid", "notice keyed to the real phone account")
  assert.equal(notice.toE164, "+14086498808")
  assert.equal(notice.content, PRESCREEN_ACCESS_ISSUE_NOTICE)
})

// ── Case 9: JOB-ONLY token where the phone IS the self uid → still starts (self path) ──
test("JOB-ONLY token, phone resolves to a real user → starts (no uid means it can never be 'self'; phone-is-auth carries it)", async () => {
  const deps = makeDeps({ phoneUserId: "selfUid", startableJob: true })
  const trig = new PrescreenTrigger(deps)

  const outcome = await trig.handle(makeCtx("WeKruit_invoko-pm_Job"))

  assert.deepEqual(outcome, { kind: "handled", action: "prescreen_triggered" })
  assert.equal(deps.runCalls.length, 1)
  assert.equal(deps.runCalls[0].userId, "selfUid")
})

// ── Bonus: lookup throws identity_conflict → notice keyed to phone, not token uid ──
test("lookup identity_conflict → notice keyed to the raw inbound phone (never the token uid)", async () => {
  const deps = makeDeps({
    phoneUserId: "ignored",
    startableJob: true,
    lookupThrows: new Error("identity_conflict: two_accounts"),
  })
  const trig = new PrescreenTrigger(deps)

  const outcome = await trig.handle(makeCtx("WeKruit_invoko-pm_someUid_Job"))

  assert.deepEqual(outcome, { kind: "handled", action: "prescreen_identity_conflict_notified" })
  assert.equal(deps.notices.length, 1)
  const notice = deps.notices[0] as { targetUserId: string }
  assert.equal(notice.targetUserId, "+14086498808", "identity-conflict notice keyed to the raw phone")
  assert.notEqual(notice.targetUserId, "someUid")
})
