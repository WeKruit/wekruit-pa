/**
 * v1.6 Phase 58 — `runNightlyRerank` unit tests.
 *
 * Coverage:
 *   - extractSkillNames: string[], object[], dedupe, whitespace
 *   - parseYoeRange: tuple, "3-5", "10+", invalid
 *   - composeRerankInput: shape, truncations, optional-field omission
 *   - runNightlyRerank: iterates only users with targetRoleFunction set
 *   - skip-fresh: cache <23h old → skipped, counter bumped
 *   - skip-fresh: cache stale → reranks
 *   - one user errors → other users still complete (Promise.allSettled)
 *   - rerank cache write: shape, computedAt, modelUsed, candidatePoolSize
 *   - JD-rel cache: written for top-N only
 *   - JD-rel error → counter bumped, other JDs continue
 *   - empty candidates → skipNoCandidates
 *   - audit always written (even when fetch fails partial users)
 *   - concurrency: peak respects userConcurrency
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  runNightlyRerank,
  processOneUser,
  composeRerankInput,
  extractSkillNames,
  parseYoeRange,
  emptyCounters,
  type RerankStore,
  type RerankDeps,
  type RerankJobDoc,
  type UserTagsLike,
  type RerankCounters,
} from "../nightly-rerank.js"
import type { RerankInput, RerankOutput } from "../lib/llm-rerank.js"
import type { JdRelInput, JdRelOutput } from "../lib/jd-relative-weights.js"

// ---------------------------------------------------------------------------
// extractSkillNames
// ---------------------------------------------------------------------------

describe("extractSkillNames", () => {
  it("returns empty when input is undefined or non-array", () => {
    assert.deepEqual(extractSkillNames(undefined), [])
    assert.deepEqual(extractSkillNames(null as unknown as undefined), [])
    assert.deepEqual(extractSkillNames("string" as unknown as undefined), [])
  })
  it("handles string skills", () => {
    assert.deepEqual(extractSkillNames(["python", "react"]), ["python", "react"])
  })
  it("handles object skills via .name", () => {
    const out = extractSkillNames([{ name: "python" }, { name: "react" }])
    assert.deepEqual(out, ["python", "react"])
  })
  it("handles mixed string + object input", () => {
    const out = extractSkillNames(["python", { name: "react" }])
    assert.deepEqual(out, ["python", "react"])
  })
  it("dedupes (case-insensitive)", () => {
    const out = extractSkillNames(["Python", "PYTHON", "python"])
    assert.deepEqual(out, ["Python"])
  })
  it("drops whitespace-only and empty", () => {
    const out = extractSkillNames(["", "  ", "valid", { name: "" }])
    assert.deepEqual(out, ["valid"])
  })
})

// ---------------------------------------------------------------------------
// parseYoeRange
// ---------------------------------------------------------------------------

describe("parseYoeRange", () => {
  it("returns tuple unchanged when valid", () => {
    assert.deepEqual(parseYoeRange([3, 5]), [3, 5])
  })
  it('parses "3-5"', () => {
    assert.deepEqual(parseYoeRange("3-5"), [3, 5])
  })
  it('parses "10+" → [10, 30]', () => {
    assert.deepEqual(parseYoeRange("10+"), [10, 30])
  })
  it('parses "5+" → [5, 25]', () => {
    assert.deepEqual(parseYoeRange("5+"), [5, 25])
  })
  it("returns undefined for invalid strings", () => {
    assert.equal(parseYoeRange("abc"), undefined)
    assert.equal(parseYoeRange(""), undefined)
  })
  it("returns undefined for invalid tuples", () => {
    assert.equal(parseYoeRange([NaN, 5] as [number, number]), undefined)
  })
  it("returns undefined for undefined input", () => {
    assert.equal(parseYoeRange(undefined), undefined)
  })
})

// ---------------------------------------------------------------------------
// composeRerankInput
// ---------------------------------------------------------------------------

describe("composeRerankInput", () => {
  it("composes basic shape with required fields", () => {
    const tags: UserTagsLike = {
      targetRoleFunction: ["software_engineering"],
      skills: ["python", "react"],
      yoeRange: "3-5",
      visaStatus: "sponsor_needed",
      cvSummary: "SWE @ Acme",
    }
    const jobs: RerankJobDoc[] = [
      {
        id: "j1",
        roleTitle: "Backend Eng",
        companyName: "Co1",
        requiredSkills: ["python"],
      },
    ]
    const out = composeRerankInput(tags, jobs)
    assert.deepEqual(out.candidate.targetRole, ["software_engineering"])
    assert.deepEqual(out.candidate.topSkills, ["python", "react"])
    assert.deepEqual(out.candidate.yoeRange, [3, 5])
    assert.equal(out.candidate.visaStatus, "sponsor_needed")
    assert.equal(out.candidate.cvSummary, "SWE @ Acme")
    assert.equal(out.jobs.length, 1)
    assert.equal(out.jobs[0]!.id, "j1")
    assert.equal(out.jobs[0]!.roleTitle, "Backend Eng")
    assert.equal(out.jobs[0]!.companyName, "Co1")
  })
  it("truncates cvSummary at 200 chars", () => {
    const tags: UserTagsLike = {
      targetRoleFunction: ["x"],
      skills: ["a"],
      cvSummary: "x".repeat(500),
    }
    const out = composeRerankInput(tags, [])
    assert.equal(out.candidate.cvSummary?.length, 200)
  })
  it("truncates jobDescription at 400 chars", () => {
    const out = composeRerankInput(
      { targetRoleFunction: ["x"], skills: [] },
      [{ id: "j1", roleTitle: "x", companyName: "y", jobDescription: "z".repeat(1000) }]
    )
    assert.equal(out.jobs[0]!.jobDescription?.length, 400)
  })
  it("truncates topSkills at 12", () => {
    const skills = Array.from({ length: 20 }, (_, i) => `skill${i}`)
    const out = composeRerankInput({ targetRoleFunction: ["x"], skills }, [])
    assert.equal(out.candidate.topSkills?.length, 12)
  })
  it("omits optional fields when missing", () => {
    const out = composeRerankInput(
      { targetRoleFunction: ["x"], skills: [] },
      [{ id: "j1", roleTitle: "r", companyName: "c" }]
    )
    assert.equal(out.candidate.yoeRange, undefined)
    assert.equal(out.candidate.visaStatus, undefined)
    assert.equal(out.candidate.cvSummary, undefined)
    assert.equal(out.jobs[0]!.requiredSkills, undefined)
    assert.equal(out.jobs[0]!.industryEnum, undefined)
  })
  it("falls back to jobTitle when roleTitle missing", () => {
    const out = composeRerankInput(
      { targetRoleFunction: ["x"], skills: [] },
      [{ id: "j1", jobTitle: "Software Engineer", companyName: "Co" }]
    )
    assert.equal(out.jobs[0]!.roleTitle, "Software Engineer")
  })
})

// ---------------------------------------------------------------------------
// In-memory store factory
// ---------------------------------------------------------------------------

type FakeStoreInit = {
  users?: Array<{ id: string; tags: UserTagsLike }>
  rerankCache?: Record<string, { computedAt: string }>
  candidatesByRole?: (roles: string[]) => RerankJobDoc[]
}

function makeFakeStore(init: FakeStoreInit = {}) {
  const users = init.users ?? []
  const rerankCache: Record<string, { computedAt: string }> = { ...(init.rerankCache ?? {}) }
  const rerankWrites: Array<{ userId: string; payload: unknown }> = []
  const jdrelWrites: Array<{ userId: string; jobId: string; payload: unknown }> = []
  const audits: Array<{ counters: RerankCounters; runAt: string; durationMs: number }> = []
  let fetchCandidatesCalls = 0

  const store: RerankStore = {
    fetchActiveUsers: async () => users.map((u) => ({ id: u.id, tags: { ...u.tags } })),
    getRerankCache: async (userId) => rerankCache[userId] ?? null,
    fetchCandidateJobs: async (roles) => {
      fetchCandidatesCalls++
      return init.candidatesByRole?.(roles) ?? []
    },
    writeRerankCache: async (userId, payload) => {
      rerankWrites.push({ userId, payload })
      rerankCache[userId] = { computedAt: payload.computedAt }
    },
    writeJdRelCache: async (userId, jobId, payload) => {
      jdrelWrites.push({ userId, jobId, payload })
    },
    writeAudit: async (counters, runAt, durationMs) => {
      audits.push({ counters: { ...counters }, runAt, durationMs })
    },
  }
  return {
    store,
    rerankWrites,
    jdrelWrites,
    audits,
    rerankCache,
    fetchCandidatesCalls: () => fetchCandidatesCalls,
  }
}

const NOW = Date.parse("2026-05-06T05:00:00Z")
const hoursAgo = (h: number) => new Date(NOW - h * 3600 * 1000).toISOString()

const okRerank = (jobs: RerankInput["jobs"]): RerankOutput => ({
  ranked: jobs.map((j, i) => ({ jobId: j.id, rank: i + 1, score: 1 - i * 0.1, reasoning: `r${i}` })),
  modelUsed: "Qwen/Qwen2.5-7B-Instruct",
  latencyMs: 100,
})

const okJdRel = (skills: ReadonlyArray<string>): JdRelOutput => {
  const weights: Record<string, number> = {}
  for (const s of skills) weights[s.trim().toLowerCase().replace(/\s+/g, "_")] = 0.7
  return { weights, modelUsed: "qwen-7b" }
}

function baseDeps(overrides: Partial<RerankDeps> & { store: RerankStore }): RerankDeps {
  return {
    store: overrides.store,
    llmRerankImpl: overrides.llmRerankImpl ?? (async (input) => okRerank(input.jobs)),
    computeJdRelImpl:
      overrides.computeJdRelImpl ??
      (async (skills) => okJdRel(skills)),
    now: overrides.now ?? (() => NOW),
    userConcurrency: overrides.userConcurrency ?? 5,
    jdrelConcurrency: overrides.jdrelConcurrency ?? 3,
    topNForJdrel: overrides.topNForJdrel ?? 10,
    candidatePoolSize: overrides.candidatePoolSize ?? 50,
    skipIfFresherThanMs: overrides.skipIfFresherThanMs ?? 23 * 3600 * 1000,
    log: overrides.log ?? (() => {}),
    errorLog: overrides.errorLog ?? (() => {}),
  }
}

// ---------------------------------------------------------------------------
// processOneUser
// ---------------------------------------------------------------------------

describe("processOneUser", () => {
  it("skips when rerank cache <23h old", async () => {
    const fake = makeFakeStore({
      rerankCache: { u1: { computedAt: hoursAgo(5) } },
    })
    const counters = emptyCounters()
    await processOneUser("u1", { targetRoleFunction: ["x"], skills: [] }, counters, baseDeps({ store: fake.store }))
    assert.equal(counters.skippedFresh, 1)
    assert.equal(counters.processed, 0)
    assert.equal(fake.rerankWrites.length, 0)
  })

  it("processes when cache stale (>23h)", async () => {
    const fake = makeFakeStore({
      rerankCache: { u1: { computedAt: hoursAgo(48) } },
      candidatesByRole: () => [
        { id: "j1", roleTitle: "r1", companyName: "c1", requiredSkills: ["python"] },
        { id: "j2", roleTitle: "r2", companyName: "c2", requiredSkills: ["python"] },
      ],
    })
    const counters = emptyCounters()
    await processOneUser(
      "u1",
      { targetRoleFunction: ["software_engineering"], skills: ["python"] },
      counters,
      baseDeps({ store: fake.store })
    )
    assert.equal(counters.skippedFresh, 0)
    assert.equal(counters.processed, 1)
    assert.equal(fake.rerankWrites.length, 1)
  })

  it("skips when no targetRoleFunction", async () => {
    const fake = makeFakeStore()
    const counters = emptyCounters()
    await processOneUser("u1", { skills: [] }, counters, baseDeps({ store: fake.store }))
    assert.equal(counters.skippedNoCandidates, 1)
    assert.equal(fake.fetchCandidatesCalls(), 0)
  })

  it("skips when candidate pool is empty", async () => {
    const fake = makeFakeStore({ candidatesByRole: () => [] })
    const counters = emptyCounters()
    await processOneUser("u1", { targetRoleFunction: ["x"], skills: [] }, counters, baseDeps({ store: fake.store }))
    assert.equal(counters.skippedNoCandidates, 1)
    assert.equal(fake.rerankWrites.length, 0)
  })

  it("writes rerank cache with correct shape", async () => {
    const fake = makeFakeStore({
      candidatesByRole: () => [
        { id: "j1", roleTitle: "r1", companyName: "c1", requiredSkills: ["python"] },
      ],
    })
    const counters = emptyCounters()
    await processOneUser(
      "u1",
      { targetRoleFunction: ["software_engineering"], skills: ["python"] },
      counters,
      baseDeps({ store: fake.store })
    )
    assert.equal(fake.rerankWrites.length, 1)
    const payload = fake.rerankWrites[0]!.payload as {
      ranked: Array<{ jobId: string; llmScore: number; reasoning: string }>
      computedAt: string
      modelUsed: string
      candidatePoolSize: number
    }
    assert.equal(payload.ranked.length, 1)
    assert.equal(payload.ranked[0]!.jobId, "j1")
    assert.equal(payload.candidatePoolSize, 1)
    assert.equal(typeof payload.computedAt, "string")
    assert.match(payload.computedAt, /^\d{4}-/)
  })

  it("writes JD-rel cache for top-N only (limited by topNForJdrel)", async () => {
    const fake = makeFakeStore({
      candidatesByRole: () =>
        Array.from({ length: 15 }, (_, i) => ({
          id: `j${i}`,
          roleTitle: `r${i}`,
          companyName: `c${i}`,
          requiredSkills: ["python"],
        })),
    })
    const counters = emptyCounters()
    await processOneUser(
      "u1",
      { targetRoleFunction: ["x"], skills: ["python"] },
      counters,
      baseDeps({ store: fake.store, topNForJdrel: 5 })
    )
    assert.equal(counters.processed, 1)
    assert.equal(counters.jdrelComputed, 5)
    assert.equal(fake.jdrelWrites.length, 5)
  })

  it("skips JD-rel when user has no skills", async () => {
    const fake = makeFakeStore({
      candidatesByRole: () => [{ id: "j1", roleTitle: "r1", companyName: "c1" }],
    })
    const counters = emptyCounters()
    await processOneUser("u1", { targetRoleFunction: ["x"], skills: [] }, counters, baseDeps({ store: fake.store }))
    assert.equal(counters.processed, 1)
    assert.equal(counters.jdrelComputed, 0)
    assert.equal(fake.jdrelWrites.length, 0)
  })

  it("JD-rel error → counter bumped, other JDs continue", async () => {
    const fake = makeFakeStore({
      candidatesByRole: () =>
        [
          { id: "j1", roleTitle: "r1", companyName: "c1", requiredSkills: ["python"] },
          { id: "j2", roleTitle: "r2", companyName: "c2", requiredSkills: ["python"] },
          { id: "j3", roleTitle: "r3", companyName: "c3", requiredSkills: ["python"] },
        ],
    })
    let calls = 0
    const counters = emptyCounters()
    await processOneUser(
      "u1",
      { targetRoleFunction: ["x"], skills: ["python"] },
      counters,
      baseDeps({
        store: fake.store,
        computeJdRelImpl: async (skills) => {
          calls++
          if (calls === 2) throw new Error("transient")
          return okJdRel(skills)
        },
      })
    )
    // 2 succeeded, 1 errored
    assert.equal(counters.jdrelComputed, 2)
    assert.equal(counters.jdrelErrored, 1)
    // rerank cache still written
    assert.equal(fake.rerankWrites.length, 1)
  })

  it("rerank impl error → counter bumped, no cache write", async () => {
    const fake = makeFakeStore({
      candidatesByRole: () => [{ id: "j1", roleTitle: "r", companyName: "c" }],
    })
    const counters = emptyCounters()
    await processOneUser(
      "u1",
      { targetRoleFunction: ["x"], skills: [] },
      counters,
      baseDeps({
        store: fake.store,
        llmRerankImpl: async () => {
          throw new Error("rerank boom")
        },
      })
    )
    assert.equal(counters.errored, 1)
    assert.equal(counters.processed, 0)
    assert.equal(fake.rerankWrites.length, 0)
  })

  it("candidate fetch error → counter bumped", async () => {
    const fake = {
      ...makeFakeStore(),
    }
    fake.store.fetchCandidateJobs = async () => {
      throw new Error("firestore boom")
    }
    const counters = emptyCounters()
    await processOneUser("u1", { targetRoleFunction: ["x"], skills: [] }, counters, baseDeps({ store: fake.store }))
    assert.equal(counters.errored, 1)
  })
})

// ---------------------------------------------------------------------------
// runNightlyRerank
// ---------------------------------------------------------------------------

describe("runNightlyRerank", () => {
  it("iterates only users with non-empty targetRoleFunction (delegated to fetchActiveUsers)", async () => {
    // Active users — only those returned by fetchActiveUsers are processed.
    const fake = makeFakeStore({
      users: [
        { id: "u1", tags: { targetRoleFunction: ["x"], skills: ["python"] } },
        { id: "u2", tags: { targetRoleFunction: ["y"], skills: [] } },
      ],
      candidatesByRole: () => [
        { id: "j1", roleTitle: "r", companyName: "c", requiredSkills: ["python"] },
      ],
    })
    const result = await runNightlyRerank(baseDeps({ store: fake.store }))
    assert.equal(result.counters.totalUsers, 2)
    assert.equal(result.counters.processed, 2)
  })

  it("one user errors → other users still complete", async () => {
    const fake = makeFakeStore({
      users: [
        { id: "u1", tags: { targetRoleFunction: ["x"], skills: ["python"] } },
        { id: "u2", tags: { targetRoleFunction: ["y"], skills: ["python"] } },
        { id: "u3", tags: { targetRoleFunction: ["z"], skills: ["python"] } },
      ],
      candidatesByRole: () => [{ id: "j1", roleTitle: "r", companyName: "c", requiredSkills: ["python"] }],
    })
    const result = await runNightlyRerank(
      baseDeps({
        store: fake.store,
        llmRerankImpl: async (input) => {
          // Fail user u2 by inspecting the candidate / no-op
          if (input.candidate.targetRole?.[0] === "y") throw new Error("u2 boom")
          return okRerank(input.jobs)
        },
      })
    )
    assert.equal(result.counters.totalUsers, 3)
    assert.equal(result.counters.processed, 2)
    assert.equal(result.counters.errored, 1)
  })

  it("writes audit row even when partial users fail", async () => {
    const fake = makeFakeStore({
      users: [{ id: "u1", tags: { targetRoleFunction: ["x"], skills: [] } }],
      candidatesByRole: () => [{ id: "j1", roleTitle: "r", companyName: "c" }],
    })
    await runNightlyRerank(baseDeps({ store: fake.store }))
    assert.equal(fake.audits.length, 1)
    assert.equal(fake.audits[0]!.counters.totalUsers, 1)
    assert.equal(typeof fake.audits[0]!.runAt, "string")
    assert.equal(typeof fake.audits[0]!.durationMs, "number")
  })

  it("respects user concurrency limit", async () => {
    let active = 0
    let peak = 0
    const userCount = 10
    const fake = makeFakeStore({
      users: Array.from({ length: userCount }, (_, i) => ({
        id: `u${i}`,
        tags: { targetRoleFunction: ["x"], skills: [] },
      })),
      candidatesByRole: () => [{ id: "j1", roleTitle: "r", companyName: "c" }],
    })
    const result = await runNightlyRerank(
      baseDeps({
        store: fake.store,
        userConcurrency: 3,
        llmRerankImpl: async (input) => {
          active++
          peak = Math.max(peak, active)
          await new Promise((r) => setTimeout(r, 5))
          active--
          return okRerank(input.jobs)
        },
      })
    )
    assert.equal(result.counters.processed, userCount)
    assert.ok(peak <= 3, `peak (${peak}) should not exceed userConcurrency (3)`)
  })

  it("idempotent on retry: skip-fresh prevents double work", async () => {
    const fake = makeFakeStore({
      users: [
        { id: "u1", tags: { targetRoleFunction: ["x"], skills: ["python"] } },
      ],
      candidatesByRole: () => [{ id: "j1", roleTitle: "r", companyName: "c", requiredSkills: ["python"] }],
    })
    const deps = baseDeps({ store: fake.store })
    const r1 = await runNightlyRerank(deps)
    assert.equal(r1.counters.processed, 1)
    // Run again immediately — second run should skip-fresh.
    const r2 = await runNightlyRerank(deps)
    assert.equal(r2.counters.processed, 0)
    assert.equal(r2.counters.skippedFresh, 1)
  })

  it("fetchActiveUsers throws → propagates (caller logs)", async () => {
    const fake = makeFakeStore()
    fake.store.fetchActiveUsers = async () => {
      throw new Error("users boom")
    }
    await assert.rejects(runNightlyRerank(baseDeps({ store: fake.store })), /users boom/)
  })

  it("getRerankCache throws → falls through to processing (non-fatal)", async () => {
    const fake = makeFakeStore({
      users: [{ id: "u1", tags: { targetRoleFunction: ["x"], skills: [] } }],
      candidatesByRole: () => [{ id: "j1", roleTitle: "r", companyName: "c" }],
    })
    fake.store.getRerankCache = async () => {
      throw new Error("read boom")
    }
    const result = await runNightlyRerank(baseDeps({ store: fake.store }))
    assert.equal(result.counters.processed, 1)
  })
})
