/**
 * Phase 36 T1 — ZH policy bank tests.
 *
 * Critical guards:
 *   1. Type priority order: bank entries are ordered self_correct →
 *      hesitate → clarify → uncertainty.
 *   2. Anti-blacklist: NO marker collides with FILLER_BLACKLIST_ZH from
 *      `tests/scenarios/lib/voice-axes.mjs`. Build fails on collision.
 *   3. Lang tagged correctly: every policy.lang === "zh".
 */
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { POLICIES_ZH } from "./policies-zh.js"
import type { InjectionType } from "./types.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
// Load the source-of-truth blacklist via dynamic import. Module is .mjs
// living outside src/ — we use a relative path resolved from this file.
const VOICE_AXES_PATH = resolve(
  __dirname,
  "../../../../../tests/scenarios/lib/voice-axes.mjs"
)

describe("Phase 36 T1 — POLICIES_ZH bank", () => {
  test("non-empty bank with ≥ 8 markers covering all 4 types", () => {
    assert.ok(POLICIES_ZH.length >= 8, `expected ≥ 8 markers, got ${POLICIES_ZH.length}`)
    const types = new Set<InjectionType>(POLICIES_ZH.map((p) => p.type))
    assert.ok(types.has("self_correct"), "missing self_correct")
    assert.ok(types.has("hesitate"), "missing hesitate")
    assert.ok(types.has("clarify"), "missing clarify")
    assert.ok(types.has("uncertainty"), "missing uncertainty")
  })

  test("type priority order: self_correct → hesitate → clarify → uncertainty", () => {
    const priorityRank: Record<InjectionType, number> = {
      self_correct: 0,
      hesitate: 1,
      clarify: 2,
      uncertainty: 3,
    }
    let lastRank = -1
    for (const p of POLICIES_ZH) {
      const r = priorityRank[p.type]
      assert.ok(
        r >= lastRank,
        `type priority broken at ${p.marker} (type=${p.type}, prev rank=${lastRank}, this rank=${r})`
      )
      lastRank = r
    }
  })

  test("every policy.lang === 'zh'", () => {
    for (const p of POLICIES_ZH) {
      assert.equal(p.lang, "zh", `policy ${p.marker} has wrong lang ${p.lang}`)
    }
  })

  test("every marker is non-empty", () => {
    for (const p of POLICIES_ZH) {
      assert.ok(p.marker.length > 0, `empty marker for type ${p.type}`)
    }
  })

  test("ANTI-BLACKLIST: no marker collides with FILLER_BLACKLIST_ZH", async () => {
    // Dynamic import of the .mjs blacklist via file: URL.
    const { FILLER_BLACKLIST_ZH } = (await import(`file://${VOICE_AXES_PATH}`)) as {
      FILLER_BLACKLIST_ZH: string[]
    }
    assert.ok(
      Array.isArray(FILLER_BLACKLIST_ZH) && FILLER_BLACKLIST_ZH.length > 0,
      "FILLER_BLACKLIST_ZH not loaded — fix path"
    )

    for (const policy of POLICIES_ZH) {
      for (const phrase of FILLER_BLACKLIST_ZH) {
        // Either direction is a violation:
        // - blacklist phrase contains marker (marker too generic)
        // - marker contains blacklist phrase (marker explicitly forbidden)
        if (phrase.includes(policy.marker)) {
          assert.fail(
            `Policy marker "${policy.marker}" is a substring of blacklist phrase "${phrase}"`
          )
        }
        if (policy.marker.includes(phrase)) {
          assert.fail(
            `Policy marker "${policy.marker}" CONTAINS blacklist phrase "${phrase}"`
          )
        }
      }
    }
  })

  test("markers are unique within bank", () => {
    const seen = new Set<string>()
    for (const p of POLICIES_ZH) {
      assert.ok(!seen.has(p.marker), `duplicate marker: ${p.marker}`)
      seen.add(p.marker)
    }
  })
})
