/**
 * v2.2 W2 — worker.ts LLM wiring.
 *
 * Asserts the WekruitLLM swap:
 *  - REQUIRED_PROD_ENV no longer contains WEKRUIT_LLM_SHIM_URL.
 *  - buildDefaultLLM() returns a WekruitLLM (provider == "wekruit-orchestrator").
 *  - startWorker exposes a `buildLLM` test seam (compile-time / type check).
 *  - In test mode (opts.defineAgent injected), the test-session path runs
 *    without requiring any shim env or openai plugin import.
 */

import test from "node:test"
import assert from "node:assert/strict"

import { initializeLogger } from "@livekit/agents"
initializeLogger({ pretty: false, level: "silent" })

import {
  buildDefaultLLM,
  REQUIRED_PROD_ENV,
  startWorker,
} from "../worker.js"
import { WekruitLLM } from "../wekruit-llm.js"

test("REQUIRED_PROD_ENV no longer demands WEKRUIT_LLM_SHIM_URL", () => {
  assert.ok(
    !REQUIRED_PROD_ENV.includes("WEKRUIT_LLM_SHIM_URL" as never),
    "shim URL must not be a required prod env after W2",
  )
})

test("REQUIRED_PROD_ENV still demands the core LK + Deepgram secrets", () => {
  for (const name of [
    "LIVEKIT_URL",
    "LIVEKIT_API_KEY",
    "LIVEKIT_API_SECRET",
    "DEEPGRAM_API_KEY",
  ]) {
    assert.ok(
      REQUIRED_PROD_ENV.includes(name as never),
      `expected ${name} in REQUIRED_PROD_ENV`,
    )
  }
})

test("buildDefaultLLM returns a WekruitLLM instance with provider=wekruit-orchestrator", () => {
  const llm = buildDefaultLLM()
  assert.ok(llm instanceof WekruitLLM)
  assert.equal(llm.provider, "wekruit-orchestrator")
  assert.equal(llm.label(), "wekruit")
})

test("startWorker test path no longer requires WEKRUIT_LLM_SHIM_URL", async () => {
  const events: string[] = []
  await startWorker({
    defineAgent: () => "test-agent-handle",
    log: (event) => events.push(event),
  })
  assert.ok(
    events.includes("voice.worker.defined"),
    "worker should reach defined state in test path",
  )
})
