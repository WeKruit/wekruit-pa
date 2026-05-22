import assert from "node:assert/strict"
import { test } from "node:test"

// Phase 10.5 cleanup C6 — the legacy `current-info` connector registry
// entry was removed; the SDK-hosted `webSearchTool` covers live-web
// access on the default OpenAI path (gated by allowedConnectors entry
// "current-info"). The previous baseline tests in this file targeted
// connectorRegistry["current-info"] and have been deleted along with
// that entry. Hosted web_search coverage now lives in:
//   - agent-runtime/src/openai-agents-adapter.test.ts
//     (buildHostedToolsForDefault gates + extractUsage hosted-tool counting)
//   - pa-orchestrator/src/index.test.ts
//     (recordHostedToolCalls invocation on usage.hostedToolCalls)

// -------- Phase 10.5 T6: remember-fact connector tests --------

import { test as t6test } from "node:test"
import { PA_COLLECTIONS, type AgentDef } from "@pa/core-types"
import { connectorRegistry as registryForT6, runConnector } from "./index.js"

type StoredDoc = Record<string, unknown>

/**
 * Fake Firestore that implements just enough surface for:
 *   - `listConfirmedMemoryFacts` (collection().where().where().limit().get())
 *   - `createConfirmedMemoryFact` (collection().doc().set())
 *   - `recordMemoryAction` (collection().doc().set())
 *   - `runConnector` audit + tool-call writes
 */
function fakeFirestoreT6() {
  const store = new Map<string, StoredDoc>()
  function makeQuery(collectionName: string, filters: Array<[string, string, unknown]>) {
    return {
      where(field: string, op: string, value: unknown) {
        return makeQuery(collectionName, [...filters, [field, op, value]])
      },
      limit(_n: number) {
        return this
      },
      async get() {
        const docs: { data(): StoredDoc }[] = []
        for (const [key, doc] of store.entries()) {
          if (!key.startsWith(`${collectionName}/`)) continue
          let ok = true
          for (const [field, op, value] of filters) {
            if (op !== "==") {
              ok = false
              break
            }
            if ((doc as Record<string, unknown>)[field] !== value) {
              ok = false
              break
            }
          }
          if (ok) docs.push({ data: () => doc })
        }
        return { docs }
      },
    }
  }
  const db = {
    collection(collectionName: string) {
      return {
        doc(id: string) {
          return {
            async set(data: StoredDoc, opts?: { merge?: boolean }) {
              const path = `${collectionName}/${id}`
              const current = store.get(path) ?? {}
              store.set(path, opts?.merge ? { ...current, ...data } : data)
            },
            async get() {
              const data = store.get(`${collectionName}/${id}`)
              return { exists: data != null, data: () => data }
            },
          }
        },
        where(field: string, op: string, value: unknown) {
          return makeQuery(collectionName, [[field, op, value]])
        },
      }
    },
    async runTransaction(fn: (tx: {
      get: (ref: { __collection: string; __id: string }) => Promise<{ exists: boolean; data: () => StoredDoc | undefined }>
      set: (
        ref: { __collection: string; __id: string },
        data: StoredDoc,
        opts?: { merge?: boolean }
      ) => void
    }) => Promise<unknown>) {
      const tx = {
        async get(ref: { __collection: string; __id: string }) {
          const data = store.get(`${ref.__collection}/${ref.__id}`)
          return { exists: data != null, data: () => data }
        },
        set(ref: { __collection: string; __id: string }, data: StoredDoc, opts?: { merge?: boolean }) {
          const path = `${ref.__collection}/${ref.__id}`
          const current = store.get(path) ?? {}
          store.set(path, opts?.merge ? { ...current, ...data } : data)
        },
      }
      return fn(tx)
    },
  }
  // Patch doc() to return a ref shape recognizable by runTransaction.
  const origCollection = db.collection.bind(db)
  db.collection = ((name: string) => {
    const col = origCollection(name)
    const origDoc = col.doc.bind(col)
    col.doc = ((id: string) => {
      const baseDoc = origDoc(id)
      return Object.assign(baseDoc, { __collection: name, __id: id })
    }) as typeof col.doc
    return col
  }) as typeof db.collection
  return { db: db as unknown as import("firebase-admin/firestore").Firestore, store }
}

