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

test("Market does not invent role fit confidence from a hash", () => {
  assert.doesNotMatch(source, /function fitForId/)
  assert.doesNotMatch(source, /fit:\s*fitForId/)
  assert.doesNotMatch(source, /Strong fit|Worth a shot|Stretch/)
  assert.doesNotMatch(source, /wk-fit/)
  assert.match(source, /type MarketEvidence/)
  assert.match(source, /function evidenceForOpenJob/)
  assert.match(source, /function EvidenceBadge/)
})

test("Market role cards surface source evidence instead of synthetic fit badges", () => {
  assert.match(source, /External source/)
  assert.match(source, /Source listed/)
  assert.match(source, /Open original posting/)
  assert.match(source, /WeKruit-screened/)
  assert.doesNotMatch(source, /return "Outbound"/)
})

test("Market default table rows surface source evidence before opening card view", () => {
  assert.match(source, /function HuntRow\([\s\S]*<EvidenceBadge evidence=\{r\.evidence\} compact \/>/)
  assert.match(source, /\.wk-tbl__evidence/)
})

test("Market tracked-role rows connect external source inspection to durable preferences", () => {
  assert.match(source, /View source/)
  assert.match(source, /function profileCorrectionHrefForRole\(r: DisplayJob\): string/)
  assert.match(source, /profileRoleSignalTitle/)
  assert.match(source, /profileRoleSignalCompany/)
  assert.match(source, /profileRoleSignalFunction/)
  assert.match(source, /profileRoleSignalLevel/)
  assert.match(source, /profileRoleSignalLocation/)
  assert.match(source, /const profileHref = profileCorrectionHrefForRole\(r\)/)
  assert.match(source, /href=\{profileHref\}/)
  assert.match(source, /Use as signal/)
  assert.match(source, /function HuntRow\([\s\S]*className="wk-roleactions"/)
  assert.match(source, /function HuntCard\([\s\S]*className="wk-roleactions wk-roleactions--card"/)
  assert.doesNotMatch(source, /href="\/me\/profile#match-preferences"/)

  assert.doesNotMatch(source, /Save role/i)
  assert.doesNotMatch(source, /Add to pipeline/i)
  assert.doesNotMatch(source, /Claire is now tracking this/i)
})

test("Market explains how Claire uses role sources before candidates chase postings", () => {
  assert.match(source, /How Claire uses this market/)
  assert.match(source, /Direct-line roles are briefs WeKruit can screen against/)
  assert.match(source, /Tracked roles are source evidence, not applications/)
  assert.match(source, /Your profile and preferences decide what Claire can pursue with you/)
  assert.match(source, /href="\/me\/profile"/)
  assert.match(source, /href="\/onboarding"/)

  assert.doesNotMatch(source, /apply to every role/i)
  assert.doesNotMatch(source, /auto-submit/i)
  assert.doesNotMatch(source, /we pitch you anyway/i)
})

test("Market direct-line roles do not overpromise employer access or invent interview capacity", () => {
  assert.doesNotMatch(source, /hiring managers <em className="wk-accent">ready<\/em> to meet you/)
  assert.doesNotMatch(source, /arrange the interview directly/i)
  assert.doesNotMatch(source, /seats:\s*typeof raw\.interviewSeats === "number" \? raw\.interviewSeats : 2/)
  assert.doesNotMatch(source, /\{r\.seats\} \{r\.seats === 1 \? "seat" : "seats"\}/)

  assert.match(source, /role briefs <em className="wk-accent">ready<\/em> for Claire/)
  assert.match(source, /Claire starts the role interview before any passed profile is shared/)
  assert.match(source, /seats:\s*typeof raw\.interviewSeats === "number" \? raw\.interviewSeats : undefined/)
  assert.match(source, /r\.seats === undefined \? "Claire interview" :/)
})
