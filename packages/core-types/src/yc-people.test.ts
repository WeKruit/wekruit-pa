import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { isYcPeopleUser } from "./yc-people.js"

describe("isYcPeopleUser — canonical YC people-lane predicate", () => {
  it("matches the website /yc-startup signup (source)", () => {
    assert.equal(isYcPeopleUser({ source: "yc_startup_school" }), true)
  })

  it("matches the REAL users the old narrow source-only guard missed (live 2026-07-24)", () => {
    // Both had active pa-job-profiles rows in the job-rec audience precisely because
    // audience-provision only checked `source`. These two cases are the regression lock.
    // xoIzGJpT06GvrmIQwHlt
    assert.equal(
      isYcPeopleUser({ source: "candidate", ycEventEntryAt: "2026-07-23T00:00:00.000Z" }),
      true,
      "event-QR entrant with source=candidate must be YC",
    )
    // f3f16f3f-0056-4418-a206-6781c71f423c
    assert.equal(
      isYcPeopleUser({
        source: "qr_imessage",
        firstTouchCampaign: "dev-card",
        ycEventEntryAt: "2026-07-23T00:00:00.000Z",
      }),
      true,
      "event-QR entrant with source=qr_imessage must be YC",
    )
  })

  it("matches on campaign attribution alone", () => {
    assert.equal(
      isYcPeopleUser({ source: "candidate", firstTouchCampaign: "yc-startup-school" }),
      true,
    )
  })

  it("does NOT match ordinary candidates (job recs must keep working fleet-wide)", () => {
    assert.equal(isYcPeopleUser({ source: "candidate" }), false)
    assert.equal(isYcPeopleUser({ source: "qr_imessage", firstTouchCampaign: "dev-card" }), false)
    assert.equal(isYcPeopleUser({}), false)
  })

  it("is null/undefined safe", () => {
    assert.equal(isYcPeopleUser(null), false)
    assert.equal(isYcPeopleUser(undefined), false)
  })

  it("treats a falsy ycEventEntryAt as not-YC (no accidental blanket match)", () => {
    assert.equal(isYcPeopleUser({ source: "candidate", ycEventEntryAt: "" }), false)
    assert.equal(isYcPeopleUser({ source: "candidate", ycEventEntryAt: null }), false)
  })
})
