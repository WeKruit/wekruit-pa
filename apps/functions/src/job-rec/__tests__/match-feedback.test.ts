import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  recordTapbackFeedback,
  extractJobIdsFromOutbound,
  selectMatchingOutbound,
  processTapbackForFeedback,
} from "../match-feedback.js"

type DocData = Record<string, unknown>

function makeFakeDb() {
  const matchingFeedback: DocData[] = []
  const outbound: Array<DocData & { id: string }> = []

  function makeQuery(filterFn: (d: DocData) => boolean, limit = Infinity) {
    const obj = {
      _filterFn: filterFn,
      _limit: limit,
      where(field: string, op: string, value: unknown) {
        return makeQuery(
          (d) => obj._filterFn(d) && (op === "==" ? d[field] === value : op === ">=" ? String(d[field] ?? "") >= String(value) : true),
          obj._limit,
        )
      },
      orderBy(_field: string, _dir: string) {
        return obj
      },
      limit(n: number) {
        return makeQuery(obj._filterFn, n)
      },
      async get() {
        const docs = outbound.filter(obj._filterFn).slice(0, obj._limit).map((d) => ({
          id: d.id,
          data: () => d,
        }))
        return { docs }
      },
    }
    return obj
  }

  const db = {
    collection(name: string) {
      if (name === "matching-feedback") {
        return {
          add(data: DocData) {
            matchingFeedback.push({ ...data })
            return Promise.resolve({ id: `mf_${matchingFeedback.length}` })
          },
        }
      }
      if (name === "pa-outbound") {
        return makeQuery(() => true)
      }
      throw new Error(`unexpected collection: ${name}`)
    },
  } as unknown as Parameters<typeof recordTapbackFeedback>[0]

  return { db, matchingFeedback, outbound }
}

describe("recordTapbackFeedback", () => {
  it("writes one matching-feedback row per jobId", async () => {
    const { db, matchingFeedback } = makeFakeDb()
    const out = await recordTapbackFeedback(db, {
      userId: "user-1",
      kind: "love",
      quotedText: "Here are 3 jobs",
      jobIds: ["job-A", "job-B", "job-C"],
    })
    assert.equal(out.written, 3)
    assert.equal(matchingFeedback.length, 3)
    const ids = matchingFeedback.map((r) => r.jobId)
    assert.deepEqual(ids.sort(), ["job-A", "job-B", "job-C"])
    for (const r of matchingFeedback) {
      assert.equal(r.userId, "user-1")
      assert.equal(r.reaction, "love")
      assert.equal(r.source, "tapback")
      assert.ok(r.createdAt)
    }
  })

  it("attaches companyName + jobTitle from jobMeta when present", async () => {
    const { db, matchingFeedback } = makeFakeDb()
    await recordTapbackFeedback(db, {
      userId: "u",
      kind: "like",
      quotedText: "x",
      jobIds: ["j1"],
      jobMeta: { j1: { companyName: "Acme", jobTitle: "PM" } },
    })
    assert.equal(matchingFeedback[0]!.companyName, "Acme")
    assert.equal(matchingFeedback[0]!.jobTitle, "PM")
  })

  it("no-op when jobIds empty (avoid polluting matching dataset)", async () => {
    const { db, matchingFeedback } = makeFakeDb()
    const out = await recordTapbackFeedback(db, {
      userId: "u",
      kind: "love",
      quotedText: "x",
      jobIds: [],
    })
    assert.equal(out.written, 0)
    assert.equal(matchingFeedback.length, 0)
  })

  it("filters out empty/non-string jobIds", async () => {
    const { db, matchingFeedback } = makeFakeDb()
    await recordTapbackFeedback(db, {
      userId: "u",
      kind: "love",
      quotedText: "x",
      jobIds: ["", "valid-id", null as unknown as string],
    })
    assert.equal(matchingFeedback.length, 1)
    assert.equal(matchingFeedback[0]!.jobId, "valid-id")
  })
})

