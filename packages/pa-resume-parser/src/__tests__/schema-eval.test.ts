/**
 * iter30 WS1 — schema validation eval (MS7.3 acceptance gate).
 *
 * Synthesizes 10 representative LLM-output JSON payloads (each modeled
 * after a fixture archetype from ws-1-detail.md §8.4) and asserts each
 * round-trips through `parseResumeText` → `parsedResumeData.parse()`
 * without error. Pass-rate must be ≥ 95% (i.e. 0 failures permitted with
 * a 10-fixture set).
 *
 * Production fixture PDFs are stored at `tests/fixtures/resumes/` and
 * exercised via the integration test (resume-parse-e2e). This unit-eval
 * checks the schema contract independent of OpenAI availability.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { parseResumeText } from "../parser.js"
import type { OpenAIResponsesClient } from "../providers/openai-responses.js"
import { parsedResumeData, type ParsedResumeData } from "../schema.js"

function clientWithJson(json: unknown): OpenAIResponsesClient {
  return {
    responses: {
      create: async () => ({ output_text: JSON.stringify(json), usage: {} }),
    },
  }
}

const fixtures: Array<{ name: string; payload: ParsedResumeData }> = [
  {
    name: "minimal_1page",
    payload: {
      fullName: "Junior Dev",
      email: "jd@example.com",
      phone: null,
      location: "SF",
      summary: null,
      skills: ["JS"],
      workHistory: [],
      education: [],
      projects: [],
      certifications: [],
      languages: [],
      interests: [],
      awards: [],
      volunteerWork: [],
      websites: [],
      totalYearsExperience: 0,
      workAuthorization: null,
      parseConfidence: 0.5,
      inferredAnswers: [],
    },
  },
  {
    name: "dense_design_studio",
    payload: {
      fullName: "Sr Designer",
      email: "s@d.com",
      phone: "+15555550100",
      location: "NY",
      summary: "Senior product designer",
      skills: ["Figma", "Sketch", "After Effects"],
      workHistory: [
        {
          title: "Sr Designer",
          company: "Studio Co",
          location: "NY",
          experienceType: "full-time",
          startDate: "2020-01",
          endDate: null,
          currentRole: true,
          description: "Lead design",
          bullets: ["Led X", "Drove Y"],
          achievements: [],
        },
      ],
      education: [],
      projects: [],
      certifications: [],
      languages: [],
      interests: [],
      awards: [],
      volunteerWork: [],
      websites: [],
      totalYearsExperience: 6,
      workAuthorization: null,
      parseConfidence: 0.85,
      inferredAnswers: [],
    },
  },
  {
    name: "image_heavy_5MB",
    payload: {
      fullName: null, // image-heavy → text-extract may miss name
      email: null,
      phone: null,
      location: null,
      summary: null,
      skills: [],
      workHistory: [],
      education: [],
      projects: [],
      certifications: [],
      languages: [],
      interests: [],
      awards: [],
      volunteerWork: [],
      websites: [],
      totalYearsExperience: null,
      workAuthorization: null,
      parseConfidence: 0.2,
      inferredAnswers: [],
    },
  },
  {
    name: "zh_chinese",
    payload: {
      fullName: "张三",
      email: "z@s.com",
      phone: null,
      location: "上海",
      summary: "全栈工程师",
      skills: ["React", "Node"],
      workHistory: [
        {
          title: "全栈工程师",
          company: "腾讯",
          location: "深圳",
          experienceType: "full-time",
          startDate: "2018-07",
          endDate: "2022-12",
          currentRole: false,
          description: "负责微信小程序",
          bullets: [],
          achievements: [],
        },
      ],
      education: [],
      projects: [],
      certifications: [],
      languages: ["Chinese", "English"],
      interests: [],
      awards: [],
      volunteerWork: [],
      websites: [],
      totalYearsExperience: 4,
      workAuthorization: null,
      parseConfidence: 0.9,
      inferredAnswers: [
        { question: "工作年限", answer: "4年", confidence: 0.95, category: "experience" },
        { question: "期望工资", answer: "30万", confidence: 0.6, category: "preferences" },
      ],
    },
  },
  {
    name: "en_traditional_sf",
    payload: {
      fullName: "Eng Lead",
      email: "el@x.com",
      phone: "+14155550100",
      location: "Bay Area",
      summary: "Eng lead",
      skills: ["TypeScript", "Python", "Kubernetes"],
      workHistory: [],
      education: [],
      projects: [],
      certifications: ["AWS Solutions Architect"],
      languages: ["English"],
      interests: [],
      awards: [],
      volunteerWork: [],
      websites: ["https://github.com/eng"],
      totalYearsExperience: 8,
      workAuthorization: "US Citizen",
      parseConfidence: 0.92,
      inferredAnswers: [
        {
          question: "Years of experience?",
          answer: "8",
          confidence: 0.95,
          category: "experience",
        },
        {
          question: "Are you authorized to work in the US?",
          answer: "Yes, US Citizen",
          confidence: 0.99,
          category: "personal",
        },
      ],
    },
  },
  {
    name: "mixed_zh_en",
    payload: {
      fullName: "Wei Chen",
      email: null,
      phone: null,
      location: "SF / 上海",
      summary: "Bilingual engineer",
      skills: ["TypeScript", "Python"],
      workHistory: [],
      education: [],
      projects: [],
      certifications: [],
      languages: ["English", "Chinese"],
      interests: [],
      awards: [],
      volunteerWork: [],
      websites: [],
      totalYearsExperience: 5,
      workAuthorization: null,
      parseConfidence: 0.78,
      inferredAnswers: [],
    },
  },
  {
    name: "grad_student",
    payload: {
      fullName: "Grad Student",
      email: "g@s.edu",
      phone: null,
      location: "Boston",
      summary: "PhD candidate",
      skills: ["ML", "PyTorch"],
      workHistory: [],
      education: [
        {
          school: "MIT",
          degree: "PhD CS",
          degreeType: "phd",
          fieldOfStudy: "ML",
          major: "ML",
          gpa: "3.95",
          startDate: "2020-09",
          endDate: null,
          expectedGraduation: "2026-05",
          honors: null,
        },
      ],
      projects: [
        {
          name: "DistShard ML",
          description: "Distributed ML training",
          technologies: ["PyTorch"],
          url: null,
          startDate: "2023-01",
          endDate: null,
        },
      ],
      certifications: [],
      languages: [],
      interests: [],
      awards: [
        { title: "Best Paper NeurIPS 2025", issuer: "NeurIPS", date: "2025-12" },
      ],
      volunteerWork: [],
      websites: [],
      totalYearsExperience: 2,
      workAuthorization: null,
      parseConfidence: 0.88,
      inferredAnswers: [],
    },
  },
  {
    name: "career_pivot",
    payload: {
      fullName: "Pivot Person",
      email: null,
      phone: null,
      location: "Portland",
      summary: "Career pivot from law to tech",
      skills: ["JavaScript"],
      workHistory: [
        {
          title: "Lawyer",
          company: "Big Law",
          location: "DC",
          experienceType: "full-time",
          startDate: "2015-09",
          endDate: "2020-06",
          currentRole: false,
          description: null,
          bullets: [],
          achievements: [],
        },
        {
          title: "Junior SWE",
          company: "Bootcamp",
          location: "Remote",
          experienceType: "full-time",
          startDate: "2024-01",
          endDate: null,
          currentRole: true,
          description: null,
          bullets: [],
          achievements: [],
        },
      ],
      education: [],
      projects: [],
      certifications: [],
      languages: [],
      interests: [],
      awards: [],
      volunteerWork: [],
      websites: [],
      totalYearsExperience: 6,
      workAuthorization: null,
      parseConfidence: 0.7,
      inferredAnswers: [],
    },
  },
  {
    name: "h1b_visa",
    payload: {
      fullName: "Visa Holder",
      email: "v@h.com",
      phone: null,
      location: "Seattle",
      summary: "On H1B",
      skills: ["Java"],
      workHistory: [],
      education: [],
      projects: [],
      certifications: [],
      languages: [],
      interests: [],
      awards: [],
      volunteerWork: [],
      websites: [],
      totalYearsExperience: 5,
      workAuthorization: "H1B",
      parseConfidence: 0.9,
      inferredAnswers: [
        {
          question: "Do you need sponsorship?",
          answer: "Yes — currently on H1B",
          confidence: 0.95,
          category: "personal",
        },
      ],
    },
  },
  {
    name: "high_school_student",
    payload: {
      fullName: "HS Student",
      email: null,
      phone: null,
      location: "Cupertino",
      summary: null,
      skills: ["Python"],
      workHistory: [],
      education: [
        {
          school: "Cupertino HS",
          degree: "High School Diploma",
          degreeType: "high-school",
          fieldOfStudy: null,
          major: null,
          gpa: "4.0",
          startDate: "2021-09",
          endDate: null,
          expectedGraduation: "2025-06",
          honors: null,
        },
      ],
      projects: [],
      certifications: [],
      languages: [],
      interests: [],
      awards: [],
      volunteerWork: [
        {
          organization: "Local food bank",
          role: "Volunteer",
          description: null,
          startDate: "2023-06",
          endDate: null,
        },
      ],
      websites: [],
      totalYearsExperience: 0,
      workAuthorization: null,
      parseConfidence: 0.6,
      inferredAnswers: [],
    },
  },
]

describe("MS7.3 schema-validation eval (10 fixtures)", () => {
  it("each fixture round-trips through parseResumeText without error", async () => {
    let passed = 0
    let failed = 0
    const failures: string[] = []
    for (const f of fixtures) {
      try {
        const result = await parseResumeText({
          apiKey: "sk-test",
          resumeText: `stub for ${f.name}`,
          retry: { sleep: async () => {}, attempts: 1 },
          clientFactory: () => clientWithJson(f.payload),
        })
        // Final Zod check just to be safe (parseResumeText already runs it).
        parsedResumeData.parse(result.parsed)
        passed++
      } catch (err) {
        failed++
        failures.push(`${f.name}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    const passRate = passed / fixtures.length
    assert.ok(
      passRate >= 0.95,
      `pass-rate ${(passRate * 100).toFixed(1)}% < 95% — failures: ${failures.join("; ")}`
    )
    assert.equal(failed, 0, "schema-eval expects 100% (10/10) on synthesized fixtures")
  })
})
