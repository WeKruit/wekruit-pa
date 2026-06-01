import assert from "node:assert/strict"
import test from "node:test"
import type { PendingOutboundRow } from "../../lib/pending-outbound-api.js"
import {
  approvableFromSelection,
  groupByReasonCode,
  isBatchSelectable,
  isSendable,
  sendReasonLabel,
  sendableFromSelection,
  statusTone,
  summarize,
} from "../PendingOutbound.helpers.js"

function row(over: Partial<PendingOutboundRow> = {}): PendingOutboundRow {
  return {
    id: over.id ?? "pending-user-1-dup_send-sess",
    userId: "user-1",
    toE164: "+14243201960",
    channel: "imessage",
    kind: "recovery",
    draftBody: "Hey, quick follow-up — still around?",
    whyQueued: "dup_send x4 on 2026-05-2x",
    reasonCode: "dup_send",
    sourceSessionId: "sess",
    enrichmentSnapshot: null,
    status: "pending",
    suppressed: false,
    suppressedReason: null,
    createdAt: "2026-06-01T12:00:00.000Z",
    approvedBy: null,
    approvedAt: null,
    sentAt: null,
    sendError: null,
    version: 1,
    ...over,
  }
}

test("statusTone maps lifecycle to badge tones", () => {
  assert.equal(statusTone("sent"), "ok")
  assert.equal(statusTone("approved"), "info")
  assert.equal(statusTone("failed"), "warn")
  assert.equal(statusTone("skipped"), "warn")
  assert.equal(statusTone("pending"), "muted")
})

test("isSendable: only approved + not suppressed", () => {
  assert.equal(isSendable(row({ status: "approved" })), true)
  assert.equal(isSendable(row({ status: "pending" })), false)
  assert.equal(isSendable(row({ status: "approved", suppressed: true })), false)
  assert.equal(isSendable(row({ status: "sent" })), false)
})

test("isBatchSelectable: pending or approved, never suppressed", () => {
  assert.equal(isBatchSelectable(row({ status: "pending" })), true)
  assert.equal(isBatchSelectable(row({ status: "approved" })), true)
  assert.equal(isBatchSelectable(row({ status: "sent" })), false)
  assert.equal(isBatchSelectable(row({ status: "pending", suppressed: true })), false)
})

test("approvableFromSelection: only selected pending non-suppressed rows", () => {
  const rows = [
    row({ id: "a", status: "pending" }),
    row({ id: "b", status: "approved" }),
    row({ id: "c", status: "pending", suppressed: true }),
    row({ id: "d", status: "pending" }),
  ]
  const selected = new Set(["a", "b", "c"]) // d not selected
  const out = approvableFromSelection(rows, selected).map((r) => r.id)
  assert.deepEqual(out, ["a"]) // b approved already, c suppressed, d unselected
})

test("sendableFromSelection: approved + not suppressed, respecting selection", () => {
  const rows = [
    row({ id: "a", status: "approved" }),
    row({ id: "b", status: "approved", suppressed: true }),
    row({ id: "c", status: "pending" }),
    row({ id: "d", status: "approved" }),
  ]
  // no selection -> all sendable
  assert.deepEqual(
    sendableFromSelection(rows).map((r) => r.id),
    ["a", "d"]
  )
  // selection restricts
  assert.deepEqual(
    sendableFromSelection(rows, new Set(["a", "b"])).map((r) => r.id),
    ["a"] // b suppressed
  )
})

test("groupByReasonCode groups, counts, and orders by size", () => {
  const rows = [
    row({ id: "1", reasonCode: "dup_send", status: "approved" }),
    row({ id: "2", reasonCode: "dup_send", status: "approved", suppressed: true }),
    row({ id: "3", reasonCode: "dup_send", status: "pending" }),
    row({ id: "4", reasonCode: "chinese_in_prod", status: "approved" }),
  ]
  const groups = groupByReasonCode(rows)
  assert.equal(groups.length, 2)
  // dup_send (3 rows) before chinese_in_prod (1 row)
  assert.equal(groups[0].reasonCode, "dup_send")
  assert.equal(groups[0].rows.length, 3)
  assert.equal(groups[0].sendableCount, 1) // only "1" (approved, not suppressed)
  assert.equal(groups[0].suppressedCount, 1)
  assert.equal(groups[1].reasonCode, "chinese_in_prod")
})

test("summarize tallies pending/approved/suppressed/sendable", () => {
  const rows = [
    row({ id: "a", status: "pending" }),
    row({ id: "b", status: "approved" }),
    row({ id: "c", status: "approved", suppressed: true }),
    row({ id: "d", status: "sent" }),
  ]
  const s = summarize(rows)
  assert.equal(s.total, 4)
  assert.equal(s.pending, 1)
  assert.equal(s.approved, 2)
  assert.equal(s.suppressed, 1)
  assert.equal(s.sendable, 1) // only b (approved + not suppressed)
})

test("sendReasonLabel surfaces the gated 'not wired' state plainly", () => {
  assert.match(sendReasonLabel("send_not_wired"), /not wired/i)
  assert.equal(sendReasonLabel("sent"), "Sent")
  assert.match(sendReasonLabel("opted_out_at_send_time"), /opted out/i)
  assert.match(sendReasonLabel("suppressed: cooldown"), /cooldown/)
})
