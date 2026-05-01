import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { parseInboundTapback } from "../tapback-parser.js"

describe("parseInboundTapback", () => {
  // Six reaction kinds × two quoted formats (smart quotes vs plain).
  const cases: Array<{ in: string; kind: string; quoted: string }> = [
    { in: "Loved “Career check-in tomorrow?”", kind: "love", quoted: "Career check-in tomorrow?" },
    { in: 'Loved "Career check-in tomorrow?"', kind: "love", quoted: "Career check-in tomorrow?" },
    { in: "Liked “Here are 3 jobs”", kind: "like", quoted: "Here are 3 jobs" },
    { in: "Liked 'Here are 3 jobs'", kind: "like", quoted: "Here are 3 jobs" },
    { in: "Disliked “noisy update”", kind: "dislike", quoted: "noisy update" },
    { in: 'Disliked "noisy update"', kind: "dislike", quoted: "noisy update" },
    { in: "Laughed at “see you then”", kind: "laugh", quoted: "see you then" },
    { in: 'Laughed at "see you then"', kind: "laugh", quoted: "see you then" },
    { in: "Emphasized “test”", kind: "emphasize", quoted: "test" },
    { in: 'Emphasized "test"', kind: "emphasize", quoted: "test" },
    { in: "Questioned “draft attached”", kind: "question", quoted: "draft attached" },
    { in: 'Questioned "draft attached"', kind: "question", quoted: "draft attached" },
  ]

  for (const c of cases) {
    it(`parses ${c.kind} (${c.in})`, () => {
      const out = parseInboundTapback(c.in)
      assert.ok(out, `expected non-null for ${c.in}`)
      assert.equal(out!.kind, c.kind)
      assert.equal(out!.quotedText, c.quoted)
    })
  }

  it("returns null for regular text (negative case)", () => {
    assert.equal(parseInboundTapback("hey, what's up?"), null)
    assert.equal(parseInboundTapback("Loved your idea about the project"), null) // no quoted text
    assert.equal(parseInboundTapback(""), null)
    assert.equal(parseInboundTapback("   "), null)
  })

  it("returns null for unsupported verbs", () => {
    assert.equal(parseInboundTapback('Hated "this"'), null)
    assert.equal(parseInboundTapback('Reacted "this"'), null)
  })

  it("returns null for non-string input", () => {
    assert.equal(parseInboundTapback(undefined as unknown as string), null)
    assert.equal(parseInboundTapback(null as unknown as string), null)
    assert.equal(parseInboundTapback(42 as unknown as string), null)
  })

  it("trims whitespace before parsing", () => {
    const out = parseInboundTapback("  Loved “hi”  ")
    assert.ok(out)
    assert.equal(out!.kind, "love")
    assert.equal(out!.quotedText, "hi")
  })

  it("rejects multi-line content (anchored regex)", () => {
    assert.equal(parseInboundTapback('Loved "hi"\nthen something else'), null)
  })

  it("respects 200-char quoted-text ceiling", () => {
    const long = "a".repeat(201)
    assert.equal(parseInboundTapback(`Loved "${long}"`), null)
    const fit = "a".repeat(200)
    const out = parseInboundTapback(`Loved "${fit}"`)
    assert.ok(out)
    assert.equal(out!.quotedText.length, 200)
  })
})
