import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { descriptionMdToJdBlocks } from "../job-description.js"

describe("descriptionMdToJdBlocks (recruiter-board-fn copy)", () => {
  it("returns [] for empty input", () => {
    assert.deepEqual(descriptionMdToJdBlocks(undefined), [])
    assert.deepEqual(descriptionMdToJdBlocks(""), [])
  })

  it("derives heading + body blocks with non-optional string fields", () => {
    const md = ["## About", "We build things.", "## What you'll own", "- Ship features"].join("\n")
    const blocks = descriptionMdToJdBlocks(md)
    assert.equal(blocks.length, 2)
    assert.equal(blocks[0].heading, "About")
    assert.equal(typeof blocks[0].body, "string")
    assert.equal(blocks[1].heading, "What you'll own")
    assert.equal(blocks[1].kind, "list")
    assert.match(blocks[1].body, /^- Ship features/m)
  })

  it("keeps visa lines (recruiter is internal)", () => {
    const blocks = descriptionMdToJdBlocks("## Logistics\n- Visa: H-1B sponsorship available")
    assert.match(blocks[0].body, /H-1B sponsorship available/)
  })
})
