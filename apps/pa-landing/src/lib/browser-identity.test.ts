import assert from "node:assert/strict"
import test from "node:test"

import { candidateLoginPath, cookieDomainForHost, readCookieValue } from "./browser-identity.js"

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
