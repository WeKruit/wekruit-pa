import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { PARSED_RESUME_JSON_SCHEMA } from "../json-schema.js"
import { parsedResumeData } from "../schema.js"

describe("schema-parity (Zod ↔ OpenAI JSON Schema)", () => {
  it("Zod and JSON Schema enumerate the same top-level keys", () => {
    const zodKeys = new Set(Object.keys(parsedResumeData.shape))
    const jsKeys = new Set(Object.keys(PARSED_RESUME_JSON_SCHEMA.properties))
    assert.deepEqual(
      [...zodKeys].sort(),
      [...jsKeys].sort(),
      "Zod schema and OpenAI JSON Schema must enumerate identical top-level fields"
    )
  })

  it("required[] in JSON Schema covers every property (OpenAI strict mode)", () => {
    const properties = Object.keys(PARSED_RESUME_JSON_SCHEMA.properties)
    const required = new Set(PARSED_RESUME_JSON_SCHEMA.required)
    for (const p of properties) {
      assert.ok(
        required.has(p),
        `OpenAI strict mode requires every property to be in 'required[]' — missing: ${p}`
      )
    }
  })

  it("additionalProperties:false at top-level (strict-mode requirement)", () => {
    assert.equal(
      (PARSED_RESUME_JSON_SCHEMA as Record<string, unknown>).additionalProperties,
      false
    )
  })
})
