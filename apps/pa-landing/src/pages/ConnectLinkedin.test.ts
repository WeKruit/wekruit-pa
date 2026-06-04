// @ts-nocheck - landing app tests run with node --test via tsx.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, "ConnectLinkedin.tsx"), "utf8")

test("ConnectLinkedin uses controlled headline rows instead of an overlapping raw h1", () => {
  assert.match(source, /<h1 className="wk-li-connect__title">/)
  assert.match(source, /<span>Connect your<\/span>\s*<span>LinkedIn<\/span>/)
  assert.doesNotMatch(
    source,
    /<h1 style=\{\{ marginBottom: "0\.25rem" \}\}>Connect your LinkedIn<\/h1>/,
  )
  assert.match(
    source,
    /\.wk-li-connect__title \{[\s\S]*font-size: clamp\(48px, 6vw, 72px\);[\s\S]*line-height: 1\.16;/,
  )
  assert.match(source, /\.wk-li-connect__title > span \{[\s\S]*line-height: inherit;/)
  assert.match(
    source,
    /@media \(max-width: 520px\) \{[\s\S]*\.wk-li-connect__title \{[\s\S]*font-size: clamp\(42px, 14vw, 54px\);[\s\S]*line-height: 1\.18;/,
  )
})
