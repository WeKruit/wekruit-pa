/**
 * v2.1 S6 — archive-spot-check unit tests.
 *
 * Validates the random-sample-+-fetch logic against the mock GCS
 * adapter. No real `@google-cloud/storage` needed.
 */
import test from "node:test"
import assert from "node:assert/strict"
import {
  sampleN,
  createMockStorageAdapter,
  runSpotCheck,
} from "../archive-spot-check.mjs"

test("sampleN: picks N distinct items deterministically with injected RNG", () => {
  const arr = ["a", "b", "c", "d", "e"]
  // RNG returns 0,0,0 — should still pick distinct items (splice).
  const rng = () => 0
  const out = sampleN(arr, 3, rng)
  assert.equal(out.length, 3)
  assert.equal(new Set(out).size, 3)
})

test("sampleN: caps N at array length", () => {
  const out = sampleN(["x"], 5, () => 0)
  assert.equal(out.length, 1)
})

test("mock storage: list + getMetadata", async () => {
  const s = createMockStorageAdapter([
    { name: "voice/b1/r1.mp4", size: 1024 },
    { name: "voice/b2/r2.mp4", size: 2048 },
    { name: "other/x.txt", size: 64 },
  ])
  const list = await s.listFiles("voice/")
  assert.equal(list.length, 2)
  const meta = await s.getMetadata("voice/b1/r1.mp4")
  assert.equal(meta.size, 1024)
})

test("runSpotCheck: ok when all sampled files have positive size", async () => {
  const s = createMockStorageAdapter([
    { name: "voice/b1/r1.mp4", size: 1024 },
    { name: "voice/b2/r2.mp4", size: 2048 },
    { name: "voice/b3/r3.mp4", size: 4096 },
  ])
  const result = await runSpotCheck({ storage: s, count: 3, rng: () => 0 })
  assert.equal(result.ok, true)
  assert.equal(result.samples.length, 3)
  assert.equal(result.failures.length, 0)
})

test("runSpotCheck: fails when a sampled file has zero size", async () => {
  const s = createMockStorageAdapter([
    { name: "voice/b1/r1.mp4", size: 0 },
    { name: "voice/b2/r2.mp4", size: 2048 },
    { name: "voice/b3/r3.mp4", size: 4096 },
  ])
  // RNG that always returns 0 → samples in order; first is zero-size.
  const result = await runSpotCheck({ storage: s, count: 3, rng: () => 0 })
  assert.equal(result.ok, false)
  assert.equal(result.failures.length, 1)
  assert.equal(result.failures[0].reason, "zero_size")
})

test("runSpotCheck: no_files reason when bucket prefix empty", async () => {
  const s = createMockStorageAdapter([])
  const result = await runSpotCheck({ storage: s, count: 3 })
  assert.equal(result.ok, false)
  assert.equal(result.reason, "no_files")
})

test("runSpotCheck: getMetadata throw → recorded as failure (not exception)", async () => {
  const s = createMockStorageAdapter([{ name: "voice/b1/r1.mp4", size: 1024 }])
  const broken = {
    ...s,
    async getMetadata() {
      throw new Error("permission denied")
    },
  }
  const result = await runSpotCheck({ storage: broken, count: 1, rng: () => 0 })
  assert.equal(result.ok, false)
  assert.equal(result.failures[0].reason, "permission denied")
})
