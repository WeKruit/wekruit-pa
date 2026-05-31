import { test } from "node:test"
import assert from "node:assert/strict"
import {
  buildRecCardPayload,
  splitReasonToBullets,
  formatSalaryRange,
  humanizeToken,
  normalizeCompanyStage,
  deriveCompanyDomain,
  googleFaviconUrl,
} from "../card-payload.js"

test("buildRecCardPayload: full job + REAL pa-company shape + reasons → complete payload", () => {
  const payload = buildRecCardPayload({
    job: {
      companyName: "Invoko",
      jobTitle: "Senior Product Designer",
      seniorityLevel: "senior",
      salaryMin: 200000,
      salaryMax: 400000,
      locationRaw: "SF, CA",
      jobType: "in-office full_time",
      atsApplyUrl: "https://jobs.invoko.com/apply/123",
      reason: "your Figma experience lines up",
    },
    company: {
      // Real PaCompany fields.
      companyStage: "series_a",
      employeeRange: "51-200",
      industry: "fintech",
      hqLocation: "San Francisco",
      logoUrl: "https://logo.clearbit.com/invoko.com",
      wekruitCollab: true,
      fundingRounds: [
        { round: "seed", amount: 4, date: "2023-01-01", investors: ["y combinator"] },
        { round: "series_a", amount: 26, date: "2024-06-01", investors: ["sequoia", "a16z"] },
      ],
    },
    reasons: { whyFits: ["Figma lines up", "fintech lane"], whyCompany: ["ships fast"] },
  })
  assert.ok(payload)
  assert.equal(payload!.company, "Invoko")
  assert.equal(payload!.title, "Senior Product Designer")
  assert.equal(payload!.seniority, "Senior")
  assert.equal(payload!.stage, "Series A")
  assert.equal(payload!.raiseAmount, "$26M") // latest round amount (USD millions)
  assert.equal(payload!.headcount, "51-200 people")
  assert.equal(payload!.industry, "Fintech")
  assert.equal(payload!.inNetwork, true) // wekruitCollab
  assert.equal(payload!.logoUrl, "https://logo.clearbit.com/invoko.com")
  assert.equal(payload!.salaryMin, 200000)
  assert.equal(payload!.salaryMax, 400000)
  assert.equal(payload!.location, "San Francisco") // hqLocation wins over job.locationRaw
  assert.equal(payload!.workMode, "in-office")
  // investors deduped + title-cased across rounds.
  assert.deepEqual(payload!.backers, ["Y Combinator", "Sequoia", "a16z"])
  assert.deepEqual(payload!.whyFits, ["Figma lines up", "fintech lane"])
  assert.deepEqual(payload!.whyCompany, ["ships fast"])
  // No team section in the contract anymore.
  assert.ok(!("team" in payload!))
  assert.equal(payload!.applyUrl, "https://jobs.invoko.com/apply/123")
})

test("buildRecCardPayload: returns null when company or title missing", () => {
  assert.equal(buildRecCardPayload({ job: { jobTitle: "X" } }), null)
  assert.equal(buildRecCardPayload({ job: { companyName: "Co" } }), null)
  assert.equal(buildRecCardPayload({ job: {} }), null)
})

test("buildRecCardPayload: gracefully omits absent sections (job-only)", () => {
  const payload = buildRecCardPayload({
    job: { companyName: "Rainforest", jobTitle: "Backend Engineer", locationRaw: "Remote" },
  })
  assert.ok(payload)
  assert.equal(payload!.company, "Rainforest")
  assert.equal(payload!.title, "Backend Engineer")
  assert.equal(payload!.stage, undefined)
  assert.equal(payload!.raiseAmount, undefined)
  assert.equal(payload!.headcount, undefined)
  assert.equal(payload!.industry, undefined)
  assert.equal(payload!.backers, undefined)
  assert.equal(payload!.whyCompany, undefined)
  assert.equal(payload!.whyFits, undefined) // no reason string either
  assert.equal(payload!.location, "Remote")
})

test("buildRecCardPayload: companyStage 'unknown' omits the stage pill", () => {
  const payload = buildRecCardPayload({
    job: { companyName: "Co", jobTitle: "Role" },
    company: { companyStage: "unknown", employeeRange: null, fundingRounds: [] },
  })
  assert.ok(payload)
  assert.equal(payload!.stage, undefined)
  assert.equal(payload!.headcount, undefined)
  assert.equal(payload!.raiseAmount, undefined)
})

test("buildRecCardPayload: falls back to reason string when no whyFits bullets", () => {
  const payload = buildRecCardPayload({
    job: {
      companyName: "Co",
      jobTitle: "Role",
      reason: "your Go experience lines up directly; same lane as your AWS stint",
    },
  })
  assert.ok(payload)
  assert.ok(Array.isArray(payload!.whyFits))
  assert.ok(payload!.whyFits!.length >= 1)
  assert.match(payload!.whyFits!.join(" "), /Go experience/)
})

