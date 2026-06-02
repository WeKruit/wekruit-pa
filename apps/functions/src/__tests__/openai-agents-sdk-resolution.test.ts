import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"

test("@pa/functions loads @openai/agents through @pa/agent-runtime's zod 4 graph", () => {
  const req = createRequire(import.meta.url)
  const functionsPackage = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { dependencies?: Record<string, string> }

  assert.equal(functionsPackage.dependencies?.["@openai/agents"], undefined)

  const runtimePackage = req.resolve("@pa/agent-runtime/package.json")
  const runtimeRequire = createRequire(runtimePackage)
  const agentsEntry = runtimeRequire.resolve("@openai/agents")
  const agentsRequire = createRequire(agentsEntry)
  const zodVersion = agentsRequire("zod/package.json").version as string

  assert.match(zodVersion, /^4\./)
  assert.doesNotThrow(() => runtimeRequire("@openai/agents"))
})
