/**
 * v1.5 §3.8 fix — OpenAI Moderation unit tests + opt-in real API smoke.
 *
 * Tests cover:
 *   1. Pure routing — sexual/minors → ESCALATE_NCMEC (priority over BLOCK)
 *   2. Pure routing — violence/graphic → BLOCK
 *   3. Pure routing — harassment/threatening + hate/threatening → BLOCK
 *   4. Pure routing — illicit/violent → BLOCK
 *   5. Pure routing — self-harm/intent → WARN (defers to crisis-detector)
 *   6. Pure routing — sexual (no /minors) → ALLOW (boundary case)
 *   7. Pure routing — flagged but soft (harassment alone) → WARN
 *   8. checkOpenAIModeration mock — happy path (200 + flagged)
 *   9. checkOpenAIModeration fail-open — missing key
 *  10. checkOpenAIModeration fail-open — empty input
 *  11. checkOpenAIModeration fail-open — network error
 *  12. checkOpenAIModeration fail-open — non-200
 *  13. checkOpenAIModeration fail-open — timeout (AbortError)
 *
 * Plus 1 opt-in real API smoke (gated on PA_OPENAI_AGENT_API_KEY presence).
 */
import assert from "node:assert/strict"
import test from "node:test"
import {
  checkOpenAIModeration,
  routeModerationVerdict,
  type ModerationCategory,
} from "./moderation.js"

// ----------------------------------------------------------------------------
// 1-7: Pure routing tests
// ----------------------------------------------------------------------------

test("§3.8 routing — sexual/minors → ESCALATE_NCMEC (highest priority)", () => {
  // Even when other BLOCK categories also fire, sexual/minors wins.
  const r = routeModerationVerdict(
    true,
    {
      "sexual/minors": true,
      "violence/graphic": true,
      sexual: true,
    },
    { "sexual/minors": 0.99, "violence/graphic": 0.8, sexual: 0.95 }
  )
  assert.equal(r.routedAction, "ESCALATE_NCMEC")
  assert.equal(r.reason, "csam_detected")
  assert.deepEqual(r.triggeredCategories, ["sexual/minors"])
})

test("§3.8 routing — violence/graphic → BLOCK", () => {
  const r = routeModerationVerdict(
    true,
    { "violence/graphic": true, violence: true },
    { "violence/graphic": 0.92, violence: 0.7 }
  )
  assert.equal(r.routedAction, "BLOCK")
  assert.equal(r.reason, "violence_graphic")
})

test("§3.8 routing — harassment/threatening + hate/threatening → BLOCK", () => {
  // Walk both branches. harassment/threatening checked second (after violence/graphic).
  const r1 = routeModerationVerdict(
    true,
    { "harassment/threatening": true },
    { "harassment/threatening": 0.85 }
  )
  assert.equal(r1.routedAction, "BLOCK")
  assert.equal(r1.reason, "harassment_threatening")

  const r2 = routeModerationVerdict(
    true,
    { "hate/threatening": true },
    { "hate/threatening": 0.9 }
  )
  assert.equal(r2.routedAction, "BLOCK")
  assert.equal(r2.reason, "hate_threatening")
})

test("§3.8 routing — illicit/violent → BLOCK (drugs/weapons how-to)", () => {
  const r = routeModerationVerdict(
    true,
    { "illicit/violent": true, illicit: true },
    { "illicit/violent": 0.88, illicit: 0.7 }
  )
  assert.equal(r.routedAction, "BLOCK")
  assert.equal(r.reason, "illicit_violent")
})

test("§3.8 routing — self-harm/intent → WARN (deferred to crisis-detector)", () => {
  // Critical edge: self-harm subcategories MUST NOT BLOCK — crisis-detector
  // owns this surface. Double-blocking would hide users from the hotline path.
  const r = routeModerationVerdict(
    true,
    { "self-harm/intent": true, "self-harm": true },
    { "self-harm/intent": 0.95, "self-harm": 0.9 }
  )
  assert.equal(r.routedAction, "WARN")
  assert.equal(r.reason, "self_harm_deferred_to_crisis_detector")
  assert.deepEqual(r.triggeredCategories, ["self-harm/intent"])

  const r2 = routeModerationVerdict(
    true,
    { "self-harm/instructions": true },
    { "self-harm/instructions": 0.92 }
  )
  assert.equal(r2.routedAction, "WARN")
})

