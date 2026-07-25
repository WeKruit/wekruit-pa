/**
 * Guards for YC company extraction. Every assertion below is a failure we hit on
 * LIVE cohort data — each named so it cannot regress silently.
 */
import assert from "node:assert/strict"
import {
  parseYcBatch, ycBatchStage, trustedCompanyEntry, namesAgree, domainOf,
  PLACEHOLDER_COMPANY_RE, SCHOOL_RE,
} from "../../src/yc-company-lib.js"

// --- YC batch tag ---
assert.equal(parseYcBatch("Co-Founder @ xPay (YC W24)"), "W24")
assert.equal(parseYcBatch("Cofounder @ AgentMail (YC S25)"), "S25")
assert.equal(parseYcBatch("ceo and co-founder @ Clad Labs (YC F25)"), "F25")
assert.equal(parseYcBatch("Founder at Sentient OS, YC S26"), "S26")
assert.equal(parseYcBatch("Founder @ Acme"), null)
assert.equal(parseYcBatch("works on NYC W2 forms"), null, "NYC must not parse as a YC batch")
assert.equal(ycBatchStage("W26"), "yc_current")
assert.equal(ycBatchStage("S24"), "yc_early")
assert.equal(ycBatchStage("W21"), "yc_maturing")

// --- LIVE FAILURE 1: BlueAlpha ---
// Manas Garg's record states "BlueAlpha". His only founder-titled Coresignal row is a
// 2020-2022 role at Machinaa Technology (active_experience: 0). Collecting that id
// returned "Machinaa Technology Inc." in full detail — a past role read as current.
const machinaa = { company_name: "Machinaa Technology", company_id: 31683223, position_title: "Founder", active_experience: 0 }
assert.equal(
  trustedCompanyEntry({ experience: [machinaa] }, "BlueAlpha").entry, null,
  "BlueAlpha: a non-active 2020-2022 role must never be reported as the current company",
)
assert.equal(trustedCompanyEntry({ experience: [machinaa] }, "BlueAlpha").reason, "no_active_experience")

// Same shape, but with an unrelated active row present — still must not pick Machinaa.
const otherActive = { company_name: "Phantm", company_id: 100217271, position_title: "Founder", active_experience: 1 }
assert.equal(
  trustedCompanyEntry({ experience: [machinaa, otherActive] }, "BlueAlpha").entry, null,
  "BlueAlpha: an active row that disagrees with the stated company must not be substituted",
)
assert.equal(trustedCompanyEntry({ experience: [machinaa, otherActive] }, "BlueAlpha").reason, "active_name_disagrees")

// --- LIVE FAILURE 2: "Stealth" ---
// 13 founders list "Stealth"/"Stealth Startup". LinkedIn's placeholder page is
// company_id 83805468, which collects as TimelyAI (Phoenix, 3954 employees).
for (const s of ["Stealth", "Stealth Startup", "Stealth AI Startup", "stealth mode", "Self-Employed", "Freelance", "Confidential"]) {
  assert.ok(PLACEHOLDER_COMPANY_RE.test(s), `placeholder must be caught: "${s}"`)
}
assert.ok(!PLACEHOLDER_COMPANY_RE.test("Phantm"))
// The trap in full: the id sits on an ACTIVE row with an agreeing name, so the trust
// gate alone PASSES it — the placeholder check is what stops TimelyAI landing.
const stealthRow = { company_name: "Stealth", company_id: 83805468, position_title: "Founder", active_experience: 1 }
assert.ok(trustedCompanyEntry({ experience: [stealthRow] }, "Stealth").entry, "trust gate alone does NOT catch Stealth...")
assert.ok(PLACEHOLDER_COMPANY_RE.test("Stealth"), "...the placeholder guard is the one that must")

// --- happy paths ---
assert.equal(trustedCompanyEntry({ experience: [machinaa, otherActive] }, "Phantm").entry?.company_id, 100217271)
assert.equal(trustedCompanyEntry({ experience: [otherActive] }, "Phantm (YC S25)").entry?.company_id, 100217271, "YC suffix must not break the name match")
assert.equal(trustedCompanyEntry({ experience: [] }, "Phantm").entry, null)

// --- schools are not companies (live: 2 founders stated their university) ---
assert.ok(SCHOOL_RE.test("Carnegie Mellon University School of Computer Science"))
assert.ok(SCHOOL_RE.test("The University of North Carolina at Chapel Hill"))
assert.ok(!SCHOOL_RE.test("Clad Labs"))

