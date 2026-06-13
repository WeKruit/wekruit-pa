import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  computeRecruiterDigest,
  renderDigestEmail,
  selectRoles,
  toMs,
  reasonLabel,
  type RawJob,
  type RawSubmission,
} from "../recruiter-digest.js"

const NOW = Date.parse("2026-06-13T12:00:00.000Z")
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString()

describe("toMs", () => {
  it("handles ISO, epoch ms, and Timestamp-like shapes", () => {
    assert.equal(toMs("2026-06-13T12:00:00.000Z"), NOW)
    assert.equal(toMs(NOW), NOW)
    assert.equal(toMs({ _seconds: Math.floor(NOW / 1000) }), Math.floor(NOW / 1000) * 1000)
    assert.equal(toMs({ toDate: () => new Date(NOW) }), NOW)
    assert.equal(toMs(undefined), 0)
  })
})

describe("computeRecruiterDigest", () => {
  const subs: RawSubmission[] = [
    // new submitted within window (1d ago), still active
    { recruiterId: "r1", status: "submitted", createdAt: daysAgo(1), updatedAt: daysAgo(1), statusHistory: [{ status: "submitted", atIso: daysAgo(1) }] },
    // submitted 5d ago (outside the new-window) but moved into interview within window
    { recruiterId: "r1", status: "wekruit_interview", createdAt: daysAgo(5), updatedAt: daysAgo(1), statusHistory: [{ status: "submitted", atIso: daysAgo(5) }, { status: "wekruit_interview", atIso: daysAgo(1) }] },
    // advanced to client within window
    { recruiterId: "r1", status: "client_review", createdAt: daysAgo(6), updatedAt: daysAgo(2), statusHistory: [{ status: "submitted", atIso: daysAgo(6) }, { status: "wekruit_interview", atIso: daysAgo(4) }, { status: "client_review", atIso: daysAgo(2) }] },
    // rejected within window, with reasons
    { recruiterId: "r1", status: "rejected", createdAt: daysAgo(8), updatedAt: daysAgo(1), recruiterFeedbackReasons: ["quality", "tier_3_hard_reject"], recruiterFeedbackNote: "no impressive bg", statusHistory: [{ status: "submitted", atIso: daysAgo(8) }, { status: "rejected", atIso: daysAgo(1) }] },
    // rejected OUTSIDE window (10d ago) — must not count in window
    { recruiterId: "r1", status: "rejected", createdAt: daysAgo(20), updatedAt: daysAgo(10), recruiterFeedbackReasons: ["quality"], statusHistory: [{ status: "rejected", atIso: daysAgo(10) }] },
    // hired (lifetime)
    { recruiterId: "r1", status: "hired", createdAt: daysAgo(30), updatedAt: daysAgo(15), statusHistory: [{ status: "hired", atIso: daysAgo(15) }] },
  ]

  const digest = computeRecruiterDigest({
    recruiter: { recruiterId: "r1", name: "Muhammad Kashif", email: "MK@example.com" },
    submissions: subs,
    newRoles: [],
    priorityRoles: [],
    nowMs: NOW,
    windowDays: 3,
  })

  it("counts window pipeline movement correctly", () => {
    assert.equal(digest.stats.newSubmitted, 1) // only the 1d-ago submit
    assert.equal(digest.stats.intoInterview, 1)
    assert.equal(digest.stats.advanced, 1) // client_review within window
    assert.equal(digest.stats.closed, 1) // one reject in window, not the 10d-ago one
  })

  it("counts current pipeline snapshot correctly", () => {
    assert.equal(digest.stats.inInterviewNow, 1)
    assert.equal(digest.stats.withClientNow, 1)
    assert.equal(digest.stats.hiredLifetime, 1)
    // active = not rejected/duplicate/hired → submitted + wekruit_interview + client_review = 3
    assert.equal(digest.stats.activeNow, 3)
    assert.equal(digest.stats.lifetimeTotal, 6)
  })

  it("builds a coaching summary from in-window rejects only", () => {
    // only the in-window reject contributes: quality(1) + clear must-have mismatch(1)
    const labels = digest.coaching.topReasons.map((r) => r.label)
    assert.ok(labels.includes("candidate quality bar"))
    assert.ok(labels.includes("clear must-have mismatch"))
    assert.equal(digest.coaching.topReasons.find((r) => r.label === "candidate quality bar")?.count, 1)
    assert.equal(digest.coaching.note, "no impressive bg")
    assert.ok(digest.coaching.tip)
  })

  it("lowercases recruiter email and falls back to 'there' for missing name", () => {
    assert.equal(digest.recruiterEmail, "mk@example.com")
    const d2 = computeRecruiterDigest({ recruiter: { recruiterId: "r2" }, submissions: [], newRoles: [], priorityRoles: [], nowMs: NOW })
    assert.equal(d2.recruiterName, "there")
    assert.equal(d2.hasActivity, false)
  })
})

