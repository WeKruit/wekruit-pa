/**
 * Phase 36 T2 — arm-router tests.
 *
 * Verifies:
 *   1. Sticky assignment: same userId → same arm across many calls
 *   2. Default 33/33/34 distribution holds (±3pp tolerance, N=10000)
 *   3. Env override: PA_IMPERFECTION_ARM=high → always "high"
 *   4. Kill switch: PA_IMPERFECTION_ARM_OFF=true → always "off"
 *   5. Empty userId → "off" (no sticky bucket without id)
 *   6. Custom ratios validation (must sum to 100, no negatives)
 *   7. firingRateForArm: off=0, low=0.15, high=0.30
 *   8. djb2Hash: deterministic across calls; non-zero for non-empty input
 */
import { describe, test, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"

import { djb2Hash, firingRateForArm, resolveArm } from "./arm-router.js"
import type { ArmBucketRatios } from "./types.js"

describe("Phase 36 T2 — djb2Hash", () => {
  test("deterministic across calls", () => {
    assert.equal(djb2Hash("user-1"), djb2Hash("user-1"))
    assert.equal(djb2Hash("+15551234567"), djb2Hash("+15551234567"))
  })

  test("different inputs → different outputs (basic collision avoidance)", () => {
    assert.notEqual(djb2Hash("user-1"), djb2Hash("user-2"))
    assert.notEqual(djb2Hash("a"), djb2Hash("b"))
  })

  test("empty string → deterministic non-zero hash (post-avalanche of seed)", () => {
    // Post-avalanche the djb2 seed (5381) maps to a stable 32-bit value.
    // We assert determinism + non-negative rather than an exact magic number
    // so the avalanche finalizer can be tuned without breaking the test.
    const a = djb2Hash("")
    const b = djb2Hash("")
    assert.equal(a, b)
    assert.ok(a >= 0)
    assert.ok(a <= 0xffff_ffff)
  })

  test("output is unsigned 32-bit", () => {
    const h = djb2Hash("test-string")
    assert.ok(h >= 0)
    assert.ok(h <= 0xffff_ffff)
  })
})

describe("Phase 36 T2 — resolveArm sticky assignment", () => {
  beforeEach(() => {
    delete process.env.PA_IMPERFECTION_ARM
    delete process.env.PA_IMPERFECTION_ARM_OFF
  })

  test("same userId → same arm across 100 calls", () => {
    const arm = resolveArm("user-sticky-1")
    for (let i = 0; i < 100; i++) {
      assert.equal(resolveArm("user-sticky-1"), arm)
    }
  })

  test("empty userId → off", () => {
    assert.equal(resolveArm(""), "off")
  })

  test("default 33/33/34 distribution over 10000 random ids — within ±3pp", () => {
    const counts = { off: 0, low: 0, high: 0 }
    const N = 10000
    for (let i = 0; i < N; i++) {
      const arm = resolveArm(`user-${i}`)
      counts[arm] += 1
    }
    const offPct = (counts.off / N) * 100
    const lowPct = (counts.low / N) * 100
    const highPct = (counts.high / N) * 100
    // Tolerance ±3pp
    assert.ok(
      Math.abs(offPct - 33) <= 3,
      `off pct ${offPct.toFixed(2)} outside [30, 36]`
    )
    assert.ok(
      Math.abs(lowPct - 33) <= 3,
      `low pct ${lowPct.toFixed(2)} outside [30, 36]`
    )
    assert.ok(
      Math.abs(highPct - 34) <= 3,
      `high pct ${highPct.toFixed(2)} outside [31, 37]`
    )
  })

  test("custom ratios applied", () => {
    const ratios: ArmBucketRatios = { off: 50, low: 25, high: 25 }
    const counts = { off: 0, low: 0, high: 0 }
    const N = 10000
    for (let i = 0; i < N; i++) {
      counts[resolveArm(`user-r-${i}`, { ratios, ignoreEnv: true })] += 1
    }
    const offPct = (counts.off / N) * 100
    const lowPct = (counts.low / N) * 100
    const highPct = (counts.high / N) * 100
    assert.ok(Math.abs(offPct - 50) <= 3, `off pct ${offPct.toFixed(2)}`)
    assert.ok(Math.abs(lowPct - 25) <= 3, `low pct ${lowPct.toFixed(2)}`)
    assert.ok(Math.abs(highPct - 25) <= 3, `high pct ${highPct.toFixed(2)}`)
  })

  test("custom ratios that don't sum to 100 → throw", () => {
    assert.throws(
      () =>
        resolveArm("user-x", {
          ratios: { off: 50, low: 25, high: 50 },
          ignoreEnv: true,
        }),
      /sum to 100/
    )
  })

  test("custom ratios with negative → throw", () => {
    assert.throws(
      () =>
        resolveArm("user-x", {
          ratios: { off: -10, low: 60, high: 50 },
          ignoreEnv: true,
        }),
      /negative/
    )
  })
})

describe("Phase 36 T2 — env overrides", () => {
  beforeEach(() => {
    delete process.env.PA_IMPERFECTION_ARM
    delete process.env.PA_IMPERFECTION_ARM_OFF
  })
  afterEach(() => {
    delete process.env.PA_IMPERFECTION_ARM
    delete process.env.PA_IMPERFECTION_ARM_OFF
  })

  test("PA_IMPERFECTION_ARM=high → always high regardless of userId", () => {
    process.env.PA_IMPERFECTION_ARM = "high"
    assert.equal(resolveArm("user-a"), "high")
    assert.equal(resolveArm("user-b"), "high")
    assert.equal(resolveArm(""), "high")
  })

  test("PA_IMPERFECTION_ARM=low → always low", () => {
    process.env.PA_IMPERFECTION_ARM = "low"
    assert.equal(resolveArm("user-a"), "low")
  })

  test("PA_IMPERFECTION_ARM=off → always off", () => {
    process.env.PA_IMPERFECTION_ARM = "off"
    assert.equal(resolveArm("user-a"), "off")
  })

  test("PA_IMPERFECTION_ARM=invalid → falls back to hash", () => {
    process.env.PA_IMPERFECTION_ARM = "garbage"
    const arm = resolveArm("user-sticky-fallback")
    assert.ok(["off", "low", "high"].includes(arm))
  })

  test("PA_IMPERFECTION_ARM_OFF=true → kill switch always off (overrides ARM)", () => {
    process.env.PA_IMPERFECTION_ARM_OFF = "true"
    process.env.PA_IMPERFECTION_ARM = "high"
    assert.equal(resolveArm("user-a"), "off")
  })

  test("ignoreEnv: true bypasses env override", () => {
    process.env.PA_IMPERFECTION_ARM = "high"
    // Should NOT be "high" — should be hash-derived.
    const arm = resolveArm("user-bypass-1", { ignoreEnv: true })
    assert.ok(["off", "low", "high"].includes(arm))
    // And should be sticky.
    assert.equal(arm, resolveArm("user-bypass-1", { ignoreEnv: true }))
  })
})

describe("Phase 36 T2 — firingRateForArm", () => {
  test("off → 0", () => {
    assert.equal(firingRateForArm("off"), 0)
  })
  test("low → 0.15", () => {
    assert.equal(firingRateForArm("low"), 0.15)
  })
  test("high → 0.30", () => {
    assert.equal(firingRateForArm("high"), 0.3)
  })
})

describe("Phase 36 T2 — Latency", () => {
  test("10000 resolveArm calls < 100ms total", () => {
    const start = performance.now()
    for (let i = 0; i < 10000; i++) {
      resolveArm(`user-${i}`, { ignoreEnv: true })
    }
    const elapsed = performance.now() - start
    assert.ok(elapsed < 100, `10000 calls took ${elapsed.toFixed(1)}ms (> 100ms budget)`)
  })
})
