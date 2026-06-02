// @ts-nocheck - landing app typecheck only includes Vite/browser types; this file runs with node --test via tsx.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const here = dirname(fileURLToPath(import.meta.url))
const employersSource = readFileSync(resolve(here, "Employers.tsx"), "utf8")
const sequenceSource = readFileSync(resolve(here, "../components/Sequence.tsx"), "utf8")
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
