/**
 * Layer 1 unit tests — q_email (EmailJudge: regex-first + LLM stub).
 *
 * P7-5 — happy path is regex-only (no LLM cost). Typo / declined / unclear
 * paths are covered via stubbed `extractEmailIntent`.
 */
import test from "node:test"
import assert from "node:assert/strict"
import { EmailJudge, type EmailIntentResult, type ExtractEmailIntentFn } from "../judges/email.js"
import type { JudgeCtx } from "../question.js"

function ctx(): JudgeCtx {
  const events: Array<{ ev: string; payload: unknown }> = []
  return {
    userId: "u",
    turnId: "t",
    log: (ev, payload) => events.push({ ev, payload }),
  }
}

function makeStubExtract(result: EmailIntentResult | null, throws?: Error): { fn: ExtractEmailIntentFn; calls: number } {
  let calls = 0
  const fn: ExtractEmailIntentFn = async () => {
    calls++
    if (throws) throw throws
    return result
  }
  return {
    fn,
    get calls() {
      return calls
    },
  } as { fn: ExtractEmailIntentFn; calls: number }
}

test("q-email: clean 'alex@gmail.com' → regex hit (no LLM)", async () => {
  const stub = makeStubExtract(null)
  const J = new EmailJudge({ extractEmailIntent: stub.fn })
  const r = await J.judge("alex@gmail.com", "en", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.equal(r.value, "alex@gmail.com")
  assert.equal(stub.calls, 0, "regex hit must skip LLM")
})

test("q-email: prose with embedded email → regex extracts", async () => {
  const stub = makeStubExtract(null)
  const J = new EmailJudge({ extractEmailIntent: stub.fn })
  const r = await J.judge("here you go: foo.bar+test@example.co.uk thanks", "en", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.equal(r.value, "foo.bar+test@example.co.uk")
})

test("q-email: lowercase normalize 'Alice@GMAIL.COM' → 'alice@gmail.com'", async () => {
  const stub = makeStubExtract(null)
  const J = new EmailJudge({ extractEmailIntent: stub.fn })
  const r = await J.judge("Alice@GMAIL.COM", "en", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.equal(r.value, "alice@gmail.com")
})

test("q-email: typo 'alex@gmal.com' → LLM 'typo' with suggestion", async () => {
  const stub = makeStubExtract({
    intent: "typo",
    original: "alex@gmal.com",
    suggestion: "alex@gmail.com",
  })
  const J = new EmailJudge({ extractEmailIntent: stub.fn })
  // Note: 'gmal.com' technically matches CHEAP_EMAIL_RE (>=2 char TLD).
  // But "alex@gmal" without TLD does NOT match — regex requires .X{2,}.
  const r = await J.judge("alex@gmal", "en", ctx())
  assert.equal(r.accept, false)
  if (!r.accept) {
    assert.equal(r.reason, "typo")
    assert.equal(r.suggestion, "alex@gmail.com")
  }
  assert.equal(stub.calls, 1)
})

test("q-email: 'no email thanks' → LLM declined", async () => {
  const stub = makeStubExtract({ intent: "declined" })
  const J = new EmailJudge({ extractEmailIntent: stub.fn })
  const r = await J.judge("no email thanks", "en", ctx())
  assert.equal(r.accept, false)
  if (!r.accept) assert.equal(r.reason, "declined")
})

test("q-email: '我没邮箱' → LLM declined", async () => {
  const stub = makeStubExtract({ intent: "declined" })
  const J = new EmailJudge({ extractEmailIntent: stub.fn })
  const r = await J.judge("我没邮箱", "zh", ctx())
  assert.equal(r.accept, false)
  if (!r.accept) assert.equal(r.reason, "declined")
})

test("q-email: nonsense 'banana cake' → LLM unclear", async () => {
  const stub = makeStubExtract({
    intent: "unclear",
    clarifyingQuestion: "Just need an email — like you@example.com",
  })
  const J = new EmailJudge({ extractEmailIntent: stub.fn })
  const r = await J.judge("banana cake", "en", ctx())
  assert.equal(r.accept, false)
  if (!r.accept) {
    assert.equal(r.reason, "unclear")
    assert.match(r.clarifyingQuestion ?? "", /email/i)
  }
})

test("q-email: low-confidence provided → still accept (regex hit shortcut)", async () => {
  // Even if reply has a clean email, the regex path wins regardless of LLM.
  const stub = makeStubExtract({
    intent: "provided",
    email: "x@y.com",
    confidence: 0.3,
  })
  const J = new EmailJudge({ extractEmailIntent: stub.fn })
  const r = await J.judge("contact me at me@me.com", "en", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.equal(r.value, "me@me.com")
  assert.equal(stub.calls, 0)
})

test("q-email: LLM provided high conf email (no clean regex hit) → accept", async () => {
  const stub = makeStubExtract({
    intent: "provided",
    email: "tricky@host",
    confidence: 0.9,
  })
  // Need a base email-ish reply that misses cheap regex.
  // 'tricky@host' fails regex (no .TLD).
  const J = new EmailJudge({ extractEmailIntent: stub.fn })
  const r = await J.judge("tricky@host", "en", ctx())
  // tricky@host fails regex (TLD requires .X{2,}).
  assert.equal(r.accept, true)
  if (r.accept) assert.equal(r.value, "tricky@host")
  assert.equal(stub.calls, 1)
})

test("q-email: LLM throws → graceful irrelevant", async () => {
  const stub = makeStubExtract(null, new Error("network down"))
  const J = new EmailJudge({ extractEmailIntent: stub.fn })
  const r = await J.judge("not an email", "en", ctx())
  assert.equal(r.accept, false)
  if (!r.accept) assert.equal(r.reason, "irrelevant")
})

test("q-email: empty + no LLM extractor → irrelevant", async () => {
  const J = new EmailJudge({})
  const r = await J.judge("foo bar baz", "en", ctx())
  assert.equal(r.accept, false)
  if (!r.accept) assert.equal(r.reason, "irrelevant")
})