const t6Agent: AgentDef = {
  id: "default",
  name: "Default",
  systemPrompt: "Be useful.",
  provider: "openai",
  model: "gpt-5.4-nano",
  status: "published",
  temperature: 0.7,
  memoryMode: "firestore_only",
  toolPolicy: "allowlist",
  allowedConnectors: ["remember-fact"],
  toolBudgetPerTurn: 3,
  version: "1",
}

t6test("remember-fact happy path writes a fact, returns factId, conflict=false", async () => {
  const { db, store } = fakeFirestoreT6()
  const ctx = { db, userId: "u1", sessionId: "s1", turnId: "t1", agent: t6Agent }
  const def = registryForT6["remember-fact"]
  const out = await def.execute({ content: "我喜欢冰美式" }, ctx)
  assert.equal(out.ok, true)
  assert.equal(out.conflict, false)
  assert.ok(out.factId, "factId set")
  // pa_memory_facts row
  const factRows = [...store.keys()].filter((k) => k.startsWith(`${PA_COLLECTIONS.memoryFacts}/`))
  assert.equal(factRows.length, 1)
  // pa_memory_actions row
  const actionRows = [...store.keys()].filter((k) => k.startsWith(`${PA_COLLECTIONS.memoryActions}/`))
  assert.equal(actionRows.length, 1)
})

t6test("remember-fact duplicate content returns conflict=true and does NOT double-write", async () => {
  const { db, store } = fakeFirestoreT6()
  const ctx = { db, userId: "u1", sessionId: "s1", turnId: "t1", agent: t6Agent }
  const def = registryForT6["remember-fact"]
  const first = await def.execute({ content: "I like cold brew" }, ctx)
  assert.equal(first.ok, true)
  assert.equal(first.conflict, false)
  const before = [...store.keys()].filter((k) => k.startsWith(`${PA_COLLECTIONS.memoryFacts}/`)).length

  const second = await def.execute({ content: "I  LIKE  cold brew" }, ctx)
  assert.equal(second.ok, true)
  assert.equal(second.conflict, true)
  assert.equal(second.factId, first.factId)
  const after = [...store.keys()].filter((k) => k.startsWith(`${PA_COLLECTIONS.memoryFacts}/`)).length
  assert.equal(after, before, "no second fact row written")
})

t6test("remember-fact rejects sensitive content with reason and does NOT write", async () => {
  const { db, store } = fakeFirestoreT6()
  const ctx = { db, userId: "u1", sessionId: "s1", turnId: "t1", agent: t6Agent }
  const def = registryForT6["remember-fact"]
  const out = await def.execute({ content: "my api key is sk-abc123def456" }, ctx)
  assert.equal(out.ok, false)
  assert.ok(out.reason, "reason returned for LLM apology")
  assert.equal(
    [...store.keys()].filter((k) => k.startsWith(`${PA_COLLECTIONS.memoryFacts}/`)).length,
    0
  )
})

t6test("remember-fact schema rejects empty content and over-length content", async () => {
  const def = registryForT6["remember-fact"]
  assert.throws(() => def.inputSchema.parse({ content: "" }))
  assert.throws(() => def.inputSchema.parse({ content: "x".repeat(600) }))
  // Sane shape passes.
  def.inputSchema.parse({ content: "hi" })
})

t6test("remember-fact via runConnector writes audit pa_tool_calls with allow + completed", async () => {
  const { db, store } = fakeFirestoreT6()
  const out = await runConnector(
    "remember-fact",
    { content: "我有一只柴犬" },
    { db, agent: t6Agent, turnId: "turn-T6", userId: "u1", sessionId: "s1", usedThisTurn: 0 }
  )
  assert.ok(typeof out === "object" && out && (out as { ok: boolean }).ok)
  // pa_tool_calls row was written by runConnector.
  const toolCallEntries = [...store.entries()].filter(([k]) =>
    k.startsWith(`${PA_COLLECTIONS.toolCalls}/`)
  )
  assert.equal(toolCallEntries.length, 1)
  const row = toolCallEntries[0]![1] as Record<string, unknown>
  assert.equal(row.connectorName, "remember-fact")
  assert.equal(row.policyDecision, "allow")
  assert.equal(row.status, "completed")
  // pa_audit_events should have started + completed entries
  const auditCount = [...store.keys()].filter((k) =>
    k.startsWith(`${PA_COLLECTIONS.auditEvents}/`)
  ).length
  assert.equal(auditCount, 2)
})

