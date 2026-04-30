/**
 * Phase 38 T3 — prompt-injector tests.
 *
 * Coverage:
 * - Bilingual gloss switch (zh / en / mixed → en default)
 * - Empty recent → empty string (caller skips append)
 * - Truncation cap (200 chars)
 * - Max items cap (default 3 + override)
 * - Most-recent-first ordering in directive (recent[] passed oldest-first)
 */
import assert from "node:assert/strict"
import test from "node:test"

import {
  buildAdviceInjection,
  MEMORY_POLICY_NOTE_EN,
  MEMORY_POLICY_NOTE_ZH,
} from "./prompt-injector.js"
import type { AdviceTrackerEntry } from "./types.js"

function makeEntry(text: string, ts: string, lang: AdviceTrackerEntry["lang"] = "en"): AdviceTrackerEntry {
  return {
    userId: "u",
    turnId: ts,
    text,
    lang,
    embedding: null,
    embeddedAt: null,
    strategy: null,
    uxState: null,
    ts,
    schemaVersion: 1,
  }
}

test("buildAdviceInjection: empty array → empty string", () => {
  assert.equal(buildAdviceInjection([], { userLang: "zh" }), "")
  assert.equal(buildAdviceInjection([], {}), "")
})

test("buildAdviceInjection: directive contains MEMORY-POLICY block markers + header", () => {
  const out = buildAdviceInjection(
    [makeEntry("you should rest", "2026-04-29T00:00:00.000Z")],
    { userLang: "en" }
  )
  assert.match(out, /\[MEMORY-POLICY\]/)
  assert.match(out, /\[\/MEMORY-POLICY\]/)
  assert.match(out, /already_given_advice \(do NOT repeat or paraphrase\):/)
})

test("buildAdviceInjection: zh user lang → 已经给过的建议 note", () => {
  const out = buildAdviceInjection(
    [makeEntry("你应该多休息", "2026-04-29T00:00:00.000Z", "zh")],
    { userLang: "zh" }
  )
  assert.ok(out.includes(MEMORY_POLICY_NOTE_ZH), `expected zh note in output. got:\n${out}`)
  assert.ok(!out.includes(MEMORY_POLICY_NOTE_EN), "should NOT contain en note when lang=zh")
})

test("buildAdviceInjection: en user lang → Already-given advice note", () => {
  const out = buildAdviceInjection(
    [makeEntry("you should rest", "2026-04-29T00:00:00.000Z")],
    { userLang: "en" }
  )
  assert.ok(out.includes(MEMORY_POLICY_NOTE_EN))
  assert.ok(!out.includes(MEMORY_POLICY_NOTE_ZH))
})

test("buildAdviceInjection: mixed lang defaults to en note", () => {
  const out = buildAdviceInjection(
    [makeEntry("你应该 try yoga", "2026-04-29T00:00:00.000Z", "mixed")],
    { userLang: "mixed" }
  )
  assert.ok(out.includes(MEMORY_POLICY_NOTE_EN))
})

test("buildAdviceInjection: no userLang → defaults to en note", () => {
  const out = buildAdviceInjection(
    [makeEntry("rest tonight", "2026-04-29T00:00:00.000Z")]
  )
  assert.ok(out.includes(MEMORY_POLICY_NOTE_EN))
})

test("buildAdviceInjection: most-recent-first ordering in numbered list", () => {
  // Input is oldest-first per recentAdvice contract.
  const recent = [
    makeEntry("oldest advice", "2026-04-29T00:00:01.000Z"),
    makeEntry("middle advice", "2026-04-29T00:00:02.000Z"),
    makeEntry("most recent advice", "2026-04-29T00:00:03.000Z"),
  ]
  const out = buildAdviceInjection(recent, { userLang: "en" })
  // "most recent advice" should be first in the numbered list (item 1).
  const lines = out.split("\n")
  const item1 = lines.find((l) => l.startsWith("  1."))
  assert.ok(item1?.includes("most recent advice"), `item 1 = "${item1}"`)
  const item3 = lines.find((l) => l.startsWith("  3."))
  assert.ok(item3?.includes("oldest advice"), `item 3 = "${item3}"`)
})

test("buildAdviceInjection: truncates items over 200 chars (... suffix)", () => {
  const long = "x".repeat(300)
  const out = buildAdviceInjection(
    [makeEntry(long, "2026-04-29T00:00:00.000Z")],
    { userLang: "en" }
  )
  assert.match(out, /x{200}\.\.\./)
  assert.ok(!out.includes("x".repeat(201)), "should not include >=201 consecutive x's")
})

test("buildAdviceInjection: max=2 caps items even when more provided", () => {
  const recent = [
    makeEntry("a", "2026-04-29T00:00:01.000Z"),
    makeEntry("b", "2026-04-29T00:00:02.000Z"),
    makeEntry("c", "2026-04-29T00:00:03.000Z"),
    makeEntry("d", "2026-04-29T00:00:04.000Z"),
  ]
  const out = buildAdviceInjection(recent, { userLang: "en", max: 2 })
  // Should contain items 1 and 2 only
  const lines = out.split("\n")
  const numbered = lines.filter((l) => /^  \d+\./.test(l))
  assert.equal(numbered.length, 2)
  // Most recent first: d then c
  assert.ok(numbered[0].includes("d"))
  assert.ok(numbered[1].includes("c"))
})

test("buildAdviceInjection: default max=3 when more provided", () => {
  const recent = [
    makeEntry("a", "2026-04-29T00:00:01.000Z"),
    makeEntry("b", "2026-04-29T00:00:02.000Z"),
    makeEntry("c", "2026-04-29T00:00:03.000Z"),
    makeEntry("d", "2026-04-29T00:00:04.000Z"),
    makeEntry("e", "2026-04-29T00:00:05.000Z"),
  ]
  const out = buildAdviceInjection(recent)
  const lines = out.split("\n")
  const numbered = lines.filter((l) => /^  \d+\./.test(l))
  assert.equal(numbered.length, 3)
})
