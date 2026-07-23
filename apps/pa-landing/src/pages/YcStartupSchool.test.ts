// @ts-nocheck - landing app typecheck only includes Vite/browser types; this file runs with node --test via tsx.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const here = dirname(fileURLToPath(import.meta.url))
const pageSource = readFileSync(resolve(here, "YcStartupSchool.tsx"), "utf8")
const mainSource = readFileSync(resolve(here, "../main.tsx"), "utf8")

test("/yc-startup route is registered on the wekruit.com bundle", () => {
  assert.match(mainSource, /path="\/yc-startup" element=\{<YcStartupSchool \/>\}/)
  const layoffBlock = mainSource.slice(mainSource.indexOf("const layoffRoutes"), mainSource.indexOf("const fullRoutes"))
  assert.doesNotMatch(layoffBlock, /yc-startup/)
})

test("YC Startup page removes roles and founders surfaces", () => {
  assert.match(pageSource, /YC Startup School/)
  assert.match(pageSource, /people matching by WeKruit/)
  assert.match(pageSource, /Start yapping/)
  assert.match(pageSource, /const YC_SOURCE = "yc_startup_school"/)
  assert.match(pageSource, /const ONBOARDING_HREF = `\/onboarding\?source=\$\{YC_SOURCE\}`/)
  assert.match(pageSource, /const LOGIN_HREF = `\/login\?next=\$\{encodeURIComponent\(ONBOARDING_HREF\)\}`/)
  assert.match(pageSource, /stickExplicitSource\(YC_SOURCE\)/)

  assert.doesNotMatch(pageSource, /id="founders"/)
  assert.doesNotMatch(pageSource, /FOUNDERS/)
  assert.doesNotMatch(pageSource, /ALL ROLES/)
  assert.doesNotMatch(pageSource, /live roles/i)
  assert.doesNotMatch(pageSource, /Startups you can match with right now/)
  assert.doesNotMatch(pageSource, /Talk to founders/i)
  assert.doesNotMatch(pageSource, /\/j\/\$\{/)
  assert.doesNotMatch(pageSource, /PUBLIC_PA_JOBS_RAW_QUERY_KEY|fetchPublicPaJobsRaw|useQuery/)
})

test("YC Startup page frames the offer as SF people matching, not job search", () => {
  assert.match(pageSource, /founders, investors, operators, and other builders/)
  assert.match(pageSource, /across San Francisco/)
  assert.match(pageSource, /Less random networking/)
  assert.match(pageSource, /How people matching works/)
  assert.match(pageSource, /Meet in SF/)
  assert.match(pageSource, /MATCHING: JULY 25TH, 7PM PT/)

  assert.doesNotMatch(pageSource, /share your resume/i)
  assert.doesNotMatch(pageSource, /recruiter/i)
  assert.doesNotMatch(pageSource, /candidate/i)
  assert.doesNotMatch(pageSource, /job/i)
  assert.doesNotMatch(pageSource, /find a job/i)
  assert.doesNotMatch(pageSource, /matching tonight/i)
})

test("YC Startup solid CTA keeps readable text color over generic link color", () => {
  assert.match(pageSource, /\.ycs a \{ color: inherit; text-decoration: none; \}/)
  assert.match(pageSource, /\.ycs \.ycs-btn--solid \{[\s\S]*color: var\(--cream, #F5EDE3\);/)
  assert.doesNotMatch(pageSource, /\n\.ycs-btn--solid \{[\s\S]*color: var\(--cream, #F5EDE3\);/)
})

test("YC Startup nav uses the shared WeKruit logo asset", () => {
  assert.match(pageSource, /<Link to="\/" className="ycs-mark" aria-label="WeKruit home">[\s\S]*<img src="\/wekruit-logo\.png" alt="" aria-hidden="true" \/>/)
  assert.match(pageSource, /\.ycs \.ycs-mark \{[\s\S]*width: 28px;[\s\S]*height: 40px;/)
  assert.match(pageSource, /\.ycs \.ycs-mark img \{[\s\S]*width: 28px;[\s\S]*height: 40px;[\s\S]*object-fit: contain;/)
  assert.doesNotMatch(pageSource, /className="ycs-mark" aria-label="WeKruit home">W<\/Link>/)
  assert.doesNotMatch(pageSource, /className="ycs-nav-pills"/)
  assert.doesNotMatch(pageSource, /className="ycs-pill"/)
})

test("YC Startup attendee label sits outside the orange graphic area", () => {
  const heroIndex = pageSource.indexOf('<section className="ycs-hero">')
  const chipIndex = pageSource.indexOf('<div className="ycs-event-chip"')
  const sunIndex = pageSource.indexOf('<div className="ycs-sun"')
  assert.ok(heroIndex >= 0)
  assert.ok(chipIndex > 0)
  assert.ok(chipIndex < heroIndex)
  assert.ok(sunIndex > heroIndex)
  assert.match(pageSource, /\.ycs-hero \{[\s\S]*overflow: hidden;/)
  assert.match(pageSource, /\.ycs-event-chip \{[\s\S]*display: grid;/)
  assert.match(pageSource, /@media \(max-width: 1040px\) \{[\s\S]*\.ycs-event-chip \{ display: none; \}/)
  assert.doesNotMatch(pageSource, /ycs-attendee-badge/)
  assert.doesNotMatch(pageSource, /\.ycs-hero-corner--right h2/)
  assert.match(pageSource, /@media \(max-width: 780px\) \{[\s\S]*\.ycs-hero-corner--right \{ display: none; \}/)
})

test("YC Startup hero graphic uses YC-style launch dome treatment", () => {
  assert.match(pageSource, /<span className="ycs-sun-big">MEET<\/span>/)
  assert.match(pageSource, /<span className="ycs-sun-label">P E O P L E<\/span>/)
  assert.match(pageSource, /interests x experience/)
  assert.match(pageSource, /\.ycs-sun-big \{[\s\S]*font-family: var\(--font-mono, 'JetBrains Mono', ui-monospace, monospace\);/)
  assert.match(pageSource, /\.ycs-sun-big \{[\s\S]*letter-spacing: 0\.04em;/)
  assert.match(pageSource, /\.ycs-sun \{[\s\S]*overflow: visible;/)
  assert.match(pageSource, /\.ycs-sun \{[\s\S]*align-self: end;/)
})
