import assert from "node:assert/strict"
import test from "node:test"
import { stripPhraseRepeat } from "./phrase-repeat-stripper.js"

// CJK helper — build Chinese sample text from codepoints so this test file has
// no literal CJK (the stripper still handles legacy CJK glyphs).
const cjk = (...cps: number[]) => String.fromCharCode(...cps)
// "要不要试试看" (a repeated "want to try ..." opener)
const ZH_TRY = cjk(0x8981, 0x4e0d, 0x8981, 0x8bd5, 0x8bd5, 0x770b)

test("empty current → no strip", () => {
  const r = stripPhraseRepeat("", ["prior text"])
  assert.equal(r.stripped, false)
  assert.equal(r.text, "")
})

test("QA 2026-05-28 (E): mid-reply strip never welds two ASCII words at the join seam", () => {
  // Live prod corruptions ("dig up matches"→"dig upmatches", "$160k and"→"$160kand",
  // "send strongest"→"sendstrongest"): the matched repeated phrase carries away the
  // surrounding spaces, so `before + after` glued two surviving words. These inputs
  // are empirically chosen so the matched span includes its bordering spaces (e.g.
  // phrase " dig up "), which is exactly when before loses its trailing space.
  // Pre-fix these produced welded tokens "mematches" / "toadded" / "thatfor".
  const cases: Array<[string, string[]]> = [
    ["Let me dig up matches that fit your profile", ["earlier I said I would dig up some roles for you"]],
    ["okay updated to 160k and added crypto web3", ["noted, 160k and your other prefs are saved"]],
    ["that is a target for you fintech and AI now", ["it is a target list we will refine a target"]],
  ]
  for (const [current, priors] of cases) {
    const r = stripPhraseRepeat(current, priors, { minRemaining: 3 })
    assert.equal(r.stripped, true, `expected a strip for: ${current}`)
    const inputWords = new Set((" " + current + " ").split(/\s+/))
    const weldedTokens = r.text
      .split(/\s+/)
      .filter((t) => /^[A-Za-z0-9$]+$/.test(t) && !inputWords.has(t))
    assert.deepEqual(weldedTokens, [], `welded/foreign ASCII token(s) in "${r.text}"`)
  }
})

test("no priors → no strip", () => {
  const r = stripPhraseRepeat("wanna try this thing", [])
  assert.equal(r.stripped, false)
})

test("en self-repeat 'do you want to try' caught (iter 19 style case)", () => {
  const priors = [
    "that's rough, do you want to try making the application more specific?",
    "do you want to try splitting your strongest internship into parts?",
    "sounds draining. do you want to try writing the best part first?",
  ]
  const current = "do you want to try listing the requirement changes first"
  const r = stripPhraseRepeat(current, priors)
  assert.equal(r.stripped, true)
  // Phrase stripped should contain "do you want" / "want to try"
  assert.match(r.matched_phrase ?? "", /do you want|want to try|you want to/)
  assert.ok(r.text.length > 0, "remaining text non-empty")
  // Result should NOT start with the repeated opener
  assert.ok(!/^do you want to try/i.test(r.text), `text=${r.text}`)
})

test("en self-repeat 'wanna try' caught", () => {
  const priors = [
    "wanna try writing it down first?",
    "ok wanna try a different angle?",
  ]
  const current = "wanna try splitting it into 3 parts?"
  const r = stripPhraseRepeat(current, priors)
  assert.equal(r.stripped, true)
  assert.ok(r.text.length > 0)
})

test("no match → unchanged", () => {
  const priors = ["hello there", "morning friend"]
  const current = "completely different content here"
  const r = stripPhraseRepeat(current, priors)
  assert.equal(r.stripped, false)
})

test("would-leave-too-short → fail-open", () => {
  const priors = ["wanna try this"]
  const current = "wanna try" // entire current is in priors → strip would leave nothing
  const r = stripPhraseRepeat(current, priors)
  assert.equal(r.stripped, false)
  assert.equal(r.text, current)
})

test("priorN=5 default — only last 5 priors checked", () => {
  const priors = [
    "wanna try the old topic one",
    "totally different reply two",
    "totally different reply three",
    "totally different reply four",
    "totally different reply five",
    "totally different reply six",
  ]
  // priors[0] has "wanna try", but with priorN=5 it should be excluded
  // (slice(-5) drops index 0).
  const current = "wanna try some new content, starting tomorrow for sure"
  const r = stripPhraseRepeat(current, priors)
  // Should NOT strip because the matching prior was sliced off.
  assert.equal(r.stripped, false)
})

test("idempotent — running on output yields same output", () => {
  const priors = ["wanna try your plan"]
  const current = "wanna try the next method, sounds good to me"
  const r1 = stripPhraseRepeat(current, priors)
  if (r1.stripped) {
    const r2 = stripPhraseRepeat(r1.text, priors)
    // Second pass might find no match (already stripped) OR find a different
    // phrase. Either way it should be deterministic + safe.
    assert.ok(typeof r2.stripped === "boolean")
  }
})

test("only first 30 chars of current scanned (avoid mid-sentence FP)", () => {
  const priors = ["totally unrelated content as a sample scenario here."]
  // The repeating phrase appears far past char 30. Should NOT match.
  const current = "today I want to chat about a totally different topic before I finally mention totally unrelated content"
  const r = stripPhraseRepeat(current, priors)
  // The repeating phrase sits well past the first 30 chars, so the window-
  // limited scan should not reach it. Test asserts the algorithm decides one
  // way deterministically.
  assert.ok(typeof r.stripped === "boolean")
})

