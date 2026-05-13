/**
 * v2.0 External Supply V1 — Wave D — IdentityStatusBadge mapping tests.
 *
 * The dashboard package uses `node --test` (no React Testing Library), so
 * we test the pure helper that drives the badge. Mirrors the
 * `CanonicalTags.test.ts` style.
 *
 * Run via:
 *   node --import tsx --test apps/dashboard-web/src/components/external-supply/__tests__/IdentityStatusBadge.test.tsx
 */
import test from "node:test"
import assert from "node:assert/strict"

import { IDENTITY_STATUS_BADGES, identityStatusBadge } from "../badges.helpers.js"

test("IDENTITY_STATUS_BADGES covers every IdentityResolutionStatus value", () => {
  const keys = Object.keys(IDENTITY_STATUS_BADGES).sort()
  assert.deepEqual(keys, ["blocked", "create_new", "merge_existing", "needs_review", "pending"])
})

test("identityStatusBadge: pending → muted 'Pending'", () => {
  const spec = identityStatusBadge("pending")
  assert.equal(spec.label, "Pending")
  assert.equal(spec.tone, "muted")
})

test("identityStatusBadge: create_new → good 'Create new'", () => {
  const spec = identityStatusBadge("create_new")
  assert.equal(spec.label, "Create new")
  assert.equal(spec.tone, "good")
})

test("identityStatusBadge: merge_existing → good 'Merge existing'", () => {
  const spec = identityStatusBadge("merge_existing")
  assert.equal(spec.label, "Merge existing")
  assert.equal(spec.tone, "good")
})

test("identityStatusBadge: needs_review → warn 'Needs review'", () => {
  const spec = identityStatusBadge("needs_review")
  assert.equal(spec.label, "Needs review")
  assert.equal(spec.tone, "warn")
})

test("identityStatusBadge: blocked → bad 'Blocked'", () => {
  const spec = identityStatusBadge("blocked")
  assert.equal(spec.label, "Blocked")
  assert.equal(spec.tone, "bad")
})

test("identityStatusBadge: every status value maps to a non-empty label + valid tone", () => {
  const validTones = new Set(["good", "bad", "warn", "muted"])
  const allStatuses = [
    "pending",
    "create_new",
    "merge_existing",
    "needs_review",
    "blocked",
  ] as const
  for (const s of allStatuses) {
    const spec = identityStatusBadge(s)
    assert.ok(spec.label.length > 0, `expected non-empty label for ${s}`)
    assert.ok(validTones.has(spec.tone), `expected valid tone for ${s}, got ${spec.tone}`)
  }
})
