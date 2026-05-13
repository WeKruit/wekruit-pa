import assert from "node:assert/strict"
import test from "node:test"
import { candidateHandleHashMaterial } from "@pa/core-types"
import { sha256Hex } from "@wekruit/shared-tags"
import {
  canonicalizeLinkedInUrl,
  dedupeWithinBatch,
  emailHash,
  linkedinHash,
  normalizeEmail,
  normalizePhoneE164,
  phoneHash,
} from "./normalize.js"

// ---------------------------------------------------------------------------
// canonicalizeLinkedInUrl
// ---------------------------------------------------------------------------

test("canonicalizeLinkedInUrl: lowercases host + slug, strips trailing slash", () => {
  assert.equal(
    canonicalizeLinkedInUrl("https://WWW.LinkedIn.COM/in/Ada-Lovelace/"),
    "https://linkedin.com/in/ada-lovelace",
  )
})

test("canonicalizeLinkedInUrl: strips query string + hash anchor", () => {
  assert.equal(
    canonicalizeLinkedInUrl("https://linkedin.com/in/ada-lovelace?trk=public_profile"),
    "https://linkedin.com/in/ada-lovelace",
  )
  assert.equal(
    canonicalizeLinkedInUrl("https://linkedin.com/in/ada-lovelace#about"),
    "https://linkedin.com/in/ada-lovelace",
  )
})

test("canonicalizeLinkedInUrl: drops locale prefix /{cc}/in/", () => {
  assert.equal(
    canonicalizeLinkedInUrl("https://www.linkedin.com/cn/in/ada-lovelace"),
    "https://linkedin.com/in/ada-lovelace",
  )
  assert.equal(
    canonicalizeLinkedInUrl("https://linkedin.com/de/in/ada-lovelace/"),
    "https://linkedin.com/in/ada-lovelace",
  )
})

test("canonicalizeLinkedInUrl: accepts http and scheme-less inputs", () => {
  assert.equal(
    canonicalizeLinkedInUrl("http://linkedin.com/in/ada-lovelace"),
    "https://linkedin.com/in/ada-lovelace",
  )
  assert.equal(
    canonicalizeLinkedInUrl("linkedin.com/in/ada-lovelace"),
    "https://linkedin.com/in/ada-lovelace",
  )
  assert.equal(
    canonicalizeLinkedInUrl("//linkedin.com/in/ada-lovelace"),
    "https://linkedin.com/in/ada-lovelace",
  )
})

test("canonicalizeLinkedInUrl: idempotent on already-canonical input", () => {
  const canonical = "https://linkedin.com/in/ada-lovelace"
  assert.equal(canonicalizeLinkedInUrl(canonical), canonical)
})

test("canonicalizeLinkedInUrl: rejects mailto / non-linkedin / company URLs", () => {
  assert.equal(canonicalizeLinkedInUrl("mailto:foo@example.com"), null)
  assert.equal(canonicalizeLinkedInUrl("https://github.com/in/ada-lovelace"), null)
  // /company/ is not a /in/ profile.
  assert.equal(canonicalizeLinkedInUrl("https://linkedin.com/company/wekruit"), null)
  // empty path / missing slug.
  assert.equal(canonicalizeLinkedInUrl("https://linkedin.com/in/"), null)
  assert.equal(canonicalizeLinkedInUrl("https://linkedin.com"), null)
})

test("canonicalizeLinkedInUrl: rejects null / undefined / empty", () => {
  assert.equal(canonicalizeLinkedInUrl(null), null)
  assert.equal(canonicalizeLinkedInUrl(undefined), null)
  assert.equal(canonicalizeLinkedInUrl(""), null)
  assert.equal(canonicalizeLinkedInUrl("   "), null)
})

// ---------------------------------------------------------------------------
// linkedinHash + emailHash + phoneHash
// ---------------------------------------------------------------------------

test("linkedinHash: matches sha256(candidateHandleHashMaterial)", () => {
  const url = "https://linkedin.com/in/ada-lovelace"
  const expected = sha256Hex(candidateHandleHashMaterial("linkedin", url))
  assert.equal(linkedinHash(url), expected)
})

test("linkedinHash: deterministic for the same canonical input", () => {
  const url = "https://linkedin.com/in/ada-lovelace"
  assert.equal(linkedinHash(url), linkedinHash(url))
})

test("emailHash: matches sha256(candidateHandleHashMaterial)", () => {
  const email = "alice@example.com"
  const expected = sha256Hex(candidateHandleHashMaterial("email", email))
  assert.equal(emailHash(email), expected)
})

test("phoneHash: matches sha256(candidateHandleHashMaterial)", () => {
  const phone = "+14155551234"
  const expected = sha256Hex(candidateHandleHashMaterial("phone", phone))
  assert.equal(phoneHash(phone), expected)
})

// ---------------------------------------------------------------------------
// normalizeEmail
// ---------------------------------------------------------------------------

test("normalizeEmail: trims + lowercases", () => {
  assert.equal(normalizeEmail("  Alice@Example.COM "), "alice@example.com")
})

