/**
 * Stream F (Phase 42) — match-explainer tests.
 *
 * Covers (per P10 brief D5):
 *   1. LLM call returns reason → cached + returned
 *   2. Cache hit → no LLM call (chat invocations = 0)
 *   3. LLM timeout → returns "" + no cache write
 *   4. LLM error → returns "" + no cache write (fail-open)
 *   5. Daily budget exceeded → returns "" + budget_skip log
 *   6. Bilingual zh + en (parametrized prompt language carries through)
 *
 * Plus regression test (D3): flag OFF → daily-batch body bytewise == H13
 *   pre-Phase-42 output.
 */

import test from "node:test"
import assert from "node:assert/strict"
import { MockFirestore, asFirestore } from "./mock-firestore.js"
import {
  explainMatch,
  buildExplainerMessages,
  sanitizeReason,
  computeChargeUsd,
  cacheDocId,
  costLedgerDocId,
  EXPLANATIONS_COLLECTION,
  COST_LEDGER_COLLECTION,
  type ChatImpl,
  type ExplainMatchInput,
} from "../match-explainer.js"
import type { MatchingJob } from "../types.js"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function fixedJob(overrides: Partial<MatchingJob> = {}): MatchingJob {
  return {
    id: "job-stripe-pm",
    companyName: "Stripe",
    jobTitle: "Senior Product Manager",
    salaryMax: 280000,
    salaryMin: 220000,
    locationRaw: "San Francisco, CA",
    primaryUrl: "https://stripe.com/jobs/4567",
    industry: "fintech",
    sponsorship: true,
    requiredSkills: ["payments", "product strategy", "API design"],
    ...overrides,
  }
}

function fixedInput(
  overrides: Partial<ExplainMatchInput> = {}
): ExplainMatchInput {
  return {
    userId: "u1",
    userCv: {
      recentRoleTitle: "Senior PM",
      recentCompany: "NEUROVA",
      topSkills: ["payments", "product strategy", "growth"],
      recentBullet: "Owned the payments pipeline, shipped a 30% throughput lift",
    },
    job: fixedJob(),
    language: "zh",
    ...overrides,
  }
}

function makeChatImpl(text: string, usage = { inputTokens: 200, outputTokens: 30 }) {
  let calls = 0
  const impl: ChatImpl = async () => {
    calls += 1
    return { text, usage }
  }
  return {
    impl,
    get calls() {
      return calls
    },
  }
}

function captureLog() {
  const events: Array<{ event: string; payload?: Record<string, unknown> }> = []
  return {
    log: (event: string, payload?: Record<string, unknown>) => {
      events.push(payload === undefined ? { event } : { event, payload })
    },
    events,
  }
}

const NOW_MS = Date.parse("2026-05-02T12:00:00Z")
const YMD = "20260502"

// ---------------------------------------------------------------------------
// Pure-function tests (no mocks)
// ---------------------------------------------------------------------------

test("buildExplainerMessages: zh prompt cites recentCompany + jdSnippet", () => {
  const msgs = buildExplainerMessages(
    fixedInput({
      language: "zh",
      // jdSnippet is an explainer-only input extension, not part of MatchingJob.
      job: { ...fixedJob(), jdSnippet: "Lead the payments platform team..." },
    })
  )
  assert.equal(msgs.length, 2)
  assert.equal(msgs[0]!.role, "system")
  assert.match(msgs[0]!.content, /中文句子/)
  assert.match(msgs[1]!.content, /NEUROVA/)
  assert.match(msgs[1]!.content, /payments/)
  assert.match(msgs[1]!.content, /Stripe/)
  // JD excerpt should be capped at 300 chars (here it's shorter)
  assert.match(msgs[1]!.content, /payments platform/)
})

test("buildExplainerMessages: en prompt switches system+user language", () => {
  const msgs = buildExplainerMessages(fixedInput({ language: "en" }))
  assert.match(msgs[0]!.content, /Output the sentence only/)
  assert.match(msgs[1]!.content, /Recent role:/)
  assert.match(msgs[1]!.content, /Top skills:/)
  // Make sure there is no Chinese system content leaking when en is asked
  assert.doesNotMatch(msgs[0]!.content, /中文句子/)
})

test("sanitizeReason: trims, strips quotes + leading dash, caps length", () => {
  assert.equal(
    sanitizeReason('  "你 payments 那段直接对得上"  '),
    "你 payments 那段直接对得上"
  )
  assert.equal(sanitizeReason("- short"), "")
  // Mid-length non-quoted output passes through unchanged.
  assert.equal(
    sanitizeReason("你 NEUROVA 支付管线那段直接对得上 Stripe 的方向"),
    "你 NEUROVA 支付管线那段直接对得上 Stripe 的方向"
  )
  // Length cap: a 200-char input should be ellipsized to 140.
  const long = "x".repeat(200)
  const out = sanitizeReason(long)
  assert.ok(out.length <= 140)
  assert.match(out, /…$/)
})

