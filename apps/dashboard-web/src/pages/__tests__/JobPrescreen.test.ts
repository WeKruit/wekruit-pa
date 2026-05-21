import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import test from "node:test"

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, "../JobPrescreen.tsx"), "utf8")

test("JobPrescreen stays scoped to prescreen config, not job lifecycle", () => {
  assert.match(source, /useParams/)
  assert.match(source, /prescreenConfig: withMeta/)
  assert.match(source, /Open job workspace/)
  assert.match(source, /Publish in job workspace/)
  assert.match(source, /Create new job/)
  assert.doesNotMatch(source, /setShowCreate/)
  assert.doesNotMatch(source, /setNewJobId/)
  assert.doesNotMatch(source, /publicVisible/)
})
