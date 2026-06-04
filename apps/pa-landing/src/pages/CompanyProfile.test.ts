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
  assert.match(source, /function CompanyScreeningContract\(\{ company, roleTitle \}: \{ company: string; roleTitle: string \}\)/)
  assert.match(source, /What Claire will test/)
  assert.match(source, /\{company\} becomes a Claire screen\./)
  assert.match(source, /Nearest-work evidence/)
  assert.match(source, /Role constraints/)
  assert.match(source, /Durable profile context/)
  assert.match(source, /Claire carries your WeKruit profile, constraints, and corrections into this company screen/)
  assert.match(source, /Consent before sharing/)
  assert.match(source, /test your profile against this company's actual bar/)
  assert.match(source, /<CompanyScreeningContract company=\{company\} roleTitle=\{firstJob\.title\} \/>[\s\S]*<section className="wk-company-roles"/)
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
  assert.match(source, /<Link className="wk-btn wk-btn--primary" to="\/market">/)
  assert.match(source, /Open market <Icon name="arrow-right" size=\{16\} stroke=\{1\.8\} \/>/)

  assert.doesNotMatch(source, /to="\/open"/)
  assert.doesNotMatch(source, /See open roles/)
  assert.doesNotMatch(source, /Open roles and company details/)
})
