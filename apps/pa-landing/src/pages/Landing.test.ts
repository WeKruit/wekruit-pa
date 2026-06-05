// @ts-nocheck - landing app typecheck only includes Vite/browser types; this file runs with node --test via tsx.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const here = dirname(fileURLToPath(import.meta.url))
const landingSource = readFileSync(resolve(here, "Landing.tsx"), "utf8")
const sequenceSource = readFileSync(resolve(here, "../components/Sequence.tsx"), "utf8")
const pageStylesSource = readFileSync(resolve(here, "../styles/wekruit-pages.css"), "utf8")
const source = `${landingSource}\n${sequenceSource}\n${pageStylesSource}`

test("Landing frames the candidate promise as Claire-first passed-profile flow", () => {
  assert.doesNotMatch(source, /interview directly with the hiring manager/i)
  assert.doesNotMatch(source, /hiring managers who want to meet you this week/i)
  assert.doesNotMatch(source, /hiring managers<\/strong> taking interviews this week/i)
  assert.doesNotMatch(source, /Claire texts back within a minute/i)
  assert.doesNotMatch(source, /interview seats fill up/i)
  assert.doesNotMatch(source, /Got <em className="wk-accent">3 interviews<\/em> in a week/i)
  assert.doesNotMatch(source, /direct first interview with the hiring manager/i)
  assert.doesNotMatch(source, /No recruiter screen|No take-home tournament|Calendar invite in 48 hours/i)
  assert.doesNotMatch(source, />\s*Interview with hiring manager\s*</i)
  assert.match(source, /builds one WeKruit profile that keeps working across roles/i)
  assert.match(source, /Claire starts the first interview/i)
  assert.match(source, /passed profile/i)
  assert.match(source, /your passed profile carries the evidence/i)
})

