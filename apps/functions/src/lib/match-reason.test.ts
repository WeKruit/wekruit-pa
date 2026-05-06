/**
 * iter34 sprint B.11 — formatJobMatchReason unit tests.
 *
 * Coverage:
 *   - high skill component + intersection found → lists ∩
 *   - high embedding only → "整体方向贴" / "lines up with your resume"
 *   - high sponsorship + user needs sponsor → mentions sponsor
 *   - high sponsorship + user does NOT need sponsor → suppressed
 *   - high location + user prefs set → mentions location
 *   - high location + no user prefs → suppressed
 *   - multi-dim → top 2 by weighted contribution
 *   - missing breakdown → ""
 *   - low total + nothing strong → ""
 *   - decent total + no specific dim → fallback phrase
 *   - zh / en / mixed all render
 *   - length cap respected
 *   - targetRole + embedding → "SWE direction" mention
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { formatJobMatchReason } from "./match-reason.js"
import type { ScoreBreakdown } from "@pa/job-rec"

const zeroBreakdown: ScoreBreakdown = {
  skill: 0,
  embedding: 0,
  sponsorship: 0,
  location: 0,
  salary: 0,
  total: 0,
}

function bd(over: Partial<ScoreBreakdown>): ScoreBreakdown {
  const next = { ...zeroBreakdown, ...over }
  // Auto-recompute total from documented weights so tests don't have to.
  next.total =
    0.35 * next.skill +
    0.3 * next.embedding +
    0.15 * next.sponsorship +
    0.15 * next.location +
    0.05 * next.salary
  return next
}

describe("formatJobMatchReason", () => {
  it("missing matchScore → empty string", () => {
    const out = formatJobMatchReason(
      { jobTitle: "SWE", requiredSkills: [] },
      "zh",
      { userSkills: ["python"] }
    )
    assert.equal(out, "")
  })

  it("high skill + skills ∩ found → lists 2 matches (zh)", () => {
    const out = formatJobMatchReason(
      {
        jobTitle: "Backend Engineer",
        matchScore: { breakdown: bd({ skill: 1.0 }) },
        requiredSkills: ["Node.js", "React", "Postgres"],
      },
      "zh",
      { userSkills: ["Node.js", "React", "TypeScript"] }
    )
    assert.match(out, /Node\.js/)
    assert.match(out, /React/)
    assert.match(out, /命中/)
  })

  it("high skill + skills ∩ found (en)", () => {
    const out = formatJobMatchReason(
      {
        jobTitle: "Backend Engineer",
        matchScore: { breakdown: bd({ skill: 1.0 }) },
        requiredSkills: ["Go", "Kubernetes"],
      },
      "en",
      { userSkills: ["Go", "Kubernetes"] }
    )
    assert.match(out, /matches/)
    assert.match(out, /Go/)
  })

  it("high skill + skills ∩ (mixed lang)", () => {
    const out = formatJobMatchReason(
      {
        jobTitle: "ML Engineer",
        matchScore: { breakdown: bd({ skill: 0.8 }) },
        requiredSkills: ["PyTorch"],
      },
      "mixed",
      { userSkills: ["PyTorch"] }
    )
    assert.match(out, /PyTorch/)
    assert.match(out, /命中/)
  })

  it("high embedding only → vibe phrase (zh, no targetRole)", () => {
    const out = formatJobMatchReason(
      {
        jobTitle: "SWE",
        matchScore: { breakdown: bd({ embedding: 0.9 }) },
      },
      "zh",
      {}
    )
    assert.match(out, /方向|贴近/)
  })

  it("high embedding + targetRole=['swe'] → SWE-aligned phrase (en)", () => {
    const out = formatJobMatchReason(
      {
        jobTitle: "SWE",
        matchScore: { breakdown: bd({ embedding: 0.85 }) },
      },
      "en",
      { targetRole: ["swe"] }
    )
    assert.match(out, /SWE/i)
  })

  it("user needs sponsor + job offers sponsor + sponsorship score 1.0 → mentions sponsor (zh)", () => {
    const out = formatJobMatchReason(
      {
        jobTitle: "SWE",
        matchScore: { breakdown: bd({ sponsorship: 1.0, embedding: 0.3 }) },
        sponsorship: true,
      },
      "zh",
      { visaStatus: "opt" }
    )
    assert.match(out, /sponsor/)
  })

  it("user does NOT need sponsor → sponsorship suppressed even if score=1", () => {
    const out = formatJobMatchReason(
      {
        jobTitle: "SWE",
        matchScore: { breakdown: bd({ sponsorship: 1.0, embedding: 0.5 }) },
        sponsorship: true,
      },
      "zh",
      { visaStatus: "citizen" }
    )
    assert.doesNotMatch(out, /sponsor/)
  })

  it("high location + user has location pref → mentions location (zh)", () => {
    const out = formatJobMatchReason(
      {
        jobTitle: "SWE",
        matchScore: { breakdown: bd({ location: 1.0, embedding: 0.3 }) },
        locationRaw: "San Francisco, CA",
      },
      "zh",
      { targetLocations: ["sf"] }
    )
    assert.match(out, /地点|sf/)
  })

  it("high location + no location pref → location suppressed", () => {
    const out = formatJobMatchReason(
      {
        jobTitle: "SWE",
        matchScore: { breakdown: bd({ location: 1.0 }) },
      },
      "zh",
      {}
    )
    // No skills, no embedding, no sponsorship, no location-pref. Total
    // ≈ 0.15 < 0.4 → empty.
    assert.equal(out, "")
  })

  it("multi-dim → top 2 by weighted contribution (skill 1.0 wins over location 1.0)", () => {
    const out = formatJobMatchReason(
      {
        jobTitle: "SWE",
        matchScore: {
          breakdown: bd({ skill: 1.0, embedding: 0.5, location: 1.0 }),
        },
        requiredSkills: ["Go"],
        locationRaw: "SF",
      },
      "zh",
      {
        userSkills: ["Go"],
        targetLocations: ["sf"],
      }
    )
    // skill 0.35 > embedding 0.15 > location 0.15. Top 2 → skill + embedding.
    assert.match(out, /Go/)
    // Ensure there's a second clause separator OR sufficient length.
    assert.ok(out.length > 4)
  })

  it("only weak signals + total ≥ 0.4 → conservative fallback phrase", () => {
    const out = formatJobMatchReason(
      {
        jobTitle: "SWE",
        matchScore: { breakdown: bd({ embedding: 0.6, sponsorship: 0.5 }) },
      },
      "zh",
      {} // no visa, no skills, no role
    )
    // sponsorship 0.5 not high enough to fire, no user-need anyway. Embedding
    // fires → renders vibe phrase.
    assert.ok(out.length > 0)
  })

  it("low total + nothing strong → empty (graceful fallback)", () => {
    const out = formatJobMatchReason(
      {
        jobTitle: "SWE",
        matchScore: { breakdown: bd({ embedding: 0, sponsorship: 0.2 }) },
      },
      "zh",
      {}
    )
    assert.equal(out, "")
  })

  it("output respects zh length cap (≤50)", () => {
    const out = formatJobMatchReason(
      {
        jobTitle: "SWE",
        matchScore: { breakdown: bd({ skill: 1.0, embedding: 1.0 }) },
        requiredSkills: ["Node.js", "React", "TypeScript", "Postgres", "Docker"],
      },
      "zh",
      {
        userSkills: ["Node.js", "React"],
        targetRole: ["swe"],
      }
    )
    assert.ok(out.length <= 50, `expected ≤50 chars, got ${out.length}: ${out}`)
  })

  it("output respects en length cap (≤70)", () => {
    const out = formatJobMatchReason(
      {
        jobTitle: "SWE",
        matchScore: { breakdown: bd({ skill: 1.0, embedding: 1.0 }) },
        requiredSkills: ["Node.js", "React"],
      },
      "en",
      {
        userSkills: ["Node.js", "React"],
        targetRole: ["swe"],
      }
    )
    assert.ok(out.length <= 70, `expected ≤70 chars, got ${out.length}: ${out}`)
  })

  it("skill score high but no actual ∩ in surfaced lists → renders empty for that dim, falls back", () => {
    // scoreJob's Jaccard fired on a skill not present in caller's userSkills
    // (e.g. CV had "go" but topSkills only surfaces ["python"]). We'd lose
    // the skill clause, so we expect either "" or a fallback from another dim.
    const out = formatJobMatchReason(
      {
        jobTitle: "SWE",
        matchScore: { breakdown: bd({ skill: 1.0, embedding: 0.5 }) },
        requiredSkills: ["go"],
      },
      "zh",
      { userSkills: ["python"] } // no overlap with required ["go"]
    )
    // skill clause empty → falls back to embedding phrase.
    assert.match(out, /方向|贴近/)
  })
})
