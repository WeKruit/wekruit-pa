/**
 * Parity test — ensures `schema.ts` (Zod) and `json-schema.ts` (OpenAI
 * strict-mode JSON Schema) enumerate the same top-level keys and the
 * canonical vocabs match shared-tags.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { enrichedJobTags } from "../schema.js"
import { ENRICHED_JOB_TAGS_JSON_SCHEMA } from "../json-schema.js"
import {
  ROLE_FUNCTION_VOCAB,
  INDUSTRY_SECTOR_VOCAB,
  CAREER_STAGE_VOCAB,
  JOB_TYPE_VOCAB,
} from "@wekruit/shared-tags/canonical"

describe("schema-parity (Zod ↔ OpenAI JSON Schema)", () => {
  it("both schemas enumerate the same top-level keys", () => {
    const zodKeys = Object.keys(enrichedJobTags.shape).sort()
    const jsonKeys = Object.keys(ENRICHED_JOB_TAGS_JSON_SCHEMA.properties).sort()
    assert.deepEqual(zodKeys, jsonKeys)
  })

  it("required[] in JSON Schema covers every top-level property (strict-mode)", () => {
    const required = ENRICHED_JOB_TAGS_JSON_SCHEMA.required as readonly string[]
    const props = Object.keys(ENRICHED_JOB_TAGS_JSON_SCHEMA.properties)
    for (const p of props) {
      assert.ok(required.includes(p), `${p} must be in required[]`)
    }
  })

  it("additionalProperties:false at top level", () => {
    assert.equal(ENRICHED_JOB_TAGS_JSON_SCHEMA.additionalProperties, false)
  })

  it("roleFunction enum matches shared-tags ROLE_FUNCTION_VOCAB", () => {
    const enumVals =
      ENRICHED_JOB_TAGS_JSON_SCHEMA.properties.roleFunction.items.enum
    assert.deepEqual([...enumVals].sort(), [...ROLE_FUNCTION_VOCAB].sort())
  })

  it("industrySector enum matches shared-tags INDUSTRY_SECTOR_VOCAB", () => {
    const enumVals =
      ENRICHED_JOB_TAGS_JSON_SCHEMA.properties.industrySector.items.enum
    assert.deepEqual([...enumVals].sort(), [...INDUSTRY_SECTOR_VOCAB].sort())
  })

  it("seniorityLevel enum matches shared-tags CAREER_STAGE_VOCAB", () => {
    const enumVals = ENRICHED_JOB_TAGS_JSON_SCHEMA.properties.seniorityLevel.enum
    assert.deepEqual([...enumVals].sort(), [...CAREER_STAGE_VOCAB].sort())
  })

  it("jobType enum matches shared-tags JOB_TYPE_VOCAB", () => {
    const enumVals = ENRICHED_JOB_TAGS_JSON_SCHEMA.properties.jobType.enum
    assert.deepEqual([...enumVals].sort(), [...JOB_TYPE_VOCAB].sort())
  })
})
