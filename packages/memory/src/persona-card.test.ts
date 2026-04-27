import assert from "node:assert/strict"
import test from "node:test"
import type { MemoryFact } from "@pa/core-types"
import { buildPersonaCard } from "./persona-card.js"

function fact(partial: Partial<MemoryFact> & { id: string; content: string; createdAt: string }): MemoryFact {
  return {
    id: partial.id,
    userId: partial.userId ?? "u1",
    content: partial.content,
    status: partial.status ?? "confirmed",
    source: partial.source ?? "explicit_user",
    createdAt: partial.createdAt,
    updatedAt: partial.updatedAt ?? partial.createdAt,
  }
}

test("buildPersonaCard returns null for empty input", () => {
  assert.equal(buildPersonaCard([]), null)
})

test("buildPersonaCard returns null when all facts are deleted", () => {
  const facts: MemoryFact[] = [
    fact({ id: "1", content: "x", createdAt: "2026-01-01T00:00:00Z", status: "deleted" }),
    fact({ id: "2", content: "y", createdAt: "2026-01-02T00:00:00Z", status: "deleted" }),
  ]
  assert.equal(buildPersonaCard(facts), null)
})

test("buildPersonaCard sorts deterministically by createdAt asc with id tiebreak", () => {
  // Scrambled input; same createdAt twice forces id tiebreak.
  const facts: MemoryFact[] = [
    fact({ id: "b", content: "second", createdAt: "2026-01-02T00:00:00Z" }),
    fact({ id: "a", content: "first", createdAt: "2026-01-01T00:00:00Z" }),
    fact({ id: "d", content: "fourth", createdAt: "2026-01-03T00:00:00Z" }),
    fact({ id: "c", content: "third", createdAt: "2026-01-03T00:00:00Z" }),
  ]
  const a = buildPersonaCard(facts)
  const b = buildPersonaCard([...facts].reverse())
  assert.equal(
    a,
    [
      "Persona facts (confirmed):",
      "- first",
      "- second",
      "- third",
      "- fourth",
    ].join("\n")
  )
  assert.equal(a, b, "output must be deterministic regardless of input order")
})

test("buildPersonaCard dedupes by normalized content (trim + collapse whitespace)", () => {
  const facts: MemoryFact[] = [
    fact({ id: "1", content: "我喜欢冰美式", createdAt: "2026-01-01T00:00:00Z" }),
    // Same after normalization (extra inner whitespace + trailing space)
    fact({ id: "2", content: "  我喜欢冰美式 ", createdAt: "2026-01-02T00:00:00Z" }),
    fact({ id: "3", content: "我住在上海", createdAt: "2026-01-03T00:00:00Z" }),
  ]
  const card = buildPersonaCard(facts)
  assert.equal(
    card,
    [
      "Persona facts (confirmed):",
      "- 我喜欢冰美式",
      "- 我住在上海",
    ].join("\n")
  )
})

test("buildPersonaCard caps at 20 facts with oldest-first eviction", () => {
  const facts: MemoryFact[] = []
  for (let i = 0; i < 25; i++) {
    const day = String(i + 1).padStart(2, "0")
    facts.push(fact({ id: `f${i}`, content: `fact-${i}`, createdAt: `2026-01-${day}T00:00:00Z` }))
  }
  const card = buildPersonaCard(facts)!
  const lines = card.split("\n").slice(1) // strip heading
  assert.equal(lines.length, 20)
  // Oldest 5 dropped: fact-0..fact-4 gone; survivors are fact-5..fact-24.
  assert.equal(lines[0], "- fact-5")
  assert.equal(lines[19], "- fact-24")
  assert.equal(card.includes("fact-0"), false)
  assert.equal(card.includes("fact-4"), false)
})

test("buildPersonaCard honors 1500-char cap with oldest-first eviction", () => {
  // Each fact ~ 200 chars of content => formatted line ~ 202 chars.
  // 8 facts * 202 = 1616 plus heading 26 + 7 newlines => well over 1500.
  const facts: MemoryFact[] = []
  const blob = "x".repeat(200)
  for (let i = 0; i < 8; i++) {
    const day = String(i + 1).padStart(2, "0")
    facts.push(fact({ id: `f${i}`, content: `${i}-${blob}`, createdAt: `2026-01-${day}T00:00:00Z` }))
  }
  const card = buildPersonaCard(facts)!
  assert.ok(card.length <= 1500, `card length ${card.length} should be <= 1500`)
  // Should keep newer facts; oldest "0-..." dropped before newest "7-...".
  assert.equal(card.includes("7-x"), true)
  assert.equal(card.includes("0-x"), false)
})

test("buildPersonaCard truncates a single oversized fact to 200 chars + ellipsis", () => {
  const huge = "y".repeat(2000)
  const facts: MemoryFact[] = [fact({ id: "f1", content: huge, createdAt: "2026-01-01T00:00:00Z" })]
  const card = buildPersonaCard(facts)!
  assert.ok(card.length <= 1500)
  assert.ok(card.endsWith("…"), "single oversized fact must end with the ellipsis sentinel")
  // Content portion length is exactly 200 + 1 (ellipsis).
  const expectedLine = "- " + "y".repeat(200) + "…"
  assert.equal(card, ["Persona facts (confirmed):", expectedLine].join("\n"))
})

test("buildPersonaCard preserves zh + ja + emoji bytes verbatim", () => {
  const facts: MemoryFact[] = [
    fact({ id: "1", content: "我喜欢喝冰美式 🧊", createdAt: "2026-01-01T00:00:00Z" }),
    fact({ id: "2", content: "私はラーメンが好き", createdAt: "2026-01-02T00:00:00Z" }),
    fact({ id: "3", content: "I prefer English explanations.", createdAt: "2026-01-03T00:00:00Z" }),
  ]
  const card = buildPersonaCard(facts)!
  assert.equal(card.includes("我喜欢喝冰美式 🧊"), true)
  assert.equal(card.includes("私はラーメンが好き"), true)
  assert.equal(card.includes("I prefer English explanations."), true)
})

test("buildPersonaCard does not mutate the input array", () => {
  const facts: MemoryFact[] = [
    fact({ id: "b", content: "second", createdAt: "2026-01-02T00:00:00Z" }),
    fact({ id: "a", content: "first", createdAt: "2026-01-01T00:00:00Z" }),
  ]
  const snapshot = facts.map((f) => f.id).join(",")
  buildPersonaCard(facts)
  assert.equal(facts.map((f) => f.id).join(","), snapshot)
})

test("buildPersonaCard skips facts with empty/whitespace-only content but keeps siblings", () => {
  const facts: MemoryFact[] = [
    fact({ id: "1", content: "   ", createdAt: "2026-01-01T00:00:00Z" }),
    fact({ id: "2", content: "real content", createdAt: "2026-01-02T00:00:00Z" }),
  ]
  const card = buildPersonaCard(facts)
  assert.equal(card, ["Persona facts (confirmed):", "- real content"].join("\n"))
})
