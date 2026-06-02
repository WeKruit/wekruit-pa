// @ts-nocheck - landing app typecheck only includes Vite/browser types; this file runs with node --test via tsx.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, "Market.tsx"), "utf8")

test("Market frames tracked external roles as Claire-managed next steps, not a scrape/apply board", () => {
  assert.doesNotMatch(source, /Live from the macmini scrape/i)
  assert.doesNotMatch(source, /Pulling fresh listings from the macmini scrape/i)
  assert.doesNotMatch(source, /We pitch them anyway|we'll pitch them|we&apos;ll pitch them/i)
  assert.doesNotMatch(source, /Next batch sends Tuesday|we email a tight shortlist|queued for you/i)
  assert.doesNotMatch(source, /<BatchTicker queuedCount=\{0\} \/>/)
  assert.doesNotMatch(source, /<th className="wk-tbl__h wk-tbl__h--cta">Apply<\/th>/)
  assert.match(source, /label="Tracked roles"/)
  assert.match(source, /External roles Claire is watching/i)
  assert.match(source, /<th className="wk-tbl__h wk-tbl__h--cta">Next step<\/th>/)
})

test("Market direct-line empty state avoids unproven background scanning claims", () => {
  assert.match(source, /<strong>No direct-line roles yet\.<\/strong>/)
  assert.doesNotMatch(source, /Claire keeps scanning for stronger company access/)
  assert.match(source, /Check tracked roles and keep your profile preferences current\./)
})