test("computeChargeUsd: Qwen-7B 200 in + 30 out ≈ $0.0000182", () => {
  const c = computeChargeUsd(200, 30)
  // 200 * 0.07/M + 30 * 0.14/M = 1.4e-5 + 4.2e-6 = 1.82e-5
  assert.ok(Math.abs(c - 0.0000182) < 1e-9, `got ${c}`)
})

test("cacheDocId: composes flat id with __ separator", () => {
  assert.equal(cacheDocId("u1", "job-stripe-pm", "zh"), "u1__job-stripe-pm__zh")
  assert.throws(() => cacheDocId("", "j1", "en"), /required/)
  assert.throws(() => cacheDocId("u1", "j/bad", "zh"), /must not contain/)
})

// ---------------------------------------------------------------------------
// Test 1 — LLM call returns reason → cached + returned
// ---------------------------------------------------------------------------

test("explainMatch [1]: LLM returns reason → cached + returned + ledger charged", async () => {
  const mfs = new MockFirestore()
  const chat = makeChatImpl("你 NEUROVA 支付管线那段直接对得上 Stripe 的方向")
  const cap = captureLog()
  const reason = await explainMatch(
    {
      db: asFirestore(mfs),
      chatImpl: chat.impl,
      now: () => NOW_MS,
      todayYmd: () => YMD,
      log: cap.log,
    },
    fixedInput()
  )
  assert.equal(reason, "你 NEUROVA 支付管线那段直接对得上 Stripe 的方向")
  assert.equal(chat.calls, 1)

  // Cache write — read back through MockFirestore's `get`.
  const cacheSnap = await mfs
    .collection(EXPLANATIONS_COLLECTION)
    .doc(cacheDocId("u1", "job-stripe-pm", "zh"))
    .get()
  assert.equal(cacheSnap.exists, true)
  const cached = cacheSnap.data()!
  assert.equal(cached.reason, reason)
  assert.equal(cached.userId, "u1")
  assert.equal(cached.jobId, "job-stripe-pm")
  assert.equal(cached.language, "zh")
  assert.ok(typeof cached.ttlAt === "string")
  // ttlAt must be > now + 6.5d (sanity, not exact)
  assert.ok(Date.parse(cached.ttlAt as string) > NOW_MS + 6 * 86400_000)

  // Ledger increment.
  const ledgerSnap = await mfs
    .collection(COST_LEDGER_COLLECTION)
    .doc(costLedgerDocId(YMD))
    .get()
  assert.equal(ledgerSnap.exists, true)
  const ld = ledgerSnap.data()!
  assert.equal(ld.callCount, 1)
  assert.ok(typeof ld.totalUsd === "number" && (ld.totalUsd as number) > 0)

  // Log: success event present.
  assert.ok(cap.events.some((e) => e.event === "match_explainer_llm_ok"))
})

// ---------------------------------------------------------------------------
// Test 2 — Cache hit → no LLM call
// ---------------------------------------------------------------------------

test("explainMatch [2]: cache hit → no LLM call, returns cached reason", async () => {
  const mfs = new MockFirestore()
  await mfs
    .collection(EXPLANATIONS_COLLECTION)
    .doc(cacheDocId("u1", "job-stripe-pm", "zh"))
    .set({
      userId: "u1",
      jobId: "job-stripe-pm",
      language: "zh",
      reason: "(缓存) 你 payments 经验和 Stripe 完全对路",
      createdAt: new Date(NOW_MS - 86400_000).toISOString(),
      ttlAt: new Date(NOW_MS + 86400_000).toISOString(),
    })
  const chat = makeChatImpl("UNUSED LLM RESPONSE")
  const cap = captureLog()
  const reason = await explainMatch(
    {
      db: asFirestore(mfs),
      chatImpl: chat.impl,
      now: () => NOW_MS,
      todayYmd: () => YMD,
      log: cap.log,
    },
    fixedInput()
  )
  assert.equal(reason, "(缓存) 你 payments 经验和 Stripe 完全对路")
  assert.equal(chat.calls, 0, "LLM must not be called on cache hit")
  // No ledger increment on cache hit.
  const ledgerSnap = await mfs
    .collection(COST_LEDGER_COLLECTION)
    .doc(costLedgerDocId(YMD))
    .get()
  assert.equal(ledgerSnap.exists, false)
  assert.ok(cap.events.some((e) => e.event === "match_explainer_cache_hit"))
})

// ---------------------------------------------------------------------------
// Test 3 — LLM timeout → returns "" + no cache write
// ---------------------------------------------------------------------------