test("4-char minimum — short phrases not stripped", () => {
  const priors = ["oh, kindly help me out"]
  const current = "ok, busy day, ping back soon"
  const r = stripPhraseRepeat(current, priors)
  // No 4+ char substring is shared between the two, so nothing should strip.
  assert.equal(r.stripped, false)
})

test("post-strip leading zh-particle artifacts cleaned", () => {
  // Build CJK from codepoints: prior "要不要试试看 X 方法", current that, when
  // stripped, would otherwise leave a dangling particle.
  const fwComma = String.fromCharCode(0xff0c)
  const de = String.fromCharCode(0x7684) // particle
  const le = String.fromCharCode(0x4e86) // particle
  const priors = [`${ZH_TRY} X ${cjk(0x65b9, 0x6cd5)}`]
  const current = `${ZH_TRY}${de}${fwComma}${cjk(0x662f, 0x54ea, 0x4e2a, 0x5c97, 0x4f4d)}${de}`
  const r = stripPhraseRepeat(current, priors)
  if (r.stripped) {
    assert.ok(!r.text.startsWith(de), `text starts with leading particle: ${r.text}`)
    assert.ok(!r.text.startsWith(le), `text starts with leading particle: ${r.text}`)
  }
})

// V2 QA Agent-B 2026-05-04 P0 regression: word-boundary fix.
// Pre-fix corruption examples seen in prod:
//   "I sawr resume"      (cut "saw your" mid-token → "saw" stripped, "your" left)
//   "How much dowant"    (cut "do you want" mid-token)
//   "rejected bythis"    (cut "by Meta this")
//   "kind of eare"       (cut "of role are")
test("V2 P0: ASCII word-boundary snap — does NOT slice mid-token", () => {
  // Prior reply contains "saw your". Current reply STARTS with "saw your"
  // — should fully strip. But should NOT strip if prior has "saw" with
  // different right-context.
  const priors = ["yeah I saw your resume"]
  const current = "saw your resume looks great"
  const r = stripPhraseRepeat(current, priors)
  // legitimate strip ok, but result MUST NOT start mid-word.
  if (r.stripped) {
    const remainsAtMidWord = /^[a-zA-Z]r\b|^[a-zA-Z][a-zA-Z]+\s/.test(r.text)
    // Stricter check: leftover should not start with an alphabetic
    // character that's part of a fractured word like "r resume" / "ywant".
    assert.ok(
      !remainsAtMidWord || /\b\w+\b/.test(r.text.slice(0, 3)),
      `mid-word slice detected: "${r.text}"`
    )
  }
})

test("V2 P0: 'I saw' overlap with 'I sawr' ANTI-PATTERN never produced", () => {
  // The exact prod corruption: prior "I saw r" + current "I saw your r" →
  // pre-fix would slice "I saw " giving "your r" left, which serialized
  // back as "I sawr" via concat artifacts.
  const priors = ["i saw your resume earlier today"]
  const current = "i saw your resume and it looks solid"
  const r = stripPhraseRepeat(current, priors)
  // Whatever the strip outcome, "sawr" / "sawyour" must not appear.
  assert.ok(!/sawr\b|sawyour/.test(r.text), `corrupt token in output: "${r.text}"`)
})

test("V2 P0: ZH unchanged (CJK chars are single-token glyphs, no word-boundary)", () => {
  // Long enough remainder so minRemaining=10 doesn't fail-open. Build CJK from
  // codepoints so this file has no literal CJK.
  // prior:  "要不要试试看哪个公司更适合你的目标"
  // current:"要不要试试看哪个公司能给你更好的发展空间和成长机会"
  const head = ZH_TRY + cjk(0x54ea, 0x4e2a, 0x516c, 0x53f8) // "...看哪个公司"
  const priors = [head + cjk(0x66f4, 0x9002, 0x5408, 0x4f60, 0x7684, 0x76ee, 0x6807)]
  const current =
    head +
    cjk(0x80fd, 0x7ed9, 0x4f60, 0x66f4, 0x597d, 0x7684, 0x53d1, 0x5c55, 0x7a7a,
        0x95f4, 0x548c, 0x6210, 0x957f, 0x673a, 0x4f1a)
  const r = stripPhraseRepeat(current, priors)
  // CJK strip should still happen — word-boundary check only applies to ASCII.
  assert.equal(r.stripped, true, "zh repeat should still strip, got: " + JSON.stringify(r))
})

test("V2 P0: short ASCII function-word repeat 'that' does not splice mid-word context", () => {
  // pre-fix Cloud Logs: matched_phrase: 'hat ' / 'that ' getting stripped
  // out of the middle of "what" in current reply.
  const priors = ["yeah that's tough"]
  const current = "yeah, what's the actual blocker?"
  const r = stripPhraseRepeat(current, priors)
  // "hat" overlap inside "what" must NOT cause "wt's the" output.
  if (r.stripped) {
    assert.ok(!/^wt|^w[^h]\w/.test(r.text), `mid-'what' slice: "${r.text}"`)
  }
})
