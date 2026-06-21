import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  boardSubmissionRankKey,
  compareRankKeys,
  confidenceBand,
  aiVerdictRank,
  type RankableSubmission,
} from "../board-submission-rank.js"

type Verdict = "advance" | "borderline" | "reject"

function sub(opts: {
  verdict?: Verdict
  confidence?: number
  hard?: [number, number]
  fit?: [number, number]
  bonus?: [number, number]
  anti?: [number, number]
}): RankableSubmission {
  const tally = (t?: [number, number]) => (t ? { met: t[0], total: t[1] } : undefined)
  return {
    aiEvaluation: {
      verdict: opts.verdict,
      confidence: opts.confidence,
      checklist: {
        hard: tally(opts.hard),
        fit: tally(opts.fit),
        bonus: tally(opts.bonus),
        anti: opts.anti ? { flagged: opts.anti[0], total: opts.anti[1] } : undefined,
      },
    },
  }
}

const sortByRank = (xs: RankableSubmission[]): RankableSubmission[] =>
  [...xs].sort((a, b) => compareRankKeys(boardSubmissionRankKey(a), boardSubmissionRankKey(b)))

const verdictOf = (s: RankableSubmission) => s.aiEvaluation?.verdict

describe("board-submission-rank", () => {
  it("verdict is non-compensatory: a confident, perfect-checklist reject never outranks a weak advance", () => {
    const strongReject = sub({ verdict: "reject", confidence: 0.99, hard: [4, 4], fit: [3, 3], bonus: [2, 2] })
    const weakAdvance = sub({ verdict: "advance", confidence: 0.5, hard: [0, 4] })
    const ordered = sortByRank([strongReject, weakAdvance])
    assert.equal(verdictOf(ordered[0]!), "advance", "advance must come first regardless of the reject's confidence/checklist")
  })

  it("orders strictly advance → borderline → reject", () => {
    const ordered = sortByRank([
      sub({ verdict: "reject", confidence: 0.9 }),
      sub({ verdict: "advance", confidence: 0.5 }),
      sub({ verdict: "borderline", confidence: 0.95 }),
    ])
    assert.deepEqual(ordered.map(verdictOf), ["advance", "borderline", "reject"])
  })

  it("ranks unscored / errored submissions below any verdict", () => {
    const ordered = sortByRank([
      { aiEvaluation: undefined },
      sub({ verdict: "reject", confidence: 0.9 }),
    ])
    assert.equal(verdictOf(ordered[0]!), "reject")
  })

  it("uses a confidence BAND, not raw confidence (0.95 does not beat 0.90 within the same band)", () => {
    // Same verdict, same band (both ≥0.8), identical sub-scores → no reorder by raw confidence.
    const c95 = sub({ verdict: "advance", confidence: 0.95, hard: [2, 4] })
    const c90 = sub({ verdict: "advance", confidence: 0.9, hard: [2, 4] })
    assert.equal(compareRankKeys(boardSubmissionRankKey(c95), boardSubmissionRankKey(c90)), 0, "same band + same sub-scores must tie")
    // But a higher band does win.
    const lowBand = sub({ verdict: "advance", confidence: 0.6, hard: [2, 4] })
    const [first] = sortByRank([lowBand, c90])
    assert.equal(first!.aiEvaluation?.confidence, 0.9, "high band (0.9) ranks above mid band (0.6)")
    assert.deepEqual([confidenceBand(0.95), confidenceBand(0.6), confidenceBand(0.3)], [2, 1, 0])
  })

  it("tie-breaks within the same (verdict, band) cohort by hard-checklist ratio first", () => {
    const moreHard = sub({ verdict: "advance", confidence: 0.9, hard: [4, 4], fit: [0, 3] })
    const lessHard = sub({ verdict: "advance", confidence: 0.9, hard: [1, 4], fit: [3, 3] })
    const [first] = sortByRank([lessHard, moreHard])
    assert.equal(first, moreHard, "hard ratio dominates fit within the cohort")
  })

  it("aiVerdictRank: advance(3) > borderline(2) > reject(1) > none(0)", () => {
    assert.equal(aiVerdictRank({ verdict: "advance" }), 3)
    assert.equal(aiVerdictRank({ verdict: "borderline" }), 2)
    assert.equal(aiVerdictRank({ verdict: "reject" }), 1)
    assert.equal(aiVerdictRank(undefined), 0)
    assert.equal(aiVerdictRank({ verdict: "advance", error: "x" }), 0, "errored eval is unscored")
  })

  it("dominance guardrail: a dominated submission never ranks above its dominator", () => {
    // Build a small pool with random-ish but fixed combos (no Math.random — deterministic).
    const verdicts: Verdict[] = ["advance", "borderline", "reject"]
    const confs = [0.95, 0.7, 0.3]
    const hards: Array<[number, number]> = [[4, 4], [2, 4], [0, 4]]
    const pool: RankableSubmission[] = []
    for (const v of verdicts) for (const c of confs) for (const h of hards) {
      pool.push(sub({ verdict: v, confidence: c, hard: h, fit: [1, 3], bonus: [0, 2], anti: [0, 2] }))
    }
    const sorted = sortByRank(pool)
    const key = (s: RankableSubmission) => boardSubmissionRankKey(s)
    const dominates = (a: readonly number[], b: readonly number[]) =>
      a.every((v, i) => v >= (b[i] ?? 0)) && a.some((v, i) => v > (b[i] ?? 0))
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        // sorted[i] is ranked at or above sorted[j]; it must not be DOMINATED by it.
        assert.ok(!dominates(key(sorted[j]!), key(sorted[i]!)), `rank inversion: #${j} dominates #${i}`)
      }
    }
  })
})
