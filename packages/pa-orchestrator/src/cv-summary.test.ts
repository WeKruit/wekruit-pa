/**
 * iter34 Sprint A.8 — tests for formatCvSummaryForUser.
 *
 * Coverage:
 *   - Full CV (topSkills + experiences) → zh / en / mixed all correct
 *   - topSkills missing, candidateProfile.skills present → falls back
 *   - skills empty, experiences present → role-only line
 *   - skills present, experiences empty → skills-only line
 *   - completely empty → fallback "info not much" line
 *   - lang=mixed → output contains both ZH and EN characters
 *   - more than 5 topSkills → truncated to 5
 *   - degenerate fields (whitespace-only strings) treated as missing
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { formatCvSummaryForUser, type CvSummaryInput } from "./cv-summary.js"

const FULL_CV: CvSummaryInput = {
  candidateProfile: { name: "Adam", skills: ["should-not-use-this"] },
  topSkills: ["Node.js", "React", "Aliyun"],
  experiences: [
    { company: "Tesla", title: "SWE" },
    { company: "OldCo", title: "Junior Dev" },
  ],
  industryTags: ["mobility"],
}

describe("formatCvSummaryForUser — full CV", () => {
  it("zh — skills + role rendered with vibe phrasing", () => {
    const out = formatCvSummaryForUser(FULL_CV, "zh")
    assert.match(out, /Node\.js \/ React \/ Aliyun/)
    assert.match(out, /在 Tesla 做 SWE/)
    assert.match(out, /资料证据/)
    // sanity — we did NOT use candidateProfile.skills (topSkills is preferred)
    assert.ok(!out.includes("should-not-use-this"))
  })

  it("en — skills + role rendered as 'title @ company'", () => {
    const out = formatCvSummaryForUser(FULL_CV, "en")
    assert.match(out, /Node\.js \/ React \/ Aliyun/)
    assert.match(out, /SWE @ Tesla/)
    assert.match(out, /profile evidence/)
  })

  it("mixed — both ZH and EN characters present", () => {
    const out = formatCvSummaryForUser(FULL_CV, "mixed")
    // ASCII letters present (skills)
    assert.match(out, /Node\.js/)
    // CJK character class present
    assert.match(out, /[一-鿿]/, "expected ZH chars in mixed output")
    // EN tech terms present
    assert.match(out, /profile evidence/)
  })
})

describe("formatCvSummaryForUser — fallback paths", () => {
  it("topSkills missing → falls back to candidateProfile.skills", () => {
    const cv: CvSummaryInput = {
      candidateProfile: { skills: ["Python", "SQL"] },
      experiences: [{ company: "DataCo", title: "Analyst" }],
    }
    const out = formatCvSummaryForUser(cv, "en")
    assert.match(out, /Python \/ SQL/)
    assert.match(out, /Analyst @ DataCo/)
  })

  it("skills empty + experiences present → role-only line (zh)", () => {
    const cv: CvSummaryInput = {
      experiences: [{ company: "Anthropic", title: "PM" }],
    }
    const out = formatCvSummaryForUser(cv, "zh")
    assert.match(out, /在 Anthropic 做 PM/)
    assert.match(out, /资料证据/)
    // no slash list since no skills
    assert.ok(!out.includes(" / "))
  })

  it("skills present + experiences empty → skills-only line (en)", () => {
    const cv: CvSummaryInput = {
      topSkills: ["Rust", "Go"],
    }
    const out = formatCvSummaryForUser(cv, "en")
    assert.match(out, /Rust \/ Go/)
    assert.match(out, /profile evidence/)
    assert.ok(!out.includes("@"))
  })

  it("completely empty CV → zh fallback message", () => {
    const out = formatCvSummaryForUser({}, "zh")
    assert.match(out, /信息不多/)
  })

  it("completely empty CV → en fallback message", () => {
    const out = formatCvSummaryForUser({}, "en")
    assert.match(out, /not much in there/)
  })

  it("completely empty CV → mixed fallback (both ZH + EN)", () => {
    const out = formatCvSummaryForUser({}, "mixed")
    assert.match(out, /[一-鿿]/)
    assert.match(out, /CV/)
  })

  it("topSkills with whitespace-only entries → ignored", () => {
    const cv: CvSummaryInput = {
      topSkills: ["  ", "", "Kubernetes", "Docker"],
      experiences: [{ company: "Meta", title: "SRE" }],
    }
    const out = formatCvSummaryForUser(cv, "en")
    // Must surface the legitimate skills
    assert.match(out, /Kubernetes/)
    assert.match(out, /Docker/)
  })
})

describe("formatCvSummaryForUser — caps + edge cases", () => {
  it("more than 5 topSkills → truncated to 5", () => {
    const cv: CvSummaryInput = {
      topSkills: ["A", "B", "C", "D", "E", "F", "G"],
    }
    const out = formatCvSummaryForUser(cv, "en")
    // First 5 present
    for (const s of ["A", "B", "C", "D", "E"]) {
      assert.ok(out.includes(s), `expected skill ${s} in output`)
    }
    // 6th + 7th NOT present (avoid menu-card vibe)
    assert.ok(!out.match(/\bF\b/), `did not expect F: ${out}`)
    assert.ok(!out.match(/\bG\b/), `did not expect G: ${out}`)
  })

  it("experiences[0] with only title → 'title' role chunk", () => {
    const cv: CvSummaryInput = {
      topSkills: ["Swift"],
      experiences: [{ title: "iOS Dev" }],
    }
    const out = formatCvSummaryForUser(cv, "en")
    assert.match(out, /Swift/)
    assert.match(out, /iOS Dev/)
    // No `@ company` since company missing
    assert.ok(!out.match(/@ /))
  })

  it("experiences[0] with only company → 'at company' style", () => {
    const cv: CvSummaryInput = {
      topSkills: ["Python"],
      experiences: [{ company: "OpenAI" }],
    }
    const out = formatCvSummaryForUser(cv, "zh")
    assert.match(out, /Python/)
    assert.match(out, /在 OpenAI/)
  })

  it("experiences[0] entirely empty (no title, no company) → drops role", () => {
    const cv: CvSummaryInput = {
      topSkills: ["TypeScript"],
      experiences: [{}],
    }
    const out = formatCvSummaryForUser(cv, "en")
    assert.match(out, /TypeScript/)
    // No role chunk
    assert.ok(!out.includes("@"))
  })
})
