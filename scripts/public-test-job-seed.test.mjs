import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const here = dirname(fileURLToPath(import.meta.url))

for (const scriptName of ["v19-bootstrap.mjs", "v19-reseed-test-job.mjs"]) {
  test(`${scriptName} keeps the canonical QA job out of public candidate surfaces`, () => {
    const source = readFileSync(resolve(here, scriptName), "utf8")

    assert.match(source, /test-swe-screen-001/)
    assert.match(source, /publicVisible:\s*false/)
    assert.match(source, /candidatePageStatus:\s*"test"/)
    assert.doesNotMatch(source, /publicVisible:\s*true/)
    assert.doesNotMatch(source, /publicVisible=true/)
    assert.doesNotMatch(source, /https:\/\/(?:candidate\.wekruit\.com|wekruit-pa\.web\.app)\/j\/test-swe-screen-001/)
  })
}