describe("extractJobIdsFromOutbound", () => {
  it("PRIMARY: extracts from rawMeta.jobIds with jobMeta", () => {
    const out = extractJobIdsFromOutbound({
      body: "irrelevant",
      rawMeta: {
        jobIds: ["job-A", "job-B"],
        jobMeta: {
          "job-A": { companyName: "Acme", jobTitle: "PM" },
          "job-B": { companyName: "Globex", jobTitle: "EM" },
        },
      },
    })
    assert.deepEqual(out.jobIds, ["job-A", "job-B"])
    assert.equal(out.jobMeta["job-A"]?.companyName, "Acme")
    assert.equal(out.jobMeta["job-B"]?.jobTitle, "EM")
  })

  it("FALLBACK: extracts from /jobs/{id} URL pattern in body", () => {
    const out = extractJobIdsFromOutbound({
      body: "Check these:\n- https://wekruit.com/jobs/job-X\n- https://www.wekruit.com/jobs/job-Y\n- /jobs/job-Z",
    })
    assert.deepEqual(out.jobIds.sort(), ["job-X", "job-Y", "job-Z"])
  })

  it("returns empty when no jobIds anywhere", () => {
    const out = extractJobIdsFromOutbound({ body: "hi there" })
    assert.deepEqual(out.jobIds, [])
  })
})

describe("selectMatchingOutbound", () => {
  it("returns rows whose body contains the quoted excerpt (case-insensitive)", () => {
    const now = Date.now()
    const candidates = [
      { id: "1", body: "Here are 3 jobs that match", createdAt: new Date(now - 60_000).toISOString() },
      { id: "2", body: "unrelated update", createdAt: new Date(now - 60_000).toISOString() },
    ]
    const matched = selectMatchingOutbound(candidates, "here are 3 jobs", now)
    assert.equal(matched.length, 1)
    assert.equal((matched[0] as { id: string }).id, "1")
  })

  it("strips trailing ellipsis from iMessage truncation", () => {
    const now = Date.now()
    const candidates = [
      { id: "1", body: "Career check-in tomorrow morning at 9am", createdAt: new Date(now - 60_000).toISOString() },
    ]
    const matched = selectMatchingOutbound(candidates, "Career check-in tomorrow…", now)
    assert.equal(matched.length, 1)
  })

  it("excludes rows older than 5 minutes", () => {
    const now = Date.now()
    const candidates = [
      { id: "1", body: "match me", createdAt: new Date(now - 10 * 60_000).toISOString() },
      { id: "2", body: "match me", createdAt: new Date(now - 60_000).toISOString() },
    ]
    const matched = selectMatchingOutbound(candidates, "match me", now)
    assert.equal(matched.length, 1)
    assert.equal((matched[0] as { id: string }).id, "2")
  })

  it("returns empty for empty quotedText", () => {
    assert.deepEqual(selectMatchingOutbound([{ body: "anything" }], ""), [])
  })
})

describe("processTapbackForFeedback (integration: 1 outbound mentions 3 jobs → 3 matching-feedback rows)", () => {
  it("end-to-end: tapback Loved → finds outbound → extracts 3 jobIds → writes 3 rows", async () => {
    const { db, matchingFeedback, outbound } = makeFakeDb()
    const peer = "+15551234567"
    const now = Date.now()
    outbound.push({
      id: "out-1",
      toE164: peer,
      body: "Here are 3 jobs that match your profile:\n- /jobs/job-A\n- /jobs/job-B\n- /jobs/job-C",
      status: "sent",
      createdAt: new Date(now - 60_000).toISOString(),
      rawMeta: {
        jobIds: ["job-A", "job-B", "job-C"],
        jobMeta: {
          "job-A": { companyName: "Acme", jobTitle: "PM" },
          "job-B": { companyName: "Globex", jobTitle: "EM" },
          "job-C": { companyName: "Initech", jobTitle: "SWE" },
        },
      },
    })

    const result = await processTapbackForFeedback(
      db,
      {
        userId: peer,
        fromNumber: peer,
        kind: "love",
        quotedText: "Here are 3 jobs",
      },
      () => new Date(now)
    )

    assert.equal(result.written, 3, "must write one row per mentioned job")
    assert.equal(matchingFeedback.length, 3)
    const ids = matchingFeedback.map((r) => r.jobId).sort()
    assert.deepEqual(ids, ["job-A", "job-B", "job-C"])
    // Reaction kind preserved + meta enriched
    for (const r of matchingFeedback) {
      assert.equal(r.reaction, "love")
      assert.equal(r.userId, peer)
      assert.equal(r.source, "tapback")
    }
    const acme = matchingFeedback.find((r) => r.jobId === "job-A")!
    assert.equal(acme.companyName, "Acme")
    assert.equal(acme.jobTitle, "PM")
  })

  it("no recent outbound match → 0 rows written (don't pollute matching dataset)", async () => {
    const { db, matchingFeedback } = makeFakeDb()
    const result = await processTapbackForFeedback(
      db,
      {
        userId: "+15551234567",
        fromNumber: "+15551234567",
        kind: "love",
        quotedText: "anything",
      }
    )
    assert.equal(result.written, 0)
    assert.equal(matchingFeedback.length, 0)
  })
})
