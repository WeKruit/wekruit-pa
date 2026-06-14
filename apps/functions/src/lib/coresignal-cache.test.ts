import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { MockFirestore, asFirestore } from "../job-rec/__tests__/mock-firestore.js"
import {
  coresignalCacheKey,
  getOrFetchCoresignalByLinkedin,
  storeCoresignalEmployee,
} from "./coresignal-cache.js"
import type { CoresignalEmployeeCollectV2 } from "@pa/external-supply"

const now = "2026-06-09T12:00:00.000Z"
const employee = {
  id: 123,
  linkedin_url: "https://www.linkedin.com/in/x",
  education: [],
  experience: [],
} as unknown as CoresignalEmployeeCollectV2

describe("coresignal-cache (unified store)", () => {
  it("coresignalCacheKey is the canonical full hash — equivalent URL forms collapse", () => {
    const a = coresignalCacheKey("https://www.linkedin.com/in/ada-lovelace/")
    const b = coresignalCacheKey("linkedin.com/in/ada-lovelace")
    const c = coresignalCacheKey("http://LinkedIn.com/in/ada-lovelace?trk=x")
    assert.equal(a, b)
    assert.equal(a, c)
    assert.equal(a.length, 64, "full sha256, not a 40-char partial")
  })

  it("getOrFetch caches a miss with the unified triple {coresignalId, linkedinUrl, employee}", async () => {
    const mfs = new MockFirestore()
    let searchCalls = 0
    const res = await getOrFetchCoresignalByLinkedin({
      db: asFirestore(mfs),
      link: "https://www.linkedin.com/in/x",
      apiKey: "k",
      now,
      source: "test",
      search: async () => { searchCalls += 1; return 123 },
      fetch: async () => employee,
    })
    assert.equal(res, employee)
    assert.equal(searchCalls, 1)
    const doc = (await mfs.collection("pa-coresignal-cache").doc(coresignalCacheKey("https://www.linkedin.com/in/x")).get()).data() ?? {}
    assert.equal(doc.coresignalId, 123)
    assert.match(String(doc.linkedinUrl), /linkedin\.com\/in\/x/) // canonical form stored
    assert.equal(doc.linkedinHash, coresignalCacheKey("https://www.linkedin.com/in/x"))
    assert.ok(doc.employee, "complete response stored")
    assert.equal(doc.source, "test")
  })

  it("getOrFetch reuses a cache hit — no key, no search/fetch", async () => {
    const mfs = new MockFirestore()
    await storeCoresignalEmployee({ db: asFirestore(mfs), link: "linkedin.com/in/x", coresignalId: 123, employee, now, source: "seed" })
    let apiCalls = 0
    const res = await getOrFetchCoresignalByLinkedin({
      db: asFirestore(mfs),
      link: "https://www.linkedin.com/in/x", // different form, same canonical key
      apiKey: null,
      now,
      source: "test",
      search: async () => { apiCalls += 1; return 123 },
      fetch: async () => { apiCalls += 1; return employee },
    })
    assert.ok(res, "served from cache despite a different URL form + no API key")
    assert.equal(apiCalls, 0)
  })

  it("getOrFetch fails open (undefined) on non-LinkedIn link is N/A — but no-key miss returns undefined", async () => {
    const mfs = new MockFirestore()
    const res = await getOrFetchCoresignalByLinkedin({
      db: asFirestore(mfs),
      link: "https://www.linkedin.com/in/nobody",
      apiKey: null,
      now,
      source: "test",
      search: async () => 1,
      fetch: async () => employee,
    })
    assert.equal(res, undefined)
  })
})
