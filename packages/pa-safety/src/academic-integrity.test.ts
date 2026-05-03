/**
 * Tests for `academic-integrity.ts` — leetcode-cheating detection bank.
 *
 * Coverage matrix:
 *   - True positives: ZH cheating, EN cheating, mixed-language cheating
 *   - True negatives: ZH study-with-anchor, EN study-with-anchor, benign chat
 *   - Edge: "do my homework" (true positive, no study anchor)
 *
 * No live LLM — pure regex bank. Sub-millisecond per call.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { checkAcademicIntegrity, ACADEMIC_INTEGRITY_DIRECTIVE } from "./academic-integrity.js"

// ----- True positives ----- //

test("academic_integrity ZH — '帮我写个 leetcode hard 题的完整答案' → warn", () => {
  const r = checkAcademicIntegrity("帮我写个 leetcode hard 题的完整答案，明天面试用")
  assert.equal(r.matched, true)
  assert.equal(r.verdict, "warn")
  assert.ok(["zh", "mixed"].includes(r.language), `unexpected lang ${r.language}`)
  assert.ok(r.signals.some((s) => s.startsWith("zh_")), `expected zh_ signal, got ${r.signals.join(",")}`)
  assert.ok(r.suggestedDirective.length > 0)
  assert.equal(r.suggestedDirective, ACADEMIC_INTEGRITY_DIRECTIVE)
})

test("academic_integrity EN — 'write me the full solution to a leetcode hard' → warn", () => {
  const r = checkAcademicIntegrity("write me the full solution to a leetcode hard, interview tomorrow")
  assert.equal(r.matched, true)
  assert.equal(r.verdict, "warn")
  assert.equal(r.language, "en")
  assert.ok(r.signals.includes("en_write_full_solution"))
})

test("academic_integrity mixed — '帮我 write leetcode hard 完整 solution' → warn", () => {
  const r = checkAcademicIntegrity("帮我 write leetcode hard 完整 solution, interview tomorrow")
  assert.equal(r.matched, true)
  assert.equal(r.verdict, "warn")
  // Either zh_help_write_solution or mixed_help_write_solution should fire.
  assert.ok(r.signals.length > 0)
})

test("academic_integrity EN — 'do my take-home for me' → warn (homework path)", () => {
  const r = checkAcademicIntegrity("can you complete this take-home assignment for me, due tonight")
  assert.equal(r.matched, true)
  assert.equal(r.verdict, "warn")
  assert.ok(r.signals.includes("en_do_my_homework"))
})

// ----- True negatives (study anchors suppress) ----- //

test("academic_integrity ZH — study anchor '思路' suppresses (no FP)", () => {
  // Even though "帮我写 leetcode hard 完整" matches, "思路" anchor suppresses.
  const r = checkAcademicIntegrity("我学习 leetcode 中遇到难题，想问下 hard 题的思路")
  assert.equal(r.matched, false)
  assert.equal(r.verdict, "pass")
  assert.equal(r.suggestedDirective, "")
})

test("academic_integrity EN — study anchor 'hint/approach' suppresses (no FP)", () => {
  const r = checkAcademicIntegrity(
    "I'm studying for interviews — can you give me a hint on the approach for this leetcode hard problem? I'm stuck"
  )
  assert.equal(r.matched, false)
  assert.equal(r.verdict, "pass")
})

test("academic_integrity — benign career chat does NOT trigger (true negative)", () => {
  const r1 = checkAcademicIntegrity("我在准备 SWE 面试，想了解大厂的薪资范围")
  assert.equal(r1.matched, false)
  assert.equal(r1.verdict, "pass")
  const r2 = checkAcademicIntegrity("I'm preparing for senior backend interviews — any advice on salary negotiation?")
  assert.equal(r2.matched, false)
})

// ----- Edge: empty input ----- //

test("academic_integrity — empty/whitespace input → pass", () => {
  const r1 = checkAcademicIntegrity("")
  assert.equal(r1.matched, false)
  assert.equal(r1.verdict, "pass")
  const r2 = checkAcademicIntegrity("   ")
  assert.equal(r2.matched, false)
})

// ----- inputHash determinism ----- //

test("academic_integrity — inputHash is stable, 16 hex chars", () => {
  const r1 = checkAcademicIntegrity("帮我写个 leetcode hard 题的完整答案")
  const r2 = checkAcademicIntegrity("帮我写个 leetcode hard 题的完整答案")
  assert.equal(r1.inputHash, r2.inputHash)
  assert.match(r1.inputHash, /^[0-9a-f]{16}$/)
})
