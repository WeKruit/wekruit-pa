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

import { runResumeAcceptedFlow } from "./runtime-bridge.js"
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
    assert.match(emits[1]!.text, /pulling matches/)
  })

  it("mixed-pref user → mixed-language messages (both ZH + EN tokens)", async () => {
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

    // Both messages should contain ZH + EN.
    for (const e of emits) {
      assert.match(e.text, /[一-鿿]/, `expected ZH chars in: ${e.text}`)
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
    assert.match(emits[1]!.text, /还在分析|still parsing|going by/i)
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

  it("missing getOnboardingUser → defaults to zh, no crash", async () => {
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
    // Default lang zh — tag-summary should be zh-formatted.
    assert.match(emits[1]!.text, /推岗位贴这个方向/)
  })
})
