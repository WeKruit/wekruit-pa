import assert from "node:assert/strict"
import test from "node:test"
import {
  buildStartUrl,
  isCanaryCampaign,
  isValidCampaignCode,
  normalizeCampaignCode,
  shortToken,
  summarizeScans,
  type QrScanRow,
} from "../QrCampaigns.helpers.js"

test("normalizeCampaignCode mirrors scan.ts: trims, lowercases, validates regex", () => {
  assert.equal(normalizeCampaignCode("  Dev-Card  "), "dev-card")
  assert.equal(normalizeCampaignCode("acme_q3-2026"), "acme_q3-2026")
  assert.equal(normalizeCampaignCode("a"), "a")
  // invalid: starts with hyphen
  assert.equal(normalizeCampaignCode("-bad"), null)
  // invalid: contains space / illegal char
  assert.equal(normalizeCampaignCode("has space"), null)
  assert.equal(normalizeCampaignCode("dot.dot"), null)
  // invalid: too long (>64)
  assert.equal(normalizeCampaignCode("a".repeat(65)), null)
  // non-string / empty
  assert.equal(normalizeCampaignCode(42), null)
  assert.equal(normalizeCampaignCode(""), null)
})

test("isValidCampaignCode tracks normalizeCampaignCode", () => {
  assert.equal(isValidCampaignCode("dev-card"), true)
  assert.equal(isValidCampaignCode("-bad"), false)
})

test("isCanaryCampaign: dev- prefix OR allowlist auto-provisions; others blocked", () => {
  assert.equal(isCanaryCampaign("dev-card"), true)
  assert.equal(isCanaryCampaign("dev-anything"), true)
  assert.equal(isCanaryCampaign("DEV-UPPER"), true)
  assert.equal(isCanaryCampaign("acme-launch"), false)
  assert.equal(isCanaryCampaign(""), false)
  assert.equal(isCanaryCampaign(null), false)
})

test("buildStartUrl encodes the campaign param against the locked base", () => {
  assert.equal(buildStartUrl("dev-card"), "https://wekruit.com/start?c=dev-card")
})

test("shortToken keeps short tokens whole and elides long ones", () => {
  assert.equal(shortToken("abc123"), "abc123")
  const long = "0123456789abcdefghij"
  const s = shortToken(long)
  assert.ok(s.startsWith("01234567"))
  assert.ok(s.endsWith("ghij"))
})

test("summarizeScans rolls up counters, canary flag, and most-recent ordering", () => {
  const rows: QrScanRow[] = [
    { scanToken: "t1", campaign: "dev-card", status: "claimed", createdAt: "2026-06-02T10:00:00Z", claimedUserId: "u1" },
    { scanToken: "t2", campaign: "dev-card", status: "pending", createdAt: "2026-06-02T11:00:00Z" },
    { scanToken: "t3", campaign: "acme-launch", status: "pending", createdAt: "2026-06-02T09:00:00Z" },
    { scanToken: "t4", campaign: "acme-launch", status: "abandoned", createdAt: "2026-06-02T08:00:00Z" },
  ]
  const out = summarizeScans(rows)
  assert.equal(out.length, 2)
  // dev-card has the most recent scan (11:00) → first
  assert.equal(out[0].campaign, "dev-card")
  assert.equal(out[0].total, 2)
  assert.equal(out[0].claimed, 1)
  assert.equal(out[0].pending, 1)
  assert.equal(out[0].canary, true)
  assert.equal(out[0].lastScanAt, "2026-06-02T11:00:00Z")

  assert.equal(out[1].campaign, "acme-launch")
  assert.equal(out[1].total, 2)
  assert.equal(out[1].pending, 1)
  assert.equal(out[1].abandoned, 1)
  assert.equal(out[1].canary, false)
})

test("summarizeScans buckets missing campaign under (none) and treats unknown status as pending", () => {
  const out = summarizeScans([
    { scanToken: "t1" },
    { scanToken: "t2", campaign: "dev-x", status: "weird" },
  ])
  const none = out.find((s) => s.campaign === "(none)")
  assert.ok(none)
  assert.equal(none?.pending, 1)
  const devx = out.find((s) => s.campaign === "dev-x")
  assert.equal(devx?.pending, 1)
})
