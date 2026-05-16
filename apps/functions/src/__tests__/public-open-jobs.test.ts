import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  formatComp,
  formatPostedAgo,
  matchesFilters,
  parseQuery,
  runOpenJobs,
  toOpenJobRow,
  _resetSnapshotCacheForTest,
} from "../public-open-jobs.js"

const NOW = Date.parse("2026-05-15T00:00:00Z")

function freshDoc(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "active",
    roleTitle: "Senior Backend Engineer",
    companyName: "Granola",
    atsApplyUrl: "https://granola.so/careers/abc",
    firstSeenAt: new Date(NOW - 2 * 24 * 60 * 60 * 1000).toISOString(),
    roleFunction: ["software_engineering"],
    locationBuckets: ["san_francisco"],
    locationRaw: "San Francisco, CA",
    seniorityLevel: "senior",
    salaryMin: 200_000,
    salaryMax: 260_000,
    jobDescription: "Build the sync engine. TypeScript, Postgres, taste required.",
    industrySector: ["productivity_software"],
    sponsorship: false,
    ...over,
  }
}

describe("public-open-jobs projection", () => {
  it("drops jobs whose status is not active", () => {
    assert.equal(toOpenJobRow("j1", freshDoc({ status: "inactive" }), NOW), null)
  })

  it("drops dead jobs", () => {
    assert.equal(toOpenJobRow("j1", freshDoc({ dead: true }), NOW), null)
  })

  it("drops jobright.ai apply URLs (D9 hard filter)", () => {
    assert.equal(toOpenJobRow("j1", freshDoc({ atsApplyUrl: "https://jobright.ai/jobs/123" }), NOW), null)
  })

  it("drops jobs missing atsApplyUrl", () => {
    assert.equal(toOpenJobRow("j1", freshDoc({ atsApplyUrl: undefined }), NOW), null)
  })

  it("drops jobs missing roleTitle or companyName", () => {
    assert.equal(toOpenJobRow("j1", freshDoc({ roleTitle: undefined }), NOW), null)
    assert.equal(toOpenJobRow("j1", freshDoc({ companyName: undefined }), NOW), null)
  })

  it("projects core fields", () => {
    const r = toOpenJobRow("j1", freshDoc(), NOW)
    assert.ok(r)
    assert.equal(r!.title, "Senior Backend Engineer")
    assert.equal(r!.company, "Granola")
    assert.equal(r!.function, "software_engineering")
    assert.equal(r!.level, "senior")
    assert.equal(r!.location, "san_francisco")
    assert.equal(r!.comp, "$200–260k")
    assert.equal(r!.posted, "2d")
    assert.equal(r!.source, "granola.so")
    assert.equal(r!.atsApplyUrl, "https://granola.so/careers/abc")
    assert.equal(r!.remote, false)
  })

  it("flags remote when locationBuckets contains remote", () => {
    const r = toOpenJobRow("j1", freshDoc({ locationBuckets: ["remote_us"] }), NOW)
    assert.equal(r?.remote, true)
  })

  it("flags remote from locationRaw fallback", () => {
    const r = toOpenJobRow("j1", freshDoc({ locationBuckets: [], locationRaw: "Remote · global" }), NOW)
    assert.equal(r?.remote, true)
  })
})

describe("formatPostedAgo", () => {
  it("renders hours for < 24h", () => {
    assert.equal(formatPostedAgo(NOW - 3 * 60 * 60 * 1000, NOW), "3h")
  })
  it("renders days under 14d", () => {
    assert.equal(formatPostedAgo(NOW - 6 * 24 * 60 * 60 * 1000, NOW), "6d")
  })
  it("renders weeks for ≥ 14d", () => {
    assert.equal(formatPostedAgo(NOW - 21 * 24 * 60 * 60 * 1000, NOW), "3w")
  })
})

describe("formatComp", () => {
  it("formats min+max", () => {
    assert.equal(formatComp(180_000, 220_000), "$180–220k")
  })
  it("formats min only", () => {
    assert.equal(formatComp(150_000, undefined), "$150k+")
  })
  it("returns undefined when both absent", () => {
    assert.equal(formatComp(undefined, undefined), undefined)
  })
})

