// @ts-nocheck - landing app typecheck only includes Vite/browser types; this file runs with node --test via tsx.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const here = dirname(fileURLToPath(import.meta.url))
const employersSource = readFileSync(resolve(here, "Employers.tsx"), "utf8")
const sequenceSource = readFileSync(resolve(here, "../components/Sequence.tsx"), "utf8")
const stylesSource = readFileSync(resolve(here, "../styles/wekruit-pages.css"), "utf8")
const source = `${employersSource}\n${sequenceSource}`

test("Employers page frames passed-profile preview without unsupported traction claims", () => {
  assert.doesNotMatch(source, /1,247|92%|13 interviews|8 hires|≈ 6\.4 hrs|14%|86%/)
  assert.doesNotMatch(source, /Claire runs the whole funnel|whole funnel/i)
  assert.doesNotMatch(source, /passes lead to a real intro|Pass → onsite conversion/i)
  assert.doesNotMatch(source, /first intro lands on your calendar in 48 hrs/i)
  assert.doesNotMatch(source, /Hundreds of conversations a week|every credible candidate/i)
  assert.doesNotMatch(source, /Three to five passes a week|3 passes|5 passes this week|14 more candidates/i)
  assert.doesNotMatch(source, /Match \{[pc]\.score\}|Match \d+/)
  assert.doesNotMatch(source, /\bmock(?:ed|s)?\b/i)
  assert.match(source, /Sample passed-profile preview/)
  assert.match(source, /passed profiles plus the transcript/i)
})

test("Employers sample inbox does not render fake fit scores or live timing", () => {
  assert.doesNotMatch(employersSource, /fitLabel/)
  assert.doesNotMatch(source, /Strong fit|Good fit|Watch risks/)
  assert.doesNotMatch(employersSource, /passedMin/)
  assert.doesNotMatch(employersSource, /formatPassedAgo/)
  assert.doesNotMatch(employersSource, /Consent expires in 5d/)
  assert.match(employersSource, /reviewBadge/)
  assert.match(employersSource, /Sample pass record/)
  assert.match(employersSource, /Consent shown in sample/)
})

test("Employers inbox preview uses non-interactive sample actions", () => {
  assert.doesNotMatch(
    employersSource,
    /<button type="button" className="wk-btn wk-btn--primary">[\s\S]*Schedule intro/,
  )
  assert.doesNotMatch(employersSource, /<button type="button" className="wk-btn wk-btn--secondary">Decline with note<\/button>/)
  assert.doesNotMatch(employersSource, /<button type="button" className="wk-btn wk-btn--ghost">Ask Claire to dig deeper<\/button>/)
  assert.match(employersSource, /aria-label="Sample employer actions"/)
  assert.match(employersSource, /Accept intro after consent/)
  assert.match(employersSource, /Sample actions only/)
})

test("Employers page avoids unsupported employer workflow actions", () => {
  assert.doesNotMatch(employersSource, /Decline, schedule, or ask Claire to dig deeper/)
  assert.doesNotMatch(employersSource, /Decline with note/)
  assert.doesNotMatch(employersSource, /Ask Claire to dig deeper/)
  assert.doesNotMatch(employersSource, /Argue with her if you disagree/)
  assert.doesNotMatch(employersSource, /she&apos;ll re-interview/i)

  assert.match(employersSource, /Review the pass record/)
  assert.match(employersSource, /decide whether this candidate should enter your normal interview process/)
  assert.match(employersSource, /Calibration goes back to WeKruit/)
})

test("Employers sequence does not invent live interview scale", () => {
  assert.doesNotMatch(sequenceSource, /4 interviews/)
  assert.doesNotMatch(sequenceSource, /in flight · this hour/)
  assert.doesNotMatch(sequenceSource, /\+18 queued/)
  assert.doesNotMatch(sequenceSource, /q: \d/)
  assert.doesNotMatch(sequenceSource, /total: \d/)
  assert.doesNotMatch(sequenceSource, /pct: \d/)
  assert.doesNotMatch(sequenceSource, /seq-live__qcount/)
  assert.doesNotMatch(sequenceSource, /seq-live__typing/)

  assert.match(sequenceSource, /screeningPlan/)
  assert.match(sequenceSource, /Role brief approved/)
  assert.match(sequenceSource, /Evidence probes/)
  assert.match(sequenceSource, /Risk follow-ups/)
  assert.match(sequenceSource, /Consent gate/)
})

