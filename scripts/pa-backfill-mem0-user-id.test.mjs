/**
 * Unit tests for the pure planning function inside the backfill script.
 * The Firestore loop itself is covered by the manual --dry-run / --apply
 * verification gate (see Phase 11.3 PLAN §3 11.3.3 DONE), but the
 * idempotency rule is critical and gets pinned here so a regression can't
 * silently overwrite an operator-set partition.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { planUserUpdate } from "./pa-backfill-mem0-user-id.mjs"

test("legacy user with no mem0UserId is planned for update", () => {
  const r = planUserUpdate({ id: "u1" })
  assert.equal(r.kind, "would_update")
  assert.equal(r.value, "u1")
})

test("user with mem0UserId === id is preserved (no churn)", () => {
  const r = planUserUpdate({ id: "u1", mem0UserId: "u1" })
  assert.equal(r.kind, "preserved")
})

test("operator-set mem0UserId different from id is preserved (NEVER overwrite)", () => {
  const r = planUserUpdate({ id: "u1", mem0UserId: "custom_partition_x" })
  assert.equal(r.kind, "preserved")
})

test("empty-string mem0UserId is treated as unset and gets backfilled", () => {
  const r = planUserUpdate({ id: "u1", mem0UserId: "" })
  assert.equal(r.kind, "would_update")
  assert.equal(r.value, "u1")
})

test("whitespace-only mem0UserId is treated as unset and gets backfilled", () => {
  const r = planUserUpdate({ id: "u1", mem0UserId: "   " })
  assert.equal(r.kind, "would_update")
  assert.equal(r.value, "u1")
})

test("doc with no id is skipped (cannot backfill what we do not know)", () => {
  assert.equal(planUserUpdate({}).kind, "no_id")
  assert.equal(planUserUpdate({ id: "" }).kind, "no_id")
  assert.equal(planUserUpdate({ id: "   " }).kind, "no_id")
})

test("idempotency — running planUserUpdate twice on a backfilled user is preserved", () => {
  // First run plans an update.
  const first = planUserUpdate({ id: "u1" })
  assert.equal(first.kind, "would_update")
  // After we'd "applied" first.value, the doc looks like this; second run is no-op.
  const second = planUserUpdate({ id: "u1", mem0UserId: first.value })
  assert.equal(second.kind, "preserved")
})
