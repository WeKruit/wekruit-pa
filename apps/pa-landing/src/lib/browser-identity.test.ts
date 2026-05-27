import assert from "node:assert/strict"
import test from "node:test"

import {
  candidateLoginPath,
  candidatePortalLoginUrl,
  cookieDomainForHost,
  deriveOnboardingIntentFromPath,
  isLayoffHost,
  isPublicJobPath,
  layoffSignupLoginPath,
  onboardingDestination,
  parseLoginNextPath,
  readCookieValue,
  resolvePostLoginDestination,
} from "./browser-identity.js"

test("cookieDomainForHost shares candidate identity across wekruit subdomains only", () => {
  assert.equal(cookieDomainForHost("candidate.wekruit.com"), ".wekruit.com")
  assert.equal(cookieDomainForHost("layoff.wekruit.com"), ".wekruit.com")
  assert.equal(cookieDomainForHost("localhost"), "")
})

test("readCookieValue decodes exact cookie names", () => {
  const cookie = "wkr_uid=abc%20123; wkr_claim_email=adam%40wekruit.com; other=x"
  assert.equal(readCookieValue(cookie, "wkr_uid"), "abc 123")
  assert.equal(readCookieValue(cookie, "wkr_claim_email"), "adam@wekruit.com")
  assert.equal(readCookieValue(cookie, "wkr"), null)
})

test("candidateLoginPath carries the profile destination through login", () => {
  assert.equal(candidateLoginPath("/me/profile"), "/login?next=%2Fme%2Fprofile")
})

test("isLayoffHost recognizes layoff Firebase hosting targets", () => {
  assert.equal(isLayoffHost("layoff.wekruit.com"), true)
  assert.equal(isLayoffHost("layoff-wekruit.web.app"), true)
  assert.equal(isLayoffHost("candidate.wekruit.com"), false)
})

test("candidatePortalLoginUrl targets candidate origin for cross-host auth", () => {
  assert.equal(
    candidatePortalLoginUrl("/me"),
    "https://wekruit.com/login?next=%2Fme",
  )
  assert.equal(
    candidatePortalLoginUrl("/onboarding?source=layoff"),
    "https://wekruit.com/login?next=%2Fonboarding%3Fsource%3Dlayoff",
  )
})

test("parseLoginNextPath splits pathname and search for layoff onboarding next", () => {
  const next = parseLoginNextPath("/onboarding?source=layoff")
  assert.equal(next.pathname, "/onboarding")
  assert.equal(next.search, "?source=layoff")
  assert.equal(next.to, "/onboarding?source=layoff")
  assert.equal(next.isOnboarding, true)
})

test("parseLoginNextPath rejects open redirects to onboarding fallback", () => {
  const next = parseLoginNextPath("//evil.example/phish")
  assert.equal(next.pathname, "/onboarding")
  assert.equal(next.isOnboarding, true)
})

test("parseLoginNextPath defaults bare login to onboarding", () => {
  const next = parseLoginNextPath(null)
  assert.equal(next.pathname, "/onboarding")
  assert.equal(next.isOnboarding, true)
})

test("parseLoginNextPath splits layoff fallback pathname and search", () => {
  const next = parseLoginNextPath(null, "/onboarding?source=layoff")
  assert.equal(next.pathname, "/onboarding")
  assert.equal(next.search, "?source=layoff")
  assert.equal(next.to, "/onboarding?source=layoff")
  assert.equal(next.isOnboarding, true)
})

test("resolvePostLoginDestination blocks /me until portal ready", () => {
  const meNext = parseLoginNextPath("/me")
  const onboardingNext = parseLoginNextPath("/onboarding?source=layoff")
  assert.equal(
    resolvePostLoginDestination(meNext, false, "candidate"),
    "/onboarding",
  )
  assert.equal(
    resolvePostLoginDestination(onboardingNext, false, "WeKruit_Laid_Off"),
    "/onboarding?source=layoff",
  )
  assert.equal(resolvePostLoginDestination(meNext, true, "candidate"), "/me")
  assert.equal(
    resolvePostLoginDestination(onboardingNext, true, "WeKruit_Laid_Off"),
    "/me",
  )
})

test("resolvePostLoginDestination preserves public job routes before portal ready", () => {
  const jobNext = parseLoginNextPath("/j/wekruit-37429d02-photon-macos-devops")
  const cvNext = parseLoginNextPath("/j/wekruit-37429d02-photon-macos-devops/cv")

  assert.equal(isPublicJobPath(jobNext.pathname), true)
  assert.equal(isPublicJobPath(cvNext.pathname), true)
  assert.equal(resolvePostLoginDestination(jobNext, false, "candidate"), jobNext.to)
  assert.equal(resolvePostLoginDestination(cvNext, false, "candidate"), cvNext.to)
})

test("parseLoginNextPath canonicalizes legacy source-leaking Photon job slugs", () => {
  const jobNext = parseLoginNextPath("/j/standout-37429d02-photon-macos-devops")
  const cvNext = parseLoginNextPath("/j/standout-973f2953-photon-objective-c-engineer/cv")

  assert.equal(jobNext.to, "/j/wekruit-37429d02-photon-macos-devops")
  assert.equal(cvNext.to, "/j/wekruit-973f2953-photon-objective-c-engineer/cv")
})

test("deriveOnboardingIntentFromPath distinguishes job prescreen from normal onboarding", () => {
  assert.deepEqual(
    deriveOnboardingIntentFromPath("/j/standout-37429d02-photon-macos-devops"),
    {
      intent: "job_prescreen",
      returnPath: "/j/wekruit-37429d02-photon-macos-devops",
    },
  )
  assert.deepEqual(deriveOnboardingIntentFromPath("/onboarding?source=candidate"), {
    intent: "generic_onboarding",
    returnPath: null,
  })
})

test("onboardingDestination routes layoff source to layoff query", () => {
  assert.equal(onboardingDestination("WeKruit_Laid_Off"), "/onboarding?source=layoff")
  assert.equal(onboardingDestination("candidate"), "/onboarding")
})

test("layoffSignupLoginPath login-first before layoff onboarding", () => {
  assert.equal(
    layoffSignupLoginPath(),
    "/login?next=%2Fonboarding%3Fsource%3Dlayoff",
  )
})