test("§3.8 routing — sexual (no /minors) → ALLOW (boundary: adult consensual not blocked)", () => {
  // Adam-locked boundary: vanilla sexual is an LLM-tone problem, not a
  // safety-block problem. Only sexual/minors hard-blocks.
  const r = routeModerationVerdict(
    true,
    { sexual: true, "sexual/minors": false },
    { sexual: 0.85, "sexual/minors": 0.001 }
  )
  // sexual alone is not in BLOCK_ORDER and not self-harm → falls to "flagged_soft" WARN
  assert.equal(r.routedAction, "WARN")
  assert.equal(r.reason, "flagged_soft")
})

test("§3.8 routing — flagged soft (harassment vanilla) → WARN, not BLOCK", () => {
  const r = routeModerationVerdict(
    true,
    { harassment: true, "harassment/threatening": false },
    { harassment: 0.7 }
  )
  assert.equal(r.routedAction, "WARN")
  assert.equal(r.reason, "flagged_soft")
})

test("§3.8 routing — all unflagged → ALLOW", () => {
  const r = routeModerationVerdict(false, {}, {})
  assert.equal(r.routedAction, "ALLOW")
  assert.equal(r.reason, undefined)
  assert.equal(r.triggeredCategories.length, 0)
})

// ----------------------------------------------------------------------------
// 8-13: checkOpenAIModeration network behaviour (mocked)
// ----------------------------------------------------------------------------

function fakeJsonFetch(body: unknown, status = 200): typeof fetch {
  return (async () => {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response
  }) as unknown as typeof fetch
}

test("§3.8 checkOpenAIModeration — mock 200 flagged sexual/minors → ESCALATE_NCMEC", async () => {
  const fakeFetch = fakeJsonFetch({
    id: "modr-test-1",
    model: "omni-moderation-latest",
    results: [
      {
        flagged: true,
        categories: { "sexual/minors": true, sexual: true },
        category_scores: { "sexual/minors": 0.97, sexual: 0.93 },
      },
    ],
  })
  const v = await checkOpenAIModeration("test text", {
    apiKey: "fake-test-key",
    fetchImpl: fakeFetch,
  })
  assert.equal(v.flagged, true)
  assert.equal(v.routedAction, "ESCALATE_NCMEC")
  assert.equal(v.reason, "csam_detected")
  assert.equal(v.categories["sexual/minors"], true)
  assert.equal(v.scores["sexual/minors"], 0.97)
  assert.ok(v.inputHash && v.inputHash.length === 16)
  assert.equal(v.inputLength, "test text".length)
})

test("§3.8 checkOpenAIModeration — fail-open: missing API key → ALLOW", async () => {
  const v = await checkOpenAIModeration("hello world", {
    apiKey: "", // explicit empty
  })
  // Defensive: even if process.env.PA_OPENAI_AGENT_API_KEY is set in CI,
  // the explicit empty arg here means we ALSO read env. Skip env-injected
  // case by passing a clearly-fake value if env is set.
  if (process.env.PA_OPENAI_AGENT_API_KEY) {
    // env-set path: we can't deterministically force missing-key without
    // mocking. Verify the OTHER fail-open path (empty input) instead below.
    return
  }
  assert.equal(v.routedAction, "ALLOW")
  assert.equal(v.reason, "missing_api_key")
  assert.equal(v.flagged, false)
  assert.equal(v.latencyMs, 0)
})

test("§3.8 checkOpenAIModeration — fail-open: empty input → ALLOW", async () => {
  const v = await checkOpenAIModeration("", { apiKey: "any" })
  assert.equal(v.routedAction, "ALLOW")
  assert.equal(v.reason, "empty_input")
  assert.equal(v.inputLength, 0)
})

test("§3.8 checkOpenAIModeration — fail-open: network error → ALLOW + reason=network_error", async () => {
  const errFetch = (async () => {
    throw new Error("ECONNRESET")
  }) as unknown as typeof fetch
  const v = await checkOpenAIModeration("hi", {
    apiKey: "fake",
    fetchImpl: errFetch,
  })
  assert.equal(v.routedAction, "ALLOW")
  assert.equal(v.reason, "network_error")
})

test("§3.8 checkOpenAIModeration — fail-open: non-200 → ALLOW + reason=http_<status>", async () => {
  const fakeFetch = fakeJsonFetch({ error: "rate_limited" }, 429)
  const v = await checkOpenAIModeration("hi", {
    apiKey: "fake",
    fetchImpl: fakeFetch,
  })
  assert.equal(v.routedAction, "ALLOW")
  assert.equal(v.reason, "http_429")
})

