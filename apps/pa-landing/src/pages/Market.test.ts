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

test("Market role-brief empty state avoids unproven background scanning claims", () => {
  assert.match(source, /<strong>No role briefs yet\.<\/strong>/)
  assert.doesNotMatch(source, /Claire keeps scanning for stronger company access/)
  assert.match(source, /Check tracked roles and keep your profile preferences current\./)
})

test("Market tracked-role zero state moves candidates to real next actions before filters", () => {
  assert.match(source, /function MarketTrackedRolesEmpty\(\{ onViewRoleBriefs \}: \{ onViewRoleBriefs: \(\) => void \}\)/)
  assert.match(source, /No tracked roles in this view yet/)
  assert.match(source, /Role briefs are still available for Claire interviews/)
  assert.match(source, /Update role signals/)
  assert.match(source, /View role briefs/)
  assert.match(source, /const trackedRolesEmpty = hunting\.isSuccess && huntingTotal === 0/)
  assert.match(source, /const trackedHead = trackedRolesEmpty[\s\S]*No tracked roles yet\./)
  assert.match(source, /\{trackedRolesEmpty \? \([\s\S]*<MarketTrackedRolesEmpty onViewRoleBriefs=\{\(\) => setTab\("direct"\)\} \/>[\s\S]*\) : \([\s\S]*<div className="wk-market__layout">/)
})

test("Market tracked-role tab shows role inventory before the supporting source contract", () => {
  assert.match(
    source,
    /\{trackedRolesEmpty \? \([\s\S]*<MarketTrackedRolesEmpty onViewRoleBriefs=\{\(\) => setTab\("direct"\)\} \/>[\s\S]*\) : \([\s\S]*<div className="wk-market__layout">[\s\S]*<HuntCard key=\{r\.id\} r=\{r\} onOpen=\{\(\) => onOpenJob\(r\)\} \/>[\s\S]*\)\}[\s\S]*<section className="wk-market-contract" aria-labelledby="wk-market-contract-title">/,
  )
  assert.match(source, /@media \(max-width: 1280px\) \{[\s\S]*\.wk-shell \.wk-market__layout \{ grid-template-columns: 1fr; gap: 24px; \}/)
  assert.match(source, /\.wk-shell \.wk-market__col \{ order: 1; \}/)
  assert.match(source, /\.wk-shell \.wk-filt \{ position: static; order: 2; \}/)
  assert.match(source, /How Claire uses this market/)
  assert.match(source, /Use roles as signal, not another apply queue\./)
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

test("Market defaults mobile tracked roles to cards instead of dense table", () => {
  assert.match(source, /function initialMarketViewMode\(\): "table" \| "cards"/)
  assert.match(source, /window\.matchMedia\("\(max-width: 720px\)"\)\.matches \? "cards" : "table"/)
  assert.match(source, /useState<"table" \| "cards">\(initialMarketViewMode\)/)
  assert.doesNotMatch(source, /useState<"table" \| "cards">\("table"\)/)
})

test("Market opens on role briefs before external tracked roles", () => {
  assert.match(source, /useState<"hunting" \| "direct">\("direct"\)/)
  assert.doesNotMatch(source, /useState<"hunting" \| "direct">\("hunting"\)/)
})

test("Market role-brief tab does not overclaim mixed inbound briefs as direct-line collab", () => {
  assert.match(source, /label="Role briefs"/)
  assert.match(source, /sub="Hiring-team briefs for Claire"/)
  assert.match(source, /Role briefs <em className="wk-accent">ready<\/em> for Claire\./)
  assert.match(source, /<strong>No role briefs yet\.<\/strong>/)
  assert.match(source, /View role briefs/)

  assert.doesNotMatch(source, /label="Direct line"/)
  assert.doesNotMatch(source, /Inbound · Collaborated with WeKruit/)
  assert.doesNotMatch(source, /Direct-line role briefs/)
  assert.doesNotMatch(source, /No direct-line roles yet/)
  assert.doesNotMatch(source, /View direct-line roles/)
})

test("Market tracked-role rows connect external source inspection to durable preferences", () => {
  assert.match(source, /View source/)
  assert.match(source, /function profileCorrectionHrefForRole\(r: DisplayJob\): string/)
  assert.match(source, /profileRoleSignalTitle/)
  assert.match(source, /profileRoleSignalCompany/)
  assert.match(source, /profileRoleSignalFunction/)
  assert.match(source, /profileRoleSignalLevel/)
  assert.match(source, /profileRoleSignalLocation/)
  assert.match(source, /function roleSignalAriaLabel\(r: DisplayJob\): string/)
  assert.match(source, /const profileHref = profileCorrectionHrefForRole\(r\)/)
  assert.match(source, /const signalLabel = roleSignalAriaLabel\(r\)/)
  assert.match(source, /href=\{profileHref\}/)
  assert.match(source, /aria-label=\{signalLabel\}/)
  assert.match(source, /title="Opens a prefilled Claire role signal for this role"/)
  assert.match(source, /Send role signal/)
  assert.match(source, /prefilled with this exact role/)
  assert.match(source, /function HuntRow\([\s\S]*className="wk-roleactions"/)
  assert.match(source, /function HuntCard\([\s\S]*className="wk-roleactions wk-roleactions--card"/)
  assert.doesNotMatch(source, /href="\/me\/profile#match-preferences"/)

  assert.doesNotMatch(source, /Save role/i)
  assert.doesNotMatch(source, /Add to pipeline/i)
  assert.doesNotMatch(source, /Claire is now tracking this/i)
})

test("Market explains how Claire uses role sources before candidates chase postings", () => {
  assert.match(source, /How Claire uses this market/)
  assert.match(source, /Role briefs are screens WeKruit can run with Claire/)
  assert.match(source, /Tracked roles are source evidence, not applications/)
  assert.match(source, /Your profile and preferences decide what Claire can pursue with you/)
  assert.match(source, /aria-label="Market primary actions"/)
  assert.match(source, /href="\/me\/profile#profile-corrections"[\s\S]*Update role signals/)
  assert.match(source, /onClick=\{\(\) => setTab\("direct"\)\}[\s\S]*View role briefs/)
  assert.match(source, /href="\/me\/profile"/)
  assert.match(source, /href="\/onboarding"/)

  assert.doesNotMatch(source, /apply to every role/i)
  assert.doesNotMatch(source, /auto-submit/i)
  assert.doesNotMatch(source, /we pitch you anyway/i)
})

test("Market does not leak unresolved loading counts into candidate-facing chrome", () => {
  assert.doesNotMatch(source, /count=\{direct\.isSuccess \? directJobs\.length : "—"\}/)
  assert.doesNotMatch(source, /count=\{hunting\.isSuccess \? huntingTotal : "—"\}/)
  assert.doesNotMatch(source, /\{hunting\.isSuccess \? huntingTotal : "…"\}<\/em> roles Claire/)
  assert.doesNotMatch(source, /\{direct\.isSuccess \? directJobs\.length : "…"\}<\/em> role briefs/)

  assert.match(source, /count=\{direct\.isSuccess \? directJobs\.length : undefined\}/)
  assert.match(source, /count=\{hunting\.isSuccess \? huntingTotal : undefined\}/)
  assert.match(source, /Roles Claire is <em className="wk-accent">tracking<\/em>\./)
  assert.match(source, /Role briefs <em className="wk-accent">ready<\/em> for Claire\./)
})

test("Market role briefs do not overpromise employer access or invent interview capacity", () => {
  assert.doesNotMatch(source, /hiring managers <em className="wk-accent">ready<\/em> to meet you/)
  assert.doesNotMatch(source, /arrange the interview directly/i)
  assert.doesNotMatch(source, /seats:\s*typeof raw\.interviewSeats === "number" \? raw\.interviewSeats : 2/)
  assert.doesNotMatch(source, /\{r\.seats\} \{r\.seats === 1 \? "seat" : "seats"\}/)

  assert.match(source, /Role briefs <em className="wk-accent">ready<\/em> for Claire/)
  assert.match(source, /Claire starts the role interview before any passed profile is shared/)
  assert.match(source, /seats:\s*typeof raw\.interviewSeats === "number" \? raw\.interviewSeats : undefined/)
  assert.match(source, /r\.seats === undefined \? "Claire interview" :/)
})

test("Market role-brief cards do not invent hiring-manager identity when a role only has a brief", () => {
  assert.doesNotMatch(source, /name: raw\.hiringManagerName \?\? "Hiring manager"/)
  assert.doesNotMatch(source, /title: raw\.hiringManagerTitle \?\? "Hiring lead"/)
  assert.doesNotMatch(source, /<th className="wk-tbl__h">Hiring manager<\/th>/)

  assert.match(source, /const hiringManagerName = raw\.hiringManagerName\?\.trim\(\)/)
  assert.match(source, /const hiringManagerTitle = raw\.hiringManagerTitle\?\.trim\(\)/)
  assert.match(source, /online: !!hiringManagerName && !!raw\.hiringManagerOnline/)
  assert.match(source, /name: hiringManagerName \?\? "Role brief"/)
  assert.match(source, /title: hiringManagerName \? \(hiringManagerTitle \?\? "Hiring lead"\) : "Employer-approved screen"/)
  assert.match(source, /className="wk-direct-card__owner"/)
})

test("Market role briefs use action cards as the primary inventory", () => {
  assert.match(source, /function DirectCard\(\{ r, onTalk \}: \{ r: DisplayJob; onTalk: \(\) => void \}\)/)
  assert.match(source, /<div className="wk-direct-cards">[\s\S]*<DirectCard key=\{r\.id\} r=\{r\} onTalk=\{\(\) => onTalkToClaire\(r\)\} \/>/)
  assert.match(source, /\.wk-shell \.wk-direct-cards \{[\s\S]*display: grid; grid-template-columns: repeat\(auto-fit, minmax\(300px, 1fr\)\);[\s\S]*gap: 14px; margin-top: 8px;/)
  assert.match(source, /@media \(max-width: 720px\) \{[\s\S]*\.wk-shell \.wk-direct-cards \{ display: grid; grid-template-columns: 1fr; gap: 8px; margin-top: 6px; \}/)
  assert.match(source, /Choose a role to talk to Claire\./)
  assert.doesNotMatch(source, /Tap a row to talk to Claire\./)
  assert.doesNotMatch(source, /function DirectRow/)
  assert.doesNotMatch(source, /wk-direct-table/)
  assert.doesNotMatch(source, /wk-tbl--direct/)
})

test("Market role briefs can be searched before candidates scan the full inventory", () => {
  assert.match(source, /const \[directSearchQ, setDirectSearchQ\] = useState\(""\)/)
  assert.match(source, /function roleBriefSearchTokens\(s: string\): string\[\]/)
  assert.match(source, /function roleBriefMatchesSearch\(r: DisplayJob, search: string\): boolean/)
  assert.match(source, /token\.startsWith\(term\)/)
  assert.match(source, /const directSearch = directSearchQ\.trim\(\)\.toLowerCase\(\)/)
  assert.match(source, /const filteredDirectJobs = useMemo\(\(\) => \{[\s\S]*if \(!directSearch\) return directJobs[\s\S]*roleBriefMatchesSearch\(r, directSearch\)/)
  assert.doesNotMatch(source, /haystack\.includes\(directSearch\)/)
  assert.match(source, /aria-label="Role brief search"/)
  assert.match(source, /placeholder="Search role, company, location…"/)
  assert.match(source, /Showing \{filteredDirectJobs\.length\} of \{directJobs\.length\} role briefs/)
  assert.match(source, /setDirectSearchQ\(""\)[\s\S]*Clear/)
  assert.match(source, /filteredDirectJobs\.length === 0 \? \([\s\S]*No role briefs match\./)
  assert.match(source, /filteredDirectJobs\.map\(\(r\) => \([\s\S]*<DirectCard key=\{r\.id\} r=\{r\} onTalk=\{\(\) => onTalkToClaire\(r\)\} \/>/)
  assert.match(source, /\.wk-shell \.wk-direct-toolbar \{[\s\S]*grid-template-columns: minmax\(240px, 360px\) minmax\(0, 1fr\) auto;/)
  assert.match(source, /@media \(max-width: 720px\) \{[\s\S]*\.wk-shell \.wk-direct-toolbar \{[\s\S]*grid-template-columns: 1fr auto;/)
})

test("Market desktop role-brief cards keep the Claire action in each role block", () => {
  assert.match(source, /className="wk-pitchbtn wk-pitchbtn--ink wk-pitchbtn--lg wk-direct-card__quick" onClick=\{onTalk\}/)
  assert.match(source, /className="wk-direct-card__foot"[\s\S]*<button className="wk-pitchbtn wk-pitchbtn--ink wk-pitchbtn--lg" onClick=\{onTalk\}>/)
  assert.match(source, /<Icon name="message" size=\{13\} stroke=\{2\} \/> Talk to Claire/)
  assert.match(source, /\.wk-shell \.wk-direct-card__foot \{[\s\S]*display: flex; align-items: center; justify-content: space-between;/)
  assert.match(source, /\.wk-shell \.wk-direct-card__quick \{ display: none; \}/)
})

test("Market default role-brief tab shows role inventory before the supporting Claire contract", () => {
  assert.match(source, /function MarketRoleBriefContract\(\)/)
  assert.match(source, /function MarketRoleBriefWorkflow\(\{ count \}: \{ count\?: number \}\)/)
  assert.match(source, /aria-label="Claire role brief workflow"/)
  assert.match(source, /Pick a brief\. Claire runs the first screen\./)
  assert.match(source, /Role brief/)
  assert.match(source, /Must-haves, filters, and evidence probes set Claire's screen\./)
  assert.match(source, /Claire screen/)
  assert.match(source, /Consent gate/)
  assert.doesNotMatch(source, /Employer bar/)
  assert.match(source, /aria-label="Role brief Claire contract"/)
  assert.match(source, /What happens when you pick a role brief/)
  assert.match(source, /Role brief sets Claire's interview/)
  assert.match(source, /Your durable profile supplies constraints/)
  assert.match(source, /corrections stay attached across Claire's role screens/)
  assert.match(source, /Passed profile only after consent/)
  assert.match(source, /\{direct\.isPending \? \([\s\S]*<MarketRoleBriefWorkflow count=\{direct\.isSuccess \? directJobs\.length : undefined\} \/>[\s\S]*<div className="wk-direct-cards">[\s\S]*<DirectCard key=\{r\.id\} r=\{r\} onTalk=\{\(\) => onTalkToClaire\(r\)\} \/>[\s\S]*\)\}[\s\S]*<MarketRoleBriefContract \/>/)
  assert.match(source, /href="\/me\/profile#profile-corrections"[\s\S]*Update profile signals/)

  assert.doesNotMatch(source, /guaranteed interview/i)
  assert.doesNotMatch(source, /auto-submit/i)
})

test("Market keeps mobile role cards primary while preserving the compact support contract", () => {
  assert.match(source, /wk-market-contract__mobile-brief/)
  assert.match(source, /Claire screens first\. Hiring teams see a passed profile only after you approve sharing\./)
  assert.match(source, /<MarketRoleBriefWorkflow count=\{direct\.isSuccess \? directJobs\.length : undefined\} \/>[\s\S]*<div className="wk-direct-cards">[\s\S]*<DirectCard key=\{r\.id\} r=\{r\} onTalk=\{\(\) => onTalkToClaire\(r\)\} \/>[\s\S]*<MarketRoleBriefContract \/>/)
  assert.match(source, /@media \(max-width: 720px\) \{[\s\S]*\.wk-shell \.wk-market-contract--role-briefs \{[\s\S]*display: block; padding: 14px 0 16px; margin: 16px 0 18px;/)
  assert.match(source, /\.wk-shell \.wk-market-contract--role-briefs \.wk-market-contract__copy,[\s\S]*\.wk-shell \.wk-market-contract--role-briefs \.wk-market-contract__grid,[\s\S]*\.wk-shell \.wk-market-contract--role-briefs \.wk-market-contract__actions \{[\s\S]*display: none;/)
  assert.match(source, /@media \(max-width: 720px\) \{[\s\S]*\.wk-shell \.wk-roleflow \{[\s\S]*padding: 14px 0 12px;[\s\S]*display: block;/)
  assert.match(source, /@media \(max-width: 720px\) \{[\s\S]*\.wk-shell \.wk-roleflow__steps \{[\s\S]*display: flex;[\s\S]*flex-wrap: wrap;/)
  assert.match(source, /\.wk-shell \.wk-roleflow__steps span \{[\s\S]*display: none;/)
})

test("Market mobile headlines leave enough line height for two-line Newsreader italics", () => {
  assert.match(source, /\.wk-shell \.wk-market__h1 \{[\s\S]*line-height: 1\.12; letter-spacing: 0;/)
  assert.match(source, /\.wk-shell \.wk-market__h1 \.wk-accent \{ line-height: inherit; \}/)
  assert.match(source, /@media \(max-width: 720px\) \{[\s\S]*\.wk-shell \.wk-market__h1 \{[\s\S]*font-size: clamp\(36px, 10vw, 44px\);[\s\S]*line-height: 1\.24;[\s\S]*letter-spacing: 0;[\s\S]*margin: 14px 0 18px;/)
  assert.doesNotMatch(source, /\.wk-shell \.wk-market__h1 \{[\s\S]*line-height: 1\.02; letter-spacing: -0\.028em;/)
})

test("Market tab chrome separates labels, counts, and subtitles on narrow screens", () => {
  assert.match(source, /<button type="button" className=\{`wk-mtab\$\{active \? " is-active" : ""\}`\}/)
  assert.match(source, /\.wk-shell \.wk-mtab \{[\s\S]*min-width: 0;/)
  assert.match(source, /\.wk-shell \.wk-mtab__top \{ display: flex; align-items: flex-start; gap: 10px; min-width: 0; \}/)
  assert.match(source, /\.wk-shell \.wk-mtab__label \{[\s\S]*line-height: 1\.14;[\s\S]*letter-spacing: 0;/)
  assert.match(source, /\.wk-shell \.wk-mtab__count \{[\s\S]*line-height: 1;[\s\S]*flex: 0 0 auto; margin-top: 4px;/)
  assert.match(source, /\.wk-shell \.wk-mtab__sub \{[\s\S]*line-height: 1\.32;[\s\S]*letter-spacing: 0;/)
  assert.match(source, /@media \(max-width: 860px\) \{[\s\S]*\.wk-shell \.wk-mtabs \{[\s\S]*display: grid;[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/)
  assert.match(source, /@media \(max-width: 860px\) \{[\s\S]*\.wk-shell \.wk-mtab__label \{ font-size: 21px; line-height: 1\.16; \}/)
  assert.match(source, /@media \(max-width: 860px\) \{[\s\S]*\.wk-shell \.wk-mtab__sub \{ display: block; font-size: 11\.75px; line-height: 1\.3; \}/)
  assert.doesNotMatch(source, /\.wk-shell \.wk-mtab__sub \{ display: none; \}/)
  assert.doesNotMatch(source, /letter-spacing: -0\.02em; color: inherit;/)
  assert.doesNotMatch(source, /letter-spacing: -0\.01em; color: inherit;/)
})

test("Market mobile role brief cards stay compact enough to compare options", () => {
  assert.match(source, /@media \(max-width: 720px\) \{[\s\S]*\.wk-shell \.wk-direct-cards \{ display: grid; grid-template-columns: 1fr; gap: 8px; margin-top: 6px; \}/)
  assert.match(source, /\.wk-shell \.wk-direct-card \{[\s\S]*padding: 14px;[\s\S]*gap: 8px;[\s\S]*border-color: var\(--wk-border\);/)
  assert.match(source, /\.wk-shell \.wk-direct-card \.wk-evidence \{[\s\S]*grid-column: auto;[\s\S]*max-width: 130px;/)
  assert.match(source, /\.wk-shell \.wk-direct-card \.wk-evidence__detail \{[\s\S]*display: none;/)
  assert.match(source, /\.wk-shell \.wk-direct-card__foot \{[\s\S]*grid-template-columns: minmax\(0, 1fr\) auto;/)
  assert.match(source, /\.wk-shell \.wk-direct-card__quick \{[\s\S]*display: inline-flex;[\s\S]*align-self: flex-start;[\s\S]*height: 34px;/)
  assert.match(source, /\.wk-shell \.wk-direct-card__foot \.wk-pitchbtn \{[\s\S]*display: none;/)
  assert.doesNotMatch(source, /\.wk-shell \.wk-direct-card__foot \.wk-pitchbtn \{ width: 100%;/)
})