t6test("set-matching-preferences via runConnector persists H1B hard constraint with tool audit", async () => {
  const { db, store } = fakeFirestoreT6()
  const agent: AgentDef = {
    ...t6Agent,
    allowedConnectors: ["set-matching-preferences"],
  }

  const out = await runConnector(
    "set-matching-preferences" as never,
    {
      visaStatus: "sponsor_needed",
      targetLocations: ["San Francisco", "remote_us"],
      targetCountry: ["usa"],
      roleFocus: ["software_engineering"],
      careerStage: "junior",
      companyStage: null,
      jobType: ["full_time"],
      negativeCompanies: ["OpenAI"],
      negativeRoleFunctions: ["customer_service_and_support"],
      constraintStrength: "hard",
      evidenceText: "Yes I need H1B support, do you have more?",
      source: "agentic_find_match_router",
    },
    { db, agent, turnId: "turn-pref", userId: "u1", sessionId: "s1", usedThisTurn: 0 },
  ) as { ok?: boolean; hardConstraint?: boolean }

  assert.equal(out.ok, true)
  assert.equal(out.hardConstraint, true)

  const user = store.get("pa-users/u1") as Record<string, unknown> | undefined
  assert.ok(user, "pa-users row written")
  const tags = user.tags as Record<string, unknown>
  assert.equal(tags.visaStatus, "sponsor_needed")
  assert.deepEqual(tags.targetLocations, ["San Francisco", "remote_us"])
  assert.deepEqual(tags.targetCountry, ["usa"])
  assert.equal(tags.careerStage, "junior")
  assert.deepEqual(tags.companyNegativeList, ["OpenAI"])
  assert.deepEqual(tags.roleFunctionNegativeList, ["customer_service_and_support"])
  const prefs = user.conversationDerivedPreferences as Record<string, unknown>
  const matchingProfile = prefs.matchingProfile as Record<string, unknown>
  const last = matchingProfile.last as Record<string, unknown>
  assert.equal(last.visaStatus, "sponsor_needed")
  assert.deepEqual(last.targetCountry, ["usa"])
  assert.equal(last.careerStage, "junior")
  assert.deepEqual(last.negativeRoleFunctions, ["customer_service_and_support"])
  assert.equal(last.constraintStrength, "hard")

  const toolCallEntries = [...store.entries()].filter(([k]) =>
    k.startsWith(`${PA_COLLECTIONS.toolCalls}/`)
  )
  assert.equal(toolCallEntries.length, 1)
  const row = toolCallEntries[0]![1] as Record<string, unknown>
  assert.equal(row.connectorName, "set-matching-preferences")
  assert.equal(row.status, "completed")
})

t6test("set-daily-job-recommendation-subscription via runConnector persists opt-in state with tool audit", async () => {
  const { db, store } = fakeFirestoreT6()
  const agent: AgentDef = {
    ...t6Agent,
    allowedConnectors: ["set-daily-job-recommendation-subscription"],
  }

  const out = await runConnector(
    "set-daily-job-recommendation-subscription" as never,
    {
      optedIn: true,
      consentText: "yes please",
      source: "post_match_retention",
      lang: "en",
    },
    { db, agent, turnId: "turn-sub", userId: "u1", sessionId: "s1", usedThisTurn: 0 },
  ) as { ok?: boolean; optedIn?: boolean; jobProfileStatus?: string }

  assert.equal(out.ok, true)
  assert.equal(out.optedIn, true)
  assert.equal(out.jobProfileStatus, "active")

  const user = store.get("pa-users/u1") as Record<string, unknown> | undefined
  assert.ok(user, "pa-users row written")
  assert.deepEqual(
    (user.dailyJobRecSubscribe as Record<string, unknown> | undefined)?.optedIn,
    true,
  )
  const profile = store.get("pa-job-profiles/u1") as Record<string, unknown> | undefined
  assert.equal(profile?.status, "active")

  const toolCallEntries = [...store.entries()].filter(([k]) =>
    k.startsWith(`${PA_COLLECTIONS.toolCalls}/`)
  )
  assert.equal(toolCallEntries.length, 1)
  const row = toolCallEntries[0]![1] as Record<string, unknown>
  assert.equal(row.connectorName, "set-daily-job-recommendation-subscription")
  assert.equal(row.status, "completed")
})

