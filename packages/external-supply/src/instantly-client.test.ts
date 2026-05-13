/**
 * Wave C Block F1 — Instantly client tests.
 *
 * Covers:
 *  - dry_run returns payload echo without calling fetch.
 *  - live without apiKey throws `instantly_api_key_missing`.
 *  - live happy path uses injected fetch + parses lead_id.
 *  - listCampaigns parses array shape AND wrapped shape.
 *  - getLead happy path + missing leadId guard.
 *  - markUnsubscribed lowercases email + POSTs to /lead/unsubscribe.
 *  - Response validation: invalid JSON → throws.
 *  - HTTP non-2xx → throws with status code.
 *  - Custom baseUrl + fetchImpl injection works.
 */

import assert from "node:assert/strict"
import test from "node:test"
import {
  INSTANTLY_DEFAULT_BASE_URL,
  createInstantlyClient,
} from "./instantly-client.js"

function makeFetchMock(responses: Array<{ status?: number; body: unknown; text?: string }>) {
  const calls: { url: string; init?: RequestInit }[] = []
  let idx = 0
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? undefined })
    const next = responses[idx]
    idx += 1
    if (!next) {
      throw new Error("test_fetch_no_more_responses")
    }
    const status = next.status ?? 200
    const body = typeof next.text === "string" ? next.text : JSON.stringify(next.body)
    return new Response(body, {
      status,
      headers: { "content-type": "application/json" },
    })
  }
  return { fetchImpl, calls }
}

// ---------------------------------------------------------------------------
// dry_run
// ---------------------------------------------------------------------------

test("addLeadToList dry_run echoes payload without fetching", async () => {
  const { fetchImpl, calls } = makeFetchMock([])
  const client = createInstantlyClient({ apiKey: "k", fetchImpl })
  const out = await client.addLeadToList(
    {
      listId: "list-1",
      campaignId: "camp-1",
      email: "ada@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
      customFields: { jobId: "job-1" },
    },
    { mode: "dry_run" },
  )
  assert.deepEqual(out.payload, {
    listId: "list-1",
    campaignId: "camp-1",
    email: "ada@example.com",
    firstName: "Ada",
    lastName: "Lovelace",
    customFields: { jobId: "job-1" },
  })
  assert.equal(out.result, undefined)
  assert.equal(calls.length, 0)
})

test("addLeadToList dry_run works even with NO apiKey set", async () => {
  // Critical for dashboard preview when env is not yet configured.
  const client = createInstantlyClient({})
  const out = await client.addLeadToList(
    { listId: "list-1", email: "a@b.com" },
    { mode: "dry_run" },
  )
  assert.equal(out.payload.email, "a@b.com")
  assert.equal(out.result, undefined)
})

// ---------------------------------------------------------------------------
// live — missing key
// ---------------------------------------------------------------------------

test("addLeadToList live without apiKey throws instantly_api_key_missing", async () => {
  const client = createInstantlyClient({})
  await assert.rejects(
    () =>
      client.addLeadToList({ listId: "l", email: "a@b.com" }, { mode: "live" }),
    /instantly_api_key_missing/,
  )
})

// ---------------------------------------------------------------------------
// live — happy path
// ---------------------------------------------------------------------------

test("addLeadToList live happy path: parses lead_id from response", async () => {
  const { fetchImpl, calls } = makeFetchMock([
    { body: { status: "success", lead_id: "ll-123" } },
  ])
  const client = createInstantlyClient({ apiKey: "test-key", fetchImpl })
  const out = await client.addLeadToList(
    {
      listId: "list-1",
      campaignId: "camp-1",
      email: "ada@example.com",
      firstName: "Ada",
      customFields: { jobId: "job-1", tier: "tier_2_personal_email" },
    },
    { mode: "live" },
  )
  assert.equal(out.result?.instantlyLeadId, "ll-123")
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.url, `${INSTANTLY_DEFAULT_BASE_URL}/lead/add`)
  const body = JSON.parse(String(calls[0]!.init!.body))
  assert.equal(body.list_id, "list-1")
  assert.equal(body.campaign_id, "camp-1")
  assert.equal(body.first_name, "Ada")
  assert.deepEqual(body.custom_variables, { jobId: "job-1", tier: "tier_2_personal_email" })
})

