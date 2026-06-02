import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { buildCandidateProofPromptItems } from "../RecruiterRolePacket.helpers.js"

describe("buildCandidateProofPromptItems", () => {
  it("turns every missing hard requirement into an ordered note prompt", () => {
    const items = buildCandidateProofPromptItems({
      missingHard: [
        "5+ years backend engineering",
        "Production AI workflow ownership",
        "New York timezone overlap",
      ],
    })

    assert.deepEqual(items.map((item) => item.detail), [
      "5+ years backend engineering",
      "Production AI workflow ownership",
      "New York timezone overlap",
    ])
    assert.equal(items[0]?.label, "Hard requirement")
    assert.equal(items[0]?.prompt, 'Proof for "5+ years backend engineering": ')
  })

  it("deduplicates blank proof gaps and caps the rendered checklist", () => {
    const items = buildCandidateProofPromptItems({
      missingHard: [
        "Healthcare domain experience",
        "",
        "Healthcare domain experience",
        "Managed enterprise integrations",
        "SOC 2 exposure",
      ],
      maxItems: 2,
    })

    assert.deepEqual(items.map((item) => item.detail), [
      "Healthcare domain experience",
      "Managed enterprise integrations",
    ])
  })
})