// -------- Phase 13 T13.1: wekruit-matching connector tests --------
//
// Exhaustive coverage of:
//   1. degraded mode when PA_MATCHING_URL unset
//   2. PA_MATCHING_DISABLED override even when URL set
//   3. happy path with roles, summary mentions count
//   4. backend 500 retries once then surfaces backend_5xx
//   5. backend 400 does NOT retry; surfaces backend_4xx
//   6. backend timeout (AbortError) retries once then surfaces backend_timeout
//   7. malformed JSON payload → backend_payload_invalid
//   8. POST body shape: {userId, query, filters} (no mem0UserId)
//
// Per Phase 13 plan §3 13.1. Uses the global `fetch` mock pattern for
// determinism. Ground rule: connector NEVER throws inside execute.


const matchingDef = registryForT6["wekruit-matching"]

const matchingCtxBase = {
  // db is unused by the matching connector but ConnectorContext requires it.
  db: {} as unknown as import("firebase-admin/firestore").Firestore,
  agent: t6Agent,
  turnId: "turn-13",
  userId: "u-13",
  sessionId: "s-13",
}

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(overrides)) {
    prev[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  return Promise.resolve(fn()).finally(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })
}

function withFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const prev = globalThis.fetch
  globalThis.fetch = impl
  return Promise.resolve(fn()).finally(() => {
    globalThis.fetch = prev
  })
}

test("wekruit-matching: degraded mode when PA_MATCHING_URL unset (no fetch issued)", async () => {
  let calls = 0
  await withFetch(
    (async () => {
      calls++
      throw new Error("fetch should not be called")
    }) as unknown as typeof fetch,
    () =>
      withEnv({ PA_MATCHING_URL: undefined, PA_MATCHING_DISABLED: undefined }, async () => {
        const out = await matchingDef.execute(
          { query: "找前端", filters: null },
          matchingCtxBase
        )
        assert.equal(out.ok, false)
        assert.equal(out.source, "wekruit-matching")
        assert.equal(out.reason, "matching_service_not_configured")
        assert.match(out.summary, /暂时|稍后/)
        assert.equal(out.roles, null)
      })
  )
  assert.equal(calls, 0, "no fetch issued in degraded mode")
})

test("wekruit-matching: PA_MATCHING_DISABLED=true overrides PA_MATCHING_URL", async () => {
  let calls = 0
  await withFetch(
    (async () => {
      calls++
      throw new Error("fetch should not be called")
    }) as unknown as typeof fetch,
    () =>
      withEnv(
        { PA_MATCHING_URL: "https://example.test/match", PA_MATCHING_DISABLED: "true" },
        async () => {
          const out = await matchingDef.execute(
            { query: "找前端", filters: null },
            matchingCtxBase
          )
          assert.equal(out.ok, false)
          assert.equal(out.reason, "matching_service_disabled")
          assert.equal(out.roles, null)
        }
      )
  )
  assert.equal(calls, 0)
})

test("wekruit-matching: happy path returns ok=true with roles and summary mentions count", async () => {
  const fakeRoles = [
    {
      roleId: "r1",
      title: "前端工程师",
      company: "WeKruit",
      fitScore: 0.92,
      applyUrl: "https://example.test/apply/r1",
      summary: "Hangzhou frontend role",
    },
    {
      roleId: "r2",
      title: "全栈工程师",
      company: "Acme",
      fitScore: 0.81,
      applyUrl: null,
      summary: "Remote ok",
    },
  ]
  const mockFetch = (async (_input: unknown, _init: unknown) => {
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ roles: fakeRoles }),
    } as unknown as Response
  }) as unknown as typeof fetch
  await withFetch(mockFetch, () =>
    withEnv({ PA_MATCHING_URL: "https://example.test/match", PA_MATCHING_DISABLED: undefined }, async () => {
      const out = await matchingDef.execute(
        { query: "杭州前端2年", filters: { location: "Hangzhou", roleType: "frontend", seniority: null } },
        matchingCtxBase
      )
      assert.equal(out.ok, true)
      assert.equal(out.reason, null)
      assert.match(out.summary, /匹配到 2 个岗位/)
      assert.match(out.summary, /前端工程师/)
      assert.ok(Array.isArray(out.roles))
      assert.equal(out.roles!.length, 2)
      assert.equal(out.roles![0]!.fitScore, 0.92)
      assert.equal(out.roles![1]!.applyUrl, null)
    })
  )
})

