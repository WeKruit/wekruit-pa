import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, it } from "node:test"

const shellCss = readFileSync(resolve(import.meta.dirname, "../../console-shell.css"), "utf8")

describe("Recruiter submissions master-detail layout", () => {
  it("uses the full admin canvas instead of the capped page width", () => {
    assert.match(
      shellCss,
      /\.sub-masterdetail\s*\{[\s\S]*width: calc\(100vw - 240px - 64px\);[\s\S]*max-width: calc\(100vw - 240px - 64px\);[\s\S]*grid-template-columns: minmax\(640px, 0\.9fr\) minmax\(640px, 1\.1fr\);/,
    )
  })

  it("falls back to normal page width when the detail panel stacks", () => {
    assert.match(
      shellCss,
      /@media \(max-width: 1100px\) \{[\s\S]*\.sub-masterdetail\s*\{[\s\S]*width: 100%;[\s\S]*max-width: 100%;[\s\S]*grid-template-columns: minmax\(0, 1fr\);/,
    )
  })
})
