/**
 * v1.6 Phase 59 — paPromoteSandboxTag unit tests.
 *
 * Pure-function exercise of `runPromoteSandboxTag` + `authorizeAdminCallable`.
 * Mirrors `admin-bootstrap.test.ts` shape (firebase-admin not booted; deps
 * passed in as fakes). Run via:
 *
 *   node --import tsx --test apps/functions/src/__tests__/promote-sandbox-tag.test.ts
 *
 * Coverage:
 *  - admin claim accepted
 *  - admin token fallback accepted
 *  - missing creds rejected with permission-denied
 *  - token validation rejects abbreviations / spaces / uppercase
 *  - promote writes overlay + audit
 *  - reject writes overlay + audit
 *  - already-canonical tokens skip write and return `already_canonical`
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  authorizeAdminCallable,
  runPromoteSandboxTag,
  type PromoteSandboxTagDeps,
} from "../promote-sandbox-tag.js"

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeFakeDeps(opts?: {
  staticVocab?: readonly string[]
}): PromoteSandboxTagDeps & {
  overlayWrites: { docId: string; data: Record<string, unknown> }[]
  auditWrites: Record<string, unknown>[]
} {
  const overlayWrites: { docId: string; data: Record<string, unknown> }[] = []
  const auditWrites: Record<string, unknown>[] = []
  return {
    overlayWrites,
    auditWrites,
    staticVocab: opts?.staticVocab,
    setOverlayDoc: async (docId, data) => {
      overlayWrites.push({ docId, data })
    },
    addAuditEvent: async (data) => {
      auditWrites.push(data)
    },
    now: () => "2026-05-06T10:00:00.000Z",
    log: () => {},
  }
}

// ---------------------------------------------------------------------------
// authorizeAdminCallable
// ---------------------------------------------------------------------------

describe("authorizeAdminCallable", () => {
  it("accepts auth.token.admin === true", () => {
    const got = authorizeAdminCallable({
      auth: { token: { admin: true }, uid: "u-1" } as never,
      data: {},
    })
    assert.equal(got.uid, "u-1")
  })

  it("accepts admin token fallback when claim missing", () => {
    const original = process.env.PA_ADMIN_TOKEN
    process.env.PA_ADMIN_TOKEN = "secret-tok"
    try {
      const got = authorizeAdminCallable({
        auth: { token: {} } as never,
        data: { adminToken: "secret-tok" },
      })
      assert.equal(typeof got.uid, "string")
    } finally {
      if (original !== undefined) process.env.PA_ADMIN_TOKEN = original
      else delete process.env.PA_ADMIN_TOKEN
    }
  })

  it("rejects when neither claim nor token", () => {
    const original = process.env.PA_ADMIN_TOKEN
    delete process.env.PA_ADMIN_TOKEN
    try {
      assert.throws(
        () => authorizeAdminCallable({ auth: { token: {} } as never, data: {} }),
        /admin only/,
      )
    } finally {
      if (original !== undefined) process.env.PA_ADMIN_TOKEN = original
    }
  })

  it("rejects mismatched admin token", () => {
    const original = process.env.PA_ADMIN_TOKEN
    process.env.PA_ADMIN_TOKEN = "real"
    try {
      assert.throws(
        () =>
          authorizeAdminCallable({
            auth: { token: {} } as never,
            data: { adminToken: "wrong" },
          }),
        /admin only/,
      )
    } finally {
      if (original !== undefined) process.env.PA_ADMIN_TOKEN = original
      else delete process.env.PA_ADMIN_TOKEN
    }
  })
})

// ---------------------------------------------------------------------------
// runPromoteSandboxTag — schema + side-effects
// ---------------------------------------------------------------------------

describe("runPromoteSandboxTag — token validation", () => {
  it("rejects abbreviations (D5)", async () => {
    const deps = makeFakeDeps()
    await assert.rejects(
      () =>
        runPromoteSandboxTag(
          { vocab: "industry-sector", token: "ai", action: "promote" },
          "admin-1",
          deps,
        ),
      /abbreviation/,
    )
    assert.equal(deps.overlayWrites.length, 0)
    assert.equal(deps.auditWrites.length, 0)
  })

  it("rejects whitespace tokens", async () => {
    const deps = makeFakeDeps()
    await assert.rejects(
      () =>
        runPromoteSandboxTag(
          { vocab: "industry-sector", token: "developer tools", action: "promote" },
          "admin-1",
          deps,
        ),
      /space/,
    )
  })

  it("rejects uppercase", async () => {
    const deps = makeFakeDeps()
    await assert.rejects(
      () =>
        runPromoteSandboxTag(
          { vocab: "industry-sector", token: "Developer_Tools", action: "promote" },
          "admin-1",
          deps,
        ),
      /lowercase/,
    )
  })
})

describe("runPromoteSandboxTag — promote", () => {
  it("writes overlay + audit on promote", async () => {
    const deps = makeFakeDeps({ staticVocab: ["software_and_saas"] })
    const got = await runPromoteSandboxTag(
      { vocab: "industry-sector", token: "developer_tools", action: "promote" },
      "admin-1",
      deps,
    )
    assert.deepEqual(got, {
      ok: true,
      token: "developer_tools",
      status: "promoted",
    })
    assert.equal(deps.overlayWrites.length, 1)
    const w = deps.overlayWrites[0]!
    assert.equal(w.docId, "industry-sector__developer_tools")
    assert.equal(w.data.status, "promoted")
    assert.equal(w.data.promotedBy, "admin-1")
    assert.equal(w.data.promotedAt, "2026-05-06T10:00:00.000Z")

    assert.equal(deps.auditWrites.length, 1)
    const a = deps.auditWrites[0]!
    assert.equal(a.eventType, "promote")
    assert.equal(a.token, "developer_tools")
    assert.equal(a.actorUid, "admin-1")
  })

  it("returns already_canonical and skips write when token already in static vocab", async () => {
    const deps = makeFakeDeps({ staticVocab: ["software_and_saas", "developer_tools"] })
    const got = await runPromoteSandboxTag(
      { vocab: "industry-sector", token: "developer_tools", action: "promote" },
      "admin-1",
      deps,
    )
    assert.deepEqual(got, {
      ok: true,
      token: "developer_tools",
      status: "already_canonical",
    })
    assert.equal(deps.overlayWrites.length, 0)
    assert.equal(deps.auditWrites.length, 0)
  })
})

describe("runPromoteSandboxTag — reject", () => {
  it("writes overlay + audit on reject", async () => {
    const deps = makeFakeDeps()
    const got = await runPromoteSandboxTag(
      { vocab: "industry-sector", token: "spam_token_test", action: "reject" },
      "admin-1",
      deps,
    )
    assert.deepEqual(got, {
      ok: true,
      token: "spam_token_test",
      status: "rejected",
    })
    assert.equal(deps.overlayWrites.length, 1)
    const w = deps.overlayWrites[0]!
    assert.equal(w.data.status, "rejected")
    assert.equal(w.data.rejectedBy, "admin-1")

    assert.equal(deps.auditWrites.length, 1)
    assert.equal(deps.auditWrites[0]!.eventType, "reject")
  })
})
