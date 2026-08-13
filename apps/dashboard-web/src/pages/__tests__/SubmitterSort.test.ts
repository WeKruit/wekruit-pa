import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { submitterSortKey, isWekruitInternalSubmitter, WEKRUIT_INTERNAL_EMAIL_DOMAIN } from "../../lib/submitter-sort.js"

/**
 * Adam 2026-07-27: "sort by recruiter, prefer 非wekruit的recruiter (for view only)".
 *
 * Real submitters measured on the live board that day — three different display names against the
 * SAME internal mailbox, which is why the rule is the domain and not the name.
 */
const INTERNAL = [
  { name: "WeKruit Admin", email: "admin1@wekruit.com" },
  { name: "Admin WeKruit", email: "admin1@wekruit.com" },
  { name: "WeKruit YC Sourcing (auto)", email: "admin1@wekruit.com" },
  { name: "Noah Liu", email: "noah.liu@wekruit.com" },
]
const EXTERNAL = [
  { name: "Elizabeth Sanda", email: "sandaelizabeth02@gmail.com" },
  { name: "sumit singh", email: "sumit@weplacedyou.com" },
  { name: "Usama Rashid", email: "usamarashid6november@gmail.com" },
]

const sorted = (rows: Array<{ name?: string | null; email?: string | null } | null | undefined>) =>
  [...rows].sort((a, b) => submitterSortKey(a).localeCompare(submitterSortKey(b)))

describe("submitter sort — external recruiters first", () => {
  it("ranks every external submitter above every internal one", () => {
    const order = sorted([...INTERNAL, ...EXTERNAL])
    const firstInternal = order.findIndex((r) => isWekruitInternalSubmitter(r?.email))
    const lastExternal = order.map((r) => !isWekruitInternalSubmitter(r?.email)).lastIndexOf(true)
    assert.ok(lastExternal < firstInternal, `expected all external before internal, got ${order.map((r) => r?.name).join(", ")}`)
  })

  it("classifies on the domain, so a renamed internal batch is still ours", () => {
    // These three share one mailbox under three display names; a name-based rule would miss the next.
    for (const s of INTERNAL) assert.match(submitterSortKey(s), /^2\|/, `${s.name} should rank internal`)
    for (const s of EXTERNAL) assert.match(submitterSortKey(s), /^0\|/, `${s.name} should rank external`)
  })

  it("does not mistake a lookalike domain for ours", () => {
    assert.match(submitterSortKey({ name: "X", email: "a@notwekruit.com" }), /^0\|/)
    assert.match(submitterSortKey({ name: "X", email: "a@wekruit.com.evil.co" }), /^0\|/)
    assert.match(submitterSortKey({ name: "X", email: "a@WEKRUIT.COM" }), /^2\|/, "case must not matter")
  })

  it("ranks an unclassifiable submitter between the two, never hidden", () => {
    assert.match(submitterSortKey({ name: "Legacy Row", email: "" }), /^1\|/)
    assert.match(submitterSortKey(undefined), /^1\|/)
    assert.match(submitterSortKey(null), /^1\|/)
  })

  it("orders alphabetically inside each band", () => {
    const order = sorted([
      { name: "Zoe External", email: "zoe@other.com" },
      { name: "Adam External", email: "adam@other.com" },
    ]).map((r) => r?.name)
    assert.deepEqual(order, ["Adam External", "Zoe External"])
  })

  it("falls back to the email when a submitter has no name", () => {
    assert.equal(submitterSortKey({ name: "", email: "solo@other.com" }), "0|solo@other.com")
  })
})