test("wekruit-matching: clamps roles to max 5", async () => {
  const fakeRoles = Array.from({ length: 8 }, (_, i) => ({
    roleId: `r${i}`,
    title: `Role ${i}`,
    company: "Co",
    fitScore: 0.5,
    applyUrl: null,
    summary: "x",
  }))
  await withFetch(
    (async () =>
      ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ roles: fakeRoles }),
      } as unknown as Response)) as unknown as typeof fetch,
    () =>
      withEnv({ PA_MATCHING_URL: "https://example.test/match", PA_MATCHING_DISABLED: undefined }, async () => {
        const out = await matchingDef.execute(
          { query: "anything", filters: null },
          matchingCtxBase
        )
        assert.equal(out.ok, true)
        assert.equal(out.roles!.length, 5, "clamped to 5")
      })
  )
})

test("wekruit-matching: backend 500 retries ONCE then surfaces backend_5xx", async () => {
  let calls = 0
  await withFetch(
    (async () => {
      calls++
      return {
        ok: false,
        status: 500,
        text: async () => "internal server error",
      } as unknown as Response
    }) as unknown as typeof fetch,
    () =>
      withEnv({ PA_MATCHING_URL: "https://example.test/match", PA_MATCHING_DISABLED: undefined }, async () => {
        const out = await matchingDef.execute(
          { query: "x", filters: null },
          matchingCtxBase
        )
        assert.equal(out.ok, false)
        assert.equal(out.reason, "backend_5xx")
        assert.equal(out.roles, null)
      })
  )
  assert.equal(calls, 2, "fetch invoked twice (initial + 1 retry)")
})

test("wekruit-matching: backend 400 does NOT retry; surfaces backend_4xx", async () => {
  let calls = 0
  await withFetch(
    (async () => {
      calls++
      return {
        ok: false,
        status: 400,
        text: async () => "bad request",
      } as unknown as Response
    }) as unknown as typeof fetch,
    () =>
      withEnv({ PA_MATCHING_URL: "https://example.test/match", PA_MATCHING_DISABLED: undefined }, async () => {
        const out = await matchingDef.execute(
          { query: "x", filters: null },
          matchingCtxBase
        )
        assert.equal(out.ok, false)
        assert.equal(out.reason, "backend_4xx")
      })
  )
  assert.equal(calls, 1, "no retry on 4xx")
})

test("wekruit-matching: AbortError retries once then surfaces backend_timeout", async () => {
  let calls = 0
  await withFetch(
    (async (_url: unknown, init: { signal?: AbortSignal } | undefined) => {
      calls++
      // Synthesize an AbortError as if the timer fired.
      const err = new Error("aborted") as Error & { name: string }
      err.name = "AbortError"
      // Honor abort signal if it's already aborted (defensive); we just throw.
      void init?.signal
      throw err
    }) as unknown as typeof fetch,
    () =>
      withEnv({ PA_MATCHING_URL: "https://example.test/match", PA_MATCHING_DISABLED: undefined }, async () => {
        const out = await matchingDef.execute(
          { query: "x", filters: null },
          matchingCtxBase
        )
        assert.equal(out.ok, false)
        assert.equal(out.reason, "backend_timeout")
      })
  )
  assert.equal(calls, 2)
})

test("wekruit-matching: malformed JSON payload → backend_payload_invalid", async () => {
  await withFetch(
    (async () =>
      ({
        ok: true,
        status: 200,
        text: async () => "<html>not json</html>",
      } as unknown as Response)) as unknown as typeof fetch,
    () =>
      withEnv({ PA_MATCHING_URL: "https://example.test/match", PA_MATCHING_DISABLED: undefined }, async () => {
        const out = await matchingDef.execute(
          { query: "x", filters: null },
          matchingCtxBase
        )
        assert.equal(out.ok, false)
        assert.equal(out.reason, "backend_payload_invalid")
      })
  )
})