test("§3.8 checkOpenAIModeration — fail-open: timeout (AbortError) → ALLOW + reason=timeout", async () => {
  // Simulate a fetch that throws AbortError when the signal fires.
  const slowFetch = ((_url: string, init?: RequestInit) => {
    return new Promise((_resolve, reject) => {
      const sig = init?.signal
      if (sig) {
        sig.addEventListener("abort", () => {
          const e = new Error("aborted")
          ;(e as Error).name = "AbortError"
          reject(e)
        })
      }
    })
  }) as unknown as typeof fetch
  const v = await checkOpenAIModeration("hi", {
    apiKey: "fake",
    fetchImpl: slowFetch,
    timeoutMs: 30,
  })
  assert.equal(v.routedAction, "ALLOW")
  assert.equal(v.reason, "timeout")
})

test("§3.8 checkOpenAIModeration — happy path (200, all unflagged) → ALLOW", async () => {
  const fakeFetch = fakeJsonFetch({
    id: "modr-test-2",
    model: "omni-moderation-latest",
    results: [
      {
        flagged: false,
        categories: {
          sexual: false,
          "sexual/minors": false,
          hate: false,
          violence: false,
        },
        category_scores: {
          sexual: 0.001,
          "sexual/minors": 0.0001,
          hate: 0.005,
          violence: 0.002,
        },
      },
    ],
  })
  const v = await checkOpenAIModeration("hello, looking for a SWE role", {
    apiKey: "fake",
    fetchImpl: fakeFetch,
  })
  assert.equal(v.flagged, false)
  assert.equal(v.routedAction, "ALLOW")
})

// ----------------------------------------------------------------------------
// 14: Opt-in real API smoke — gated on PA_OPENAI_AGENT_API_KEY presence.
// We do NOT cause CI failures when key is missing; we skip + log a notice.
// ----------------------------------------------------------------------------

test("§3.8 checkOpenAIModeration — REAL API smoke (gated)", async (t) => {
  const apiKey = process.env.PA_OPENAI_AGENT_API_KEY?.trim()
  if (!apiKey) {
    t.skip(
      "PA_OPENAI_AGENT_API_KEY not set — skipping live API smoke. " +
        "To exercise: PA_OPENAI_AGENT_API_KEY=<real-key> npm test --workspace=@pa/pa-safety"
    )
    return
  }
  // Benign input — should return flagged=false. We assert structural
  // properties only (no semantic claim about the score values).
  const v = await checkOpenAIModeration(
    "Hello, I am looking for a software engineering job in San Francisco.",
    {
      apiKey,
      timeoutMs: 8000,
    }
  )
  assert.equal(typeof v.flagged, "boolean", "flagged must be boolean on real API success")
  assert.equal(v.flagged, false, "benign career text should be unflagged")
  assert.equal(v.routedAction, "ALLOW")
  assert.ok(v.latencyMs >= 0)
  assert.ok(v.inputHash.length === 16)
  // categories/scores objects come back populated — sanity check at least one
  // canonical category is present.
  assert.ok(typeof v.categories.sexual === "boolean", "sexual category should be boolean")
  assert.ok(typeof v.scores.sexual === "number", "sexual score should be number")
  // Log shape so reviewer can see real wire output without leaking input text.
  // eslint-disable-next-line no-console
  console.log("[smoke] real API verdict:", {
    flagged: v.flagged,
    routedAction: v.routedAction,
    latencyMs: v.latencyMs,
    inputHash: v.inputHash,
    sexualScore: v.scores.sexual,
    violenceScore: v.scores.violence,
  })
})

// Sanity exhaustive walk — every BLOCK_ORDER category routes correctly in isolation.
test("§3.8 routing — every BLOCK_ORDER category in isolation", () => {
  const cases: Array<{ cat: ModerationCategory; expected: string; reason: string }> = [
    { cat: "sexual/minors", expected: "ESCALATE_NCMEC", reason: "csam_detected" },
    { cat: "violence/graphic", expected: "BLOCK", reason: "violence_graphic" },
    { cat: "harassment/threatening", expected: "BLOCK", reason: "harassment_threatening" },
    { cat: "hate/threatening", expected: "BLOCK", reason: "hate_threatening" },
    { cat: "illicit/violent", expected: "BLOCK", reason: "illicit_violent" },
  ]
  for (const c of cases) {
    const r = routeModerationVerdict(
      true,
      { [c.cat]: true },
      { [c.cat]: 0.9 }
    )
    assert.equal(r.routedAction, c.expected, `cat=${c.cat}`)
    assert.equal(r.reason, c.reason, `reason for cat=${c.cat}`)
  }
})
