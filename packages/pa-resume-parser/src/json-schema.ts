/**
 * iter30 WS1 — Pre-baked OpenAI Responses API JSON Schema for `parsedResumeData`.
 *
 * Mirrors `schema.ts` (Zod) in JSON Schema form for `text.format = { type:
 * "json_schema", strict: true }` calls. OpenAI strict mode requires every
 * property to appear in `required` (even nullable ones) and
 * `additionalProperties: false` everywhere.
 *
 * A parity test (`__tests__/schema-parity.test.ts`) ensures the field set
 * stays in lockstep with `schema.ts`.
 */

export const PARSED_RESUME_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "fullName",
    "email",
    "phone",
    "location",
    "summary",
    "skills",
    "workHistory",
    "education",
    "projects",
    "certifications",
    "languages",
    "interests",
    "awards",
    "volunteerWork",
    "websites",
    "totalYearsExperience",
    "workAuthorization",
    "parseConfidence",
    "inferredAnswers",
  ],
  properties: {
    fullName: { type: ["string", "null"] },
    email: { type: ["string", "null"] },
    phone: { type: ["string", "null"] },
    location: { type: ["string", "null"] },
    summary: { type: ["string", "null"] },
    totalYearsExperience: { type: ["number", "null"] },
    workAuthorization: { type: ["string", "null"] },
    parseConfidence: { type: "number", minimum: 0, maximum: 1 },
    skills: { type: "array", items: { type: "string" } },
    certifications: { type: "array", items: { type: "string" } },
    languages: { type: "array", items: { type: "string" } },
    interests: { type: "array", items: { type: "string" } },
    websites: { type: "array", items: { type: "string" } },
    workHistory: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "title",
          "company",
          "location",
          "experienceType",
          "startDate",
          "endDate",
          "currentRole",
          "description",
          "bullets",
          "achievements",
        ],
        properties: {
          title: { type: "string" },
          company: { type: "string" },
          location: { type: ["string", "null"] },
          experienceType: {
            type: ["string", "null"],
            enum: [
              "full-time",
              "part-time",
              "contract",
              "internship",
              "freelance",
              "volunteer",
              null,
            ],
          },
          startDate: { type: ["string", "null"] },
          endDate: { type: ["string", "null"] },
          currentRole: { type: ["boolean", "null"] },
          description: { type: ["string", "null"] },
          bullets: { type: "array", items: { type: "string" } },
          achievements: { type: "array", items: { type: "string" } },
        },
      },
    },
    education: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "school",
          "degree",
          "degreeType",
          "fieldOfStudy",
          "major",
          "gpa",
          "startDate",
          "endDate",
          "expectedGraduation",
          "honors",
        ],
        properties: {
          school: { type: "string" },
          degree: { type: "string" },
          degreeType: {
            type: ["string", "null"],
            enum: [
              "high-school",
              "associate",
              "bachelor-of-arts",
              "bachelor-of-science",
              "master-of-arts",
              "master-of-science",
              "mba",
              "phd",
              "md",
              "jd",
              "other",
              null,
            ],
          },
          fieldOfStudy: { type: ["string", "null"] },
          major: { type: ["string", "null"] },
          gpa: { type: ["string", "null"] },
          startDate: { type: ["string", "null"] },
          endDate: { type: ["string", "null"] },
          expectedGraduation: { type: ["string", "null"] },
          honors: { type: ["string", "null"] },
        },
      },
    },
    projects: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "description", "technologies", "url", "startDate", "endDate"],
        properties: {
          name: { type: "string" },
          description: { type: ["string", "null"] },
          technologies: { type: "array", items: { type: "string" } },
          url: { type: ["string", "null"] },
          startDate: { type: ["string", "null"] },
          endDate: { type: ["string", "null"] },
        },
      },
    },
    awards: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "issuer", "date"],
        properties: {
          title: { type: "string" },
          issuer: { type: ["string", "null"] },
          date: { type: ["string", "null"] },
        },
      },
    },
    volunteerWork: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["organization", "role", "description", "startDate", "endDate"],
        properties: {
          organization: { type: "string" },
          role: { type: ["string", "null"] },
          description: { type: ["string", "null"] },
          startDate: { type: ["string", "null"] },
          endDate: { type: ["string", "null"] },
        },
      },
    },
    inferredAnswers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["question", "answer", "confidence", "category"],
        properties: {
          question: { type: "string" },
          answer: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          category: {
            type: "string",
            enum: ["personal", "experience", "education", "skills", "preferences"],
          },
        },
      },
    },
  },
} as const

export const PARSED_RESUME_SCHEMA_NAME = "parsed_resume_data"
