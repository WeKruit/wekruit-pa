/**
 * iter34 Sprint A.6 — tests for runResumeAcceptedFlow.
 *
 * Pins the post-resume sequence:
 *   1. Send interim ack
 *   2. Poll Firestore
 *   3. Send tag-summary (or timeout fallback)
 *   4. applyOnboarding("complete") — only AFTER poll resolves
 *
 * The CV poll mechanics are covered separately in cv-poll.test.ts; here
 * we focus on the orchestration: ordering, lang routing, applyOnboarding
 * timing relative to poll, fallback messages.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { runOnboardingPipelineTurn, runResumeAcceptedFlow } from "./runtime-bridge.js"
import { emptyPipelineState, type PipelineState } from "./pipeline.js"
import type { CvSummaryInput } from "../cv-summary.js"

// ---------- Test harness -----------------------------------------------------

interface EmitRecord {
  text: string
  meta: { qId: string | null; kind: string }
}

interface ApplyOnboardingRecord {
  userId: string
  phoneE164: string
  step: string
  opts?: Record<string, unknown>
  /** order index — used to assert applyOnboarding ran AFTER all emits. */
  emitsAtCallTime: number
}

function makeFakeDb(snapshots: Array<{ docs: unknown[] }>) {
  let getCalls = 0
  const queryShape = {
    where(_field: string, _op: string, _val: unknown) {
      return this
    },
    orderBy(_field: string, _dir: string) {
      return this
    },
    limit(_n: number) {
      return this
    },
    async get() {
      getCalls++
      const idx = Math.min(getCalls - 1, snapshots.length - 1)
      const docs = snapshots[idx]?.docs ?? []
      const snapDocs = docs.map((d) => ({ data: () => d }))
      return { empty: snapDocs.length === 0, docs: snapDocs }
    },
  }
  return {
    db: {
      collection(_name: string) {
        return queryShape
      },
    },
  }
}

function makeClock() {
  let t = 1_000_000
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms
    },
  }
}

const FULL_CV: CvSummaryInput = {
  topSkills: ["TypeScript", "Firestore"],
  experiences: [{ company: "WeKruit", title: "Founder" }],
}

// ---------- Tests ------------------------------------------------------------

describe("runOnboardingPipelineTurn — [cv-parsed] synthetic", () => {
  it("rejects runtime events before the deterministic question pipeline", async () => {
    const calls: string[] = []
    const result = await runOnboardingPipelineTurn({
      event: {
        id: "evt_runtime",
        userId: "u1",
        sessionId: "s1",
        from: "+10000000001",
        body: "[system-event:layoff_onboarding:layoff_onboarding_started]",
        createdAt: "2026-05-18T20:00:00.000Z",
        rawMeta: {
          runtimeEvent: true,
          runtimeEventSource: "layoff_onboarding",
          runtimeEventKind: "layoff_onboarding_started",
        },
      } as never,
      turnId: "turn_runtime",
      agent: {} as never,
      suppressOutbound: false,
      deps: {
        log: (e) => calls.push(e),
        nowIso: () => "2026-05-18T20:00:01.000Z",
        appendMessage: async () => {
          throw new Error("runtime event must not append a pipeline prompt")
        },
        enqueueOutbound: async () => {
          throw new Error("runtime event must not enqueue a pipeline prompt")
        },
        applyOnboarding: async () => {
          throw new Error("runtime event must not advance onboarding")
        },
      },
    })

    assert.equal(result.handled, false)
    assert.deepEqual(calls, ["pa.onboarding.pipeline.reject_runtime_event"])
  })

  it("returns handled:false so dispatcher runs deterministic resume completion", async () => {
    let logged = false
    const result = await runOnboardingPipelineTurn({
      event: {
        id: "evt_cv",
        userId: "u1",
        sessionId: "s1",
        from: "+10000000001",
        body: "[cv-parsed]",
        createdAt: "2026-05-07T20:00:00.000Z",
        rawMeta: { triggerResumeId: "resume-doc-1" },
      } as never,
      turnId: "turn_cv",
      agent: {} as never,
      suppressOutbound: false,
      deps: {
        log: (e) => {
          if (e === "pa.onboarding.pipeline.defer_cv_parsed_to_deterministic") logged = true
        },
        nowIso: () => "2026-05-07T20:00:01.000Z",
        appendMessage: async () => {},
        enqueueOutbound: async () => {},
      },
    })
    assert.equal(result.handled, false)
    assert.equal(logged, true)
  })
})

