import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  applyPagination,
  buildWekruitUrl,
  computeEtag,
  decodeCursor,
  encodeCursor,
  formatComp,
  formatPostedAgo,
  matchesFilters,
  parseQuery,
  runOpenJobs,
  stripJobSourceSection,
  toCollabJobRow,
  toOpenJobRow,
  toPublicCompanyProfile,
  verifyCollabAuth,
  type OpenJobRow,
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

  it("includes wekruitUrl built from doc id", () => {
    const r = toOpenJobRow("rain-xyz-swe-001", freshDoc(), NOW)
    assert.equal(r!.wekruitUrl, "https://wekruit.com/j/rain-xyz-swe-001")
  })

  it("url-encodes doc ids with special chars in wekruitUrl", () => {
    const r = toOpenJobRow("rain xyz/swe?001", freshDoc(), NOW)
    assert.equal(r!.wekruitUrl, "https://wekruit.com/j/rain%20xyz%2Fswe%3F001")
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

// ============================================================ cursor

describe("cursor encode/decode", () => {
  it("round-trips", () => {
    const payload = { fs: 1_715_000_000_000, id: "rain-xyz-swe-001" }
    const decoded = decodeCursor(encodeCursor(payload))
    assert.deepEqual(decoded, payload)
  })

  it("returns null on garbage", () => {
    assert.equal(decodeCursor("not-base64!!!"), null)
    assert.equal(decodeCursor(""), null)
  })

  it("returns null when payload missing fs", () => {
    const bad = Buffer.from(JSON.stringify({ id: "x" })).toString("base64")
    assert.equal(decodeCursor(bad), null)
  })

  it("returns null when payload missing id", () => {
    const bad = Buffer.from(JSON.stringify({ fs: 1 })).toString("base64")
    assert.equal(decodeCursor(bad), null)
  })

  it("parseQuery decodes the cursor query param", () => {
    const c = encodeCursor({ fs: 100, id: "abc" })
    const p = parseQuery({ cursor: c })
    assert.deepEqual(p.cursor, { fs: 100, id: "abc" })
  })

  it("parseQuery leaves cursor undefined when missing", () => {
    assert.equal(parseQuery({}).cursor, undefined)
  })
})

// ============================================================ applyPagination

describe("applyPagination", () => {
  function row(id: string, fsIso: string): OpenJobRow {
    return {
      id,
      wekruitUrl: buildWekruitUrl(id),
      title: id,
      company: "X",
      remote: false,
      firstSeenAt: fsIso,
    }
  }
  const rows = [
    row("a", new Date(NOW - 1 * 86400000).toISOString()),
    row("b", new Date(NOW - 2 * 86400000).toISOString()),
    row("c", new Date(NOW - 3 * 86400000).toISOString()),
    row("d", new Date(NOW - 4 * 86400000).toISOString()),
    row("e", new Date(NOW - 5 * 86400000).toISOString()),
  ]

  it("offset-based paging works", () => {
    const r = applyPagination(rows, { ...parseQuery({}), offset: 0, limit: 2 })
    assert.deepEqual(r.rows.map((x) => x.id), ["a", "b"])
    assert.equal(r.hasMore, true)
    assert.ok(r.nextCursor)
  })

  it("cursor advances past the row whose id matches", () => {
    const c = encodeCursor({ fs: Date.parse(rows[1].firstSeenAt!), id: "b" })
    const r = applyPagination(rows, { ...parseQuery({ cursor: c }), limit: 2 })
    assert.deepEqual(r.rows.map((x) => x.id), ["c", "d"])
    assert.equal(r.hasMore, true)
  })

  it("hasMore=false at end, nextCursor=null", () => {
    const r = applyPagination(rows, { ...parseQuery({}), offset: 3, limit: 2 })
    assert.deepEqual(r.rows.map((x) => x.id), ["d", "e"])
    assert.equal(r.hasMore, false)
    assert.equal(r.nextCursor, null)
  })

  it("dangling cursor (id no longer in list) falls through to offset=0", () => {
    const c = encodeCursor({ fs: 1, id: "no-such-id" })
    const r = applyPagination(rows, { ...parseQuery({ cursor: c }), limit: 2 })
    assert.deepEqual(r.rows.map((x) => x.id), ["a", "b"])
  })
})

// ============================================================ ETag

describe("computeEtag", () => {
  function row(id: string, fs: string): { id: string; firstSeenAt: string } {
    return { id, firstSeenAt: fs }
  }

  it("is stable for the same input", () => {
    const rows = [row("a", "2026-05-01T00:00:00Z"), row("b", "2026-05-02T00:00:00Z")]
    const params = parseQuery({})
    assert.equal(computeEtag(rows, params), computeEtag(rows, params))
  })

  it("changes when rows change", () => {
    const params = parseQuery({})
    const a = computeEtag([row("a", "2026-05-01T00:00:00Z")], params)
    const b = computeEtag([row("a", "2026-05-02T00:00:00Z")], params)
    assert.notEqual(a, b)
  })

  it("changes when filters change", () => {
    const rows = [row("a", "2026-05-01T00:00:00Z")]
    const p1 = parseQuery({})
    const p2 = parseQuery({ search: "swe" })
    assert.notEqual(computeEtag(rows, p1), computeEtag(rows, p2))
  })

  it("changes when source changes", () => {
    const rows = [row("a", "2026-05-01T00:00:00Z")]
    assert.notEqual(
      computeEtag(rows, parseQuery({ source: "scraped" })),
      computeEtag(rows, parseQuery({ source: "collab" }))
    )
  })

  it("is wrapped in double quotes per RFC 7232", () => {
    const e = computeEtag([row("a", "2026-05-01T00:00:00Z")], parseQuery({}))
    assert.equal(e.startsWith('"'), true)
    assert.equal(e.endsWith('"'), true)
  })
})

// ============================================================ collab projection

describe("toCollabJobRow", () => {
  function collabDoc(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      publicVisible: true,
      wekruitCollaborationStatus: "collaborated",
      title: "Senior iOS Engineer",
      companyName: "Rain XYZ",
      location: "Remote · US",
      descriptionMd:
        "# About\n\nBuild the iOS app from scratch.\n\n## Source\n\nhttps://jobright.ai/jobs/123\n",
      roleFunction: ["software_engineering"],
      seniorityLevel: "senior",
      industrySector: ["consumer_apps"],
      salaryMin: 180_000,
      salaryMax: 240_000,
      firstSeenAt: new Date(NOW - 86400000).toISOString(),
      ...over,
    }
  }

  it("drops jobs that are not publicVisible", () => {
    assert.equal(toCollabJobRow("j1", collabDoc({ publicVisible: false }), NOW), null)
  })

  it("drops jobs that are not collaborated", () => {
    assert.equal(
      toCollabJobRow("j1", collabDoc({ wekruitCollaborationStatus: "not_collaborated" }), NOW),
      null
    )
  })

  it("drops dead jobs", () => {
    assert.equal(toCollabJobRow("j1", collabDoc({ dead: true }), NOW), null)
  })

  it("projects core fields + wekruitUrl + collaborated=true", () => {
    const r = toCollabJobRow("rain-xyz-001", collabDoc(), NOW)
    assert.ok(r)
    assert.equal(r!.id, "rain-xyz-001")
    assert.equal(r!.wekruitUrl, "https://wekruit.com/j/rain-xyz-001")
    assert.equal(r!.title, "Senior iOS Engineer")
    assert.equal(r!.company, "Rain XYZ")
    assert.equal(r!.collaborated, true)
    assert.equal(r!.comp, "$180–240k")
    assert.equal(r!.remote, true)
  })

  it("omits atsApplyUrl (funnel must flow through wekruitUrl)", () => {
    const r = toCollabJobRow(
      "rain-xyz-001",
      collabDoc({ atsApplyUrl: "https://greenhouse.io/jobs/xyz" }),
      NOW
    )
    assert.equal(r!.atsApplyUrl, undefined)
  })

  it("omits source (provenance hidden in collab mode)", () => {
    const r = toCollabJobRow("rain-xyz-001", collabDoc(), NOW)
    assert.equal(r!.source, undefined)
  })

  it("strips Source section from descriptionMd before summary extraction", () => {
    const r = toCollabJobRow("rain-xyz-001", collabDoc(), NOW)
    assert.ok(r!.summary)
    assert.equal(r!.summary!.includes("jobright"), false)
  })

  it("falls back to prescreenConfig.jobTitle when title missing", () => {
    const r = toCollabJobRow(
      "j1",
      collabDoc({ title: undefined, prescreenConfig: { jobTitle: "Fallback Title" } }),
      NOW
    )
    assert.equal(r!.title, "Fallback Title")
  })
})

describe("stripJobSourceSection", () => {
  it("removes ## Source section + content until next heading", () => {
    const md = "# About\n\nReal copy.\n\n## Source\n\nhttps://x.com\n\n## Perks\n\nFood."
    const stripped = stripJobSourceSection(md)
    assert.equal(stripped!.includes("Source"), false)
    assert.equal(stripped!.includes("Perks"), true)
    assert.equal(stripped!.includes("Food"), true)
  })

  it("removes standalone URL lines", () => {
    const md = "Real copy\n\nhttps://jobright.ai/x\n\nMore copy"
    const stripped = stripJobSourceSection(md)
    assert.equal(stripped!.includes("jobright"), false)
  })

  it("returns undefined for empty input", () => {
    assert.equal(stripJobSourceSection(""), "")
    assert.equal(stripJobSourceSection(undefined), undefined)
  })
})

describe("toPublicCompanyProfile", () => {
  it("projects safe fields only", () => {
    const p = toPublicCompanyProfile({
      displayName: "Rain XYZ",
      logoUrl: "https://logo.clearbit.com/rain.xyz",
      hqLocation: "New York, NY",
      employeeRange: "11-50",
      industry: "Consumer apps",
      companyStage: "seed",
      companyTags: ["consumer", "mobile"],
      // Sensitive fields below — must NOT appear in output
      enrichmentSource: "clearbit",
      lastReviewedBy: "adam@wekruit.com",
      jobsCount: 5,
      fundingRounds: [{ round: "seed", amount: 3, date: "2025-01-01", investors: ["a16z"] }],
    })
    assert.ok(p)
    assert.equal(p!.displayName, "Rain XYZ")
    assert.equal(p!.logoUrl, "https://logo.clearbit.com/rain.xyz")
    assert.equal(p!.companyStage, "seed")
    assert.deepEqual(p!.companyTags, ["consumer", "mobile"])
    // No leakage of internal fields.
    assert.equal((p as unknown as Record<string, unknown>).enrichmentSource, undefined)
    assert.equal((p as unknown as Record<string, unknown>).lastReviewedBy, undefined)
    assert.equal((p as unknown as Record<string, unknown>).fundingRounds, undefined)
  })

  it("returns undefined for empty data", () => {
    assert.equal(toPublicCompanyProfile(undefined), undefined)
    assert.equal(toPublicCompanyProfile({}), undefined)
  })
})

// ============================================================ auth

describe("verifyCollabAuth", () => {
  const KEYS = "key_alpha_secret,key_beta_secret"
  const ORIGINS = "https://partner.com,https://staging.partner.com"

  it("rejects missing api key", () => {
    const r = verifyCollabAuth(undefined, "https://partner.com", KEYS, ORIGINS)
    assert.equal(r.ok, false)
    assert.equal(r.reason, "missing_api_key")
  })

  it("rejects invalid api key", () => {
    const r = verifyCollabAuth("wrong_key", "https://partner.com", KEYS, ORIGINS)
    assert.equal(r.ok, false)
    assert.equal(r.reason, "invalid_api_key")
  })

  it("accepts valid api key + allowed origin", () => {
    const r = verifyCollabAuth("key_alpha_secret", "https://partner.com", KEYS, ORIGINS)
    assert.equal(r.ok, true)
  })

  it("accepts valid api key + no origin (server-to-server)", () => {
    const r = verifyCollabAuth("key_alpha_secret", undefined, KEYS, ORIGINS)
    assert.equal(r.ok, true)
  })

  it("rejects valid api key + disallowed origin", () => {
    const r = verifyCollabAuth("key_alpha_secret", "https://evil.com", KEYS, ORIGINS)
    assert.equal(r.ok, false)
    assert.equal(r.reason, "origin_not_allowed")
  })

  it('treats "*" origins as disabled', () => {
    const r = verifyCollabAuth("key_alpha_secret", "https://anywhere.com", KEYS, "*")
    assert.equal(r.ok, true)
  })

  it("treats empty origin list as disabled", () => {
    const r = verifyCollabAuth("key_alpha_secret", "https://anywhere.com", KEYS, "")
    assert.equal(r.ok, true)
  })

  it("constant-time check tolerates differing key lengths", () => {
    const r = verifyCollabAuth("x", "https://partner.com", KEYS, ORIGINS)
    assert.equal(r.ok, false)
  })

  it("accepts second key in CSV", () => {
    const r = verifyCollabAuth("key_beta_secret", undefined, KEYS, ORIGINS)
    assert.equal(r.ok, true)
  })
})
