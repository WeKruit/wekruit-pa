/**
 * Phase 38 T3 — extractor-config audit tests.
 *
 * Coverage (per CONTEXT D-38-5):
 * - Default fallback `Qwen/Qwen2.5-72B-Instruct` when env unset
 * - Empty/whitespace env → falls back to default
 * - Qwen-72B / Qwen-7B → pinned: true
 * - Qwen-1.5B / mini / tiny / small → pinned: false (with warning)
 * - assertExtractorPinnedOrThrow respects PA_MEMORY_EXTRACTOR_HARDFAIL
 */
import assert from "node:assert/strict"
import test from "node:test"

import {
  MEMORY_POLICY_DEFAULT_EXTRACTOR,
  assertExtractorPinnedOrThrow,
  pinnedExtractorModel,
  verifyExtractorPinned,
} from "./extractor-config.js"

function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => void | Promise<void>
): void | Promise<void> {
  const orig: Record<string, string | undefined> = {}
  for (const k of Object.keys(vars)) {
    orig[k] = process.env[k]
    if (vars[k] === undefined) delete process.env[k]
    else process.env[k] = vars[k]!
  }
  const restore = () => {
    for (const k of Object.keys(orig)) {
      if (orig[k] === undefined) delete process.env[k]
      else process.env[k] = orig[k]!
    }
  }
  try {
    const r = fn()
    if (r instanceof Promise) {
      return r.finally(restore)
    }
    restore()
  } catch (err) {
    restore()
    throw err
  }
}

test("pinnedExtractorModel: env unset → default Qwen/Qwen2.5-72B-Instruct", () => {
  withEnv({ MEM0_LLM_MODEL: undefined }, () => {
    assert.equal(pinnedExtractorModel(), MEMORY_POLICY_DEFAULT_EXTRACTOR)
  })
})

test("pinnedExtractorModel: env empty string → default", () => {
  withEnv({ MEM0_LLM_MODEL: "" }, () => {
    assert.equal(pinnedExtractorModel(), MEMORY_POLICY_DEFAULT_EXTRACTOR)
  })
})

test("pinnedExtractorModel: env whitespace-only → default", () => {
  withEnv({ MEM0_LLM_MODEL: "   " }, () => {
    assert.equal(pinnedExtractorModel(), MEMORY_POLICY_DEFAULT_EXTRACTOR)
  })
})

test("pinnedExtractorModel: env populated → trimmed value", () => {
  withEnv({ MEM0_LLM_MODEL: "  Qwen/Qwen2.5-7B-Instruct  " }, () => {
    assert.equal(pinnedExtractorModel(), "Qwen/Qwen2.5-7B-Instruct")
  })
})

test("verifyExtractorPinned: Qwen-72B-Instruct → pinned: true", () => {
  withEnv({ MEM0_LLM_MODEL: "Qwen/Qwen2.5-72B-Instruct" }, () => {
    const r = verifyExtractorPinned()
    assert.equal(r.pinned, true)
    assert.equal(r.warning, null)
    assert.equal(r.model, "Qwen/Qwen2.5-72B-Instruct")
  })
})

test("verifyExtractorPinned: Qwen-7B-Instruct → pinned: true", () => {
  withEnv({ MEM0_LLM_MODEL: "Qwen/Qwen2.5-7B-Instruct" }, () => {
    const r = verifyExtractorPinned()
    assert.equal(r.pinned, true)
  })
})

test("verifyExtractorPinned: Qwen-1.5B-Instruct → pinned: false (warning includes 1.5b)", () => {
  withEnv({ MEM0_LLM_MODEL: "Qwen/Qwen2.5-1.5B-Instruct" }, () => {
    const r = verifyExtractorPinned()
    assert.equal(r.pinned, false)
    assert.ok(r.warning !== null)
    assert.match(r.warning!, /1\.5b/i)
  })
})

test("verifyExtractorPinned: qwen-mini → pinned: false (warning includes mini)", () => {
  withEnv({ MEM0_LLM_MODEL: "qwen-mini" }, () => {
    const r = verifyExtractorPinned()
    assert.equal(r.pinned, false)
    assert.match(r.warning!, /mini/)
  })
})

