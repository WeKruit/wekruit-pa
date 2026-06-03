/**
 * linkedin-identity-verify.test.ts — verified against Adam's REAL profile (2026-06-03).
 * OIDC login photo + Coresignal pasted-URL photo share the same licdn asset key; names match.
 */
import test from "node:test"
import assert from "node:assert/strict"
import {
  licdnAssetKey,
  nameTokenSetMatch,
  verifyLinkedinIdentity,
} from "./linkedin-identity-verify.js"

// Real values captured live:
const OIDC_PIC =
  "https://media.licdn.com/dms/image/v2/D5603AQFBF9xN99YgeQ/profile-displayphoto-shrink_100_100/profile-displayphoto-shrink_100_100/0/1719511227257?e=1782345600&v=beta&t=nUg2ebUIhHyq_TSmFTj-T64bsZRguAmBFW8OTquUfOM"
const CS_PIC =
  "https://media.licdn.com/dms/image/v2/D5603AQFBF9xN99YgeQ/profile-displayphoto-shrink_200_200/profile-displayphoto-shrink_200_200/0/1719511227257?e=2147483647&v=beta&t=xD2VD6RXmlTrtO1HvpvM94rDdVqhddyBOzphoLPHkf4"

test("licdnAssetKey — strips size/expiry/signature, keeps asset id + epoch (same across OIDC & Coresignal)", () => {
  assert.equal(licdnAssetKey(OIDC_PIC), "D5603AQFBF9xN99YgeQ:1719511227257")
  assert.equal(licdnAssetKey(CS_PIC), "D5603AQFBF9xN99YgeQ:1719511227257")
  assert.equal(licdnAssetKey(OIDC_PIC), licdnAssetKey(CS_PIC))
})

test("licdnAssetKey — null/garbage/non-licdn → null", () => {
  assert.equal(licdnAssetKey(null), null)
  assert.equal(licdnAssetKey(""), null)
  assert.equal(licdnAssetKey("https://example.com/pic.png"), null)
})

test("nameTokenSetMatch — order + middle name tolerant; single-name collision rejected", () => {
  assert.equal(nameTokenSetMatch("Adam Yang", "Adam Yang"), true)
  assert.equal(nameTokenSetMatch("Adam Yang", "Adam J. Yang"), true)
  assert.equal(nameTokenSetMatch("Adam Yang", "Yang Adam"), true)
  assert.equal(nameTokenSetMatch("Adam Yang", "Bill Gates"), false)
  assert.equal(nameTokenSetMatch("Adam Yang", "Shixiang Yang"), false) // shares only "yang"
  assert.equal(nameTokenSetMatch("Adam", "Adam Smith"), false) // lone given name must not pass
  assert.equal(nameTokenSetMatch("", "Adam Yang"), false)
})

test("verifyLinkedinIdentity — PHOTO match wins (Adam's real profile)", () => {
  const r = verifyLinkedinIdentity(
    { name: "Adam Yang", picture: OIDC_PIC },
    { full_name: "Adam Yang", name_first: "Adam", name_last: "Yang", picture_url: CS_PIC },
  )
  assert.equal(r.verified, true)
  assert.equal(r.matchedBy, "photo")
  assert.equal(r.claimedName, "Adam Yang")
})

test("verifyLinkedinIdentity — photo changed/stale but NAME matches → still verified via fallback", () => {
  const r = verifyLinkedinIdentity(
    { name: "Adam Yang", picture: OIDC_PIC },
    { full_name: "Adam Yang", picture_url: "https://media.licdn.com/dms/image/v2/DIFFERENT99/profile-displayphoto-shrink_200_200/0/1700000000000?e=1&t=z" },
  )
  assert.equal(r.verified, true)
  assert.equal(r.matchedBy, "name")
})

test("verifyLinkedinIdentity — stranger's URL (name AND photo differ) → NOT verified, surfaces claimed name", () => {
  const r = verifyLinkedinIdentity(
    { name: "Adam Yang", picture: OIDC_PIC },
    { full_name: "Bill Gates", name_first: "Bill", name_last: "Gates", picture_url: "https://media.licdn.com/dms/image/v2/OTHER123/profile-displayphoto-shrink_200_200/0/1699999999999?e=1&t=z" },
  )
  assert.equal(r.verified, false)
  assert.equal(r.matchedBy, "none")
  assert.equal(r.claimedName, "Bill Gates")
})

test("verifyLinkedinIdentity — résumé-only user (no OIDC photo, no OIDC name) → name fallback can't match → not verified", () => {
  const r = verifyLinkedinIdentity(
    { name: null, picture: null },
    { full_name: "Adam Yang", picture_url: CS_PIC },
  )
  assert.equal(r.verified, false)
  assert.equal(r.matchedBy, "none")
})
