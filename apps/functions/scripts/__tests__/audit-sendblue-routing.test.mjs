import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  listPoolLines,
  isAdminLine,
  isNewLoadEligibleStatus,
  isActiveReachable,
  isAdminOrDevUser,
  buildDistribution,
  capacityGaps,
  capacityRecommendation,
  checkStickiness,
  checkAdminIsolation,
  checkCapacity,
  checkStatus,
  checkCoverage,
  runAudit,
  GUIDELINE_MAX,
  DEV_PHONES,
} from "../audit-sendblue-routing.mjs"

// Mirrors the observed live pool: 305 = admin/dev-only, 717 = public candidate.
const PROD_LIKE_POOL = {
  numbers: [
    {
      number: "+13054507715",
      label: "Admin/internal/developer testing",
      status: "active",
      capacity: 10,
      audience: "admin",
      adminOnly: true,
    },
    {
      number: "+17174919939",
      label: "Public candidate pool",
      status: "active",
      capacity: 500,
      audience: "public",
    },
  ],
}

function makeUsers(n, overrides = (i) => ({})) {
  return Array.from({ length: n }, (_, i) => ({
    uid: `user_${i}`,
    phoneE164: `+1555000${String(1000 + i)}`,
    ...overrides(i),
  }))
}

describe("listPoolLines", () => {
  it("flattens legacy numbers with all printable fields", () => {
    const lines = listPoolLines(PROD_LIKE_POOL)
    assert.equal(lines.length, 2)
    const admin = lines.find((l) => l.number === "+13054507715")
    assert.equal(admin.adminOnly, true)
    assert.equal(admin.audience, "admin")
    assert.equal(admin.capacity, 10)
    assert.equal(admin.status, "active")
  })

  it("expands groups and inherits group-level fields", () => {
    const pool = {
      groups: [
        {
          groupId: "g1",
          status: "active",
          audience: "public",
          capacity: 500,
          numbers: ["+1999", { number: "+1888", status: "warmup" }],
        },
      ],
    }
    const lines = listPoolLines(pool)
    assert.equal(lines.length, 2)
    assert.equal(lines[0].number, "+1999")
    assert.equal(lines[0].status, "active")
    assert.equal(lines[0].audience, "public")
    assert.equal(lines[1].number, "+1888")
    assert.equal(lines[1].status, "warmup") // entry override wins
  })

  it("returns [] for null pool", () => {
    assert.deepEqual(listPoolLines(null), [])
  })
})

describe("isAdminLine", () => {
  it("flags adminOnly + admin/internal/developer audience", () => {
    assert.equal(isAdminLine({ number: "+1", status: "active", adminOnly: true }), true)
    assert.equal(isAdminLine({ number: "+1", status: "active", audience: "admin" }), true)
    assert.equal(isAdminLine({ number: "+1", status: "active", audience: "internal" }), true)
    assert.equal(isAdminLine({ number: "+1", status: "active", audience: "developer" }), true)
  })
  it("does not flag public/candidate lines", () => {
    assert.equal(isAdminLine({ number: "+1", status: "active", audience: "public" }), false)
    assert.equal(isAdminLine({ number: "+1", status: "active", audience: "candidate" }), false)
  })
})

describe("isNewLoadEligibleStatus", () => {
  it("only active takes NEW load", () => {
    assert.equal(isNewLoadEligibleStatus("active"), true)
    for (const s of ["warmup", "throttled", "paused", "degraded"]) {
      assert.equal(isNewLoadEligibleStatus(s), false)
    }
  })
})

describe("isActiveReachable", () => {
  it("true when deliverable phone and not suppressed", () => {
    assert.equal(isActiveReachable({ phoneE164: "+15551234567" }), true)
  })
  it("false without a valid E.164 phone", () => {
    assert.equal(isActiveReachable({}), false)
    assert.equal(isActiveReachable({ phoneE164: "not-a-phone" }), false)
    assert.equal(isActiveReachable({ phoneE164: "alice@apple" }), false)
  })
  it("false when opted_out / deleted via lifecycle (both field shapes)", () => {
    assert.equal(isActiveReachable({ phoneE164: "+15551234567", candidateLifecycleState: "opted_out" }), false)
    assert.equal(isActiveReachable({ phoneE164: "+15551234567", candidateLifecycleState: "deleted" }), false)
    assert.equal(
      isActiveReachable({ phoneE164: "+15551234567", candidateLifecycle: { state: "opted_out" } }),
      false
    )
  })
  it("false when outreach status opted_out/paused, doNotContact, outreachPaused, daily unsub", () => {
    assert.equal(isActiveReachable({ phoneE164: "+15551234567", outreach: { status: "opted_out" } }), false)
    assert.equal(isActiveReachable({ phoneE164: "+15551234567", outreach: { status: "paused" } }), false)
    assert.equal(isActiveReachable({ phoneE164: "+15551234567", doNotContact: true }), false)
    assert.equal(isActiveReachable({ phoneE164: "+15551234567", outreachPaused: true }), false)
    assert.equal(
      isActiveReachable({ phoneE164: "+15551234567", dailyJobRecSubscribe: { optedIn: false } }),
      false
    )
  })
})

