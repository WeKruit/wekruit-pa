import assert from "node:assert/strict"
import test from "node:test"

import {
  CalcomClientError,
  CalcomServerError,
  createBooking,
  flattenSlots,
  getAvailableSlots,
  getCalcomApiKey,
  getEventTypes,
} from "./calcom-client.js"

// FAKE key — NEVER a literal cal_live_. Set in env so the client reads it.
const FAKE_KEY = "cal_test_FAKEKEY_do_not_use"
process.env.CALCOM_API_KEY = FAKE_KEY

type FetchCapture = { url: string; init: RequestInit | undefined }

function mockFetch(
  responder: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
): { restore: () => void; calls: FetchCapture[] } {
  const calls: FetchCapture[] = []
  const orig = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString()
    calls.push({ url, init })
    return responder(url, init)
  }) as typeof fetch
  return { restore: () => { globalThis.fetch = orig }, calls }
}

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...(headers ?? {}) },
  })
}

function headerOf(init: RequestInit | undefined, name: string): string | null {
  const h = init?.headers
  if (!h) return null
  if (h instanceof Headers) return h.get(name)
  const rec = h as Record<string, string>
  // case-insensitive
  for (const [k, v] of Object.entries(rec)) {
    if (k.toLowerCase() === name.toLowerCase()) return v
  }
  return null
}

test("getCalcomApiKey throws CalcomServerError when unset", () => {
  const saved = process.env.CALCOM_API_KEY
  delete process.env.CALCOM_API_KEY
  try {
    assert.throws(() => getCalcomApiKey(), (e) => e instanceof CalcomServerError)
  } finally {
    process.env.CALCOM_API_KEY = saved
  }
})

test("flattenSlots flattens multi-day, out-of-order keys into one ascending-sorted array", () => {
  const data = {
    "2026-06-03": [{ start: "2026-06-03T14:00:00.000-04:00" }, { start: "2026-06-03T09:00:00.000-04:00" }],
    "2026-06-02": [{ start: "2026-06-02T11:00:00.000-04:00" }],
  }
  const flat = flattenSlots(data)
  assert.deepEqual(
    flat.map((s) => s.iso),
    [
      "2026-06-02T11:00:00.000-04:00",
      "2026-06-03T09:00:00.000-04:00",
      "2026-06-03T14:00:00.000-04:00",
    ],
  )
  assert.equal(flat[0]!.date, "2026-06-02")
})

test("flattenSlots returns [] for empty data:{}", () => {
  assert.deepEqual(flattenSlots({}), [])
  assert.deepEqual(flattenSlots(undefined), [])
})

test("getAvailableSlots sends cal-api-version 2024-09-04 + Bearer + correct query params, flattens+sorts", async () => {
  const { restore, calls } = mockFetch((_url) =>
    jsonResponse(200, {
      status: "success",
      data: {
        "2026-06-02": [{ start: "2026-06-02T13:00:00.000-04:00" }, { start: "2026-06-02T09:00:00.000-04:00" }],
      },
    }),
  )
  try {
    const slots = await getAvailableSlots({
      start: "2026-06-02T00:00:00Z",
      end: "2026-06-09T00:00:00Z",
      eventTypeId: 5847961,
      timeZone: "America/New_York",
    })
    assert.equal(slots.length, 2)
    // sorted ascending by instant.
    assert.equal(slots[0]!.iso, "2026-06-02T09:00:00.000-04:00")
    const c = calls[0]!
    assert.equal(headerOf(c.init, "cal-api-version"), "2024-09-04")
    assert.equal(headerOf(c.init, "authorization"), `Bearer ${FAKE_KEY}`)
    assert.ok(c.url.includes("eventTypeId=5847961"))
    assert.ok(c.url.includes("timeZone=America%2FNew_York"))
    assert.ok(c.url.startsWith("https://api.cal.com/v2/slots?"))
  } finally {
    restore()
  }
})