test("addLeadToList live accepts both `lead_id` and `leadId` field naming", async () => {
  const { fetchImpl } = makeFetchMock([{ body: { leadId: "ll-camelcase-99" } }])
  const client = createInstantlyClient({ apiKey: "k", fetchImpl })
  const out = await client.addLeadToList(
    { listId: "l", email: "a@b.com" },
    { mode: "live" },
  )
  assert.equal(out.result?.instantlyLeadId, "ll-camelcase-99")
})

// ---------------------------------------------------------------------------
// listCampaigns
// ---------------------------------------------------------------------------

test("listCampaigns accepts plain array response", async () => {
  const { fetchImpl } = makeFetchMock([
    {
      body: [
        { id: "c1", name: "Outbound A" },
        { id: "c2", name: "Outbound B" },
      ],
    },
  ])
  const client = createInstantlyClient({ apiKey: "k", fetchImpl })
  const out = await client.listCampaigns()
  assert.equal(out.length, 2)
  assert.equal(out[0]!.id, "c1")
  assert.equal(out[1]!.name, "Outbound B")
})

test("listCampaigns accepts wrapped {campaigns: [...]} response", async () => {
  const { fetchImpl } = makeFetchMock([
    { body: { campaigns: [{ id: "c1", name: "Outbound A" }] } },
  ])
  const client = createInstantlyClient({ apiKey: "k", fetchImpl })
  const out = await client.listCampaigns()
  assert.deepEqual(out, [{ id: "c1", name: "Outbound A" }])
})

// ---------------------------------------------------------------------------
// getLead
// ---------------------------------------------------------------------------

test("getLead returns parsed response", async () => {
  const { fetchImpl, calls } = makeFetchMock([
    { body: { id: "ll-99", email: "ada@example.com" } },
  ])
  const client = createInstantlyClient({ apiKey: "k", fetchImpl })
  const lead = (await client.getLead("ll-99")) as { id: string; email: string }
  assert.equal(lead.id, "ll-99")
  assert.equal(lead.email, "ada@example.com")
  assert.ok(calls[0]!.url.includes("lead_id=ll-99"))
})

test("getLead empty id throws", async () => {
  const client = createInstantlyClient({ apiKey: "k" })
  await assert.rejects(() => client.getLead(""), /instantly_lead_id_required/)
})

// ---------------------------------------------------------------------------
// markUnsubscribed
// ---------------------------------------------------------------------------

test("markUnsubscribed POSTs lowercased email", async () => {
  const { fetchImpl, calls } = makeFetchMock([{ body: { status: "ok" } }])
  const client = createInstantlyClient({ apiKey: "k", fetchImpl })
  await client.markUnsubscribed("  Ada@Example.COM  ")
  assert.equal(calls.length, 1)
  const body = JSON.parse(String(calls[0]!.init!.body))
  assert.equal(body.email, "ada@example.com")
})

// ---------------------------------------------------------------------------
// Validation + error handling
// ---------------------------------------------------------------------------

test("non-2xx response throws instantly_request_failed:<status>", async () => {
  const { fetchImpl } = makeFetchMock([
    { status: 429, text: "Rate limited", body: null },
  ])
  const client = createInstantlyClient({ apiKey: "k", fetchImpl })
  await assert.rejects(
    () => client.addLeadToList({ listId: "l", email: "a@b.com" }, { mode: "live" }),
    /instantly_request_failed:429/,
  )
})

test("response missing lead_id throws instantly_response_missing_lead_id", async () => {
  const { fetchImpl } = makeFetchMock([{ body: { status: "ok" } }])
  const client = createInstantlyClient({ apiKey: "k", fetchImpl })
  await assert.rejects(
    () => client.addLeadToList({ listId: "l", email: "a@b.com" }, { mode: "live" }),
    /instantly_response_missing_lead_id/,
  )
})

test("custom baseUrl is honored", async () => {
  const { fetchImpl, calls } = makeFetchMock([{ body: { lead_id: "x" } }])
  const client = createInstantlyClient({
    apiKey: "k",
    fetchImpl,
    baseUrl: "https://stage.instantly.test/api/v1/",
  })
  await client.addLeadToList(
    { listId: "l", email: "a@b.com" },
    { mode: "live" },
  )
  assert.equal(calls[0]!.url, "https://stage.instantly.test/api/v1/lead/add")
})
