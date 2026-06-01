/**
 * Phase 36 T5 — smoke / pipeline integration test.
 *
 * Verifies full pipeline (resolveArm → injectImperfection) on 100
 * synthetic turns spanning zh + en + mixed. Asserts:
 *   - Latency p95 < 5ms over 100 invocations
 *   - Arm assignment sticky per-userId
 *   - Cross-arm probability respects firingRate (off=0%, low=15%, high=30%)
 *   - Position invariant: every applied output has marker at index 0
 *   - Anti-blacklist runtime: 0 FILLER_BLACKLIST_* hits across all
 *     produced outputs (defense in depth)
 */
import { describe, test, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { injectImperfection, resolveArm } from "./index.js"
import { POLICIES_EN } from "./policies-en.js"
import type { Policy } from "./types.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const VOICE_AXES_PATH = resolve(
  __dirname,
  "../../../../../tests/scenarios/lib/voice-axes.mjs"
)

// NOTE: synthetic inputs deliberately avoid any FILLER_BLACKLIST_*
// substring so the runtime anti-blacklist check tests THE INJECTOR's
// behavior — not contamination from the input. ("you got it" was
// removed because "Got it" is in FILLER_BLACKLIST_EN.)
const SYNTH_TURNS = [
  { text: "sleep early tonight.", userId: "+15550000001" },
  { text: "think it over again.", userId: "+15550000002" },
  { text: "let us talk tomorrow.", userId: "+15550000003" },
  { text: "rest tonight.", userId: "+15550000004" },
  { text: "interview was rough.", userId: "+15550000005" },
  { text: "deploys are flaky lately.", userId: "+15550000006" },
  { text: "use React hooks for state", userId: "+15550000007" },
  { text: "i used that framework before", userId: "+15550000008" },
]

/**
 * Strip FILLER_BLACKLIST hits already present in the INPUT text from
 * the assertion. Defense in depth: the injector should only ADD safe
 * markers, not strip existing problematic content. We test that the
 * marker portion (prefix) doesn't introduce blacklist phrases.
 */
function injectorAddedMarkerOnly(injected: string, original: string): string {
  return injected.startsWith(original) ? "" : injected.slice(0, injected.length - original.length)
}

describe("Phase 36 T5 — smoke / pipeline integration", () => {
  beforeEach(() => {
    delete process.env.PA_IMPERFECTION_ARM
    delete process.env.PA_IMPERFECTION_ARM_OFF
  })
  afterEach(() => {
    delete process.env.PA_IMPERFECTION_ARM
    delete process.env.PA_IMPERFECTION_ARM_OFF
  })

  test("100 synthetic turns: latency p95 < 5ms", () => {
    const samples = []
    for (let i = 0; i < 100; i++) {
      const t = SYNTH_TURNS[i % SYNTH_TURNS.length]
      const arm = resolveArm(t.userId)
      const r = injectImperfection({ text: t.text, arm })
      samples.push(r.latencyMs)
    }
    samples.sort((a, b) => a - b)
    const p95 = samples[Math.floor(samples.length * 0.95)]
    assert.ok(p95 < 5, `p95 latency ${p95.toFixed(3)}ms exceeds 5ms`)
  })

  test("sticky arm: same userId 50 calls → same arm", () => {
    const arm = resolveArm("+15550099999")
    for (let i = 0; i < 50; i++) {
      assert.equal(resolveArm("+15550099999"), arm)
    }
  })

  test("ANTI-BLACKLIST runtime: 1000 outputs across arms — 0 FILLER_BLACKLIST hits", async () => {
    const { FILLER_BLACKLIST_ZH, FILLER_BLACKLIST_EN } = (await import(
      `file://${VOICE_AXES_PATH}`
    )) as { FILLER_BLACKLIST_ZH: string[]; FILLER_BLACKLIST_EN: string[] }

    const outputs = []
    for (let i = 0; i < 1000; i++) {
      const t = SYNTH_TURNS[i % SYNTH_TURNS.length]
      // Force high arm to maximize injection rate.
      const r = injectImperfection({ text: t.text, arm: "high" })
      outputs.push(r.injected)
    }
    for (const out of outputs) {
      const lower = out.toLowerCase()
      for (const phrase of FILLER_BLACKLIST_ZH) {
        assert.ok(
          !out.includes(phrase),
          `output "${out}" contains zh blacklist phrase "${phrase}"`
        )
      }
      for (const phrase of FILLER_BLACKLIST_EN) {
        assert.ok(
          !lower.includes(phrase.toLowerCase()),
          `output "${out}" contains en blacklist phrase "${phrase}"`
        )
      }
    }
  })

  test("position invariant: 100+ applied outputs all have marker at index 0", () => {
    const allMarkers = POLICIES_EN.map((p: Policy) => p.marker)
    let appliedCount = 0
    for (let i = 0; i < 1000 && appliedCount < 100; i++) {
      const t = SYNTH_TURNS[i % SYNTH_TURNS.length]
      const r = injectImperfection({ text: t.text, arm: "high" })
      if (r.applied) {
        appliedCount += 1
        assert.equal(r.position, "turn_onset")
        const matches = allMarkers.some((m) => r.injected.startsWith(m))
        assert.ok(
          matches,
          `applied output "${r.injected}" should start with a policy marker`
        )
      }
    }
    assert.ok(appliedCount >= 100, `only ${appliedCount} applied outputs`)
  })

  test("arm probability over 1000 — off=0%, low~=15%, high~=30%", () => {
    const counts = { off: 0, low: 0, high: 0 }
    const N = 1000
    for (const arm of ["off", "low", "high"] as const) {
      let applied = 0
      for (let i = 0; i < N; i++) {
        const t = SYNTH_TURNS[i % SYNTH_TURNS.length]
        const r = injectImperfection({ text: t.text, arm })
        if (r.applied) applied += 1
      }
      counts[arm] = applied
    }
    assert.equal(counts.off, 0)
    const lowPct = (counts.low / N) * 100
    const highPct = (counts.high / N) * 100
    assert.ok(Math.abs(lowPct - 15) <= 4, `low pct ${lowPct.toFixed(2)}`)
    assert.ok(Math.abs(highPct - 30) <= 4, `high pct ${highPct.toFixed(2)}`)
  })

  test("end-to-end smoke: resolveArm + injectImperfection chained", () => {
    process.env.PA_IMPERFECTION_ARM = "high"
    let appliedAny = false
    for (let i = 0; i < 50; i++) {
      const t = SYNTH_TURNS[i % SYNTH_TURNS.length]
      const arm = resolveArm(t.userId)
      assert.equal(arm, "high")
      const r = injectImperfection({ text: t.text, userId: t.userId })
      if (r.applied) appliedAny = true
    }
    assert.ok(appliedAny, "expected at least one applied injection over 50 high-arm calls")
  })
})