describe("parseQuery", () => {
  it("clamps limit to [1, 200]", () => {
    assert.equal(parseQuery({ limit: "999" }).limit, 200)
    assert.equal(parseQuery({ limit: "0" }).limit, 60)
  })
  it("parses csv lists", () => {
    assert.deepEqual(parseQuery({ function: "software_engineering,product" }).function, ["software_engineering", "product"])
  })
  it("parses remoteOnly", () => {
    assert.equal(parseQuery({ remoteOnly: "true" }).remoteOnly, true)
    assert.equal(parseQuery({ remoteOnly: "1" }).remoteOnly, true)
    assert.equal(parseQuery({ remoteOnly: "false" }).remoteOnly, false)
  })
  it("lowercases search", () => {
    assert.equal(parseQuery({ search: "GRANOLA" }).search, "granola")
  })
})

describe("runOpenJobs snapshot cache", () => {
  function makeFakeDb(
    docs: Array<{ id: string; data: Record<string, unknown> }>,
    counter: { reads: number }
  ): unknown {
    const q: Record<string, unknown> = {}
    q.where = () => q
    q.orderBy = () => q
    q.limit = () => q
    q.get = async () => {
      counter.reads++
      return { size: docs.length, docs: docs.map((d) => ({ id: d.id, data: () => d.data })) }
    }
    return { collection: () => q }
  }

  it("re-uses the snapshot for repeat reads within TTL", async () => {
    _resetSnapshotCacheForTest()
    const counter = { reads: 0 }
    const docs = [
      { id: "j1", data: { status: "active", roleTitle: "SWE", companyName: "Acme", atsApplyUrl: "https://acme.co/jobs/1", firstSeenAt: new Date(NOW - 86400000).toISOString() } },
    ]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = makeFakeDb(docs, counter) as any
    const a = await runOpenJobs(parseQuery({}), { db, now: NOW })
    const b = await runOpenJobs(parseQuery({}), { db, now: NOW + 1000 })
    assert.equal(counter.reads, 1, "expected only one Firestore read across two calls")
    assert.equal(a.cached, false)
    assert.equal(b.cached, true)
  })

  it("re-fetches after TTL expires", async () => {
    _resetSnapshotCacheForTest()
    const counter = { reads: 0 }
    const docs = [
      { id: "j1", data: { status: "active", roleTitle: "SWE", companyName: "Acme", atsApplyUrl: "https://acme.co/jobs/1", firstSeenAt: new Date(NOW - 86400000).toISOString() } },
    ]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = makeFakeDb(docs, counter) as any
    await runOpenJobs(parseQuery({}), { db, now: NOW })
    await runOpenJobs(parseQuery({}), { db, now: NOW + 61_000 })
    assert.equal(counter.reads, 2, "expected a fresh Firestore read after 60s TTL")
  })
})

describe("matchesFilters", () => {
  it("passes empty filters", () => {
    const row = toOpenJobRow("j1", freshDoc(), NOW)!
    assert.equal(matchesFilters(row, parseQuery({})), true)
  })
  it("filters by function", () => {
    const row = toOpenJobRow("j1", freshDoc(), NOW)!
    assert.equal(matchesFilters(row, parseQuery({ function: "design" })), false)
    assert.equal(matchesFilters(row, parseQuery({ function: "software_engineering" })), true)
  })
  it("filters by level", () => {
    const row = toOpenJobRow("j1", freshDoc(), NOW)!
    assert.equal(matchesFilters(row, parseQuery({ level: "staff_plus" })), false)
    assert.equal(matchesFilters(row, parseQuery({ level: "senior" })), true)
  })
  it("filters by location substring", () => {
    const row = toOpenJobRow("j1", freshDoc(), NOW)!
    assert.equal(matchesFilters(row, parseQuery({ location: "francisco" })), true)
    assert.equal(matchesFilters(row, parseQuery({ location: "new_york" })), false)
  })
  it("filters remoteOnly", () => {
    const row = toOpenJobRow("j1", freshDoc(), NOW)!
    assert.equal(matchesFilters(row, parseQuery({ remoteOnly: "true" })), false)
    const remoteRow = toOpenJobRow("j2", freshDoc({ locationBuckets: ["remote_us"] }), NOW)!
    assert.equal(matchesFilters(remoteRow, parseQuery({ remoteOnly: "true" })), true)
  })
  it("filters by search across title/company/summary", () => {
    const row = toOpenJobRow("j1", freshDoc(), NOW)!
    assert.equal(matchesFilters(row, parseQuery({ search: "sync engine" })), true)
    assert.equal(matchesFilters(row, parseQuery({ search: "datadog" })), false)
  })
})
