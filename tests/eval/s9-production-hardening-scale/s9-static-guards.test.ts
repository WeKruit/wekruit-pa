import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import test from "node:test"

const execFileAsync = promisify(execFile)

test("S9 static guard preserves no-send no-delete privacy and route split locks", async () => {
  const result = await execFileAsync("node", ["static-guards.mjs"], {
    cwd: new URL(".", import.meta.url),
  })
  assert.match(result.stdout, /S9 static guard passed/)
})
