/**
 * Phase 36 T2 — EN policy bank tests.
 *
 * Same guards as ZH:
 *   1. Type priority order: bank entries are ordered self_correct →
 *      hesitate → clarify → uncertainty.
 *   2. Anti-blacklist: NO marker collides with FILLER_BLACKLIST_EN from
 *      `tests/scenarios/lib/voice-axes.mjs`. Build fails on collision.
 *   3. Lang tagged correctly: every policy.lang === "en".
 */
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { POLICIES_EN } from "./policies-en.js"
import type { InjectionType } from "./types.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const VOICE_AXES_PATH = resolve(
  __dirname,
  "../../../../../tests/scenarios/lib/voice-axes.mjs"
)

describe("Phase 36 T2 — POLICIES_EN bank", () => {
  test("non-empty bank with ≥ 8 markers covering all 4 types", () => {
    assert.ok(POLICIES_EN.length >= 8, `expected ≥ 8 markers, got ${POLICIES_EN.length}`)
    const types = new Set<InjectionType>(POLICIES_EN.map((p) => p.type))
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
    for (const p of POLICIES_EN) {
      const r = priorityRank[p.type]
      assert.ok(
        r >= lastRank,
        `type priority broken at "${p.marker}" (type=${p.type}, prev rank=${lastRank}, this rank=${r})`
      )
      lastRank = r
    }
  })

  test("every policy.lang === 'en'", () => {
    for (const p of POLICIES_EN) {
      assert.equal(p.lang, "en", `policy "${p.marker}" has wrong lang ${p.lang}`)
    }
  })

  test("every marker is non-empty", () => {
    for (const p of POLICIES_EN) {
      assert.ok(p.marker.length > 0, `empty marker for type ${p.type}`)
    }
  })

  test("ANTI-BLACKLIST: no marker collides with FILLER_BLACKLIST_EN (case-insensitive)", async () => {
    const { FILLER_BLACKLIST_EN } = (await import(`file://${VOICE_AXES_PATH}`)) as {
      FILLER_BLACKLIST_EN: string[]
    }
    assert.ok(
      Array.isArray(FILLER_BLACKLIST_EN) && FILLER_BLACKLIST_EN.length > 0,
      "FILLER_BLACKLIST_EN not loaded — fix path"
    )

    for (const policy of POLICIES_EN) {
      const m = policy.marker.toLowerCase()
      for (const phrase of FILLER_BLACKLIST_EN) {
        const p = phrase.toLowerCase()
        if (p.includes(m)) {
          assert.fail(
            `Policy marker "${policy.marker}" is a substring of blacklist phrase "${phrase}"`
          )
        }
        if (m.includes(p)) {
          assert.fail(
            `Policy marker "${policy.marker}" CONTAINS blacklist phrase "${phrase}"`
          )
        }
      }
    }
  })

  test("markers are unique within bank", () => {
    const seen = new Set<string>()
    for (const p of POLICIES_EN) {
      assert.ok(!seen.has(p.marker), `duplicate marker: ${p.marker}`)
      seen.add(p.marker)
    }
  })
})
