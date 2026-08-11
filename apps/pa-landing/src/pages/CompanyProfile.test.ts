// @ts-nocheck - landing app typecheck only includes Vite/browser types; this file runs with node --test via tsx.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, "CompanyProfile.tsx"), "utf8")

test("CompanyProfile keeps the employer process copy consent-safe", () => {
  assert.match(source, /Claire confirms role fit with you\./)
  assert.match(source, /Only candidates who pass and consent get shared\./)
  assert.match(source, /If there is mutual interest, the first chat gets booked\./)

  assert.doesNotMatch(source, /WeKruit shares a concise profile\./)
})

test("CompanyProfile shows Claire's company-specific screening contract before role cards", () => {
  assert.match(source, /function CompanyScreeningContract\(\{ company \}: \{ company: string \}\)/)
  assert.match(source, /What Claire will test/)
  assert.match(source, /\{company\} becomes a Claire screen\./)
  assert.match(source, /Nearest-work evidence/)
  assert.match(source, /Role constraints/)
  assert.match(source, /Durable profile context/)
  assert.match(source, /Claire carries your WeKruit profile, constraints, and corrections into this company screen/)
  assert.match(source, /Consent before sharing/)
  assert.match(source, /test your profile against this company's actual bar/)
  assert.match(source, /closest shipped work before treating a selected role as a fit/)
  assert.match(source, /<CompanyScreeningContract company=\{company\} \/>[\s\S]*<section className="wk-company-roles"/)
  assert.doesNotMatch(source, /roleTitle=\{firstJob\.title\}/)
  assert.doesNotMatch(source, /treating \$\{roleTitle\} as a fit/)
})

test("CompanyProfile surfaces the first Claire interview action in the hero", () => {
  assert.match(source, /function CompanyHeroRoleCta\(\{ job, company, roleCount \}: \{ job: PublicJobOpening; company: string; roleCount: number \}\)/)
  assert.match(source, /<CompanyHeroRoleCta job=\{firstJob\} company=\{company\} roleCount=\{jobs\.length\} \/>/)
  assert.match(source, /className="wk-company-hero-cta"/)
  assert.match(source, /aria-label=\{`Start Claire interview for \$\{company\}`\}/)
  assert.match(source, /Claire-ready role/)
  assert.match(source, /to=\{`\/j\/\$\{job\.id\}`\}/)
  assert.match(source, /Start Claire interview <Icon name="arrow-right" size=\{16\} stroke=\{1\.8\} \/>/)
  assert.match(source, /\.wk-company-hero-cta \{[\s\S]*grid-template-columns: minmax\(0, 1fr\) auto;/)
  assert.match(source, /@media \(max-width: 560px\)[\s\S]*\.wk-company-hero-cta \{[\s\S]*grid-template-columns: 1fr;/)
  assert.match(source, /@media \(max-width: 560px\)[\s\S]*\.wk-company-hero-cta__primary \{ width: 100%; justify-content: center; \}/)
})

test("CompanyProfile role cards expose the Claire interview action", () => {
  assert.match(source, /aria-label=\{`Start Claire interview for \$\{job\.title\}`\}/)
  assert.match(source, /className="wk-company-role__action"/)
  assert.match(source, /Start Claire interview/)
  assert.match(source, /Start a role when you want Claire to test your profile against this company's actual bar/)

  assert.doesNotMatch(source, /Apply now/i)
  assert.doesNotMatch(source, /Browse role/i)
})

test("CompanyProfile routes market navigation to the canonical market surface", () => {
  assert.match(source, /Role briefs and company details are shared through the WeKruit interview process\./)
  assert.match(source, /<Link className="wk-company-back" to="\/market">/)
  assert.match(source, /<Icon name="arrow-left" size=\{16\} stroke=\{1\.8\} \/> Market/)
  assert.match(source, /<Link className="wk-btn wk-btn--primary wk-company-empty-panel__primary" to="\/market">/)
  assert.match(source, /Open role briefs <Icon name="arrow-right" size=\{16\} stroke=\{1\.8\} \/>/)

  assert.doesNotMatch(source, /to="\/open"/)
  assert.doesNotMatch(source, /See open roles/)
  assert.doesNotMatch(source, /Open roles and company details/)
})

test("CompanyProfile empty state routes candidates back into Claire instead of a dead page", () => {
  assert.match(source, /<main className="wk-company wk-container wk-company-state wk-company-state--empty">/)
  assert.match(source, /No active Claire screen here yet\./)
  assert.match(source, /This company does not have an open WeKruit role brief right now\./)
  assert.match(source, /className="wk-company-empty-panel" aria-label="Company profile recovery actions"/)
  assert.match(source, /Keep moving with Claire\./)
  assert.match(source, /Role briefs are the live interview surface; your WeKruit profile stays reusable across companies\./)
  assert.match(source, /<Link className="wk-company-empty-panel__secondary" to="\/onboarding">/)
  assert.match(source, /Start with Claire/)
  assert.match(source, /\.wk-company-state--empty \{[\s\S]*align-content: center;/)
  assert.match(source, /@media \(max-width: 560px\)[\s\S]*\.wk-company-state--empty \{[\s\S]*align-content: start;/)
  assert.match(source, /@media \(max-width: 560px\)[\s\S]*\.wk-company-empty-panel__primary \{[\s\S]*width: 100%;[\s\S]*justify-content: center;/)

  assert.doesNotMatch(source, /This company profile is not open\./)
  assert.doesNotMatch(source, /There are no public WeKruit roles for this company yet\./)
})

test("CompanyProfile does not use a first role sentence as the company summary", () => {
  assert.match(source, /if \(profile\?\.tagline\) return profile\.tagline/)
  assert.match(source, /if \(profile\?\.about\) return profile\.about/)
  assert.match(source, /const roleText = roleCount === 1 \? "public role" : "public roles"/)
  assert.match(source, /Explore \$\{roleCount\} \$\{roleText\} at \$\{company\}/)
  assert.match(source, /Choose a role when you want Claire to screen your profile against that team's actual bar/)

  assert.doesNotMatch(source, /stripJobSourceSection/)
  assert.doesNotMatch(source, /job\.descriptionMd/)
  assert.doesNotMatch(source, /if \(inCompanySection \|\| normalized\.length > 80\) return cleanMarkdownLine\(trimmed\)/)
  assert.doesNotMatch(source, /if \(inCompanySection\) return cleanMarkdownLine\(trimmed\)/)
  assert.doesNotMatch(source, /normalized\.includes\("why this role exists"\)/)
  assert.doesNotMatch(source, /Android Engineer at Rain is a mid level software engineering opportunity/)
  assert.doesNotMatch(source, /You'll be the lead Android engineer at Rain/)
  assert.doesNotMatch(source, /Own the entire Android development lifecycle/)
  assert.doesNotMatch(source, /Bonus attributes:/)
})

test("CompanyProfile can render Photon from curated fallback data", () => {
  assert.match(source, /const PHOTON_PROFILE: PublicCompanyProfile = \{/)
  assert.match(source, /websiteUrl: "https:\/\/photon\.codes\/"/)
  assert.match(source, /Photon builds Spectrum, a framework for bringing AI agents into iMessage, WhatsApp, Discord, Slack, Telegram, Instagram/)
  assert.match(source, /const PHOTON_STATIC_JOBS: PublicJobOpening\[\] = \[/)
  assert.match(source, /id: "wekruit-37429d02-photon-macos-devops"/)
  assert.match(source, /title: "Member of Technical Staff, macOS DevOps"/)
  assert.match(source, /id: "wekruit-973f2953-photon-objective-c-engineer"/)
  assert.match(source, /title: "Member of Technical Staff, Objective-C"/)
  assert.match(source, /const STATIC_COMPANY_JOBS: Record<string, PublicJobOpening\[\]> = \{[\s\S]*photon: PHOTON_STATIC_JOBS/)
})

test("CompanyProfile leaves non-curated companies blank when Firestore has no jobs", () => {
  assert.match(source, /function getStaticCompanyJobs\(companyId: string \| undefined\): PublicJobOpening\[\] \{[\s\S]*STATIC_COMPANY_JOBS\[normalizeCompanySlug\(companyId\)\] \?\? \[\]/)
  assert.match(source, /const jobs = jobsQuery\.data\?\.length \? jobsQuery\.data : fallbackJobs/)
  assert.match(source, /if \(!jobs\.length\) return <CompanyEmpty \/>/)
})