test("wekruit-matching: POST body includes {userId, query, filters} and never mem0UserId", async () => {
  type Captured = { url: unknown; init: RequestInit | undefined }
  let captured: Captured | null = null
  await withFetch(
    (async (url: unknown, init: RequestInit | undefined) => {
      captured = { url, init }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ roles: [] }),
      } as unknown as Response
    }) as unknown as typeof fetch,
    () =>
      withEnv(
        {
          PA_MATCHING_URL: "https://example.test/match",
          PA_MATCHING_DISABLED: undefined,
          PA_MATCHING_TOKEN: "tok-secret",
        },
        async () => {
          await matchingDef.execute(
            {
              query: "找前端",
              filters: { location: "Hangzhou", roleType: "frontend", seniority: "junior" },
            },
            { ...matchingCtxBase, userId: "u-canonical" }
          )
        }
      )
  )
  assert.ok(captured, "fetch invoked")
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const cap = captured as Captured
  assert.equal(cap.url, "https://example.test/match")
  const body = JSON.parse(String(cap.init?.body))
  assert.equal(body.userId, "u-canonical")
  assert.equal(body.query, "找前端")
  assert.equal(body.filters.location, "Hangzhou")
  assert.equal(body.filters.roleType, "frontend")
  assert.equal(body.filters.seniority, "junior")
  // Identity contract red line: no mem0UserId in payload.
  assert.equal("mem0UserId" in body, false)
  // Auth header carries the token but body does not.
  const headers = cap.init?.headers as Record<string, string> | undefined
  assert.equal(headers?.["Authorization"], "Bearer tok-secret")
  assert.equal(String(cap.init?.body).includes("tok-secret"), false)
})

test("wekruit-matching: input schema rejects empty query and over-length query", () => {
  assert.throws(() => matchingDef.inputSchema.parse({ query: "", filters: null }))
  assert.throws(() => matchingDef.inputSchema.parse({ query: "x".repeat(600), filters: null }))
  // Sane shape passes.
  matchingDef.inputSchema.parse({
    query: "ok",
    filters: { location: null, roleType: null, seniority: null },
  })
  matchingDef.inputSchema.parse({ query: "ok", filters: null })
})

test("wekruit-matching: input schema requires every key in filters when filters is provided", () => {
  // Per Phase 10.5 hot-fix #4: every property in `required`. Missing
  // a nested key is a validation error (NOT silently filled with null).
  assert.throws(() =>
    matchingDef.inputSchema.parse({
      query: "x",
      // location and roleType present, seniority missing — must throw
      filters: { location: null, roleType: null } as unknown as {
        location: string | null
        roleType: string | null
        seniority: string | null
      },
    })
  )
})

test("wekruit-matching: input schema requires `filters` key (not optional)", () => {
  assert.throws(() =>
    matchingDef.inputSchema.parse({ query: "x" } as unknown as { query: string })
  )
})

test("wekruit-matching: connector NEVER throws inside execute (every path resolves)", async () => {
  // Network error path
  await withFetch(
    (async () => {
      throw new TypeError("connect ECONNREFUSED")
    }) as unknown as typeof fetch,
    () =>
      withEnv({ PA_MATCHING_URL: "https://example.test/match", PA_MATCHING_DISABLED: undefined }, async () => {
        const out = await matchingDef.execute(
          { query: "x", filters: null },
          matchingCtxBase
        )
        assert.equal(out.ok, false)
        assert.equal(out.reason, "backend_network_error")
      })
  )
})

// -------- Stream F4: save-job-profile connector tests --------

const saveJobAgent: AgentDef = {
  ...t6Agent,
  allowedConnectors: ["save-job-profile"],
}

t6test("save-job-profile happy path: writes pa-job-profiles/{userId} with status=active", async () => {
  const { db, store } = fakeFirestoreT6()
  const def = registryForT6["save-job-profile"]
  const ctx = { db, userId: "user_alice", sessionId: "s1", turnId: "t1", agent: saveJobAgent }
  const out = await def.execute(
    {
      industryTags: ["fintech_finance", "ai_ml"],
      sponsorshipNeeded: "H1B",
      locationPreference: "湾区",
      sizePreference: "startup",
      salaryMin: null,
    },
    ctx
  )
  assert.equal(out.ok, true)
  const row = store.get("pa-job-profiles/user_alice") as Record<string, unknown> | undefined
  assert.ok(row, "pa-job-profiles row written")
  assert.equal(row!.userId, "user_alice")
  assert.equal(row!.status, "active")
  const profile = row!.profile as Record<string, unknown>
  assert.deepEqual(profile.industryTags, ["fintech_finance", "ai_ml"])
  assert.equal(profile.sponsorshipNeeded, "H1B")
  assert.equal(profile.locationPreference, "湾区")
  assert.equal(profile.sizePreference, "startup")
  assert.equal(profile.salaryMin, null)
  assert.ok(typeof row!.createdAt === "string")
  assert.ok(typeof row!.updatedAt === "string")
})

