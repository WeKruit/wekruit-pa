import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  appendProbeHardRule,
  parseArgs,
  JOB_PREF_PROBE_RULE,
} from "../migrate-bible-v7.6-probe.js"

describe("migrate-bible-v7.6-probe argParser", () => {
  it("defaults to dry-run", () => {
    const a = parseArgs([])
    assert.equal(a.dryRun, true)
    assert.equal(a.live, false)
    assert.equal(a.slug, "claire")
  })
  it("--live --slug=foo", () => {
    const a = parseArgs(["--live", "--slug", "foo"])
    assert.equal(a.live, true)
    assert.equal(a.dryRun, false)
    assert.equal(a.slug, "foo")
  })
})

describe("appendProbeHardRule (pure)", () => {
  const baseSections = {
    identity: "X",
    hard_rules: ["A", "B"],
    default_posture: "P",
    never_5: [],
    escape_hatch: "E",
    tone_flavors: {},
    human_tells: [],
    vocab: { allowed: [], banned: [] },
    playbooks: {},
  }

  it("appends JOB-PREF PROBE rule when not present", () => {
    const out = appendProbeHardRule(baseSections)
    assert.equal(out.hard_rules.length, 3)
    assert.match(out.hard_rules[2]!, /JOB-PREF PROBE/)
    assert.match(out.hard_rules[2]!, /SPONSORSHIP/)
    assert.match(out.hard_rules[2]!, /saveJobProfile/)
    assert.match(out.hard_rules[2]!, /tech_software/)
    assert.match(out.hard_rules[2]!, /industryTags/)
  })

  it("idempotent: re-running on already-updated sections is a no-op", () => {
    const once = appendProbeHardRule(baseSections)
    const twice = appendProbeHardRule(once)
    assert.equal(once.hard_rules.length, twice.hard_rules.length)
    // The rule string is unchanged
    assert.equal(once.hard_rules[2], twice.hard_rules[2])
  })

  it("preserves other sections verbatim", () => {
    const out = appendProbeHardRule(baseSections)
    assert.equal(out.identity, baseSections.identity)
    assert.equal(out.default_posture, baseSections.default_posture)
    assert.deepEqual(out.never_5, baseSections.never_5)
    assert.equal(out.escape_hatch, baseSections.escape_hatch)
  })

  it("rule includes all 4 probe categories: SPONSORSHIP, LOCATION, SIZE, INDUSTRY", () => {
    assert.match(JOB_PREF_PROBE_RULE, /SPONSORSHIP/)
    assert.match(JOB_PREF_PROBE_RULE, /LOCATION/)
    assert.match(JOB_PREF_PROBE_RULE, /SIZE/)
    assert.match(JOB_PREF_PROBE_RULE, /INDUSTRY/)
  })
})
