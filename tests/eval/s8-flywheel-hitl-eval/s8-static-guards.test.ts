import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import test from "node:test"

const execFileAsync = promisify(execFile)

test("S8 static guard preserves no-outbound, domain split, privacy, and first-interview locks", async () => {
  const result = await execFileAsync("node", ["static-guards.mjs"], {
    cwd: new URL(".", import.meta.url),
  })
  assert.match(result.stdout, /S8 static guard passed/)
})
