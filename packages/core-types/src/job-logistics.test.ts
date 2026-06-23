import assert from "node:assert/strict"
import test from "node:test"
import {
  resolveJobPay,
  resolveJobLocation,
  resolveJobVisa,
  resolveJobBenefits,
  resolveJobLogistics,
} from "./job-logistics.js"

test("pay: salaryRange → compSummary → level1Reveal", () => {
  assert.equal(resolveJobPay({ salaryRange: "$160K-$250K" }), "$160K-$250K")
  assert.equal(resolveJobPay({ compSummary: "Competitive + equity" }), "Competitive + equity")
  assert.equal(resolveJobPay({ prescreenConfig: { level1Reveal: { salaryRange: "$140K" } } }), "$140K")
  assert.equal(resolveJobPay({}), undefined)
})

test("location: location → prescreenConfig.region", () => {
  assert.equal(resolveJobLocation({ location: "NYC - on-site" }), "NYC - on-site")
  assert.equal(resolveJobLocation({ prescreenConfig: { region: "Remote" } }), "Remote")
  assert.equal(resolveJobLocation({}), undefined)
})

test("visa: sponsorship bool, else extracted from JD, else undefined", () => {
  assert.equal(resolveJobVisa({ sponsorship: true }), "Sponsorship available")
  assert.equal(resolveJobVisa({ sponsorship: false }), "No sponsorship")
  assert.match(
    resolveJobVisa({ descriptionMd: "## Logistics\n- Visa: OPT / H-1B sponsorship available" }) ?? "",
    /OPT \/ H-1B sponsorship available/,
  )
  assert.match(
    resolveJobVisa({ descriptionMd: "US work authorization required" }) ?? "",
    /work authorization/i,
  )
  assert.equal(resolveJobVisa({ descriptionMd: "We build great software for everyone." }), undefined)
})

test("benefits: structured field, JD section, or benefit-keyword line", () => {
  assert.equal(resolveJobBenefits({ benefits: "Health, dental, 401k" }), "Health, dental, 401k")
  assert.equal(resolveJobBenefits({ benefits: ["Health", "Equity"] }), "Health, Equity")
  assert.match(
    resolveJobBenefits({ descriptionMd: "## Benefits\n- Full health, dental, vision\n- Unlimited PTO\n\n## About" }) ?? "",
    /Full health.*Unlimited PTO/,
  )
  assert.match(
    resolveJobBenefits({ descriptionMd: "We offer competitive equity and stock options." }) ?? "",
    /equity/i,
  )
  assert.equal(resolveJobBenefits({ descriptionMd: "Ship fast and own outcomes." }), undefined)
})

test("benefits reads jdBlocks (recruiter payload, no raw descriptionMd)", () => {
  const blocks = [
    { heading: "About", body: "We build things." },
    { heading: "Benefits", items: ["Health insurance", "401(k) match", "Equity"] },
  ]
  assert.match(resolveJobBenefits({ jdBlocks: blocks }) ?? "", /Health insurance.*Equity/)
})

test("resolveJobLogistics returns all four; visa present for recruiter", () => {
  const l = resolveJobLogistics({
    salaryRange: "$200K",
    location: "Remote",
    descriptionMd: "## Visa\n- H-1B sponsorship available\n## Benefits\n- Equity + health",
  })
  assert.equal(l.pay, "$200K")
  assert.equal(l.location, "Remote")
  assert.match(l.visa ?? "", /sponsorship available/i)
  assert.match(l.benefits ?? "", /Equity/i)
})

test("does not misread non-visa/benefit prose", () => {
  // "opt-in" lowercase is not the OPT visa acronym; no visa keyword sentence.
  assert.equal(resolveJobVisa({ descriptionMd: "Build opt-in onboarding flows." }), undefined)
})
