import assert from "node:assert/strict"
import test from "node:test"

import { buildRichMatchReason, humanizeToken } from "../match-reason.js"

// The flagged Helium card from Adam's directive: a full-stack product role at an
// early-stage SF startup; candidate React/TS + backend, junior, comp + early
// equity stated. The reason must NAME the specific bridge — never the old
// "matches skills: java, javascript." template.
test("buildRichMatchReason composes a compelling multi-signal pitch (Helium-style)", () => {
  const reason = buildRichMatchReason({
    candidate: {
      skills: [{ name: "React" }, { name: "TypeScript" }, { name: "Node.js" }, { name: "PostgreSQL" }],
      careerStage: "junior",
      targetCompanyTags: ["compensation", "early_equity"],
      preferredLang: "en",
    },
    job: {
      jobTitle: "Full-Stack Engineer",
      companyName: "Helium",
      companySize: "early_startup",
      seniorityLevel: "junior",
      requiredSkills: ["React", "TypeScript", "Node.js"],
    },
    matchedSkills: [
      { name: "React", proficiency: "advanced" },
      { name: "TypeScript", proficiency: "advanced" },
    ],
    lang: "en",
  })

  // Names the role + company + stage.
  assert.match(reason, /Full-Stack Engineer at Helium/)
  assert.match(reason, /early-stage startup/)
  // Cites the actual matched stack.
  assert.match(reason, /React/)
  assert.match(reason, /background fits the stack/)
  // Seniority fit lines up.
  assert.match(reason, /junior level lines up/)
  // Lands the stated-priority angle Adam flagged as missing.
  assert.match(reason, /leans into/)
  assert.match(reason, /comp/)
  assert.match(reason, /equity/)
  assert.match(reason, /you said matter most/)

  // NEVER the weak templates.
  assert.doesNotMatch(reason, /Matches your resume skills:/i)
  assert.doesNotMatch(reason, /Aligned with your target role area:/i)
})

test("buildRichMatchReason folds in industry + location when present", () => {
  const reason = buildRichMatchReason({
    candidate: {
      skills: ["python", "sql"],
      industrySector: ["financial_technology"],
      relevantIndustry: ["financial_technology"],
      targetLocations: ["new york"],
      careerStage: "senior",
    },
    job: {
      jobTitle: "Backend Engineer",
      companyName: "Rain",
      industrySector: ["financial_technology"],
      seniorityLevel: "senior",
      requiredSkills: ["python", "sql"],
      locationRaw: "New York, NY",
    },
    matchedSkills: [{ name: "python" }, { name: "sql" }],
    lang: "en",
  })

  assert.match(reason, /Backend Engineer at Rain/)
  assert.match(reason, /python \+ sql/i)
  // industry "where you've worked"
  assert.match(reason, /financial technology/)
  // location works / seniority lines up — at least one secondary signal surfaces
  assert.match(reason, /location works|seniority lines up|where you've worked/)
  assert.doesNotMatch(reason, /Matches your resume skills:/i)
})

test("buildRichMatchReason degrades gracefully with thin signals but is never the weak template", () => {
  const reason = buildRichMatchReason({
    candidate: { skills: ["java"], targetRoleFunction: ["software_engineering"] },
    job: {
      jobTitle: "Software Engineer",
      companyName: "Acme",
      roleFunction: ["software_engineering"],
      // no requiredSkills overlap, no stage, no industry
    },
    lang: "en",
  })
  assert.ok(reason.length >= 8)
  // role hit surfaces as the target-area bridge when no skill overlap.
  assert.match(reason, /software engineering|Software Engineer at Acme/)
  assert.doesNotMatch(reason, /Matches your resume skills:/i)
  assert.doesNotMatch(reason, /Aligned with your target role area:/i)
})

test("buildRichMatchReason never echoes raw snake_case tokens to the user", () => {
  const reason = buildRichMatchReason({
    candidate: {
      skills: ["go"],
      industrySector: ["artificial_intelligence_and_machine_learning"],
      relevantIndustry: ["artificial_intelligence_and_machine_learning"],
    },
    job: {
      jobTitle: "ML Engineer",
      companyName: "Nyx",
      industrySector: ["artificial_intelligence_and_machine_learning"],
      requiredSkills: ["go"],
    },
    matchedSkills: [{ name: "go" }],
    lang: "en",
  })
  // industry token must be humanized, not snake_case.
  assert.doesNotMatch(reason, /artificial_intelligence_and_machine_learning/)
  assert.match(reason, /artificial intelligence and machine learning/)
})

test("buildRichMatchReason emits a Chinese pitch when preferredLang=zh", () => {
  const reason = buildRichMatchReason({
    candidate: {
      skills: [{ name: "React" }, { name: "TypeScript" }],
      careerStage: "junior",
      targetCompanyTags: ["compensation"],
      preferredLang: "zh",
    },
    job: {
      jobTitle: "全栈工程师",
      companyName: "Helium",
      companySize: "early_startup",
      seniorityLevel: "junior",
      requiredSkills: ["React", "TypeScript"],
    },
    matchedSkills: [{ name: "React" }, { name: "TypeScript" }],
  })
  assert.match(reason, /Helium/)
  assert.match(reason, /对得上/)
  assert.doesNotMatch(reason, /Matches your resume skills:/i)
})

test("humanizeToken turns snake_case into spaced words", () => {
  assert.equal(humanizeToken("software_engineering"), "software engineering")
  assert.equal(humanizeToken("financial_technology"), "financial technology")
})
