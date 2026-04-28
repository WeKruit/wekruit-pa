/**
 * Phase 27 T2 — health.ts unit tests.
 *
 * Tests the pure-function `computeHealthBody` and the helpers around it.
 * The `onRequest` wrapper is exercised in deploy/curl-smoke (out-of-band).
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { computeHealthBody, probeSecrets } from "./health.js"

describe("probeSecrets", () => {
  it("returns ok when every required key is set", async () => {
    process.env.PA_HEALTH_TEST_A = "value_a"
    process.env.PA_HEALTH_TEST_B = "value_b"
    try {
      const probe = probeSecrets(["PA_HEALTH_TEST_A", "PA_HEALTH_TEST_B"])
      assert.equal(await probe(), "ok")
    } finally {
      delete process.env.PA_HEALTH_TEST_A
      delete process.env.PA_HEALTH_TEST_B
    }
  })

  it("returns missing when any key is unset", async () => {
    process.env.PA_HEALTH_TEST_A = "value_a"
    delete process.env.PA_HEALTH_TEST_B
    try {
      const probe = probeSecrets(["PA_HEALTH_TEST_A", "PA_HEALTH_TEST_B"])
      assert.equal(await probe(), "missing")
    } finally {
      delete process.env.PA_HEALTH_TEST_A
    }
  })

  it("returns missing when key is set to empty string", async () => {
    process.env.PA_HEALTH_TEST_A = "   "
    try {
      const probe = probeSecrets(["PA_HEALTH_TEST_A"])
      assert.equal(await probe(), "missing")
    } finally {
      delete process.env.PA_HEALTH_TEST_A
    }
  })

  it("returns ok when no required keys (empty list)", async () => {
    const probe = probeSecrets([])
    assert.equal(await probe(), "ok")
  })
})

describe("computeHealthBody", () => {
  it("ok=true when all probes pass", async () => {
    const body = await computeHealthBody({
      name: "paTestCF",
      requiredSecrets: [],
      now: () => "2026-04-28T00:00:00.000Z",
      probes: {
        firestore: async () => "ok",
        secrets: async () => "ok",
      },
    })
    assert.equal(body.ok, true)
    assert.equal(body.name, "paTestCF")
    assert.equal(body.ts, "2026-04-28T00:00:00.000Z")
    assert.equal(body.deps.firestore, "ok")
    assert.equal(body.deps.secrets, "ok")
    assert.ok(body.version)
  })

  it("ok=false when firestore probe fails", async () => {
    const body = await computeHealthBody({
      name: "paTestCF",
      requiredSecrets: [],
      probes: {
        firestore: async () => "fail",
        secrets: async () => "ok",
      },
    })
    assert.equal(body.ok, false)
    assert.equal(body.deps.firestore, "fail")
  })

  it("ok=false when secrets probe says missing", async () => {
    const body = await computeHealthBody({
      name: "paTestCF",
      requiredSecrets: [],
      probes: {
        firestore: async () => "ok",
        secrets: async () => "missing",
      },
    })
    assert.equal(body.ok, false)
    assert.equal(body.deps.secrets, "missing")
  })

  it("includes a non-empty version string", async () => {
    const body = await computeHealthBody({
      name: "paTestCF",
      requiredSecrets: [],
      probes: {
        firestore: async () => "ok",
        secrets: async () => "ok",
      },
    })
    assert.ok(typeof body.version === "string" && body.version.length > 0)
  })

  it("uses K_REVISION env var as version when present", async () => {
    const original = process.env.K_REVISION
    process.env.K_REVISION = "test-revision-123"
    try {
      const body = await computeHealthBody({
        name: "paTestCF",
        requiredSecrets: [],
        probes: {
          firestore: async () => "ok",
          secrets: async () => "ok",
        },
      })
      assert.equal(body.version, "test-revision-123")
    } finally {
      if (original === undefined) delete process.env.K_REVISION
      else process.env.K_REVISION = original
    }
  })
})