test("Landing does not invent role availability or interview scarcity", () => {
  assert.doesNotMatch(landingSource, /claireReadyCount \|\| jobs\.length \|\| 6/)
  assert.doesNotMatch(landingSource, /data\.hiringManagerOnline \?\? \(h % 3 !== 0\)/)
  assert.doesNotMatch(landingSource, /data\.interviewSeats \?\? \(\(h % 4\) \+ 1\)/)
  assert.doesNotMatch(landingSource, /I've got 3 roles I can interview you for this week/)
  assert.doesNotMatch(landingSource, /Claire-ready roles/)
  assert.doesNotMatch(landingSource, /Loading Claire-ready roles/)
  assert.doesNotMatch(landingSource, /No Claire-ready roles are open right now\. Claire will text you when one opens\./)
  assert.doesNotMatch(landingSource, /Review opens tomorrow/)
  assert.doesNotMatch(landingSource, /job\.seats/)
  assert.doesNotMatch(landingSource, /Claire interview \{job\.seats === 1 \? "slot" : "slots"\} this week/)

  assert.match(landingSource, /public roles Claire can screen against/)
  assert.match(landingSource, /Claire interviews against real role briefs/)
  assert.match(landingSource, /Claire starts with the role interview/)
  assert.match(landingSource, /No public WeKruit roles are open right now/)
})

test("Landing trust section uses product proof instead of fake customer proof", () => {
  assert.doesNotMatch(landingSource, /Anthropic", "Perplexity", "Figma", "Stripe", "Vercel", "Cursor"/)
  assert.doesNotMatch(landingSource, /Built around hiring-team signal at/)
  assert.doesNotMatch(landingSource, /Renée Holloway|Renee Holloway/)
  assert.doesNotMatch(landingSource, /matched in 9 days/)
  assert.doesNotMatch(landingSource, /Claire turned my résumé into a real role conversation/)
  assert.doesNotMatch(landingSource, /wk-trust-logos/)
  assert.doesNotMatch(landingSource, /wk-quote/)

  assert.match(landingSource, /What Claire can prove/)
  assert.match(landingSource, /Evidence packet/)
  assert.match(landingSource, /Candidate-controlled sharing/)
  assert.match(landingSource, /Profile memory/)
  assert.match(landingSource, /pass reason, risks, fit notes, and transcript excerpts/)
})

test("Landing sample artifacts avoid borrowed real-company proof", () => {
  assert.doesNotMatch(source, /Maya Okafor/)
  assert.doesNotMatch(source, /Stripe|Anthropic|Snowflake|Notion|Vercel/)
  assert.doesNotMatch(source, /Claude APIs/)
  assert.doesNotMatch(source, /Replit|Linear/)

  assert.match(source, /Sample candidate/)
  assert.match(source, /AI infra platform/)
  assert.match(source, /Developer platform/)
  assert.match(source, /Productivity suite/)
})

test("Landing explains the candidate operating model without turning into an apply board", () => {
  assert.match(landingSource, /Candidate operating model/)
  assert.match(landingSource, /Who sees my profile\?/)
  assert.match(landingSource, /What if I do not pass a role screen\?/)
  assert.match(landingSource, /Does Claire apply for me\?/)
  assert.match(landingSource, /How do corrections stick\?/)

  assert.match(landingSource, /Only employers for roles you pass and consent to share with/)
  assert.match(landingSource, /Once you enter a role flow, Claire starts the first interview/)
  assert.match(landingSource, /A not-pass is role-specific/)
  assert.match(landingSource, /Public roles are role briefs Claire can interview against/)
  assert.match(landingSource, /Corrections update your durable profile and preferences/)

  assert.doesNotMatch(landingSource, /we apply to every role/i)
  assert.doesNotMatch(landingSource, /auto-submit/i)
  assert.doesNotMatch(landingSource, /guaranteed interview/i)
})

test("Landing exposes the market source layer without becoming an apply queue", () => {
  assert.match(landingSource, /<Link to="\/market" className="wk-btn wk-btn--secondary wk-btn--lg">/)
  assert.match(landingSource, /Open market/)
  assert.match(landingSource, /Tracked roles are source evidence, not applications/)
  assert.match(landingSource, /Use roles as signal before Claire chases anything/)

  assert.doesNotMatch(landingSource, /Apply queue/i)
  assert.doesNotMatch(landingSource, /auto-submit/i)
  assert.doesNotMatch(landingSource, /we pitch you anyway/i)
})

test("Landing hero shows the passed-profile evidence artifact Claire produces", () => {
  assert.match(landingSource, /function HeroEvidencePacket\(\)/)
  assert.match(landingSource, /aria-label="Sample Claire evidence packet"/)
  assert.match(landingSource, /Passed profile draft/)
  assert.match(landingSource, /Senior PM · AI infra/)
  assert.match(landingSource, /Nearest proof/)
  assert.match(landingSource, /AI workflow: 0 to 7 teams\./)
  assert.match(landingSource, /Constraints/)
  assert.match(landingSource, /NYC\/remote · \$180k\+\./)
  assert.match(landingSource, /Share gate/)
  assert.match(landingSource, /Employer share waits for candidate approval\./)
  assert.match(landingSource, /<HeroEvidencePacket \/>\s*<div className="wk-hero__caption">/)
  assert.match(landingSource, /\.wk-hero__grid \{[\s\S]*align-items: start;/)
  assert.match(landingSource, /\.wk-hero__visual \{ display: flex; flex-direction: column; align-items: center; gap: 9px; margin-top: -20px; \}/)
  assert.match(landingSource, /\.wk-hero__visual \.wk-imsg-thread__body \{ min-height: 160px; \}/)
  assert.match(landingSource, /\.wk-hero-packet \{[\s\S]*width: min\(100%, 390px\);[\s\S]*margin-top: 0;[\s\S]*border-radius: 8px;/)
  assert.match(landingSource, /\.wk-hero-packet__grid \{[\s\S]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/)
  assert.match(landingSource, /@media \(max-width: 980px\) \{[\s\S]*\.wk-hero__visual \{ margin-top: 0; padding-top: 24px; \}[\s\S]*\.wk-hero-packet \{ max-width: 320px; margin-top: 0; padding: 12px; \}/)
  assert.match(landingSource, /@media \(max-width: 760px\) \{[\s\S]*\.wk-hero-packet \{ max-width: 360px; \}/)

  assert.doesNotMatch(landingSource, /guaranteed pass/i)
  assert.doesNotMatch(landingSource, /auto-send/i)
  assert.doesNotMatch(landingSource, /without consent/i)
})

test("Landing hero headline keeps editorial lines separated across breakpoints", () => {
  assert.match(landingSource, /<h1 className="wk-hero__h1" aria-label="You don't apply\. You interview\.">/)
  assert.match(landingSource, /<span>You don&apos;t <em className="wk-accent">apply\.<\/em><\/span>/)
  assert.match(landingSource, /<span>You interview\.<\/span>/)
  assert.doesNotMatch(landingSource, /<span>You don&apos;t<\/span>\s*<span><em className="wk-accent">apply\.<\/em><\/span>/)
  assert.doesNotMatch(landingSource, /<span>You<\/span>\s*<span>interview\.<\/span>/)
  assert.match(landingSource, /\.wk-hero__h1 \{[\s\S]*--wk-hero-title-leading: 1\.14;[\s\S]*--wk-hero-title-row-gap: 5px;/)
  assert.match(landingSource, /\.wk-hero__h1 \{[\s\S]*display: flex;[\s\S]*flex-direction: column;[\s\S]*gap: var\(--wk-hero-title-row-gap\);/)
  assert.match(landingSource, /\.wk-hero__h1 \{[\s\S]*max-width: min\(100%, 620px\);[\s\S]*font-size: 52px;[\s\S]*line-height: var\(--wk-hero-title-leading\);/)
  assert.match(landingSource, /\.wk-hero__h1 \{[\s\S]*overflow: visible;/)
  assert.match(landingSource, /\.wk-hero__h1 > span \{[\s\S]*line-height: var\(--wk-hero-title-leading\);/)
  assert.match(landingSource, /\.wk-hero__h1 > span \{[\s\S]*white-space: nowrap;/)
  assert.doesNotMatch(landingSource, /\.wk-hero__h1 > span \{[^}]*text-wrap: balance;/)
  assert.match(landingSource, /\.wk-hero__h1 \.wk-accent \{[\s\S]*line-height: var\(--wk-hero-title-leading\);/)
  assert.match(landingSource, /\.wk-hero__h1 \.wk-accent \{[\s\S]*padding-bottom: 0\.03em;/)
  assert.match(landingSource, /\.wk-section__h2 \{[\s\S]*line-height: 1\.14; letter-spacing: 0;/)
  assert.match(source, /\.seq__h2 \{[\s\S]*letter-spacing: 0;[\s\S]*line-height: 1\.14;/)
  assert.match(
    landingSource,
    /@media \(max-width: 980px\) \{[\s\S]*\.wk-hero__h1 \{ --wk-hero-title-leading: 1\.16; --wk-hero-title-row-gap: 5px; font-size: 44px; \}/,
  )
  assert.match(
    landingSource,
    /@media \(max-width: 600px\) \{[\s\S]*\.wk-hero__h1 \{ --wk-hero-title-leading: 1\.18; --wk-hero-title-row-gap: 5px; font-size: 35px; \}/,
  )
  assert.match(landingSource, /@media \(max-width: 360px\) \{[\s\S]*\.wk-hero__h1 \{ font-size: 32px; \}/)
  assert.match(landingSource, /@media \(max-width: 600px\) \{[\s\S]*\.wk-hero__browse \{ flex-basis: 100%; \}/)
})

test("Landing hero lede keeps readable paragraph rhythm", () => {
  const ledeBlock = landingSource.match(/\.wk-hero__lede \{([\s\S]*?)\n\}/)?.[1] ?? ""
  assert.match(ledeBlock, /line-height: 1\.46;/)
  assert.match(ledeBlock, /color: var\(--wk-ink-2\);/)
  assert.match(ledeBlock, /margin: 0 0 22px;/)
  assert.doesNotMatch(ledeBlock, /line-height: 1\.14/)
  assert.doesNotMatch(ledeBlock, /letter-spacing: 0/)
  assert.doesNotMatch(ledeBlock, /color: var\(--wk-ink\); margin: 0/)
})

test("Landing hero yields the first viewport to the product flow", () => {
  assert.match(landingSource, /\.wk-hero \{ padding: 36px 0 44px; position: relative; \}/)
  assert.match(landingSource, /\.wk-hero__grid \{[\s\S]*gap: 48px;[\s\S]*align-items: start;/)
  assert.match(landingSource, /\.wk-hero__cta \{[\s\S]*gap: 10px;[\s\S]*margin-bottom: 22px;/)
  assert.match(landingSource, /\.wk-hero__browse \{[\s\S]*font-weight: 500; font-size: 13\.5px;/)
  assert.match(landingSource, /\.wk-hero__visual \.wk-imsg-phone \{ max-width: 320px; \}/)
  assert.match(landingSource, /@media \(max-width: 760px\) \{[\s\S]*\.wk-hero__visual \{[\s\S]*display: none;[\s\S]*\}/)
  assert.doesNotMatch(landingSource, /@media \(max-width: 760px\) \{[\s\S]*\.wk-hero__visual \{[\s\S]*padding-top: 0;[\s\S]*align-items: center;/)
})

test("Landing sequence feed has enough mobile art height for its own rows", () => {
  assert.match(pageStylesSource, /\.seq-feed__body \{[\s\S]*min-width: 0;[\s\S]*display: grid;[\s\S]*gap: 2px;/)
  assert.match(pageStylesSource, /\.seq-feed__row \{[\s\S]*min-height: 50px;/)
  assert.match(pageStylesSource, /\.seq-feed__why \{[\s\S]*line-height: 1\.35;/)
  assert.match(
    pageStylesSource,
    /@media \(max-width: 880px\) \{[\s\S]*\.seq-card__art:has\(\.seq-feed\) \{ min-height: 352px; \}/,
  )
  assert.match(
    pageStylesSource,
    /@media \(max-width: 880px\) \{[\s\S]*\.seq-feed__row \{[\s\S]*grid-template-columns: 24px minmax\(0, 1fr\) 22px;[\s\S]*min-height: 52px;[\s\S]*padding-block: 8px;/,
  )
})

test("Landing formats public job type chips before rendering candidate cards", () => {
  assert.match(landingSource, /import \{ formatPublicJobType \} from "\.\.\/lib\/public-job-labels\.js"/)
  assert.match(landingSource, /jobType: formatPublicJobType\(data\.jobType \?\? data\.prescreenConfig\?\.jobType\)/)
  assert.doesNotMatch(landingSource, /jobType: data\.jobType \?\? data\.prescreenConfig\?\.jobType/)
})

test("Landing sequence avoids rough job-board-as-verb copy", () => {
  assert.doesNotMatch(sequenceSource, /you don&apos;t job-board/i)
  assert.match(sequenceSource, /You don&apos;t apply, you don&apos;t chase job boards, and you don&apos;t get spammed\./)
})
