/**
 * Phase 36 T3 — injector orchestrator integration tests.
 *
 * Verifies end-to-end pipeline behavior:
 *   1. 3-arm probability (1000 samples each, fixed seed) — within ±3pp
 *   2. Type priority — when all 4 types eligible, self_correct wins
 *   3. Anti-stutter — prev turn opens with marker → applied rate < 5%
 *   4. Anti-blacklist runtime — 100 produced injections contain ZERO
 *      FILLER_BLACKLIST_* phrases (defense in depth beyond unit tests)
 *   5. Lang routing — English-only product always uses POLICIES_EN
 *   6. Latency — p95 < 5ms over 1000 invocations
 *   7. Empty text → never injected
 *   8. Off arm → never injected
 *   9. detectLang — bilingual sanity
 *   10. Position invariant — every applied injection has marker at index 0
 */
import { describe, test, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { detectLang, injectImperfection } from "./injector.js"
import { POLICIES_EN } from "./policies-en.js"
import type { Policy } from "./types.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const VOICE_AXES_PATH = resolve(
  __dirname,
  "../../../../../tests/scenarios/lib/voice-axes.mjs"
)

/**
 * Mulberry32 PRNG. Deterministic across runtimes given a seed. Used to
 * make probability tests reproducible.
 */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe("Phase 36 T3 — injector orchestrator", () => {
  beforeEach(() => {
    delete process.env.PA_IMPERFECTION_ARM
    delete process.env.PA_IMPERFECTION_ARM_OFF
  })
  afterEach(() => {
    delete process.env.PA_IMPERFECTION_ARM
    delete process.env.PA_IMPERFECTION_ARM_OFF
  })

  describe("detectLang", () => {
    test("en majority → en", () => {
      assert.equal(detectLang("rest tonight"), "en")
      assert.equal(detectLang("interview was brutal"), "en")
    })
    test("ascii-letter code-switch → en", () => {
      // ASCII-letter heavy text — algorithm matches Phase 35
      // (cjk vs ascii letter count). Documented behavior.
      assert.equal(detectLang("use React for the dashboard"), "en")
    })
    test("empty → en (default)", () => {
      assert.equal(detectLang(""), "en")
    })
  })

  describe("Arm gating", () => {
    test("arm=off → never applied", () => {
      for (let i = 0; i < 100; i++) {
        const r = injectImperfection({
          text: "rest tonight",
          arm: "off",
          rng: () => Math.random(),
        })
        assert.equal(r.applied, false)
        assert.equal(r.injection_type, null)
        assert.equal(r.position, "none")
        assert.equal(r.injected, "rest tonight")
      }
    })

    test("empty text → never applied even on high arm", () => {
      const r = injectImperfection({ text: "", arm: "high", rng: () => 0 })
      assert.equal(r.applied, false)
      assert.equal(r.reason, "empty_text")
    })

    test("missing userId AND missing arm → defaults to off", () => {
      const r = injectImperfection({ text: "hello", rng: () => 0 })
      assert.equal(r.arm, "off")
      assert.equal(r.applied, false)
    })

    test("userId provided → arm resolved via sticky bucket", () => {
      const r = injectImperfection({
        text: "rest tonight",
        userId: "+15551234567",
        rng: () => 0,
      })
      // Whatever arm got resolved, must be one of the 3.
      assert.ok(["off", "low", "high"].includes(r.arm))
    })
  })

  describe("3-arm probability sanity (N=1000, fixed seed)", () => {
    test("arm=off → 0% applied", () => {
      const rng = mulberry32(42)
      let applied = 0
      for (let i = 0; i < 1000; i++) {
        const r = injectImperfection({ text: "rest tonight", arm: "off", rng })
        if (r.applied) applied += 1
      }
      assert.equal(applied, 0, `expected 0, got ${applied}`)
    })

    test("arm=low → 15% ± 3pp", () => {
      const rng = mulberry32(42)
      let applied = 0
      for (let i = 0; i < 1000; i++) {
        const r = injectImperfection({ text: "rest tonight", arm: "low", rng })
        if (r.applied) applied += 1
      }
      const pct = (applied / 1000) * 100
      assert.ok(
        Math.abs(pct - 15) <= 3,
        `arm=low applied pct ${pct.toFixed(2)}% outside [12, 18]`
      )
    })

    test("arm=high → 30% ± 3pp", () => {
      const rng = mulberry32(123)
      let applied = 0
      for (let i = 0; i < 1000; i++) {
        const r = injectImperfection({ text: "rest tonight", arm: "high", rng })
        if (r.applied) applied += 1
      }
      const pct = (applied / 1000) * 100
      assert.ok(
        Math.abs(pct - 30) <= 3,
        `arm=high applied pct ${pct.toFixed(2)}% outside [27, 33]`
      )
    })
  })

  describe("Type priority — self_correct > hesitate > clarify > uncertainty", () => {
    test("seeded RNG forcing all-pass → applied policy is highest priority type", () => {
      // RNG that always returns 0 → probability draw passes (0 < 0.30) AND
      // weighted policy selection picks first (0 < first weight). Type
      // priority order means injector commits to the FIRST type bucket
      // (self_correct), and weighted draw within picks the first marker.
      // Product is English-only: every turn routes through POLICIES_EN.
      const rng = () => 0
      const r = injectImperfection({
        text: "rest tonight",
        arm: "high",
        rng,
        lang: "en",
      })
      assert.equal(r.applied, true)
      assert.equal(r.injection_type, "self_correct")
      // First self_correct marker in POLICIES_EN:
      const firstSelfCorrect = POLICIES_EN.find((p: Policy) => p.type === "self_correct")
      assert.ok(firstSelfCorrect)
      assert.ok(r.injected.startsWith(firstSelfCorrect.marker))
    })

    test("when prob draw barely passes → first type wins (self_correct)", () => {
      const r = injectImperfection({
        text: "rest tonight",
        arm: "high",
        rng: () => 0,
        lang: "en",
      })
      assert.equal(r.applied, true)
      assert.equal(r.injection_type, "self_correct")
    })
  })

  describe("Anti-stutter — prev turn opens with marker", () => {
    test("prev reply starts with our marker → current applied rate < 5%", () => {
      const rng = mulberry32(99)
      let applied = 0
      const N = 200
      for (let i = 0; i < N; i++) {
        const r = injectImperfection({
          text: "think it over again.",
          arm: "high",
          prevAssistantReply: `${POLICIES_EN[0].marker}rest tonight.`,
          rng,
        })
        if (r.applied) applied += 1
      }
      const pct = (applied / N) * 100
      assert.ok(pct < 5, `expected applied < 5%, got ${pct.toFixed(2)}%`)
    })

    test("prev reply NOT starting with marker → applied rate ≈ 30% on high", () => {
      const rng = mulberry32(77)
      let applied = 0
      const N = 1000
      for (let i = 0; i < N; i++) {
        const r = injectImperfection({
          text: "rest tonight",
          arm: "high",
          prevAssistantReply: "previous turn no marker here.",
          rng,
        })
        if (r.applied) applied += 1
      }
      const pct = (applied / N) * 100
      assert.ok(
        Math.abs(pct - 30) <= 4,
        `expected ~30%, got ${pct.toFixed(2)}%`
      )
    })
  })

  describe("ANTI-BLACKLIST runtime — defense in depth", () => {
    test("100 produced injections contain no FILLER_BLACKLIST_{ZH,EN} phrase", async () => {
      const { FILLER_BLACKLIST_ZH, FILLER_BLACKLIST_EN } = (await import(
        `file://${VOICE_AXES_PATH}`
      )) as { FILLER_BLACKLIST_ZH: string[]; FILLER_BLACKLIST_EN: string[] }

      const inputs = [
        "sleep early tonight.",
        "rest tonight.",
        "use React for the dashboard.",
        "interview was brutal today.",
        "i dont know what to do.",
        "this is rough.",
      ]
      const rng = mulberry32(42)
      const collected: string[] = []
      for (let i = 0; i < 100; i++) {
        const r = injectImperfection({
          text: inputs[i % inputs.length],
          arm: "high",
          rng,
        })
        if (r.applied) collected.push(r.injected)
      }
      assert.ok(collected.length > 0, "no injections collected — RNG broken?")
      for (const out of collected) {
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
  })

  describe("Lang routing (English-only)", () => {
    test("any text → POLICIES_EN marker (product is English-only)", () => {
      const rng = () => 0 // forces apply + first policy
      const r = injectImperfection({
        text: "rest tonight.",
        arm: "high",
        rng,
      })
      assert.equal(r.applied, true)
      const enMarkers = POLICIES_EN.map((p: Policy) => p.marker)
      const usedMarker = enMarkers.find((m) => r.injected.startsWith(m))
      assert.ok(usedMarker, `injected "${r.injected}" should use an EN marker`)
    })

    test("en-majority text → POLICIES_EN marker", () => {
      const rng = () => 0
      const r = injectImperfection({
        text: "interview was brutal.",
        arm: "high",
        rng,
      })
      assert.equal(r.applied, true)
      const enMarkers = POLICIES_EN.map((p: Policy) => p.marker)
      const usedMarker = enMarkers.find((m) => r.injected.startsWith(m))
      assert.ok(usedMarker, `injected "${r.injected}" should use an EN marker`)
    })

    test("explicit lang override still routes through POLICIES_EN", () => {
      const rng = () => 0
      const r = injectImperfection({
        text: "rest tonight.",
        arm: "high",
        lang: "zh", // lang field is accepted but no longer changes the bank
        rng,
      })
      assert.equal(r.applied, true)
      const enMarkers = POLICIES_EN.map((p: Policy) => p.marker)
      const usedMarker = enMarkers.find((m) => r.injected.startsWith(m))
      assert.ok(usedMarker, `injected "${r.injected}" should use an EN marker`)
    })
  })

  describe("Position invariant — marker always at index 0 when applied", () => {
    test("100 applied injections all have marker at start", () => {
      const rng = mulberry32(42)
      const inputs = ["sleep early tonight.", "rest tonight.", "interview was tough."]
      const allMarkers = POLICIES_EN.map((p: Policy) => p.marker)
      let collected = 0
      for (let i = 0; i < 500 && collected < 100; i++) {
        const r = injectImperfection({
          text: inputs[i % inputs.length],
          arm: "high",
          rng,
        })
        if (r.applied) {
          collected += 1
          assert.equal(r.position, "turn_onset")
          const matchesMarker = allMarkers.some((m) => r.injected.startsWith(m))
          assert.ok(
            matchesMarker,
            `injected "${r.injected}" doesn't start with any policy marker`
          )
        }
      }
      assert.ok(collected >= 50, `only collected ${collected} samples`)
    })
  })

  describe("Latency — < 5ms p95 over 1000 invocations", () => {
    test("p95 well within budget", () => {
      const rng = mulberry32(1)
      const samples: number[] = []
      const inputs = [
        "sleep early tonight.",
        "rest tonight.",
        "use React for the dashboard.",
      ]
      for (let i = 0; i < 1000; i++) {
        const r = injectImperfection({
          text: inputs[i % inputs.length],
          arm: "high",
          rng,
          prevAssistantReply: i % 7 === 0 ? `${POLICIES_EN[0].marker}something prev` : undefined,
        })
        samples.push(r.latencyMs)
      }
      samples.sort((a, b) => a - b)
      const p95 = samples[Math.floor(samples.length * 0.95)]
      assert.ok(p95 < 5, `p95 latency ${p95.toFixed(3)}ms exceeds 5ms budget`)
    })
  })

  describe("InjectorResult schema completeness", () => {
    test("all fields populated when applied", () => {
      const r = injectImperfection({
        text: "rest tonight",
        arm: "high",
        rng: () => 0,
      })
      assert.equal(r.applied, true)
      assert.ok(typeof r.arm === "string")
      assert.ok(typeof r.original === "string")
      assert.ok(typeof r.injected === "string")
      assert.ok(typeof r.injection_type === "string")
      assert.equal(r.position, "turn_onset")
      assert.ok(typeof r.reason === "string")
      assert.ok(typeof r.latencyMs === "number")
      assert.ok(r.latencyMs >= 0)
    })

    test("all fields populated when NOT applied", () => {
      const r = injectImperfection({
        text: "rest tonight",
        arm: "off",
      })
      assert.equal(r.applied, false)
      assert.equal(r.injection_type, null)
      assert.equal(r.position, "none")
      assert.equal(r.injected, r.original)
    })
  })
})
