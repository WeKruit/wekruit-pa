import assert from "node:assert/strict"
import test from "node:test"
import {
  compactValue,
  displaySponsorship,
  enrichmentStatusTone,
  formatPercent,
  listify,
  sortByUpdatedAt,
} from "../JobEnrichmentReview.helpers.js"

test("displaySponsorship keeps unknown/null sponsorship in review state", () => {
  assert.deepEqual(displaySponsorship(null), { label: "Unknown/Review", tone: "warn" })
  assert.deepEqual(displaySponsorship(undefined), { label: "Unknown/Review", tone: "warn" })
  assert.deepEqual(displaySponsorship("unknown"), { label: "Unknown/Review", tone: "warn" })
  assert.deepEqual(displaySponsorship(false), { label: "No", tone: "muted" })
  assert.deepEqual(displaySponsorship(true), { label: "Yes", tone: "ok" })
})

test("job enrichment helpers format dense operator values", () => {
  assert.equal(enrichmentStatusTone("approved"), "ok")
  assert.equal(enrichmentStatusTone("needs_review"), "warn")
  assert.equal(enrichmentStatusTone("draft"), "info")
  assert.equal(enrichmentStatusTone("unknown"), "muted")
  assert.equal(formatPercent(0.624), "62%")
  assert.equal(formatPercent(null), "-")
  assert.equal(compactValue({ a: 1 }), "{\"a\":1}")
  assert.deepEqual(listify({ remote: true, salary: null, visa: "Unknown" }), ["remote: true", "visa: Unknown"])
})

test("sortByUpdatedAt orders newest update first without mutating input", () => {
  const rows = [
    { id: "old", updatedAt: "2026-05-12T00:00:00.000Z" },
    { id: "missing" },
    { id: "new", updatedAt: "2026-05-13T00:00:00.000Z" },
  ]

  const sorted = sortByUpdatedAt(rows)

  assert.deepEqual(sorted.map((row) => row.id), ["new", "old", "missing"])
  assert.deepEqual(rows.map((row) => row.id), ["old", "missing", "new"])
})