test("createBooking sends cal-api-version 2026-02-25 + cal-video location + attendee.language=en", async () => {
  const { restore, calls } = mockFetch(() =>
    jsonResponse(200, {
      status: "success",
      data: {
        id: 999,
        uid: "booking-uid-1",
        title: "Software Engineer Interview",
        status: "accepted",
        start: "2026-06-02T13:00:00.000-04:00",
        end: "2026-06-02T13:15:00.000-04:00",
        duration: 15,
        eventType: { id: 5847961, slug: "software-engineer-interview" },
      },
    }),
  )
  try {
    const res = await createBooking({
      start: "2026-06-02T13:00:00.000-04:00",
      eventTypeId: 5847961,
      attendee: { name: "Adam", email: "adam@example.com", timeZone: "America/New_York" },
      metadata: { wekruitUserId: "u1", wekruitJobId: "job-1" },
    })
    assert.equal(res.uid, "booking-uid-1")
    assert.equal(res.status, "accepted")
    const c = calls[0]!
    assert.equal(c.init?.method, "POST")
    assert.equal(headerOf(c.init, "cal-api-version"), "2026-02-25")
    assert.equal(headerOf(c.init, "authorization"), `Bearer ${FAKE_KEY}`)
    const body = JSON.parse(String(c.init?.body))
    assert.deepEqual(body.location, { type: "integration", integration: "cal-video" })
    assert.equal(body.attendee.language, "en")
    assert.equal(body.attendee.email, "adam@example.com")
    assert.equal(body.eventTypeId, 5847961)
  } finally {
    restore()
  }
})

test("getEventTypes sends cal-api-version 2024-06-14", async () => {
  const { restore, calls } = mockFetch(() =>
    jsonResponse(200, { status: "success", data: [{ id: 5847961, slug: "swe", title: "SWE", lengthInMinutes: 15 }] }),
  )
  try {
    const types = await getEventTypes("noah-liu-wzqq8w")
    assert.equal(types.length, 1)
    assert.equal(types[0]!.id, 5847961)
    assert.equal(headerOf(calls[0]!.init, "cal-api-version"), "2024-06-14")
    assert.ok(calls[0]!.url.includes("username=noah-liu-wzqq8w"))
  } finally {
    restore()
  }
})

test("4xx → CalcomClientError (status carried)", async () => {
  const { restore } = mockFetch(() => jsonResponse(400, { error: { message: "bad request" } }))
  try {
    await assert.rejects(
      () => getAvailableSlots({ start: "x", end: "y", eventTypeId: 1 }),
      (e) => e instanceof CalcomClientError && (e as CalcomClientError).status === 400,
    )
  } finally {
    restore()
  }
})

test("5xx → CalcomServerError", async () => {
  const { restore } = mockFetch(() => jsonResponse(503, { error: { message: "down" } }))
  try {
    await assert.rejects(
      () => createBooking({ start: "x", eventTypeId: 1, attendee: { name: "a", email: "a@b.c", timeZone: "America/New_York" } }),
      (e) => e instanceof CalcomServerError && (e as CalcomServerError).status === 503,
    )
  } finally {
    restore()
  }
})

test("429 → CalcomServerError with retry-after carried", async () => {
  const { restore } = mockFetch(() => jsonResponse(429, { error: { message: "rate" } }, { "retry-after": "30" }))
  try {
    await assert.rejects(
      () => getAvailableSlots({ start: "x", end: "y", eventTypeId: 1 }),
      (e) => e instanceof CalcomServerError && (e as CalcomServerError).status === 429 && (e as CalcomServerError).retryAfter === "30",
    )
  } finally {
    restore()
  }
})

test("network/abort → CalcomServerError(0)", async () => {
  const { restore } = mockFetch(() => {
    throw new Error("aborted")
  })
  try {
    await assert.rejects(
      () => getAvailableSlots({ start: "x", end: "y", eventTypeId: 1 }),
      (e) => e instanceof CalcomServerError && (e as CalcomServerError).status === 0,
    )
  } finally {
    restore()
  }
})
