import assert from "node:assert/strict"
import test from "node:test"
import { rerankAndTrim, _TEST_CAPS } from "./mem0-rerank.js"

function withEnv<T>(key: string, value: string | undefined, fn: () => Promise<T> | T): Promise<T> {
  const prev = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prev === undefined) delete process.env[key]
      else process.env[key] = prev
    })
}

test("rerankAndTrim: empty input returns empty", async () => {
  const out = await rerankAndTrim("q", [], { rerank: async () => null })
  assert.deepEqual(out, [])
})

test("rerankAndTrim: ≤ TOP_AFTER_RERANK candidates returned untouched", async () => {
  let calls = 0
  const out = await rerankAndTrim("q", ["a", "b"], {
    rerank: async () => {
      calls++
      return [1, 0]
    },
  })
  assert.deepEqual(out, ["a", "b"], "no rerank needed when input ≤ top-3")
  assert.equal(calls, 0, "rerank dep must not be invoked")
})

test("rerankAndTrim: applies LLM ordering and trims to top-3", async () => {
  const lines = ["zero", "one", "two", "three", "four"]
  const out = await rerankAndTrim("q", lines, {
    rerank: async () => [3, 1, 4, 0, 2],
  })
  assert.deepEqual(out, ["three", "one", "four"])
})

test("rerankAndTrim: invalid order entries are dropped, untouched lines appended", async () => {
  const lines = ["a", "b", "c", "d"]
  // 9 is OOR, 1.5 not an integer, "x" not number, 1 dup → effective order [0]
  const out = await rerankAndTrim("q", lines, {
    rerank: async () => [9, 1.5, 0, "x" as unknown as number, 1, 1],
  })
  // After applyOrdering: [0, 1] explicitly chosen, then unreferenced (2, 3) appended.
  // Trimmed to top-3: [0, 1, 2] = ["a","b","c"]
  assert.deepEqual(out, ["a", "b", "c"])
})

test("rerankAndTrim: rerank dep throws → fail-open to original top-3", async () => {
  const lines = ["a", "b", "c", "d", "e"]
  const out = await rerankAndTrim("q", lines, {
    rerank: async () => {
      throw new Error("boom")
    },
  })
  assert.deepEqual(out, ["a", "b", "c"])
})

test("rerankAndTrim: rerank returns null → fail-open to original top-3", async () => {
  const out = await rerankAndTrim("q", ["a", "b", "c", "d"], {
    rerank: async () => null,
  })
  assert.deepEqual(out, ["a", "b", "c"])
})

test("rerankAndTrim: PA_MEM0_RERANK_DISABLED=true → no LLM call, top-3 of input", async () => {
  await withEnv("PA_MEM0_RERANK_DISABLED", "true", async () => {
    let called = 0
    const out = await rerankAndTrim("q", ["a", "b", "c", "d"], {
      rerank: async () => {
        called++
        return [3, 2, 1, 0]
      },
    })
    assert.equal(called, 0, "rerank dep must not be invoked when disabled")
    assert.deepEqual(out, ["a", "b", "c"])
  })
})

test("rerankAndTrim: long lines are truncated before reaching the LLM", async () => {
  const longLine = "x".repeat(_TEST_CAPS.MAX_LINE_CHARS + 100)
  let receivedLines: string[] = []
  await rerankAndTrim("q", [longLine, "short", "third", "fourth"], {
    rerank: async (_q, cands) => {
      receivedLines = cands
      return [0]
    },
  })
  assert.ok(receivedLines[0]!.length <= _TEST_CAPS.MAX_LINE_CHARS + 1)
  assert.ok(receivedLines[0]!.endsWith("…"))
})

test("rerankAndTrim: caps candidates to MAX_CANDIDATES even when more provided", async () => {
  const many = Array.from({ length: 20 }, (_, i) => `c${i}`)
  let receivedLen = 0
  await rerankAndTrim("q", many, {
    rerank: async (_q, cands) => {
      receivedLen = cands.length
      return null
    },
  })
  assert.equal(receivedLen, _TEST_CAPS.MAX_CANDIDATES)
})

test("rerankAndTrim: rerank dep timeout → fail-open within timeout window", async () => {
  const lines = ["a", "b", "c", "d"]
  const start = Date.now()
  const out = await rerankAndTrim("q", lines, {
    timeoutMs: 30,
    rerank: (_q, _c, signal) =>
      new Promise<number[] | null>((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")))
      }),
  })
  const elapsed = Date.now() - start
  assert.deepEqual(out, ["a", "b", "c"], "timeout should fail-open")
  assert.ok(elapsed < 500, `rerank should not block past timeout, elapsed=${elapsed}`)
})