test("verifyExtractorPinned: model name with 'tiny' → pinned: false", () => {
  withEnv({ MEM0_LLM_MODEL: "tiny-model-7B" }, () => {
    const r = verifyExtractorPinned()
    assert.equal(r.pinned, false)
    assert.match(r.warning!, /tiny/)
  })
})

test("verifyExtractorPinned: model name with 'Small' (case-insensitive) → pinned: false", () => {
  withEnv({ MEM0_LLM_MODEL: "Some-Small-Model" }, () => {
    const r = verifyExtractorPinned()
    assert.equal(r.pinned, false)
    assert.match(r.warning!, /small/)
  })
})

test("verifyExtractorPinned: model with 0.5B → pinned: false", () => {
  withEnv({ MEM0_LLM_MODEL: "Qwen/Qwen2.5-0.5B-Instruct" }, () => {
    const r = verifyExtractorPinned()
    assert.equal(r.pinned, false)
    assert.match(r.warning!, /0\.5b/i)
  })
})

test("verifyExtractorPinned: model with 0.6B → pinned: false", () => {
  withEnv({ MEM0_LLM_MODEL: "qwen3-0.6B-instruct" }, () => {
    const r = verifyExtractorPinned()
    assert.equal(r.pinned, false)
    assert.match(r.warning!, /0\.6b/i)
  })
})

test("assertExtractorPinnedOrThrow: pinned model → returns silently", () => {
  withEnv({ MEM0_LLM_MODEL: "Qwen/Qwen2.5-72B-Instruct" }, () => {
    const r = assertExtractorPinnedOrThrow()
    assert.equal(r.pinned, true)
  })
})

test("assertExtractorPinnedOrThrow: bad model + HARDFAIL=true → throws", () => {
  withEnv(
    {
      MEM0_LLM_MODEL: "Qwen/Qwen2.5-1.5B-Instruct",
      PA_MEMORY_EXTRACTOR_HARDFAIL: "true",
    },
    () => {
      assert.throws(
        () => assertExtractorPinnedOrThrow(),
        /HARD-FAIL.*1\.5b/i
      )
    }
  )
})

test("assertExtractorPinnedOrThrow: bad model + HARDFAIL unset → does NOT throw (logs only)", () => {
  withEnv(
    {
      MEM0_LLM_MODEL: "Qwen/Qwen2.5-1.5B-Instruct",
      PA_MEMORY_EXTRACTOR_HARDFAIL: undefined,
    },
    () => {
      // Should not throw; returns the result with pinned: false.
      const r = assertExtractorPinnedOrThrow()
      assert.equal(r.pinned, false)
    }
  )
})

test("assertExtractorPinnedOrThrow: bad model + HARDFAIL='false' → does NOT throw", () => {
  withEnv(
    {
      MEM0_LLM_MODEL: "Qwen/Qwen2.5-1.5B-Instruct",
      PA_MEMORY_EXTRACTOR_HARDFAIL: "false",
    },
    () => {
      const r = assertExtractorPinnedOrThrow()
      assert.equal(r.pinned, false)
    }
  )
})

test("assertExtractorPinnedOrThrow: bad model + HARDFAIL='True' (case-insensitive) → throws", () => {
  withEnv(
    {
      MEM0_LLM_MODEL: "Qwen/Qwen2.5-1.5B-Instruct",
      PA_MEMORY_EXTRACTOR_HARDFAIL: "True",
    },
    () => {
      // 'True' (capital T) → toLowerCase() === 'true' → matches → throws
      assert.throws(() => assertExtractorPinnedOrThrow())
    }
  )
})

test("assertExtractorPinnedOrThrow: bad model + HARDFAIL='1' (non-true value) → does NOT throw", () => {
  withEnv(
    {
      MEM0_LLM_MODEL: "Qwen/Qwen2.5-1.5B-Instruct",
      PA_MEMORY_EXTRACTOR_HARDFAIL: "1",
    },
    () => {
      // '1' is not 'true' → no throw, logs only
      const r = assertExtractorPinnedOrThrow()
      assert.equal(r.pinned, false)
    }
  )
})
