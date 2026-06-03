// @ts-nocheck - landing app typecheck only includes Vite/browser types; this file runs with node --test via tsx.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, "OpenJobs.tsx"), "utf8")

test("OpenJobs avoids internal pipeline language and unsupported signed-in promises", () => {
  assert.doesNotMatch(source, /macmini|scraper|scraped roles|collab companies|companies don&apos;t know us yet|tight shortlist|every Tuesday/i)
  assert.doesNotMatch(source, /We pitch them anyway|we&apos;ll pitch them|we'll pitch them/i)
  assert.doesNotMatch(source, /unlock filters, alerts, and one-tap apply/i)
  assert.doesNotMatch(source, /j\.source \?\? "ATS"/)
  assert.doesNotMatch(source, /Talk to a human within 48h/i)
  assert.match(source, /Sign in to keep your WeKruit profile connected/i)
  assert.match(source, /External roles WeKruit is tracking/i)
  assert.match(source, /\{totalForTab\} total \{tab === "hunt" \? "tracked roles" : "direct-line roles"\}/)
  assert.match(source, /j\.source \?\? "source listing"/)
})

test("OpenJobs routes candidate entry points to onboarding or the job flow", () => {
  assert.doesNotMatch(source, /<Link to="\/" className="btn btn--primary btn--sm">Add your name<\/Link>/)
  assert.doesNotMatch(source, /<Link to="\/" className="btn btn--primary btn--sm">Get an interview/)
  assert.doesNotMatch(source, /<Link to="\/" className="btn btn--secondary btn--sm">Apply via WeKruit/)
  assert.match(source, /<Link to="\/onboarding" className="btn btn--primary btn--sm">Add your name<\/Link>/)
  assert.match(source, /to=\{jobRoute\(j\)\}/)
})

test("OpenJobs empty filter state offers real candidate actions instead of unsupported alerts", () => {
  assert.doesNotMatch(source, /fresh roles drop every night/i)
  assert.doesNotMatch(source, /Save as alert/)
  assert.doesNotMatch(source, /<Link to="\/" className="btn btn--primary btn--sm">/)
  assert.match(source, /add your profile so Claire can keep matching roles to your actual targets/i)
  assert.match(source, /<Link to="\/onboarding" className="btn btn--primary btn--sm">Add your profile<\/Link>/)
})

test("OpenJobs table action language stays interview and role centric", () => {
  assert.doesNotMatch(source, /\{tab === "direct" \? "Apply" : "Pitch"\}/)
  assert.doesNotMatch(source, /Open · apply via us/)
  assert.match(source, /<div style=\{\{ textAlign: "right" \}\}>Next step<\/div>/)
  assert.match(source, /\{strong \? "● Strong match" : "○ Open role"\}/)
})

test("OpenJobs starts narrow mobile visitors in cards instead of the desktop table", () => {
  assert.match(source, /function initialOpenJobsLayout\(\): LayoutId/)
  assert.match(source, /window\.matchMedia\("\(max-width: 720px\)"\)\.matches \? "cards" : "table"/)
  assert.match(source, /const \[layout, setLayout\] = useState<LayoutId>\(initialOpenJobsLayout\)/)
  assert.match(source, /const isNarrowViewport = useOpenJobsNarrowViewport\(\)/)
  assert.match(source, /const effectiveLayout = isNarrowViewport && layout === "table" \? "cards" : layout/)
  assert.match(source, /layout=\{effectiveLayout\}[\s\S]*setLayout=\{setLayout\}/)
  assert.match(source, /<List jobs=\{filtered\.slice\(0, visibleCount\)\} tab=\{tab\} layout=\{effectiveLayout\} \/>/)
  assert.doesNotMatch(source, /const \[layout, setLayout\] = useState<LayoutId>\("table"\)/)
})

test("OpenJobs mobile chrome uses responsive wrappers instead of forcing page-wide overflow", () => {
  assert.match(source, /className="open-page"/)
  assert.match(source, /className="container open-nav__inner"/)
  assert.match(source, /className="open-nav__links"/)
  assert.match(source, /className="open-nav__actions"/)
  assert.match(source, /className="container open-guest__inner"/)
  assert.match(source, /className="open-header"/)
  assert.match(source, /className="open-header__controls"/)
  assert.match(source, /className="open-search"/)
  assert.match(source, /className="open-layout-switcher"/)
  assert.match(source, /@media \(max-width: 720px\)[\s\S]*\.open-nav__inner[\s\S]*flex-wrap: wrap/)
  assert.match(source, /@media \(max-width: 720px\)[\s\S]*\.open-header__controls[\s\S]*width: 100%/)
  assert.match(source, /@media \(max-width: 720px\)[\s\S]*\.open-search[\s\S]*width: 100%/)
  assert.match(source, /@media \(max-width: 720px\)[\s\S]*\.open-layout-switcher[\s\S]*width: 100%/)
})
