/**
 * v1.7 Phase 70 — paAdminMatchDebug schema + admin-auth tests.
 *
 * The CF itself is a thin shim around `queryMatchingJobsV16` (already
 * covered by apps/job-rec/src/__tests__/tools/query-matching-jobs-v16.test.ts).
 * Here we exercise the input-schema parser + the shared admin-auth gate to
 * confirm Phase 70's contract:
 *  - userId required, min length 8
 *  - weightOverrides each clamped 0..1, all keys optional
 *  - limit clamped 1..50, defaults 10
 *  - admin claim accepted; missing claim + missing token → permission-denied
 *
 * Run via:
 *   node --import tsx --test apps/functions/src/__tests__/admin-match-debug.test.ts
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { AdminMatchDebugInputSchema } from "../admin-match-debug.js"
import { authorizeAdminCallable } from "../promote-sandbox-tag.js"

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

describe("AdminMatchDebugInputSchema", () => {
  it("accepts a minimal payload — userId only, defaults limit=10", () => {
    const out = AdminMatchDebugInputSchema.safeParse({ userId: "u_abcdef12" })
    assert.equal(out.success, true)
    if (out.success) {
      assert.equal(out.data.userId, "u_abcdef12")
      assert.equal(out.data.limit, 10)
      assert.equal(out.data.weightOverrides, undefined)
    }
  })

  it("rejects userId shorter than 8 chars", () => {
    const out = AdminMatchDebugInputSchema.safeParse({ userId: "short" })
    assert.equal(out.success, false)
  })

  it("accepts partial weight overrides — missing keys allowed", () => {
    const out = AdminMatchDebugInputSchema.safeParse({
      userId: "u_abcdef12",
      weightOverrides: { llmMatch: 0.6, salaryFit: 0.0 },
    })
    assert.equal(out.success, true)
    if (out.success) {
      assert.equal(out.data.weightOverrides?.llmMatch, 0.6)
      assert.equal(out.data.weightOverrides?.salaryFit, 0.0)
      assert.equal(out.data.weightOverrides?.skillJaccard, undefined)
    }
  })

  it("rejects weight override outside 0..1", () => {
    const high = AdminMatchDebugInputSchema.safeParse({
      userId: "u_abcdef12",
      weightOverrides: { llmMatch: 1.5 },
    })
    assert.equal(high.success, false)
    const low = AdminMatchDebugInputSchema.safeParse({
      userId: "u_abcdef12",
      weightOverrides: { llmMatch: -0.1 },
    })
    assert.equal(low.success, false)
  })

  it("clamps limit to 1..50 and accepts defaults", () => {
    assert.equal(
      AdminMatchDebugInputSchema.safeParse({ userId: "u_abcdef12", limit: 0 }).success,
      false,
    )
    assert.equal(
      AdminMatchDebugInputSchema.safeParse({ userId: "u_abcdef12", limit: 51 }).success,
      false,
    )
    const ok = AdminMatchDebugInputSchema.safeParse({ userId: "u_abcdef12", limit: 25 })
    assert.equal(ok.success, true)
    if (ok.success) assert.equal(ok.data.limit, 25)
  })

  it("rejects non-integer limit", () => {
    const out = AdminMatchDebugInputSchema.safeParse({ userId: "u_abcdef12", limit: 5.5 })
    assert.equal(out.success, false)
  })
})

// ---------------------------------------------------------------------------
// Admin gate — paAdminMatchDebug shares the same authorizer as
// paPromoteSandboxTag, so a smoke test on the gate is sufficient.
// ---------------------------------------------------------------------------

describe("paAdminMatchDebug auth gate (via authorizeAdminCallable)", () => {
  it("accepts auth.token.admin === true", () => {
    const got = authorizeAdminCallable({
      auth: { token: { admin: true }, uid: "u-admin" } as never,
      data: { userId: "u_abcdef12" },
    })
    assert.equal(got.uid, "u-admin")
  })

  it("rejects when neither claim nor token", () => {
    const original = process.env.PA_ADMIN_TOKEN
    delete process.env.PA_ADMIN_TOKEN
    try {
      assert.throws(
        () =>
          authorizeAdminCallable({
            auth: { token: {} } as never,
            data: { userId: "u_abcdef12" },
          }),
        /admin only/,
      )
    } finally {
      if (original !== undefined) process.env.PA_ADMIN_TOKEN = original
    }
  })

  it("accepts admin token fallback for scripted callers", () => {
    const original = process.env.PA_ADMIN_TOKEN
    process.env.PA_ADMIN_TOKEN = "secret-tok-70"
    try {
      const got = authorizeAdminCallable({
        auth: { token: {} } as never,
        data: { userId: "u_abcdef12", adminToken: "secret-tok-70" },
      })
      assert.equal(typeof got.uid, "string")
    } finally {
      if (original !== undefined) process.env.PA_ADMIN_TOKEN = original
      else delete process.env.PA_ADMIN_TOKEN
    }
  })
})
