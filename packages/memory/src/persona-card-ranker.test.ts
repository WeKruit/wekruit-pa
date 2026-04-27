import assert from "node:assert/strict"
import test from "node:test"
import type { MemoryFact } from "@pa/core-types"
import { buildPersonaCard } from "./persona-card.js"
import { rankFactsByImportance, scoreFact } from "./persona-card-ranker.js"

const NOW = Date.parse("2026-04-27T00:00:00Z")
const day = (d: number) => new Date(NOW - d * 86_400_000).toISOString()

function fact(p: Partial<MemoryFact> & { id: string; content: string; createdAt: string }): MemoryFact {
  return {
    id: p.id,
    userId: p.userId ?? "u1",
    content: p.content,
    status: p.status ?? "confirmed",
    source: p.source ?? "explicit_user",
    createdAt: p.createdAt,
    updatedAt: p.updatedAt ?? p.createdAt,
    accessCount: p.accessCount,
    salience: p.salience,
  }
}

// ---- ranker unit tests ------------------------------------------------------

test("ranker: equal-recency, different salience → salient fact wins", () => {
  const a = fact({ id: "a", content: "I like coffee", createdAt: day(5) })
  const b = fact({ id: "b", content: "my email is adam@example.com", createdAt: day(5) })
  const ranked = rankFactsByImportance([a, b], NOW)
  assert.equal(ranked[0]!.fact.id, "b", "salient (email) fact must rank first")
  assert.ok(ranked[0]!.score > ranked[1]!.score)
})

test("ranker: equal-salience, different access → high-access wins", () => {
  const a = fact({ id: "a", content: "neutral one", createdAt: day(5), accessCount: 0 })
  const b = fact({ id: "b", content: "neutral two", createdAt: day(5), accessCount: 5 })
  const ranked = rankFactsByImportance([a, b], NOW)
  assert.equal(ranked[0]!.fact.id, "b")
})

test("ranker: equal-everything → newer createdAt wins (deterministic tiebreak)", () => {
  const a = fact({ id: "a", content: "x", createdAt: day(10) })
  const b = fact({ id: "b", content: "y", createdAt: day(5) })
  const ranked = rankFactsByImportance([a, b], NOW)
  assert.equal(ranked[0]!.fact.id, "b", "newer fact wins on score-tie")
})

test("ranker: salient + recent + accessed beats neutral + old + unused", () => {
  const winner = fact({
    id: "win",
    content: "interview at Google on Monday",
    createdAt: day(2),
    accessCount: 3,
  })
  const loser = fact({
    id: "lose",
    content: "I prefer iced coffee",
    createdAt: day(60),
    accessCount: 0,
  })
  const ranked = rankFactsByImportance([loser, winner], NOW)
  assert.equal(ranked[0]!.fact.id, "win")
})

test("ranker: explicit per-fact salience overrides auto-detected pattern", () => {
  // content matches no salient pattern, but explicit salience=1 forces high score.
  const explicit = fact({ id: "e", content: "neutral content", createdAt: day(5), salience: 1 })
  // matches "interview" auto-pattern but old → still loses to explicit
  const auto = fact({ id: "a", content: "interview prep notes", createdAt: day(80) })
  const ranked = rankFactsByImportance([auto, explicit], NOW)
  assert.equal(ranked[0]!.fact.id, "e")
})

test("ranker: facts older than 90d get zero recency contribution", () => {
  const old = fact({ id: "o", content: "old neutral", createdAt: day(120) })
  const fresh = fact({ id: "f", content: "fresh neutral", createdAt: day(1) })
  const oldScored = scoreFact(old, NOW)
  const freshScored = scoreFact(fresh, NOW)
  assert.equal(oldScored.components.recency, 0)
  assert.ok(freshScored.components.recency > 0.9)
})

// ---- buildPersonaCard integration: importance-weighted eviction --------------

test("buildPersonaCard: salient facts survive eviction over neutral newer ones", () => {
  // 21 facts: 1 salient at the very oldest position + 20 neutral newer ones.
  // Old contract (FIFO): salient fact dropped, neutral 20 kept.
  // New contract (importance-weighted): salient fact must survive even though
  // it's the oldest, because salience contribution wins on the tie of recency
  // shared by neutral newer facts being mostly fresh.
  const facts: MemoryFact[] = []
  facts.push(
    fact({
      id: "salient",
      content: "my email is adam@wekruit.com",
      createdAt: day(60), // older but inside recency window
    })
  )
  for (let i = 0; i < 20; i++) {
    facts.push(
      fact({
        id: `n${i}`,
        content: `neutral fact ${i}`,
        createdAt: day(50 - i), // newer than the salient fact
      })
    )
  }
  const card = buildPersonaCard(facts, { now: () => NOW })!
  assert.ok(card.includes("adam@wekruit.com"), "salient identity fact must survive eviction")
  // We dropped exactly one neutral fact (the lowest-scored of the 20 — the oldest neutral).
  const lines = card.split("\n").slice(1)
  assert.equal(lines.length, 20, "must cap to 20 facts total")
})

test("buildPersonaCard: legacy data with no salience/access ranks recency-desc → matches old FIFO", () => {
  const facts: MemoryFact[] = []
  for (let i = 0; i < 25; i++) {
    facts.push(
      fact({
        id: `f${i}`,
        content: `neutral-${i}`,
        createdAt: day(25 - i), // older→newer as i grows
      })
    )
  }
  const card = buildPersonaCard(facts, { now: () => NOW })!
  // Top 20 by recency = i=5..24. f0..f4 dropped.
  assert.equal(card.includes("neutral-0"), false)
  assert.equal(card.includes("neutral-4"), false)
  assert.equal(card.includes("neutral-5"), true)
  assert.equal(card.includes("neutral-24"), true)
})