describe("runResumeAcceptedFlow — happy path (CV available immediately)", () => {
  it("emits ack → emits tag-summary → calls applyOnboarding('complete')", async () => {
    const { db } = makeFakeDb([{ docs: [FULL_CV] }])
    const clock = makeClock()
    const emits: EmitRecord[] = []
    const applies: ApplyOnboardingRecord[] = []

    await runResumeAcceptedFlow({
      userId: "user_a",
      phoneE164: "+15551234",
      getOnboardingUser: async () => ({
        id: "user_a",
        phoneE164: "+15551234",
        statedPreferences: { preferredLang: "zh" },
      }),
      applyOnboarding: async (userId, phoneE164, step, opts) => {
        applies.push({
          userId,
          phoneE164,
          step,
          opts,
          emitsAtCallTime: emits.length,
        })
      },
      emit: async (text, meta) => {
        emits.push({ text, meta })
      },
      db,
      log: () => {},
      cvPollOpts: { intervalMs: 5_000, timeoutMs: 90_000, sleep: clock.sleep, now: clock.now },
    })

    // Two emits: interim ack + tag summary
    assert.equal(emits.length, 2, `expected 2 emits, got ${emits.length}`)
    assert.equal(emits[0]!.meta.kind, "cv_interim_ack")
    assert.equal(emits[1]!.meta.kind, "cv_summary_tag")
    // Tag-summary must reference the CV's actual content (zh path).
    assert.match(emits[1]!.text, /TypeScript/)
    assert.match(emits[1]!.text, /Firestore/)
    assert.match(emits[1]!.text, /Tesla|WeKruit/) // company

    // applyOnboarding ran exactly once, after both emits.
    assert.equal(applies.length, 1)
    assert.equal(applies[0]!.step, "complete")
    assert.equal(
      applies[0]!.emitsAtCallTime,
      2,
      "applyOnboarding must run AFTER both emits — this is the bug fix"
    )
  })

  it("english-pref user → english ack + english tag-summary", async () => {
    const { db } = makeFakeDb([{ docs: [FULL_CV] }])
    const clock = makeClock()
    const emits: EmitRecord[] = []

    await runResumeAcceptedFlow({
      userId: "user_b",
      phoneE164: "+15551234",
      getOnboardingUser: async () => ({
        id: "user_b",
        phoneE164: "+15551234",
        statedPreferences: { preferredLang: "en" },
      }),
      applyOnboarding: async () => {},
      emit: async (text, meta) => {
        emits.push({ text, meta })
      },
      db,
      log: () => {},
      cvPollOpts: { sleep: clock.sleep, now: clock.now },
    })

    assert.equal(emits.length, 2)
    // Tag-summary EN format: "title @ company"
    assert.match(emits[1]!.text, /@ WeKruit/)
    assert.match(emits[1]!.text, /profile evidence/)
  })

  it("active turn language overrides stale stored preference", async () => {
    const { db } = makeFakeDb([{ docs: [FULL_CV] }])
    const clock = makeClock()
    const emits: EmitRecord[] = []

    await runResumeAcceptedFlow({
      userId: "user_turn_lang",
      phoneE164: "+15551234",
      getOnboardingUser: async () => ({
        id: "user_turn_lang",
        phoneE164: "+15551234",
        statedPreferences: { preferredLang: "zh" },
      }),
      preferredLang: "en",
      applyOnboarding: async () => {},
      emit: async (text, meta) => {
        emits.push({ text, meta })
      },
      db,
      log: () => {},
      cvPollOpts: { sleep: clock.sleep, now: clock.now },
    })

    assert.equal(emits.length, 2)
    assert.ok(
      emits.every((e) => !/[\u4e00-\u9fff]/.test(e.text)),
      `expected active EN turn to avoid stale ZH copy: ${emits.map((e) => e.text).join(" | ")}`
    )
    assert.match(emits[1]!.text, /@ WeKruit/)
  })

  it("mixed-pref user → English messages (product is English-only)", async () => {
    const { db } = makeFakeDb([{ docs: [FULL_CV] }])
    const clock = makeClock()
    const emits: EmitRecord[] = []

    await runResumeAcceptedFlow({
      userId: "user_c",
      phoneE164: "+15551234",
      getOnboardingUser: async () => ({
        id: "user_c",
        phoneE164: "+15551234",
        statedPreferences: { preferredLang: "mixed" },
      }),
      applyOnboarding: async () => {},
      emit: async (text, meta) => {
        emits.push({ text, meta })
      },
      db,
      log: () => {},
      cvPollOpts: { sleep: clock.sleep, now: clock.now },
    })

    // Product is English-only — no Chinese characters in any message.
    for (const e of emits) {
      assert.doesNotMatch(e.text, /[\u4e00-\u9fff]/, `unexpected ZH chars in: ${e.text}`)
    }
  })
})

