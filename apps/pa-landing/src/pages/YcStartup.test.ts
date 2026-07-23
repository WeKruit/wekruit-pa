// @ts-nocheck - source contract test runs with node --test via tsx.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, "YcStartup.tsx"), "utf8")

test("YC Startup page removes roles and founders surfaces", () => {
  assert.match(source, /YC Startup School/)
  assert.match(source, /people matching by WeKruit/)
  assert.match(source, /Start yapping/)
  assert.match(source, /const SOURCE = "yc_startup_school"/)
  assert.match(source, /const ONBOARDING_HREF = `\/onboarding\?source=\$\{SOURCE\}`/)
  assert.match(source, /const LOGIN_HREF = `\/login\?next=\$\{encodeURIComponent\(ONBOARDING_HREF\)\}`/)

  assert.doesNotMatch(source, /id="founders"/)
  assert.doesNotMatch(source, /FOUNDERS/)
  assert.doesNotMatch(source, /ALL ROLES/)
  assert.doesNotMatch(source, /live roles/i)
  assert.doesNotMatch(source, /Startups you can match with right now/)
  assert.doesNotMatch(source, /Talk to founders/i)
  assert.doesNotMatch(source, /\/j\/\$\{/)
  assert.doesNotMatch(source, /listPublicJobOpenings|fetchPublicPaJobsRaw|PUBLIC_PA_JOBS_RAW_QUERY_KEY/)
})

test("YC Startup page frames the offer as SF people matching, not job search", () => {
  assert.match(source, /founders, investors, operators, and other builders/)
  assert.match(source, /across San Francisco/)
  assert.match(source, /Less random networking/)
  assert.match(source, /How people matching works/)
  assert.match(source, /Meet in SF/)
  assert.match(source, /MATCHING: JULY 25TH, 7PM/)

  assert.doesNotMatch(source, /share your resume/i)
  assert.doesNotMatch(source, /recruiter/i)
  assert.doesNotMatch(source, /candidate/i)
  assert.doesNotMatch(source, /job/i)
  assert.doesNotMatch(source, /find a job/i)
  assert.doesNotMatch(source, /matching tonight/i)
})

test("YC Startup solid CTA keeps readable text color over generic link color", () => {
  assert.match(source, /\.ycs a \{ color: inherit; text-decoration: none; \}/)
  assert.match(source, /\.ycs \.ycs-btn--solid \{[\s\S]*color: var\(--cream, #F5EDE3\);/)
  assert.doesNotMatch(source, /\n\.ycs-btn--solid \{[\s\S]*color: var\(--cream, #F5EDE3\);/)
})

test("YC Startup nav uses the shared WeKruit logo asset", () => {
  assert.match(source, /<Link to="\/" className="ycs-mark" aria-label="WeKruit home">[\s\S]*<img src="\/wekruit-logo\.png" alt="" aria-hidden="true" \/>/)
  assert.match(source, /\.ycs \.ycs-mark img \{[\s\S]*object-fit: contain;/)
  assert.doesNotMatch(source, /className="ycs-mark" aria-label="WeKruit home">W<\/Link>/)
  assert.doesNotMatch(source, /className="ycs-nav-pills"/)
  assert.doesNotMatch(source, /className="ycs-pill"/)
})

test("YC Startup attendee label sits outside the orange graphic area", () => {
  const heroIndex = source.indexOf('<section className="ycs-hero">')
  const chipIndex = source.indexOf('<div className="ycs-event-chip"')
  const sunIndex = source.indexOf('<div className="ycs-sun"')
  assert.ok(heroIndex >= 0)
  assert.ok(chipIndex > 0)
  assert.ok(chipIndex < heroIndex)
  assert.ok(sunIndex > heroIndex)
  assert.match(source, /\.ycs-hero \{[\s\S]*overflow: hidden;/)
  assert.match(source, /\.ycs-event-chip \{[\s\S]*display: grid;/)
  assert.match(source, /@media \(max-width: 1040px\) \{[\s\S]*\.ycs-event-chip \{ display: none; \}/)
  assert.doesNotMatch(source, /ycs-attendee-badge/)
  assert.doesNotMatch(source, /\.ycs-hero-corner--right h2/)
  assert.match(source, /@media \(max-width: 780px\) \{[\s\S]*\.ycs-hero-corner--right \{ display: none; \}/)
})

test("YC Startup hero graphic uses YC-style launch dome treatment", () => {
  assert.match(source, /<span className="ycs-sun-big">MEET<\/span>/)
  assert.match(source, /<span className="ycs-sun-label">P E O P L E<\/span>/)
  assert.match(source, /interests x experience/)
  assert.match(source, /\.ycs-sun-big \{[\s\S]*font-family: var\(--font-mono, 'JetBrains Mono', ui-monospace, monospace\);/)
  assert.match(source, /\.ycs-sun-big \{[\s\S]*letter-spacing: 0\.04em;/)
  assert.match(source, /\.ycs-sun \{[\s\S]*overflow: visible;/)
  assert.match(source, /\.ycs-sun \{[\s\S]*align-self: end;/)
  assert.match(source, /\.ycs-sun \{[\s\S]*isolation: isolate;/)
  assert.match(source, /\.ycs-sun::before \{[\s\S]*filter: blur\(46px\);/)
  assert.match(source, /\.ycs-sun::before \{[\s\S]*mask-image: radial-gradient\(ellipse at 50% 88%/)
  assert.doesNotMatch(source, /\.ycs-sun::after/)
  assert.match(source, /repeating-linear-gradient\(90deg, rgba\(255, 246, 232, 0\.11\) 0 1px, transparent 1px 23px\)/)
  assert.match(source, /radial-gradient\(ellipse at 50% 100%/)
  assert.match(source, /mask-image: radial-gradient\(ellipse at 50% 100%/)
  assert.match(source, /filter: blur\(2\.8px\);/)
  assert.match(source, /box-shadow:[\s\S]*0 -44px 118px rgba\(247, 83, 28, 0\.24\)/)
  assert.doesNotMatch(source, /border-radius: 50% 50% 0 0/)
})
