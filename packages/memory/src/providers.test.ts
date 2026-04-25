import assert from "node:assert/strict"
import test from "node:test"
import { Mem0SemanticMemoryProvider, NoopSemanticMemoryProvider, type SemanticMemoryProvider } from "./providers.js"

async function searchWithProvider(provider: SemanticMemoryProvider) {
  return provider.search({ userId: "u1", query: "latte" })
}

test("semantic memory provider can be switched to noop", async () => {
  const provider = new NoopSemanticMemoryProvider()
  assert.equal(provider.name, "noop")
  assert.equal(provider.isConfigured(), true)
  assert.deepEqual(await searchWithProvider(provider), [])
})

test("Mem0 provider reports unconfigured without calling network", async () => {
  const provider = new Mem0SemanticMemoryProvider(() => null)
  assert.equal(provider.name, "mem0")
  assert.equal(provider.isConfigured(), false)
  assert.deepEqual(await searchWithProvider(provider), [])
  await provider.add({ userId: "u1", messages: [{ role: "user", content: "hello" }] })
})
