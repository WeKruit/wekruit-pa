/**
 * iter34 followup G.3 — paBackfillMatchingJobsAtsUrl unit tests.
 *
 * Covers:
 *   - isAtsHost host classification (allow + reject)
 *   - resolveAtsUrl pass-1 / pass-3 / miss branches
 *   - createSerperSearch returns first ATS hit, falls back to broader query
 *   - checkLiveness 200/404/timeout/network classifications
 *   - runBackfill end-to-end with in-memory store (all modes)
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  ATS_HOSTS,
  isAtsHost,
  resolveAtsUrl,
  createSerperSearch,
  checkLiveness,
  runBackfill,
  type FetchFn,
  type BackfillStore,
  type MatchingJobDoc,
  type BackfillUpdates,
  type LivenessResult,
  type SerperFn,
} from "./backfill-ats-urls.js"

// -----------------------------------------------------------------------------
// isAtsHost
// -----------------------------------------------------------------------------

describe("isAtsHost", () => {
  it("returns true for known ATS hosts (and subdomains)", () => {
    assert.equal(isAtsHost("https://job-boards.greenhouse.io/stripe/jobs/123"), true)
    assert.equal(isAtsHost("https://boards.greenhouse.io/openai"), true)
    assert.equal(isAtsHost("https://jobs.lever.co/lever/abc-def"), true)
    assert.equal(isAtsHost("https://jobs.ashbyhq.com/Anthropic/post-id"), true)
    assert.equal(isAtsHost("https://acme.wd1.myworkdayjobs.com/external/job/123"), true)
    assert.equal(isAtsHost("https://acme.bamboohr.com/jobs/view.php?id=42"), true)
    assert.equal(isAtsHost("https://career.teamtailor.com/jobs/abc"), true)
  })

  it("returns false for non-ATS hosts", () => {
    assert.equal(isAtsHost("https://google.com/search"), false)
    assert.equal(isAtsHost("https://jobright.ai/jobs/123"), false)
    assert.equal(isAtsHost("https://www.jobright.ai/jobs/123"), false)
    assert.equal(isAtsHost("https://linkedin.com/jobs/view/456"), false)
    assert.equal(isAtsHost("https://example.com/careers/1"), false)
  })

  it("returns false for malformed / empty input", () => {
    assert.equal(isAtsHost(""), false)
    assert.equal(isAtsHost(undefined), false)
    assert.equal(isAtsHost(null), false)
    assert.equal(isAtsHost("not-a-url"), false)
  })

  it("ATS_HOSTS exposes the canonical suffix list", () => {
    assert.ok(ATS_HOSTS.includes("greenhouse.io"))
    assert.ok(ATS_HOSTS.includes("lever.co"))
    assert.ok(ATS_HOSTS.includes("ashbyhq.com"))
  })
})

// -----------------------------------------------------------------------------
// resolveAtsUrl
// -----------------------------------------------------------------------------

describe("resolveAtsUrl", () => {
  const makeSerper = (returnValue: string | null): SerperFn => async () => returnValue

  it("pass 1: primaryUrl is greenhouse → returns primaryUrl as pass1", async () => {
    const out = await resolveAtsUrl(
      {
        primaryUrl: "https://boards.greenhouse.io/stripe/jobs/4123",
        companyName: "Stripe",
        jobTitle: "Software Engineer",
      },
      { serper: makeSerper(null) }
    )
    assert.equal(out.kind, "pass1")
    if (out.kind === "pass1") {
      assert.equal(out.url, "https://boards.greenhouse.io/stripe/jobs/4123")
    }
  })

  it("pass 3: jobright primaryUrl, Serper returns greenhouse → pass3", async () => {
    let serperCalled = false
    const out = await resolveAtsUrl(
      {
        primaryUrl: "https://jobright.ai/jobs/abcdef",
        companyName: "Stripe",
        jobTitle: "Software Engineer",
      },
      {
        serper: async () => {
          serperCalled = true
          return "https://boards.greenhouse.io/stripe/jobs/4123"
        },
      }
    )
    assert.equal(serperCalled, true, "serper must be invoked when primaryUrl is not ATS")
    assert.equal(out.kind, "pass3")
    if (out.kind === "pass3") {
      assert.equal(out.url, "https://boards.greenhouse.io/stripe/jobs/4123")
    }
  })

  it("miss: no primaryUrl, Serper miss → miss", async () => {
    const out = await resolveAtsUrl(
      { companyName: "Acme", jobTitle: "Engineer" },
      { serper: makeSerper(null) }
    )
    assert.equal(out.kind, "miss")
  })

  it("miss: serper returns non-ATS URL → miss", async () => {
    const out = await resolveAtsUrl(
      { companyName: "Acme", jobTitle: "Engineer" },
      { serper: makeSerper("https://google.com/jobs/foo") }
    )
    assert.equal(out.kind, "miss")
  })

  it("miss: missing companyName/jobTitle → skip serper call", async () => {
    let called = false
    const out = await resolveAtsUrl(
      { primaryUrl: "https://jobright.ai/jobs/x" },
      {
        serper: async () => {
          called = true
          return "https://boards.greenhouse.io/x"
        },
      }
    )
    assert.equal(called, false, "serper must not be called when title/company missing")
    assert.equal(out.kind, "miss")
  })

  it("falls back to roleTitle when jobTitle absent", async () => {
    const out = await resolveAtsUrl(
      {
        roleTitle: "Software Engineer",
        companyName: "Stripe",
      },
      { serper: makeSerper("https://boards.greenhouse.io/stripe/jobs/4123") }
    )
    assert.equal(out.kind, "pass3")
  })
})

// -----------------------------------------------------------------------------
// createSerperSearch
// -----------------------------------------------------------------------------

describe("createSerperSearch", () => {
  function makeMockFetch(responses: Array<{ ok: boolean; json: unknown; status?: number }>): {
    fetch: FetchFn
    calls: Array<{ url: string; body: unknown }>
  } {
    const calls: Array<{ url: string; body: unknown }> = []
    let i = 0
    const fetchImpl: FetchFn = async (url, init) => {
      const r = responses[i++] ?? { ok: false, json: {}, status: 500 }
      const bodyStr = (init?.body as string) ?? ""
      let parsedBody: unknown
      try { parsedBody = JSON.parse(bodyStr) } catch { parsedBody = bodyStr }
      calls.push({ url: String(url), body: parsedBody })
      return {
        ok: r.ok,
        status: r.status ?? (r.ok ? 200 : 500),
        json: async () => r.json,
      } as Response
    }
    return { fetch: fetchImpl, calls }
  }

  it("returns first ATS hit in organic results (precise query)", async () => {
    const mock = makeMockFetch([
      {
        ok: true,
        json: {
          organic: [
            { link: "https://google.com/jobs/foo" },
            { link: "https://boards.greenhouse.io/stripe/jobs/4123" },
            { link: "https://jobs.lever.co/something/abc" },
          ],
        },
      },
    ])
    const search = createSerperSearch({ apiKey: "test", fetchImpl: mock.fetch })
    const url = await search("Software Engineer", "Stripe")
    assert.equal(url, "https://boards.greenhouse.io/stripe/jobs/4123")
    assert.equal(mock.calls.length, 1, "second query must NOT fire when first hit found")
    const firstCall = mock.calls[0]!
    assert.equal(firstCall.url, "https://google.serper.dev/search")
    const body = firstCall.body as { q: string; num: number }
    assert.ok(body.q.includes("careers apply"), "first query should include 'careers apply' tail")
  })

  it("falls back to broader query when first miss", async () => {
    const mock = makeMockFetch([
      { ok: true, json: { organic: [{ link: "https://google.com/foo" }] } },
      {
        ok: true,
        json: { organic: [{ link: "https://jobs.lever.co/lever/abc" }] },
      },
    ])
    const search = createSerperSearch({ apiKey: "test", fetchImpl: mock.fetch })
    const url = await search("Software Engineer", "Lever")
    assert.equal(url, "https://jobs.lever.co/lever/abc")
    assert.equal(mock.calls.length, 2, "second query should fire when first misses")
  })

  it("returns null when both queries miss ATS hosts", async () => {
    const mock = makeMockFetch([
      { ok: true, json: { organic: [{ link: "https://google.com/x" }] } },
      { ok: true, json: { organic: [{ link: "https://linkedin.com/y" }] } },
    ])
    const search = createSerperSearch({ apiKey: "test", fetchImpl: mock.fetch })
    const url = await search("Engineer", "Acme")
    assert.equal(url, null)
  })

  it("returns null when serper API errors out", async () => {
    const mock = makeMockFetch([
      { ok: false, json: {}, status: 500 },
      { ok: false, json: {}, status: 500 },
    ])
    const search = createSerperSearch({ apiKey: "test", fetchImpl: mock.fetch })
    const url = await search("Engineer", "Acme")
    assert.equal(url, null)
  })

  it("sets X-API-KEY header on each request", async () => {
    let capturedHeaders: Record<string, string> | undefined
    const fetchImpl: FetchFn = async (_url, init) => {
      capturedHeaders = (init?.headers as Record<string, string>) ?? {}
      return {
        ok: true,
        status: 200,
        json: async () => ({ organic: [{ link: "https://boards.greenhouse.io/x" }] }),
      } as Response
    }
    const search = createSerperSearch({ apiKey: "supersecret", fetchImpl })
    await search("Engineer", "Acme")
    assert.equal(capturedHeaders?.["X-API-KEY"], "supersecret")
  })
})

// -----------------------------------------------------------------------------
// checkLiveness
// -----------------------------------------------------------------------------

describe("checkLiveness", () => {
  function statusFetch(status: number): FetchFn {
    return async () => ({ ok: status < 400, status, json: async () => ({}) } as Response)
  }

  it("returns dead=false on 200", async () => {
    const out = await checkLiveness("https://boards.greenhouse.io/x", { fetchImpl: statusFetch(200) })
    assert.deepEqual(out, { dead: false })
  })

  it("returns dead=true reason='404' on 404", async () => {
    const out = await checkLiveness("https://boards.greenhouse.io/x", { fetchImpl: statusFetch(404) })
    assert.deepEqual(out, { dead: true, reason: "404" })
  })

  it("returns dead=true reason='410' on 410", async () => {
    const out = await checkLiveness("https://boards.greenhouse.io/x", { fetchImpl: statusFetch(410) })
    assert.deepEqual(out, { dead: true, reason: "410" })
  })

  it("returns dead=true reason='500' on 500", async () => {
    const out = await checkLiveness("https://boards.greenhouse.io/x", { fetchImpl: statusFetch(500) })
    assert.deepEqual(out, { dead: true, reason: "500" })
  })

  it("treats 405 (method not allowed) as alive", async () => {
    const out = await checkLiveness("https://boards.greenhouse.io/x", { fetchImpl: statusFetch(405) })
    assert.deepEqual(out, { dead: false })
  })

  it("returns dead=true reason='timeout' on AbortError", async () => {
    const fetchImpl: FetchFn = async () => {
      const err = new Error("aborted") as Error & { name: string }
      err.name = "AbortError"
      throw err
    }
    const out = await checkLiveness("https://boards.greenhouse.io/x", { fetchImpl })
    assert.deepEqual(out, { dead: true, reason: "timeout" })
  })

  it("returns dead=true reason='network' on generic fetch errors", async () => {
    const fetchImpl: FetchFn = async () => {
      throw new Error("ECONNREFUSED")
    }
    const out = await checkLiveness("https://boards.greenhouse.io/x", { fetchImpl })
    assert.deepEqual(out, { dead: true, reason: "network" })
  })
})

// -----------------------------------------------------------------------------
// runBackfill — end-to-end with in-memory store
// -----------------------------------------------------------------------------

function makeStore(seed: MatchingJobDoc[]): BackfillStore & {
  getDoc: (id: string) => MatchingJobDoc & BackfillUpdates
  getUpdates: (id: string) => BackfillUpdates[]
} {
  const docs = new Map<string, MatchingJobDoc & BackfillUpdates>(
    seed.map((d) => [d.id, { ...d }])
  )
  const updates = new Map<string, BackfillUpdates[]>()
  return {
    fetchActiveJobs: async (limit) => {
      return [...docs.values()]
        .filter((d) => d.status === "active")
        .slice(0, limit)
        .map((d) => ({ ...d }))
    },
    updateJob: async (id, u) => {
      const cur = docs.get(id)
      if (!cur) throw new Error(`unknown id ${id}`)
      docs.set(id, { ...cur, ...u })
      const arr = updates.get(id) ?? []
      arr.push({ ...u })
      updates.set(id, arr)
    },
    getDoc: (id) => docs.get(id) ?? ({} as MatchingJobDoc & BackfillUpdates),
    getUpdates: (id) => updates.get(id) ?? [],
  }
}

describe("runBackfill", () => {
  it("mode=all: pass1 + pass3 + liveness all wire correctly", async () => {
    const store = makeStore([
      {
        id: "j1",
        status: "active",
        primaryUrl: "https://boards.greenhouse.io/stripe/jobs/p1",
        companyName: "Stripe",
        jobTitle: "SWE",
      },
      {
        id: "j2",
        status: "active",
        primaryUrl: "https://jobright.ai/jobs/p2",
        companyName: "Anthropic",
        jobTitle: "MLE",
      },
      {
        id: "j3",
        status: "active",
        primaryUrl: "https://jobright.ai/jobs/p3",
        companyName: "MysteryCorp",
        jobTitle: "PM",
      },
      // pre-existing atsApplyUrl — pass3/pass1 skipped, liveness still runs
      {
        id: "j4",
        status: "active",
        atsApplyUrl: "https://jobs.lever.co/dead/abc",
        companyName: "DeadCo",
        jobTitle: "Old Role",
      },
    ])

    const livenessLog: string[] = []
    const result = await runBackfill(
      { mode: "all", limit: 100 },
      {
        store,
        serper: async (_t, c) => {
          if (c === "Anthropic") return "https://jobs.ashbyhq.com/anthropic/job-2"
          return null
        },
        liveness: async (url) => {
          livenessLog.push(url)
          if (url.includes("dead")) return { dead: true, reason: "404" }
          return { dead: false }
        },
        now: () => "2026-05-05T00:00:00.000Z",
      }
    )

    assert.equal(result.totalProcessed, 4)
    assert.equal(result.pass1Count, 1, "j1 → pass1")
    assert.equal(result.pass3Count, 1, "j2 → pass3")
    assert.equal(result.missCount, 1, "j3 → miss")
    assert.equal(result.livenessChecked, 3, "j1, j2, j4 had a URL to check (j3 missed)")
    assert.equal(result.livenessFailCount, 1, "j4's lever URL is dead")
    assert.equal(result.errors, 0)

    // j1 — pass1 wrote atsApplyUrl + atsResolvedAt + liveness=alive
    const j1u = store.getUpdates("j1")
    assert.ok(j1u.some((u) => u.atsApplyUrl === "https://boards.greenhouse.io/stripe/jobs/p1" && u.atsResolvedBy === "cf-backfill-pass1"))
    assert.ok(j1u.some((u) => u.dead === false && u.deadCheckedAt))

    // j2 — pass3 wrote atsApplyUrl + liveness=alive
    const j2u = store.getUpdates("j2")
    assert.ok(j2u.some((u) => u.atsApplyUrl === "https://jobs.ashbyhq.com/anthropic/job-2" && u.atsResolvedBy === "cf-backfill-pass3"))
    assert.ok(j2u.some((u) => u.dead === false))

    // j3 — miss → urlResolutionAttemptedAt set, NO liveness (no URL)
    const j3u = store.getUpdates("j3")
    assert.equal(j3u.length, 1, "j3 should only have miss-stamp")
    assert.equal(j3u[0]!.urlResolutionAttemptedAt, "2026-05-05T00:00:00.000Z")
    assert.equal(j3u[0]!.atsApplyUrl, undefined)

    // j4 — dead=true with reason
    const j4u = store.getUpdates("j4")
    assert.ok(j4u.some((u) => u.dead === true && u.deadReason === "404"))
  })

  it("mode=pass1-only: skips Serper and liveness", async () => {
    const store = makeStore([
      {
        id: "j1",
        status: "active",
        primaryUrl: "https://boards.greenhouse.io/x/y",
        companyName: "X",
        jobTitle: "Eng",
      },
      {
        id: "j2",
        status: "active",
        primaryUrl: "https://jobright.ai/y",
        companyName: "Y",
        jobTitle: "Eng",
      },
    ])
    let serperCalled = 0
    let livenessCalled = 0
    const result = await runBackfill(
      { mode: "pass1-only" },
      {
        store,
        serper: async () => {
          serperCalled++
          return null
        },
        liveness: async () => {
          livenessCalled++
          return { dead: false }
        },
        now: () => "T",
      }
    )
    assert.equal(serperCalled, 0, "Serper must NOT be called in pass1-only")
    assert.equal(livenessCalled, 0, "liveness must NOT be called in pass1-only")
    assert.equal(result.pass1Count, 1)
    assert.equal(result.pass3Count, 0)
    assert.equal(result.missCount, 1)
  })

  it("mode=liveness-only: skips resolve, runs HEAD on docs that already have atsApplyUrl", async () => {
    const store = makeStore([
      {
        id: "j1",
        status: "active",
        atsApplyUrl: "https://boards.greenhouse.io/alive",
        companyName: "X",
        jobTitle: "Eng",
      },
      {
        id: "j2",
        status: "active",
        atsApplyUrl: "https://jobs.lever.co/dead",
        companyName: "Y",
        jobTitle: "Eng",
      },
      {
        id: "j3",
        status: "active",
        // no atsApplyUrl — liveness-only skips
        primaryUrl: "https://jobright.ai/x",
        companyName: "Z",
        jobTitle: "Eng",
      },
    ])
    let serperCalled = 0
    const result = await runBackfill(
      { mode: "liveness-only" },
      {
        store,
        serper: async () => {
          serperCalled++
          return null
        },
        liveness: async (url) => (url.includes("dead") ? { dead: true, reason: "410" } : { dead: false }),
        now: () => "T",
      }
    )
    assert.equal(serperCalled, 0, "Serper must NOT fire in liveness-only")
    assert.equal(result.pass1Count, 0)
    assert.equal(result.pass3Count, 0)
    assert.equal(result.missCount, 0)
    assert.equal(result.livenessChecked, 2, "j1+j2 only — j3 has no atsApplyUrl")
    assert.equal(result.livenessFailCount, 1)
    assert.deepEqual(
      store.getUpdates("j3"),
      [],
      "j3 must not be touched in liveness-only"
    )
  })

  it("respects limit", async () => {
    const store = makeStore(
      Array.from({ length: 50 }, (_, i): MatchingJobDoc => ({
        id: `j${i}`,
        status: "active",
        primaryUrl: "https://boards.greenhouse.io/x/y",
        companyName: "X",
        jobTitle: "Eng",
      }))
    )
    const result = await runBackfill(
      { mode: "pass1-only", limit: 10 },
      {
        store,
        serper: async () => null,
        liveness: async () => ({ dead: false }),
        now: () => "T",
      }
    )
    assert.equal(result.totalProcessed, 10)
    assert.equal(result.pass1Count, 10)
  })

  it("captures errors but continues processing", async () => {
    const store = makeStore([
      {
        id: "j1",
        status: "active",
        primaryUrl: "https://boards.greenhouse.io/ok",
        companyName: "X",
        jobTitle: "Eng",
      },
      {
        id: "j2",
        status: "active",
        primaryUrl: "https://jobright.ai/x",
        companyName: "X",
        jobTitle: "Eng",
      },
      {
        id: "j3",
        status: "active",
        primaryUrl: "https://boards.greenhouse.io/ok2",
        companyName: "X",
        jobTitle: "Eng",
      },
    ])
    const result = await runBackfill(
      { mode: "all" },
      {
        store,
        serper: async () => {
          throw new Error("serper exploded")
        },
        liveness: async () => ({ dead: false }),
        now: () => "T",
      }
    )
    // j1 + j3 → pass1; j2 → resolve threw, errors++, no liveness for j2
    assert.equal(result.pass1Count, 2)
    assert.equal(result.errors, 1)
    assert.equal(result.livenessChecked, 2, "j1+j3 still got liveness")
    const j2u = store.getUpdates("j2")
    // j2 must NOT have been written-through despite the throw
    assert.equal(j2u.length, 0, "j2 should have no updates after resolve threw")
  })
})

// -----------------------------------------------------------------------------
// LivenessResult discriminated-union sanity (compile-time + runtime guard)
// -----------------------------------------------------------------------------

describe("LivenessResult union", () => {
  it("alive shape", () => {
    const alive: LivenessResult = { dead: false }
    assert.equal(alive.dead, false)
  })
  it("dead shape carries reason", () => {
    const dead: LivenessResult = { dead: true, reason: "404" }
    assert.equal(dead.reason, "404")
  })
})