t6test("save-job-profile re-save merges: createdAt preserved, updatedAt bumps, status stays active", async () => {
  const { db, store } = fakeFirestoreT6()
  const def = registryForT6["save-job-profile"]
  const ctx = { db, userId: "user_bob", sessionId: "s1", turnId: "t1", agent: saveJobAgent }
  const first = await def.execute(
    {
      industryTags: ["tech_software"],
      sponsorshipNeeded: "none",
      locationPreference: "remote",
      sizePreference: "any",
      salaryMin: 150000,
    },
    ctx
  )
  assert.equal(first.ok, true)
  const before = store.get("pa-job-profiles/user_bob") as Record<string, unknown>
  const createdAtBefore = before.createdAt as string
  // Sleep 5ms to ensure new timestamp is monotonically later.
  await new Promise((r) => setTimeout(r, 5))
  const second = await def.execute(
    {
      industryTags: ["tech_software", "fintech_finance"],
      sponsorshipNeeded: "H1B",
      locationPreference: "NYC",
      sizePreference: "big",
      salaryMin: 200000,
    },
    ctx
  )
  assert.equal(second.ok, true)
  const after = store.get("pa-job-profiles/user_bob") as Record<string, unknown>
  assert.equal(after.createdAt, createdAtBefore, "createdAt MUST be preserved across re-saves")
  assert.notEqual(after.updatedAt, before.updatedAt, "updatedAt MUST advance")
  assert.equal(after.status, "active")
  const profile = after.profile as Record<string, unknown>
  assert.deepEqual(profile.industryTags, ["tech_software", "fintech_finance"])
  assert.equal(profile.salaryMin, 200000)
})

t6test("save-job-profile preserves operator-paused status across re-save", async () => {
  const { db, store } = fakeFirestoreT6()
  const def = registryForT6["save-job-profile"]
  const ctx = { db, userId: "user_paused", sessionId: "s1", turnId: "t1", agent: saveJobAgent }
  // Pre-seed the doc as paused (operator action).
  store.set("pa-job-profiles/user_paused", {
    userId: "user_paused",
    status: "paused",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    profile: {
      industryTags: ["other"],
      sponsorshipNeeded: "none",
      locationPreference: "anywhere",
      sizePreference: "any",
      salaryMin: null,
    },
  })
  const out = await def.execute(
    {
      industryTags: ["tech_software"],
      sponsorshipNeeded: "H1B",
      locationPreference: "湾区",
      sizePreference: "startup",
      salaryMin: null,
    },
    ctx
  )
  assert.equal(out.ok, true)
  const row = store.get("pa-job-profiles/user_paused") as Record<string, unknown>
  assert.equal(row.status, "paused", "operator-paused status must be sticky")
})

t6test("save-job-profile schema rejects empty industryTags + invalid sponsorship", async () => {
  const def = registryForT6["save-job-profile"]
  // Empty tags array
  assert.throws(() =>
    def.inputSchema.parse({
      industryTags: [],
      sponsorshipNeeded: "H1B",
      locationPreference: "SF",
      sizePreference: "any",
      salaryMin: null,
    })
  )
  // Bogus sponsorship enum value
  assert.throws(() =>
    def.inputSchema.parse({
      industryTags: ["tech_software"],
      sponsorshipNeeded: "TN",
      locationPreference: "SF",
      sizePreference: "any",
      salaryMin: null,
    })
  )
  // Sane shape passes
  def.inputSchema.parse({
    industryTags: ["tech_software"],
    sponsorshipNeeded: "H1B",
    locationPreference: "SF",
    sizePreference: "any",
    salaryMin: null,
  })
})
