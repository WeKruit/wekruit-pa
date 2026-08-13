import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { seedActiveChips } from "../console/useTable.js"

describe("useTable default chips", () => {
  it("seeds the named chip row as active", () => {
    const seed = seedActiveChips({ triage: ["hideClosed"] })
    assert.deepEqual([...(seed.triage ?? [])], ["hideClosed"])
  })

  it("returns an empty seed when no defaults are given", () => {
    assert.deepEqual(seedActiveChips(undefined), {})
    assert.deepEqual(seedActiveChips({}), {})
  })

  it("drops an empty key list — an active row that filters nothing is worse than no row", () => {
    assert.deepEqual(seedActiveChips({ triage: [] }), {})
  })

  // Reset re-seeds from the same literal. If the Sets were shared, a toggle after mount would
  // mutate the caller's default and Reset would restore the MUTATED view.
  it("hands out a fresh Set each call so a later toggle cannot poison the default", () => {
    const defaults = { triage: ["hideClosed"] }
    const first = seedActiveChips(defaults)
    first.triage?.add("needsReview")
    const second = seedActiveChips(defaults)
    assert.deepEqual([...(second.triage ?? [])], ["hideClosed"])
    assert.deepEqual(defaults.triage, ["hideClosed"])
  })
})

describe("recruiter submissions board opens filtered", () => {
  const pageSource = readFileSync(
    resolve(import.meta.dirname, "../../pages/RecruiterSubmissions.tsx"),
    "utf8",
  )

  // Adam 2026-07-27: "by default we should filter out the rejected submissions why still seeing
  // here" — the chip existed but was opt-in, so the board still opened with 679 rejected rows.
  it("hides rejected rows on first render, and the chip it names exists", () => {
    assert.match(pageSource, /defaultChips:\s*\{\s*triage:\s*\[\s*"hideClosed"\s*\]\s*\}/)
    assert.match(pageSource, /id:\s*"triage"/)
    assert.match(pageSource, /key:\s*"hideClosed"/)
  })

  it("keeps it a chip, not a hard prefilter, so rejected rows stay one click away", () => {
    assert.doesNotMatch(pageSource, /prefilter:.*NEGATIVE_SUBMISSION_STATUSES/s)
  })
})
