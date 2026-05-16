/**
 * Lock L7: NO `minEndpointingDelay` literal in voice-agent source.
 *
 * Adaptive turn detection (Silero VAD + MultilingualModel) decides endpointing
 * internally. A hardcoded numeric `minEndpointingDelay` would defeat the
 * adaptive model and is forbidden by the goal-prompt.
 *
 * This test greps the production source for the literal symbol.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC_ROOT = path.resolve(here, "..")

function walkProductionTs(dir: string): string[] {
  const results: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules" || entry === "dist") continue
      results.push(...walkProductionTs(full))
      continue
    }
    if (st.isFile() && entry.endsWith(".ts")) {
      results.push(full)
    }
  }
  return results
}

test("no `minEndpointingDelay` literal in voice-agent production source", () => {
  const offenders: string[] = []
  for (const file of walkProductionTs(SRC_ROOT)) {
    const text = readFileSync(file, "utf8")
    if (text.includes("minEndpointingDelay")) {
      offenders.push(file)
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `minEndpointingDelay literal found in: ${offenders.join(", ")}`
  )
})
