// @ts-nocheck - landing app tests run with node --test via tsx.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, "ConnectLinkedin.tsx"), "utf8")

test("ConnectLinkedin uses controlled headline rows instead of an overlapping raw h1", () => {
  assert.match(source, /<h1 className="wk-li-connect__title" aria-label="Connect your LinkedIn">/)
  assert.match(source, /<span>Connect your<\/span>\s*<span>LinkedIn<\/span>/)
  assert.match(source, /<h1 className="wk-li-connect__title" aria-label="Connecting LinkedIn">/)
  assert.doesNotMatch(
    source,
    /<h1 style=\{\{ marginBottom: "0\.25rem" \}\}>Connect your LinkedIn<\/h1>/,
  )
  assert.match(
    source,
    /\.wk-li-connect__title \{[\s\S]*gap: clamp\(6px, 0\.8vw, 10px\);[\s\S]*font-size: clamp\(40px, 5vw, 62px\);[\s\S]*line-height: 1\.16;/,
  )
  assert.match(source, /\.wk-li-connect__title > span \{[\s\S]*line-height: inherit;/)
  assert.match(
    source,
    /@media \(max-width: 520px\) \{[\s\S]*\.wk-li-connect__title \{[\s\S]*font-size: clamp\(34px, 11vw, 42px\);[\s\S]*line-height: 1\.2;[\s\S]*gap: 6px;/,
  )
  assert.doesNotMatch(source, /font-size: clamp\(42px, 14vw, 54px\)/)
})

test("ConnectLinkedin missing-token state does not render a dead URL form", () => {
  assert.match(source, /function MissingConnectToken\(\)/)
  assert.match(source, /<h1 className="wk-li-connect__title" aria-label="Open your Claire link">/)
  assert.match(source, /This page needs the secure LinkedIn link Claire texted you\./)
  assert.match(source, /href="\/me"[\s\S]*Go to My WeKruit/)
  assert.match(source, /href="\/onboarding"[\s\S]*Start with Claire instead/)
  assert.match(source, /\{tokenMissing \? \(\s*<MissingConnectToken \/>[\s\S]*\) : token && !useUrlFallback && status === "idle" \?/)
  assert.doesNotMatch(source, /disabled=\{status === "submitting" \|\| tokenMissing\}/)
  assert.doesNotMatch(source, /This link looks incomplete\. Please reopen the link from your text message\./)
})