describe("selectRoles", () => {
  const jobs: RawJob[] = [
    { id: "j-new", title: "New Role", createdAt: daysAgo(2), recruiterBoard: { label: { company: "Co A", location: "NYC" } } },
    { id: "j-old", title: "Old Role", createdAt: daysAgo(40), recruiterBoard: { label: { company: "Co B", location: "SF" } } },
    { id: "j-urgent", title: "Urgent Role", createdAt: daysAgo(50), recruiterBoard: { label: { company: "Co C", location: "Remote" }, priority: { tier: "urgent", rank: 2 } } },
    { id: "j-high", title: "High Role", createdAt: daysAgo(60), recruiterBoard: { label: { company: "Co D", location: "LA" }, priority: { tier: "high", rank: 1 } } },
    { id: "j-urgent1", title: "Urgent One", createdAt: daysAgo(70), recruiterBoard: { label: { company: "Co E", location: "Austin" }, priority: { tier: "urgent", rank: 1 } } },
  ]
  const { newRoles, priorityRoles } = selectRoles(jobs, NOW)

  it("new roles = opened within 14 days", () => {
    assert.deepEqual(newRoles.map((r) => r.jobId), ["j-new"])
  })

  it("priority roles sorted urgent-before-high, then by rank", () => {
    assert.deepEqual(priorityRoles.map((r) => r.jobId), ["j-urgent1", "j-urgent", "j-high"])
    assert.equal(priorityRoles[0].tier, "urgent")
  })
})

describe("renderDigestEmail", () => {
  const digest = computeRecruiterDigest({
    recruiter: { recruiterId: "r1", name: "Muhammad Kashif", email: "mk@example.com" },
    submissions: [
      { recruiterId: "r1", status: "rejected", createdAt: daysAgo(1), updatedAt: daysAgo(1), recruiterFeedbackReasons: ["quality"], recruiterFeedbackNote: "weak bg" },
    ],
    newRoles: [{ jobId: "j1", title: "Staff Eng", company: "Co K", location: "NYC" }],
    priorityRoles: [{ jobId: "j2", title: "Agent Eng", company: "Co F", location: "SF", tier: "urgent" }],
    nowMs: NOW,
    windowDays: 3,
  })
  const email = renderDigestEmail(digest)

  it("subject reflects new submissions + window", () => {
    // the rejected candidate was also submitted within the window → counts as 1 new
    assert.match(email.subject, /Your WeKruit pipeline — 1 new in 3 days/)
  })

  it("text body has stats, coaching, and both role lists", () => {
    assert.match(email.text, /1 closed out/)
    assert.match(email.text, /candidate quality bar \(1\)/)
    assert.match(email.text, /Staff Eng — Co K \(NYC\)/)
    assert.match(email.text, /\[URGENT\] Agent Eng — Co F \(SF\)/)
  })

  it("html escapes content and includes the urgent badge + board link", () => {
    assert.match(email.html, /URGENT/)
    assert.match(email.html, /wekruit-recruiters\.web\.app/)
  })

  it("omits the coaching block when there are no closes", () => {
    const clean = computeRecruiterDigest({ recruiter: { recruiterId: "r9", name: "Ada" }, submissions: [{ status: "submitted", createdAt: daysAgo(1) }], newRoles: [], priorityRoles: [], nowMs: NOW })
    assert.equal(clean.coaching.topReasons.length, 0)
    assert.doesNotMatch(renderDigestEmail(clean).text, /Most candidates closed for/)
  })
})

describe("reasonLabel", () => {
  it("maps known codes and prettifies unknown", () => {
    assert.equal(reasonLabel("tier_3_hard_reject"), "clear must-have mismatch")
    assert.equal(reasonLabel("some_new_code"), "some new code")
  })
})
