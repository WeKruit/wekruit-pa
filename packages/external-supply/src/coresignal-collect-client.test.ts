import test from "node:test"
import assert from "node:assert/strict"
import {
  CoresignalCollectError,
  CORESIGNAL_DEFAULT_BASE_URL,
  fetchCompanyCollect,
  fetchEmployeeCollect,
  searchEmployeeIdByLinkedinUrl,
} from "./coresignal-collect-client.js"

const noSleep = (): Promise<void> => Promise.resolve()

function mockFetch(
  responses: Array<{ status: number; body?: unknown; throwError?: string }>,
): {
  fetchImpl: typeof fetch
  calls: Array<{ url: string; headers: Record<string, string> }>
} {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  let i = 0
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString()
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({ url, headers })
    const spec = responses[Math.min(i, responses.length - 1)]
    i++
    if (spec.throwError) {
      throw new Error(spec.throwError)
    }
    return new Response(JSON.stringify(spec.body ?? {}), {
      status: spec.status,
      headers: { "Content-Type": "application/json" },
    })
  }
  return { fetchImpl: fetchImpl as typeof fetch, calls }
}

test("fetchEmployeeCollect — 200 happy path returns parsed shape", async () => {
  const { fetchImpl, calls } = mockFetch([
    {
      status: 200,
      body: {
        id: 725992096,
        full_name: "Yue H.",
        linkedin_url: "https://www.linkedin.com/in/yue-h-69a807130",
        primary_professional_email: "yh@intelliprogroup.com",
        headline: "Tech Recruiter | AI-driven",
        experience: [
          {
            company_name: "IntelliPro",
            position_title: "Tech Recruiter",
            duration_months: 24,
          },
        ],
        education: [],
        inferred_skills: ["talent acquisition", "sourcing"],
      },
    },
  ])
  const result = await fetchEmployeeCollect(725992096, {
    apiKey: "test-key",
    fetchImpl,
    sleepImpl: noSleep,
  })
  assert.equal(result.id, 725992096)
  assert.equal(result.full_name, "Yue H.")
  assert.equal(result.experience?.[0]?.company_name, "IntelliPro")
  assert.equal(calls.length, 1)
  assert.equal(
    calls[0].url,
    `${CORESIGNAL_DEFAULT_BASE_URL}/employee_multi_source/collect/725992096`,
  )
  assert.equal(calls[0].headers.apikey, "test-key")
})

test("fetchEmployeeCollect — missing apiKey throws", async () => {
  await assert.rejects(
    async () =>
      fetchEmployeeCollect(123, {
        apiKey: "",
        sleepImpl: noSleep,
      }),
    (err) =>
      err instanceof CoresignalCollectError && err.message === "coresignal_api_key_missing",
  )
})

test("fetchEmployeeCollect — 429 retries then succeeds", async () => {
  const { fetchImpl, calls } = mockFetch([
    { status: 429 },
    { status: 429 },
    { status: 200, body: { id: 1 } },
  ])
  const result = await fetchEmployeeCollect(1, {
    apiKey: "k",
    fetchImpl,
    sleepImpl: noSleep,
  })
  assert.equal(result.id, 1)
  assert.equal(calls.length, 3)
})

test("fetchEmployeeCollect — 500 retries then exhausts", async () => {
  const { fetchImpl, calls } = mockFetch([
    { status: 500 },
    { status: 500 },
    { status: 502 },
  ])
  await assert.rejects(
    async () =>
      fetchEmployeeCollect(1, { apiKey: "k", fetchImpl, sleepImpl: noSleep }),
    (err) =>
      err instanceof CoresignalCollectError &&
      err.status === 502 &&
      err.attempts === 3,
  )
  assert.equal(calls.length, 3)
})

test("fetchEmployeeCollect — 404 fails fast no retry", async () => {
  const { fetchImpl, calls } = mockFetch([
    { status: 404, body: { error: "not found" } },
    { status: 200 },
  ])
  await assert.rejects(
    async () =>
      fetchEmployeeCollect(999, { apiKey: "k", fetchImpl, sleepImpl: noSleep }),
    (err) => err instanceof CoresignalCollectError && err.status === 404,
  )
  assert.equal(calls.length, 1)
})