// --- name agreement: loose containment is how the wrong firm gets attached ---
assert.ok(namesAgree("xPay (YC W24)", "xPay"))
assert.ok(namesAgree("Centralize", "Centralize"))
assert.ok(!namesAgree("Axiom", "Axiom Space"), "containment must NOT agree — Axiom is not Axiom Space")
assert.ok(!namesAgree("Exa", "Exabeam"))
assert.ok(namesAgree("Clad Labs (YC F25)", "Clad"), "stripped fillers still agree")
assert.ok(namesAgree("Reeltors AI", "Reeltors"))
assert.ok(!namesAgree("Phantm", "Phantom"))
assert.ok(!namesAgree("", "Phantm"))

// --- domain extraction feeds the exact `website_domain` search ---
assert.equal(domainOf("https://www.agentmail.to"), "agentmail.to")
assert.equal(domainOf("http://songscription.ai/pricing"), "songscription.ai")
assert.equal(domainOf(null), null)

console.log("yc-company-guards: ok")

// ---------------------------------------------------------------------------
// inferCompanyStage — de-regexed 2026-07-25. Every rule removed below was WRONG on
// live data; these assertions exist so none of them creeps back as a "helpful" guess.
// ---------------------------------------------------------------------------
import { inferCompanyStage, roundTypeToStage } from "../../src/yc-people-match.js"

// The real funding round wins outright.
assert.deepEqual(inferCompanyStage({ profileStage: "Pre Seed Round" }), { stage: "pre_seed", source: "funding_round" })
assert.deepEqual(inferCompanyStage({ profileStage: "Series C Round" }), { stage: "series_c", source: "funding_round" })
assert.equal(roundTypeToStage("SEED ROUND"), "seed", "round lookup is case/whitespace tolerant but still exact")
assert.equal(roundTypeToStage("Some New Round Type"), null, "an unrecognised round must NOT be guessed")

// REMOVED RULE 1: "(YC W24)" used to return seed. Measured false — W24 companies are
// still Pre Seed (xPay 16 emp, Centralize 13 emp, Focal 4 emp).
assert.equal(
  inferCompanyStage({ experience: [{ currentRole: true, companySizeRange: null }], libraryStage: null }).stage,
  "unknown",
  "a YC batch tag must no longer produce a stage — batch age does not pin the round",
)
// And when the real round IS known, it must win over what the batch would have implied.
assert.equal(inferCompanyStage({ profileStage: "Pre Seed Round" }).stage, "pre_seed", "xPay (YC W24) is pre_seed, not seed")

// REMOVED RULE 2: "Stealth" used to return pre_seed. It means the founder declined to say.
assert.equal(inferCompanyStage({ experience: [{ currentRole: true }] }).stage, "unknown", "Stealth must yield no stage")

// Size range is an EXACT lookup over the vendor's closed set, not a pattern.
assert.deepEqual(inferCompanyStage({ experience: [{ currentRole: true, companySizeRange: "1-10 employees" }] }), { stage: "seed", source: "company_size" })
assert.deepEqual(inferCompanyStage({ experience: [{ currentRole: true, companySizeRange: "Myself Only" }] }), { stage: "pre_seed", source: "company_size" })
assert.deepEqual(inferCompanyStage({ experience: [{ currentRole: true, companySizeRange: "10,001+ employees" }] }), { stage: "ipo_public", source: "company_size" })
assert.equal(
  inferCompanyStage({ experience: [{ currentRole: true, companySizeRange: "1–10 employees" }] }).stage,
  "unknown",
  "en-dash: an unrecognised vendor spelling must return unknown, never the nearest guess",
)
assert.equal(inferCompanyStage({}).stage, "unknown")

// Priority: funding round > library > headcount.
assert.equal(
  inferCompanyStage({ profileStage: "Seed Round", libraryStage: "ipo_public", experience: [{ currentRole: true, companySizeRange: "10,001+ employees" }] }).source,
  "funding_round",
)
assert.equal(
  inferCompanyStage({ libraryStage: "series_b", experience: [{ currentRole: true, companySizeRange: "1-10 employees" }] }).source,
  "library",
)

console.log("inferCompanyStage guards: ok")