describe("isAdminOrDevUser", () => {
  it("flags dev phones and explicit admin flags", () => {
    for (const p of DEV_PHONES) assert.equal(isAdminOrDevUser({ phoneE164: p }), true)
    assert.equal(isAdminOrDevUser({ phoneE164: "+15550001111", isAdmin: true }), true)
    assert.equal(isAdminOrDevUser({ phoneE164: "+15550001111", audience: "internal" }), true)
    assert.equal(isAdminOrDevUser({ phoneE164: "+15550001111" }), false)
  })
})

describe("buildDistribution (uses real pickFromNumber)", () => {
  it("routes ALL candidate-path users only to the public line (admin line excluded)", () => {
    const users = makeUsers(200)
    const { byNumber, unrouted } = buildDistribution(PROD_LIKE_POOL, users, { includeInternal: false })
    assert.equal(unrouted.length, 0)
    assert.deepEqual([...byNumber.keys()], ["+17174919939"])
    assert.equal(byNumber.get("+17174919939"), 200)
  })

  it("includeInternal:true can land users on the admin line", () => {
    const users = makeUsers(200)
    const { byNumber } = buildDistribution(PROD_LIKE_POOL, users, { includeInternal: true })
    // both lines present when internal allowed
    assert.ok(byNumber.get("+13054507715") > 0)
    assert.ok(byNumber.get("+17174919939") > 0)
  })

  it("reports unrouted when no candidate-visible active line exists", () => {
    const adminOnlyPool = { numbers: [PROD_LIKE_POOL.numbers[0]] }
    const users = makeUsers(10)
    const { byNumber, unrouted } = buildDistribution(adminOnlyPool, users, { includeInternal: false })
    assert.equal(byNumber.size, 0)
    assert.equal(unrouted.length, 10)
  })
})

describe("capacityGaps + checkCapacity", () => {
  it("flags over-capacity and over-guideline", () => {
    const lines = listPoolLines({
      numbers: [{ number: "+17174919939", status: "active", capacity: 100, audience: "public" }],
    })
    const dist = new Map([["+17174919939", 600]]) // over both cap(100) and guideline(500)
    const gaps = capacityGaps(lines, dist)
    assert.equal(gaps[0].overCapacity, true)
    assert.equal(gaps[0].overGuideline, true)
    const check = checkCapacity(gaps)
    assert.equal(check.pass, false)
    assert.equal(check.offenders.length, 1)
  })

  it("passes when under cap and guideline", () => {
    const lines = listPoolLines({
      numbers: [{ number: "+17174919939", status: "active", capacity: 500, audience: "public" }],
    })
    const gaps = capacityGaps(lines, new Map([["+17174919939", 120]]))
    assert.equal(checkCapacity(gaps).pass, true)
  })
})

describe("capacityRecommendation", () => {
  it("FINE FOR NOW when well under floor", () => {
    const lines = listPoolLines(PROD_LIKE_POOL)
    const rec = capacityRecommendation(lines, new Map([["+17174919939", 120]]), 120)
    assert.equal(rec.recommendAddLines, 0)
    assert.match(rec.verdict, /FINE FOR NOW/)
    assert.equal(rec.publicActiveLineCount, 1) // admin line excluded
  })

  it("recommends ADD when over the ceiling", () => {
    const lines = listPoolLines(PROD_LIKE_POOL)
    const total = GUIDELINE_MAX * 2 + 50 // needs 3 lines @500
    const rec = capacityRecommendation(lines, new Map([["+17174919939", total]]), total)
    assert.ok(rec.recommendAddLines >= 2)
    assert.match(rec.verdict, /ADD/)
  })
})