test("buildRecCardPayload: structured whyFits wins over reason-string fallback", () => {
  const payload = buildRecCardPayload({
    job: { companyName: "Co", roleTitle: "Staff Engineer", reason: "fallback reason" },
    reasons: { whyFits: ["structured bullet"] },
  })
  assert.ok(payload)
  assert.equal(payload!.title, "Staff Engineer") // roleTitle fallback
  assert.deepEqual(payload!.whyFits, ["structured bullet"])
})

test("buildRecCardPayload: rejects non-https logo url (no domain → no favicon)", () => {
  const payload = buildRecCardPayload({
    job: { companyName: "Co", jobTitle: "Role" },
    company: { logoUrl: "http://insecure/logo.png" },
  })
  assert.ok(payload)
  // Non-https logo dropped; company name "Co" is not a domain → no favicon either.
  assert.equal(payload!.logoUrl, undefined)
})

// ── logo source: domain → Google favicon (Clearbit-dead replacement, D5) ──────

test("deriveCompanyDomain: from explicit domain / websiteUrl / domain-shaped name", () => {
  assert.equal(deriveCompanyDomain({ domain: "metavoice.io" }), "metavoice.io")
  assert.equal(deriveCompanyDomain({ websiteUrl: "https://www.photon.codes/careers" }), "photon.codes")
  assert.equal(deriveCompanyDomain({ companyName: "invoko.ai" }), "invoko.ai")
  // Non-domain company names → undefined (renderer falls back to monogram).
  assert.equal(deriveCompanyDomain({ companyName: "Helium" }), undefined)
  assert.equal(deriveCompanyDomain({ companyName: "VoiceCursor" }), undefined)
  assert.equal(deriveCompanyDomain({}), undefined)
})

test("googleFaviconUrl: 128px PNG endpoint for a domain", () => {
  assert.equal(
    googleFaviconUrl("metavoice.io"),
    "https://www.google.com/s2/favicons?domain=metavoice.io&sz=128",
  )
  assert.equal(googleFaviconUrl(undefined), undefined)
})

test("buildRecCardPayload: derives Google favicon logoUrl from company domain when no logoUrl", () => {
  const payload = buildRecCardPayload({
    job: { companyName: "MetaVoice", jobTitle: "Research Scientist" },
    company: { logoUrl: null, domain: "metavoice.io" },
  })
  assert.ok(payload)
  assert.equal(payload!.logoUrl, "https://www.google.com/s2/favicons?domain=metavoice.io&sz=128")
})

test("buildRecCardPayload: derives favicon from domain-shaped company name with NO company doc", () => {
  const payload = buildRecCardPayload({
    job: { companyName: "invoko.ai", jobTitle: "Product Designer" },
  })
  assert.ok(payload)
  assert.equal(payload!.logoUrl, "https://www.google.com/s2/favicons?domain=invoko.ai&sz=128")
})

test("buildRecCardPayload: explicit https logoUrl wins over favicon", () => {
  const payload = buildRecCardPayload({
    job: { companyName: "metavoice.io", jobTitle: "Role" },
    company: { logoUrl: "https://cdn.example.com/logo.png", domain: "metavoice.io" },
  })
  assert.equal(payload!.logoUrl, "https://cdn.example.com/logo.png")
})

test("buildRecCardPayload: raise amount over $1B renders in B", () => {
  const payload = buildRecCardPayload({
    job: { companyName: "Co", jobTitle: "Role" },
    company: { fundingRounds: [{ round: "series_f", amount: 1500, date: "2025-01-01", investors: [] }] },
  })
  assert.equal(payload!.raiseAmount, "$1.5B") // 1500 USD millions
})

test("normalizeCompanyStage: enum → label, unknown → undefined", () => {
  assert.equal(normalizeCompanyStage("series_b"), "Series B")
  assert.equal(normalizeCompanyStage("seed"), "Seed")
  assert.equal(normalizeCompanyStage("ipo_public"), "Public")
  assert.equal(normalizeCompanyStage("unknown"), undefined)
  assert.equal(normalizeCompanyStage(null), undefined)
  assert.equal(normalizeCompanyStage(""), undefined)
})

test("splitReasonToBullets: caps at 3; empty → undefined", () => {
  const out = splitReasonToBullets("a lines up. b matches. c offers more. d extra")
  assert.ok(out)
  assert.ok(out!.length <= 3)
  assert.equal(splitReasonToBullets(""), undefined)
  assert.equal(splitReasonToBullets(undefined), undefined)
})

test("formatSalaryRange", () => {
  assert.equal(formatSalaryRange(200000, 400000), "$200k–400k")
  assert.equal(formatSalaryRange(undefined, 150000), "up to $150k")
  assert.equal(formatSalaryRange(120000, undefined), "$120k+")
  assert.equal(formatSalaryRange(undefined, undefined), undefined)
})

test("humanizeToken", () => {
  assert.equal(humanizeToken("series_a"), "Series A")
  assert.equal(humanizeToken("staff-engineer"), "Staff Engineer")
})
