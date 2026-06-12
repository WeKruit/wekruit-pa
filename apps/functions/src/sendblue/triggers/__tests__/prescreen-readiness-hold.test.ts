/**
 * prescreen-readiness-hold.test.ts — ENTRY-UX PRD §2.6.3-4 trigger-side readiness hold.
 *
 * runPreScreenForUser already implements the pre-Q1 hold (maybeHoldForProfileReadiness sends the
 * one-line hold + records pendingPrescreenStart=waiting_profile, and the resume_parse_completed
 * completion event resumes Q1 directly). BUT the PrescreenTrigger had no `readiness_hold` branch:
 * the result fell into the generic `throw new Error("prescreen_start_readiness_hold")` → webhook
 * error + idempotency-stamp clear AFTER the candidate already received the hold line. These tests
 * prove the hold is a HANDLED outcome: no throw, no user-visible error notice, stamp kept.
 *
 * Separate file (not router.test.ts) because that file is concurrently owned by another workstream.
 *
 * Run: node --import tsx --test apps/functions/src/sendblue/triggers/__tests__/prescreen-readiness-hold.test.ts
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { PrescreenTrigger, type PrescreenTriggerDeps, type TriggerContext } from "../index.js"

function makeCtx(text: string, opts: Partial<TriggerContext> = {}): TriggerContext {
  return {
    text,
    fromNumber: opts.fromNumber ?? "+15551234",
    toNumber: opts.toNumber,
    messageHandle: opts.messageHandle ?? "h-readiness",
    receivedAtIso: opts.receivedAtIso ?? "2026-06-12T00:00:00Z",
    log: opts.log ?? (() => {}),
    hasMedia: opts.hasMedia ?? false,
  }
}

function makeDeps(): PrescreenTriggerDeps & {
  audits: Record<string, unknown>[]
  notices: Record<string, unknown>[]
  setLastCalls: string[]
  clearLastCalls: string[]
} {
  const audits: Record<string, unknown>[] = []
  const notices: Record<string, unknown>[] = []
  const setLastCalls: string[] = []
  const clearLastCalls: string[] = []
  return {
    audits,
    notices,
    setLastCalls,
    clearLastCalls,
    async lookupUserByPhone() {
      return "user123"
    },
    async isAdmin() {
      return false
    },
    async getLastFiredMs() {
      return null
    },
    async setLastFiredMs(jobId, userId, messageHandle) {
      setLastCalls.push(`${jobId}:${userId}:${messageHandle}`)
    },
    async clearLastFiredMs(jobId, userId, messageHandle) {
      clearLastCalls.push(`${jobId}:${userId}:${messageHandle}`)
    },
    async runPreScreen() {
      // The session-start path sent the hold copy itself and stored pendingPrescreenStart.
      return { ok: false, reason: "readiness_hold" }
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

test("readiness_hold is a HANDLED outcome: no throw, audited, idempotency stamp kept, no extra notice", async () => {
  const deps = makeDeps()
  const trig = new PrescreenTrigger(deps)

  const outcome = await trig.handle(makeCtx("WeKruit_job1_user123_Job"))

  assert.deepEqual(outcome, { kind: "handled", action: "prescreen_readiness_hold" })
  assert.equal(deps.notices.length, 0, "the hold line was already sent by runPreScreenForUser — no second message")
  const notice = deps.audits.find((a) => a.type === "trigger_notice")
  assert.equal(notice?.reason, "readiness_hold")
  assert.equal(deps.setLastCalls.length, 1, "idempotency stamped before dispatch")
  assert.equal(
    deps.clearLastCalls.length,
    0,
    "stamp KEPT — the pending start resumes via the completion event; a fresh paste is a new messageHandle",
  )
})

test("other unknown failure reasons still throw (the readiness branch is narrow)", async () => {
  const deps = makeDeps()
  deps.runPreScreen = async () => ({ ok: false, reason: "config_invalid" })
  const trig = new PrescreenTrigger(deps)

  await assert.rejects(
    () => trig.handle(makeCtx("WeKruit_job1_user123_Job")),
    /prescreen_start_config_invalid/,
  )
})
