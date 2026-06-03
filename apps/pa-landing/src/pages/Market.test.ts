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

test("Market role-brief rows do not invent hiring-manager identity when a role only has a brief", () => {
  assert.doesNotMatch(source, /name: raw\.hiringManagerName \?\? "Hiring manager"/)
  assert.doesNotMatch(source, /title: raw\.hiringManagerTitle \?\? "Hiring lead"/)
  assert.doesNotMatch(source, /<th className="wk-tbl__h">Hiring manager<\/th>/)

  assert.match(source, /const hiringManagerName = raw\.hiringManagerName\?\.trim\(\)/)
  assert.match(source, /const hiringManagerTitle = raw\.hiringManagerTitle\?\.trim\(\)/)
  assert.match(source, /online: !!hiringManagerName && !!raw\.hiringManagerOnline/)
  assert.match(source, /name: hiringManagerName \?\? "Role brief"/)
  assert.match(source, /title: hiringManagerName \? \(hiringManagerTitle \?\? "Hiring lead"\) : "Employer-approved screen"/)
  assert.match(source, /<th className="wk-tbl__h">Owner<\/th>/)
})

test("Market role briefs render mobile cards instead of only a wide table", () => {
  assert.match(source, /function DirectCard\(\{ r, onTalk \}: \{ r: DisplayJob; onTalk: \(\) => void \}\)/)
  assert.match(source, /className="wk-tbl-wrap wk-tbl-wrap--solo wk-direct-table"/)
  assert.match(source, /<div className="wk-direct-cards">[\s\S]*<DirectCard key=\{r\.id\} r=\{r\} onTalk=\{\(\) => onTalkToClaire\(r\)\} \/>/)
  assert.match(source, /\.wk-shell \.wk-direct-cards \{ display: none; \}/)
  assert.match(source, /@media \(max-width: 720px\) \{[\s\S]*\.wk-shell \.wk-direct-table \{ display: none; \}[\s\S]*\.wk-shell \.wk-direct-cards \{ display: grid;/)
  assert.match(source, /Choose a role to talk to Claire\./)
  assert.doesNotMatch(source, /Tap a row to talk to Claire\./)
})

test("Market default role-brief tab explains the Claire interview contract before role cards", () => {
  assert.match(source, /function MarketRoleBriefContract\(\)/)
  assert.match(source, /aria-label="Role brief Claire contract"/)
  assert.match(source, /What happens when you pick a role brief/)
  assert.match(source, /Role brief sets Claire's interview/)
  assert.match(source, /Your durable profile supplies constraints/)
  assert.match(source, /corrections stay attached across Claire's role screens/)
  assert.match(source, /Passed profile only after consent/)
  assert.match(source, /<MarketRoleBriefContract \/>[\s\S]*\{direct\.isPending \? \(/)
  assert.match(source, /href="\/me\/profile#profile-corrections"[\s\S]*Update profile signals/)

  assert.doesNotMatch(source, /guaranteed interview/i)
  assert.doesNotMatch(source, /auto-submit/i)
})

test("Market keeps mobile role briefs actionable before the first scroll", () => {
  assert.match(source, /wk-market-contract__mobile-brief/)
  assert.match(source, /Claire screens first\. Hiring teams see a passed profile only after you approve sharing\./)
  assert.match(source, /@media \(max-width: 720px\) \{[\s\S]*\.wk-shell \.wk-market-contract--role-briefs \{[\s\S]*display: block; padding: 14px 0 16px; margin-bottom: 18px;/)
  assert.match(source, /\.wk-shell \.wk-market-contract--role-briefs \.wk-market-contract__copy,[\s\S]*\.wk-shell \.wk-market-contract--role-briefs \.wk-market-contract__grid,[\s\S]*\.wk-shell \.wk-market-contract--role-briefs \.wk-market-contract__actions \{[\s\S]*display: none;/)
})