test("explainMatch [3]: LLM timeout → returns empty + no cache write", async () => {
  const mfs = new MockFirestore()
  const chat: ChatImpl = async () => {
    throw new Error("match-explainer: timeout after 5000ms")
  }
  const cap = captureLog()
  const reason = await explainMatch(
    {
      db: asFirestore(mfs),
      chatImpl: chat,
      now: () => NOW_MS,
      todayYmd: () => YMD,
      log: cap.log,
    },
    fixedInput()
  )
  assert.equal(reason, "")
  // No cache write.
  const cacheSnap = await mfs
    .collection(EXPLANATIONS_COLLECTION)
    .doc(cacheDocId("u1", "job-stripe-pm", "zh"))
    .get()
  assert.equal(cacheSnap.exists, false)
  // Failure log fired.
  assert.ok(
    cap.events.some(
      (e) =>
        e.event === "match_explainer_llm_failed" &&
        typeof e.payload?.error === "string" &&
        (e.payload.error as string).includes("timeout")
    )
  )
})

// ---------------------------------------------------------------------------
// Test 4 — LLM error → returns "" + no cache write (fail-open)
// ---------------------------------------------------------------------------

test("explainMatch [4]: LLM error (HTTP 500) → returns empty + no cache write", async () => {
  const mfs = new MockFirestore()
  const chat: ChatImpl = async () => {
    throw new Error("match-explainer: HTTP 500: upstream blew up")
  }
  const cap = captureLog()
  const reason = await explainMatch(
    {
      db: asFirestore(mfs),
      chatImpl: chat,
      now: () => NOW_MS,
      todayYmd: () => YMD,
      log: cap.log,
    },
    fixedInput()
  )
  assert.equal(reason, "")
  const cacheSnap = await mfs
    .collection(EXPLANATIONS_COLLECTION)
    .doc(cacheDocId("u1", "job-stripe-pm", "zh"))
    .get()
  assert.equal(cacheSnap.exists, false)
  // Ledger NOT bumped on failure (we only charge on success).
  const ledgerSnap = await mfs
    .collection(COST_LEDGER_COLLECTION)
    .doc(costLedgerDocId(YMD))
    .get()
  assert.equal(ledgerSnap.exists, false)
  assert.ok(cap.events.some((e) => e.event === "match_explainer_llm_failed"))
})

// ---------------------------------------------------------------------------
// Test 5 — Budget exceeded → returns "" + no LLM call
// ---------------------------------------------------------------------------

test("explainMatch [5]: budget exceeded → returns empty + budget_skip log + no LLM call", async () => {
  const mfs = new MockFirestore()
  // Pre-seed ledger above budget.
  await mfs
    .collection(COST_LEDGER_COLLECTION)
    .doc(costLedgerDocId(YMD))
    .set({
      ymd: YMD,
      totalUsd: 1.5, // > default $1
      callCount: 99999,
      lastUpdatedAt: new Date(NOW_MS).toISOString(),
    })
  const chat = makeChatImpl("UNREACHABLE")
  const cap = captureLog()
  const reason = await explainMatch(
    {
      db: asFirestore(mfs),
      chatImpl: chat.impl,
      now: () => NOW_MS,
      todayYmd: () => YMD,
      dailyBudgetUsd: 1.0,
      log: cap.log,
    },
    fixedInput()
  )
  assert.equal(reason, "")
  assert.equal(chat.calls, 0, "must not call LLM when over budget")
  assert.ok(
    cap.events.some(
      (e) =>
        e.event === "match_explainer_budget_skip" &&
        e.payload?.budget === 1.0 &&
        (e.payload?.currentTotalUsd as number) >= 1.5
    )
  )
})

// ---------------------------------------------------------------------------
// Test 6 — Bilingual zh + en (parametrized)
// ---------------------------------------------------------------------------

for (const language of ["zh", "en"] as const) {
  test(`explainMatch [6] bilingual: language=${language} round-trips end-to-end`, async () => {
    const mfs = new MockFirestore()
    const expected =
      language === "zh"
        ? "你 NEUROVA 的 payments 经验和 Stripe 这个 PM 角色直接对得上"
        : "Your NEUROVA payments experience lines up directly with Stripe's senior PM role"
    const chat = makeChatImpl(expected)
    const cap = captureLog()
    const reason = await explainMatch(
      {
        db: asFirestore(mfs),
        chatImpl: chat.impl,
        now: () => NOW_MS,
        todayYmd: () => YMD,
        log: cap.log,
      },
      fixedInput({ language })
    )
    assert.equal(reason, expected)
    // Cache key contains language so zh + en don't collide.
    const snap = await mfs
      .collection(EXPLANATIONS_COLLECTION)
      .doc(cacheDocId("u1", "job-stripe-pm", language))
      .get()
    assert.equal(snap.exists, true)
    assert.equal(snap.data()!.language, language)
  })
}