describe("correctness checks", () => {
  it("(a) stickiness PASS — deterministic", () => {
    const res = checkStickiness(PROD_LIKE_POOL, makeUsers(40))
    assert.equal(res.pass, true)
    assert.equal(res.offenders.length, 0)
  })

  it("(b) admin isolation PASS — candidate path never hits admin line", () => {
    const lines = listPoolLines(PROD_LIKE_POOL)
    const res = checkAdminIsolation(PROD_LIKE_POOL, makeUsers(300), lines)
    assert.equal(res.pass, true)
    assert.deepEqual(res.adminNumbers, ["+13054507715"])
  })

  it("(d) status PASS — selector never lands users on non-active lines", () => {
    const pool = {
      numbers: [
        { number: "+17174919939", status: "active", audience: "public", capacity: 500 },
        { number: "+1222", status: "paused", audience: "public", capacity: 500 },
      ],
    }
    const lines = listPoolLines(pool)
    const res = checkStatus(pool, makeUsers(100), lines)
    assert.equal(res.pass, true)
    assert.equal(res.offenders.length, 0)
  })

  it("(e) coverage PASS when a public active line exists, FAIL when only admin line", () => {
    const ok = checkCoverage(PROD_LIKE_POOL, makeUsers(50))
    assert.equal(ok.pass, true)
    assert.equal(ok.unroutedCount, 0)

    const adminOnly = { numbers: [PROD_LIKE_POOL.numbers[0]] }
    const bad = checkCoverage(adminOnly, makeUsers(50))
    assert.equal(bad.pass, false)
    assert.equal(bad.unroutedCount, 50)
  })
})

// ── map-db fake exercising the full runAudit production seam ──
function mapDb(poolDoc, userDocs) {
  return {
    collection(name) {
      if (name === "pa-config") {
        return {
          doc() {
            return { async get() { return { exists: poolDoc != null, data: () => poolDoc } } }
          },
        }
      }
      if (name === "pa-users") {
        return {
          limit() {
            return {
              async get() {
                return {
                  docs: userDocs.map((u) => ({ id: u.uid, data: () => u })),
                }
              },
            }
          },
        }
      }
      throw new Error(`unexpected collection ${name}`)
    },
  }
}

describe("runAudit (map-db fake, full seam)", () => {
  it("produces distribution + all 5 checks green + a sane recommendation", async () => {
    const users = [
      ...makeUsers(120), // active reachable, public
      { uid: "opted", phoneE164: "+15559990000", candidateLifecycleState: "opted_out" },
      { uid: "nophone", phoneE164: "" },
      { uid: "dev", phoneE164: [...DEV_PHONES][0] },
    ]
    const db = mapDb(PROD_LIKE_POOL, users)
    const report = await runAudit(db, { limit: 1000 })

    assert.equal(report.readOnly, true)
    assert.equal(report.totalUsers, users.length)
    // 120 makeUsers + dev phone are reachable; opted-out + nophone excluded.
    assert.equal(report.totalActiveReachable, 121)

    // every candidate-path user lands on the public line
    assert.deepEqual(Object.keys(report.distributionAllUsers), ["+17174919939"])
    assert.deepEqual(Object.keys(report.distributionActiveReachable), ["+17174919939"])

    assert.equal(report.checks.a_stickiness.pass, true)
    assert.equal(report.checks.b_admin_isolation.pass, true)
    assert.equal(report.checks.c_capacity.pass, true)
    assert.equal(report.checks.d_status.pass, true)
    assert.equal(report.checks.e_coverage.pass, true)

    assert.equal(report.recommendation.publicActiveLineCount, 1)
    assert.equal(report.recommendation.recommendAddLines, 0)
    assert.match(report.recommendation.verdict, /FINE FOR NOW/)
  })

  it("recommendation flags ADD when active-reachable far exceeds one line", async () => {
    const users = makeUsers(1100)
    const db = mapDb(PROD_LIKE_POOL, users)
    const report = await runAudit(db, { limit: 5000 })
    assert.equal(report.totalActiveReachable, 1100)
    // capacity=500 on the single public line → over-capacity offender
    assert.equal(report.checks.c_capacity.pass, false)
    assert.ok(report.recommendation.recommendAddLines >= 2)
    assert.match(report.recommendation.verdict, /ADD/)
  })
})
