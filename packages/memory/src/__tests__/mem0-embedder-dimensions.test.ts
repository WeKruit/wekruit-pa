/**
 * mem0-embedder-dimensions.test.ts — regression for the 2026-06-03→ mem0 outage.
 *
 * ROOT CAUSE: mem0ai's OpenAIEmbedder sends the OpenAI-only `dimensions` request param whenever
 * `embeddingDims` is set in its config. SiliconFlow's BAAI/bge-m3 (our embedder) REJECTS that param
 * with HTTP 400 ({"code":20015,"message":"The parameter is invalid"}) — so every mem0 search+add 400'd
 * and long-term memory went silently dead for ALL users (verified by live probe + Cloud Logging).
 *
 * FIX (mem0.ts getClient): only pass `embeddingDims` to the embedder for OpenAI's text-embedding-3*
 * family (the only models that accept `dimensions`); OMIT it for bge-m3 / other providers so no
 * `dimensions` is sent. The Qdrant collection is still sized via the vectorStore config.
 *
 * These tests assert the embedder CONFIG the Memory ctor receives — the seam that decides whether
 * `dimensions` reaches SiliconFlow.
 */
import assert from "node:assert/strict"
import test, { afterEach } from "node:test"
import { mem0Add, _resetMem0Client, __test__setMemoryCtor, type Mem0Config } from "../mem0.js"

function installCtorCapture(): { ctorConfigs: Record<string, unknown>[] } {
  const ctorConfigs: Record<string, unknown>[] = []
  class FakeMemory {
    constructor(cfg: Record<string, unknown>) {
      ctorConfigs.push(cfg)
    }
    async add() {
      return { results: [] }
    }
    async search() {
      return { results: [] }
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  __test__setMemoryCtor(FakeMemory as any)
  return { ctorConfigs }
}

const embedderConfigOf = (cfg: Record<string, unknown>): Record<string, unknown> => {
  const embedder = cfg.embedder as { config?: Record<string, unknown> } | undefined
  return embedder?.config ?? {}
}

afterEach(() => {
  __test__setMemoryCtor(null)
  _resetMem0Client()
})

test("bge-m3 (default): embedder config OMITS embeddingDims → no `dimensions` sent → no SiliconFlow 400", async () => {
  const { ctorConfigs } = installCtorCapture()
  const cfg: Mem0Config = {
    apiKey: "sk-test",
    qdrantUrl: "https://qdrant.example",
    qdrantApiKey: "q",
    // embedModel omitted → DEFAULT_EMBED_MODEL = BAAI/bge-m3
  }
  await mem0Add(cfg, [{ role: "user", content: "hi" }], "u1")
  assert.equal(ctorConfigs.length, 1)
  const ec = embedderConfigOf(ctorConfigs[0]!)
  assert.equal(ec.model, "BAAI/bge-m3")
  assert.equal(
    "embeddingDims" in ec,
    false,
    "bge-m3 must NOT carry embeddingDims (would become the 400-causing `dimensions` param)",
  )
})

test("explicit bge-m3 with embeddingDims set in config: still OMITTED from the embedder", async () => {
  const { ctorConfigs } = installCtorCapture()
  const cfg: Mem0Config = {
    apiKey: "sk-test",
    qdrantUrl: "https://qdrant.example",
    qdrantApiKey: "q",
    embedModel: "BAAI/bge-m3",
    embeddingDims: 1024,
  }
  await mem0Add(cfg, [{ role: "user", content: "hi" }], "u2")
  const ec = embedderConfigOf(ctorConfigs[0]!)
  assert.equal("embeddingDims" in ec, false, "embeddingDims must be dropped for bge-m3 even when explicitly configured")
})

test("OpenAI text-embedding-3-small: embeddingDims IS forwarded (that family supports `dimensions`)", async () => {
  const { ctorConfigs } = installCtorCapture()
  const cfg: Mem0Config = {
    apiKey: "sk-test",
    qdrantUrl: "https://qdrant.example",
    qdrantApiKey: "q",
    embedModel: "text-embedding-3-small",
    embeddingDims: 1536,
  }
  await mem0Add(cfg, [{ role: "user", content: "hi" }], "u3")
  const ec = embedderConfigOf(ctorConfigs[0]!)
  assert.equal(ec.model, "text-embedding-3-small")
  assert.equal(ec.embeddingDims, 1536, "OpenAI text-embedding-3* keeps embeddingDims → `dimensions` is valid there")
})