test("Employers visual labels do not invent weekly pass volume", () => {
  assert.doesNotMatch(stylesSource, /4 passes this week/)
  assert.doesNotMatch(stylesSource, /passes this week/i)
  assert.match(stylesSource, /Inbox · sample pass records/)
})

test("Employers sample proof avoids borrowed real-company specificity", () => {
  assert.doesNotMatch(source, /Maya Okafor/)
  assert.doesNotMatch(source, /Anthropic|Perplexity|Claude APIs/)
  assert.doesNotMatch(source, /Linear|Replit/)
  assert.doesNotMatch(employersSource, /Open full transcript \(38 min\)/)
  assert.doesNotMatch(employersSource, /href="#full-transcript"/)

  assert.match(source, /Sample candidate/)
  assert.match(source, /Sample hiring team/)
  assert.match(source, /Developer platform lead/)
  assert.match(employersSource, /Open sample transcript excerpt/)
})

test("Employers page avoids unsupported commercial certainty", () => {
  assert.doesNotMatch(employersSource, /Free trial/)
  assert.doesNotMatch(employersSource, /invoice only on signed offers/i)
  assert.doesNotMatch(employersSource, /No retainers, no exclusivity/i)

  assert.match(employersSource, /Start with one role brief/)
  assert.match(employersSource, /WeKruit confirms scope and terms/)
})

test("Employers page includes a scope-safe operating FAQ", () => {
  assert.match(employersSource, /Employer operating model/)
  assert.match(employersSource, /What does WeKruit send to employers\?/)
  assert.match(employersSource, /Can employers browse candidates\?/)
  assert.match(employersSource, /What happens after we accept a pass\?/)
  assert.match(employersSource, /How are scope and terms handled\?/)
  assert.match(employersSource, /What if the evidence misses our bar\?/)

  assert.match(employersSource, /consented passed profiles only/)
  assert.match(employersSource, /not an ATS and not a candidate browser/)
  assert.match(employersSource, /normal interview process/)
  assert.match(employersSource, /before Claire screens/)
  assert.match(employersSource, /Calibration goes back to WeKruit before the next pass/)

  assert.doesNotMatch(employersSource, /replacement search/i)
  assert.doesNotMatch(employersSource, /flat percentage/i)
  assert.doesNotMatch(employersSource, /90 days/i)
})

test("Employers page explains where WeKruit fits without broad ATS or agency scope", () => {
  assert.match(employersSource, /Where WeKruit fits/)
  assert.match(employersSource, /Use it where a résumé screen is too weak/)
  assert.match(employersSource, /Founder-led or high-context roles/)
  assert.match(employersSource, /Specialized roles where evidence matters/)
  assert.match(employersSource, /Teams with an existing interview process/)
  assert.match(employersSource, /Not bulk requisition filling/)

  assert.match(employersSource, /one approved role brief/)
  assert.match(employersSource, /Claire probes for concrete work examples and risks/)
  assert.match(employersSource, /Your team owns scheduling, interview loops, and final decisions/)
  assert.match(employersSource, /not an ATS replacement or a candidate browser/)

  assert.doesNotMatch(employersSource, /source every open req/i)
  assert.doesNotMatch(employersSource, /replace your in-house recruiters/i)
  assert.doesNotMatch(employersSource, /multiple expert recruiters/i)
})

test("Employers mobile hero grid allows preview columns to shrink inside the viewport", () => {
  assert.match(stylesSource, /\.wk-emp-hero__copy,\s*\.wk-emp-hero__visual\s*\{\s*min-width: 0;\s*\}/s)
})