describe("runResumeAcceptedFlow — CV lands after delay", () => {
  it("doc shows up after 60s of polling → returns when found, then applyOnboarding", async () => {
    // 11 empty polls (~55s elapsed), then the CV lands on poll #12.
    const snapshots: Array<{ docs: unknown[] }> = []
    for (let i = 0; i < 11; i++) snapshots.push({ docs: [] })
    snapshots.push({ docs: [FULL_CV] })

    const { db } = makeFakeDb(snapshots)
    const clock = makeClock()
    const emits: EmitRecord[] = []
    const applies: ApplyOnboardingRecord[] = []

    await runResumeAcceptedFlow({
      userId: "user_d",
      phoneE164: "+15551234",
      getOnboardingUser: async () => ({
        id: "user_d",
        phoneE164: "+15551234",
        statedPreferences: { preferredLang: "zh" },
      }),
      applyOnboarding: async (userId, phoneE164, step, opts) => {
        applies.push({
          userId,
          phoneE164,
          step,
          opts,
          emitsAtCallTime: emits.length,
        })
      },
      emit: async (text, meta) => {
        emits.push({ text, meta })
      },
      db,
      log: () => {},
      cvPollOpts: { intervalMs: 5_000, timeoutMs: 90_000, sleep: clock.sleep, now: clock.now },
    })

    // Tag-summary should reference the real CV (not the timeout fallback).
    assert.equal(emits.length, 2)
    assert.match(emits[1]!.text, /TypeScript/)
    // Order: applyOnboarding only after both emits.
    assert.equal(applies.length, 1)
    assert.equal(applies[0]!.emitsAtCallTime, 2)
  })
})

describe("runResumeAcceptedFlow — timeout fallback", () => {
  it("CV never lands within 90s → timeout fallback message + still applyOnboarding", async () => {
    const { db } = makeFakeDb([{ docs: [] }])
    const clock = makeClock()
    const emits: EmitRecord[] = []
    const applies: ApplyOnboardingRecord[] = []

    await runResumeAcceptedFlow({
      userId: "user_e",
      phoneE164: "+15551234",
      getOnboardingUser: async () => ({
        id: "user_e",
        phoneE164: "+15551234",
        statedPreferences: { preferredLang: "zh" },
      }),
      applyOnboarding: async (userId, phoneE164, step, opts) => {
        applies.push({
          userId,
          phoneE164,
          step,
          opts,
          emitsAtCallTime: emits.length,
        })
      },
      emit: async (text, meta) => {
        emits.push({ text, meta })
      },
      db,
      log: () => {},
      cvPollOpts: { intervalMs: 5_000, timeoutMs: 90_000, sleep: clock.sleep, now: clock.now },
    })

    // Two emits: interim ack + timeout-fallback line.
    assert.equal(emits.length, 2)
    assert.match(emits[1]!.text, /still parsing|going by/i)
    // applyOnboarding STILL fires (don't strand user) — this matches the
    // "fallback path" requirement from the iter34 spec.
    assert.equal(applies.length, 1)
    assert.equal(applies[0]!.step, "complete")
    assert.equal(applies[0]!.emitsAtCallTime, 2)
  })

  it("english pref + timeout → english fallback line", async () => {
    const { db } = makeFakeDb([{ docs: [] }])
    const clock = makeClock()
    const emits: EmitRecord[] = []

    await runResumeAcceptedFlow({
      userId: "user_f",
      phoneE164: "+15551234",
      getOnboardingUser: async () => ({
        id: "user_f",
        phoneE164: "+15551234",
        statedPreferences: { preferredLang: "en" },
      }),
      applyOnboarding: async () => {},
      emit: async (text, meta) => {
        emits.push({ text, meta })
      },
      db,
      log: () => {},
      cvPollOpts: { intervalMs: 5_000, timeoutMs: 90_000, sleep: clock.sleep, now: clock.now },
    })

    assert.equal(emits.length, 2)
    assert.match(emits[1]!.text, /still parsing|retune|going by/i)
  })

  it("missing applyOnboarding (degraded deps) → still emits both messages", async () => {
    const { db } = makeFakeDb([{ docs: [FULL_CV] }])
    const clock = makeClock()
    const emits: EmitRecord[] = []

    await runResumeAcceptedFlow({
      userId: "user_g",
      phoneE164: "+15551234",
      getOnboardingUser: async () => ({
        id: "user_g",
        phoneE164: "+15551234",
        statedPreferences: { preferredLang: "zh" },
      }),
      // applyOnboarding intentionally omitted
      emit: async (text, meta) => {
        emits.push({ text, meta })
      },
      db,
      log: () => {},
      cvPollOpts: { sleep: clock.sleep, now: clock.now },
    })

    // Should not throw, and both messages still emitted.
    assert.equal(emits.length, 2)
  })

  it("missing getOnboardingUser → English summary, no crash", async () => {
    const { db } = makeFakeDb([{ docs: [FULL_CV] }])
    const clock = makeClock()
    const emits: EmitRecord[] = []

    await runResumeAcceptedFlow({
      userId: "user_h",
      phoneE164: "+15551234",
      // getOnboardingUser intentionally omitted
      applyOnboarding: async () => {},
      emit: async (text, meta) => {
        emits.push({ text, meta })
      },
      db,
      log: () => {},
      cvPollOpts: { sleep: clock.sleep, now: clock.now },
    })

    assert.equal(emits.length, 2)
    // Product is English-only — tag-summary should be English-formatted.
    assert.match(emits[1]!.text, /profile evidence/i)
  })
})