test("normalizeEmail: preserves plus-aliases verbatim", () => {
  assert.equal(normalizeEmail("foo+bar@example.com"), "foo+bar@example.com")
})

test("normalizeEmail: rejects malformed inputs", () => {
  assert.equal(normalizeEmail("not-an-email"), null)
  assert.equal(normalizeEmail("foo@"), null)
  assert.equal(normalizeEmail("@bar.com"), null)
  assert.equal(normalizeEmail("foo bar@baz.com"), null)
  assert.equal(normalizeEmail(""), null)
  assert.equal(normalizeEmail(null), null)
  assert.equal(normalizeEmail(undefined), null)
})

// ---------------------------------------------------------------------------
// normalizePhoneE164
// ---------------------------------------------------------------------------

test("normalizePhoneE164: accepts valid E.164", () => {
  const r = normalizePhoneE164("+14155551234")
  assert.equal(r.ok, true)
  assert.equal(r.value, "+14155551234")
})

test("normalizePhoneE164: strips non-digit punctuation when leading +", () => {
  const r = normalizePhoneE164("+1 (415) 555-1234")
  assert.equal(r.ok, true)
  assert.equal(r.value, "+14155551234")
})

test("normalizePhoneE164: rejects bare 10-digit US-style numbers (no country code)", () => {
  // Per lead resolution B Q3 — do NOT default to +1.
  const r = normalizePhoneE164("4155551234")
  assert.equal(r.ok, false)
  assert.equal(r.value, null)
})

test("normalizePhoneE164: rejects leading 0 after + (E.164 disallows)", () => {
  const r = normalizePhoneE164("+0123456789")
  assert.equal(r.ok, false)
})

test("normalizePhoneE164: rejects empty / null / undefined", () => {
  assert.equal(normalizePhoneE164(null).ok, false)
  assert.equal(normalizePhoneE164(undefined).ok, false)
  assert.equal(normalizePhoneE164("").ok, false)
  assert.equal(normalizePhoneE164("   ").ok, false)
})

test("normalizePhoneE164: rejects numbers > 15 digits", () => {
  const r = normalizePhoneE164("+1234567890123456")
  assert.equal(r.ok, false)
})

// ---------------------------------------------------------------------------
// dedupeWithinBatch
// ---------------------------------------------------------------------------

test("dedupeWithinBatch: dedupes by LinkedIn hash first occurrence wins", () => {
  const records = [
    { linkedinProfileHash: "li-a", emails: [{ value: "a@x.com", hash: "h-a" }] },
    { linkedinProfileHash: "li-a", emails: [{ value: "b@x.com", hash: "h-b" }] },
    { linkedinProfileHash: "li-b", emails: [{ value: "c@x.com", hash: "h-c" }] },
  ]
  const result = dedupeWithinBatch(records)
  assert.equal(result.kept.length, 2)
  assert.equal(result.duplicateCount, 1)
  assert.deepEqual(result.duplicateIndexes, [1])
  // First-wins: index 0 kept, index 1 dropped.
  assert.equal(result.kept[0]!.emails![0]!.value, "a@x.com")
})

test("dedupeWithinBatch: falls back to email hash when LinkedIn missing", () => {
  const records = [
    { emails: [{ value: "a@x.com", hash: "h-a" }] },
    { emails: [{ value: "a@x.com", hash: "h-a" }] },
    { emails: [{ value: "b@x.com", hash: "h-b" }] },
  ]
  const result = dedupeWithinBatch(records)
  assert.equal(result.kept.length, 2)
  assert.equal(result.duplicateCount, 1)
})

test("dedupeWithinBatch: preserves rows with no signal", () => {
  const records = [
    { name: "no signal a" },
    { name: "no signal b" },
    // unique-by-linkedin
    { linkedinProfileHash: "li-a" },
  ]
  const result = dedupeWithinBatch(records as Array<{ linkedinProfileHash?: string }>)
  // No-signal rows are kept as-is (no way to know they're dupes).
  assert.equal(result.kept.length, 3)
  assert.equal(result.duplicateCount, 0)
})

test("dedupeWithinBatch: handles empty input", () => {
  const result = dedupeWithinBatch([])
  assert.equal(result.kept.length, 0)
  assert.equal(result.duplicateCount, 0)
})

test("dedupeWithinBatch: dedupe priority — LinkedIn wins over shared email", () => {
  // Two rows share the same email. The first row also has a LinkedIn hash;
  // the second row has only the email. Dedupe should drop the second on email
  // match — the LinkedIn-hash-only signal on row 0 doesn't gate the email
  // bucket for row 1 because row 1 has no LinkedIn signal of its own.
  const records = [
    {
      linkedinProfileHash: "li-a",
      emails: [{ value: "shared@x.com", hash: "h-shared" }],
    },
    { emails: [{ value: "shared@x.com", hash: "h-shared" }] },
  ]
  const result = dedupeWithinBatch(records)
  assert.equal(result.kept.length, 1)
  assert.equal(result.duplicateCount, 1)
})
