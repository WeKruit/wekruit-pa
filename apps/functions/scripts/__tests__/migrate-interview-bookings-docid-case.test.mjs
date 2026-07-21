/**
 * L4 docId case-migration — pure-logic tests.
 *
 * Covers: case-preserving slug parity with core-types, plan correctness, and
 * the key idempotency assertion (re-planning a moved doc = noop).
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  slugifySegment,
  interviewBookingDocId,
  planDocIdMigration,
} from "../migrate-interview-bookings-docid-case.mjs"

describe("slugifySegment (case-preserving; parity with core-types)", () => {
  it("preserves letter-case and replaces non-alnum with -", () => {
    assert.equal(slugifySegment("User_ID 1"), "User-ID-1")
    assert.equal(slugifySegment("Job//ABC"), "Job-ABC")
    assert.equal(slugifySegment("8fEwIduUrzxZsblHHsNz"), "8fEwIduUrzxZsblHHsNz")
  })
  it("trims leading/trailing - and collapses repeats", () => {
    assert.equal(slugifySegment("--a__b--"), "a-b")
  })
  it("matches the core-types interviewBookingDocId vector", () => {
    // mirrors packages/core-types/src/interview-bookings.test.ts
    assert.equal(interviewBookingDocId("User_ID 1", "Job//ABC"), "calbk-User-ID-1__Job-ABC")
  })
})

describe("planDocIdMigration", () => {
  it("skips a non-calbk (legacy booking-) doc", () => {
    const p = planDocIdMigration("booking-u1__job-1", { userId: "u1", jobId: "job-1" })
    assert.equal(p.action, "skip")
    assert.equal(p.reason, "not_calbk_namespace")
  })

  it("skips a calbk doc missing userId/jobId (cannot recompute)", () => {
    assert.equal(planDocIdMigration("calbk-x__y", { jobId: "job-1" }).action, "skip")
    assert.equal(planDocIdMigration("calbk-x__y", { userId: "u1", jobId: "" }).action, "skip")
    assert.equal(planDocIdMigration("calbk-x__y", null).action, "skip")
  })

  it("noops a doc whose id is already case-correct", () => {
    const p = planDocIdMigration("calbk-AbC__job-1", { userId: "AbC", jobId: "job-1" })
    assert.equal(p.action, "noop")
    assert.equal(p.newId, "calbk-AbC__job-1")
  })

  it("moves a lowercased legacy id to the case-preserving id", () => {
    // old (lowercased) id vs raw-case body fields
    const p = planDocIdMigration("calbk-abcdef__job-1", {
      userId: "AbCdEf",
      jobId: "Job-1",
      status: "offered",
    })
    assert.equal(p.action, "move")
    assert.equal(p.oldId, "calbk-abcdef__job-1")
    assert.equal(p.newId, "calbk-AbCdEf__Job-1")
    assert.equal(p.data.id, "calbk-AbCdEf__Job-1", "rewrites the id field to match new doc id")
    assert.equal(p.data.status, "offered", "preserves the rest of the doc body")
  })

  it("is idempotent: re-planning the moved doc is a noop (key assertion)", () => {
    const body = { userId: "AbCdEf", jobId: "Job-1", status: "offered" }
    const first = planDocIdMigration("calbk-abcdef__job-1", body)
    assert.equal(first.action, "move")
    // after the move, the new doc lives at first.newId with first.data
    const second = planDocIdMigration(first.newId, first.data)
    assert.equal(second.action, "noop")
    assert.equal(second.newId, first.newId)
  })
})
