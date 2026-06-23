import assert from "node:assert/strict"
import test from "node:test"
import { descriptionMdToJdBlocks } from "./job-description.js"

test("descriptionMdToJdBlocks returns [] for empty/absent input", () => {
  assert.deepEqual(descriptionMdToJdBlocks(undefined), [])
  assert.deepEqual(descriptionMdToJdBlocks(null), [])
  assert.deepEqual(descriptionMdToJdBlocks("   "), [])
})

test("descriptionMdToJdBlocks splits a real JD into heading + body blocks", () => {
  const md = [
    "## About Invoko",
    "Invoko is building AI that connects with people.",
    "",
    "## What you'll own",
    "- Drive product design across core features",
    "- Own and evolve the design system",
    "",
    "## Who we're looking for",
    "- 1-3 years product design experience",
  ].join("\n")
  const blocks = descriptionMdToJdBlocks(md)
  assert.equal(blocks.length, 3)
  assert.equal(blocks[0].heading, "About Invoko")
  assert.equal(blocks[0].kind, "prose")
  assert.match(blocks[0].body ?? "", /connects with people/)

  assert.equal(blocks[1].heading, "What you'll own")
  assert.equal(blocks[1].kind, "list")
  // Bullets live in body as markdown so RoleSheetPage (body-only) renders them.
  assert.match(blocks[1].body ?? "", /^- Drive product design/m)
  assert.match(blocks[1].body ?? "", /^- Own and evolve/m)

  assert.equal(blocks[2].heading, "Who we're looking for")
})

test("descriptionMdToJdBlocks keeps visa lines (recruiter is internal, not stripped)", () => {
  const md = ["## Logistics", "- Visa: OPT / H-1B sponsorship available"].join("\n")
  const blocks = descriptionMdToJdBlocks(md)
  assert.equal(blocks.length, 1)
  assert.match(blocks[0].body ?? "", /Visa: OPT \/ H-1B sponsorship available/)
})

test("descriptionMdToJdBlocks handles **bold** and content before the first heading", () => {
  const md = ["Intro line with no heading.", "**Responsibilities**", "- Ship things"].join("\n")
  const blocks = descriptionMdToJdBlocks(md)
  // "Intro line with no heading." ends with "." → body of a leading headless block.
  assert.equal(blocks[0].heading, undefined)
  assert.match(blocks[0].body ?? "", /Intro line/)
  assert.equal(blocks[1].heading, "Responsibilities")
  assert.match(blocks[1].body ?? "", /^- Ship things/m)
})