test("fetchEmployeeCollect — network error retries", async () => {
  const { fetchImpl, calls } = mockFetch([
    { status: 0, throwError: "ECONNRESET" },
    { status: 200, body: { id: 7 } },
  ])
  const result = await fetchEmployeeCollect(7, {
    apiKey: "k",
    fetchImpl,
    sleepImpl: noSleep,
  })
  assert.equal(result.id, 7)
  assert.equal(calls.length, 2)
})

test("fetchCompanyCollect — happy path", async () => {
  const { fetchImpl, calls } = mockFetch([
    {
      status: 200,
      body: {
        id: 25355004,
        company_name: "Glacial Skin",
        canonical_linkedin_url: "https://www.linkedin.com/company/r2techofficial",
        industry: "Medical Equipment Manufacturing",
      },
    },
  ])
  const result = await fetchCompanyCollect(25355004, {
    apiKey: "k",
    fetchImpl,
    sleepImpl: noSleep,
  })
  assert.equal(result.id, 25355004)
  assert.equal(result.company_name, "Glacial Skin")
  assert.equal(
    calls[0].url,
    `${CORESIGNAL_DEFAULT_BASE_URL}/company_multi_source/collect/25355004`,
  )
})

test("fetchEmployeeCollect — zod parse failure surfaces clearly", async () => {
  const { fetchImpl } = mockFetch([
    {
      status: 200,
      body: { id: "not-a-number" }, // schema expects number
    },
  ])
  await assert.rejects(
    async () =>
      fetchEmployeeCollect(1, { apiKey: "k", fetchImpl, sleepImpl: noSleep }),
    /Expected number/,
  )
})

test("fetchEmployeeCollect — passes through unknown fields", async () => {
  const { fetchImpl } = mockFetch([
    {
      status: 200,
      body: {
        id: 1,
        full_name: "Test",
        future_field_added_by_coresignal: { nested: "value" },
      },
    },
  ])
  const result = (await fetchEmployeeCollect(1, {
    apiKey: "k",
    fetchImpl,
    sleepImpl: noSleep,
  })) as Record<string, unknown>
  assert.deepEqual(result.future_field_added_by_coresignal, { nested: "value" })
})

test("searchEmployeeIdByLinkedinUrl — POSTs ES-DSL and returns first id (array shape)", async () => {
  const { fetchImpl, calls } = mockFetch([{ status: 200, body: [725992096, 111] }])
  const id = await searchEmployeeIdByLinkedinUrl("https://linkedin.com/in/yue-h", {
    apiKey: "test-key",
    fetchImpl,
    sleepImpl: noSleep,
  })
  assert.equal(id, 725992096)
  assert.equal(calls.length, 1)
  assert.equal(
    calls[0].url,
    `${CORESIGNAL_DEFAULT_BASE_URL}/employee_multi_source/search/es_dsl`,
  )
  assert.equal(calls[0].headers.apikey, "test-key")
})

test("searchEmployeeIdByLinkedinUrl — tolerates {data:[]} and {hits:{hits:[]}} shapes", async () => {
  const wrapped = mockFetch([{ status: 200, body: { data: [{ id: 42 }] } }])
  assert.equal(
    await searchEmployeeIdByLinkedinUrl("https://linkedin.com/in/a", {
      apiKey: "k",
      fetchImpl: wrapped.fetchImpl,
      sleepImpl: noSleep,
    }),
    42,
  )
  const hits = mockFetch([{ status: 200, body: { hits: { hits: [{ _id: "777" }] } } }])
  assert.equal(
    await searchEmployeeIdByLinkedinUrl("https://linkedin.com/in/b", {
      apiKey: "k",
      fetchImpl: hits.fetchImpl,
      sleepImpl: noSleep,
    }),
    777,
  )
})

test("searchEmployeeIdByLinkedinUrl — returns null when no match", async () => {
  const { fetchImpl } = mockFetch([{ status: 200, body: [] }])
  assert.equal(
    await searchEmployeeIdByLinkedinUrl("https://linkedin.com/in/none", {
      apiKey: "k",
      fetchImpl,
      sleepImpl: noSleep,
    }),
    null,
  )
})

test("searchEmployeeIdByLinkedinUrl — empty url returns null without fetching", async () => {
  const { fetchImpl, calls } = mockFetch([{ status: 200, body: [1] }])
  assert.equal(
    await searchEmployeeIdByLinkedinUrl("  ", { apiKey: "k", fetchImpl, sleepImpl: noSleep }),
    null,
  )
  assert.equal(calls.length, 0)
})
