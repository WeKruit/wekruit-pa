import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { connectorRegistry } from "./index.js"

const originalFetch = globalThis.fetch
const originalOpenAiApiKey = process.env.OPENAI_API_KEY
const originalPaOpenAiAgentApiKey = process.env.PA_OPENAI_AGENT_API_KEY
const originalOpenAiBaseUrl = process.env.OPENAI_BASE_URL
const currentInfo = connectorRegistry["current-info"]

afterEach(() => {
  globalThis.fetch = originalFetch
  for (const [key, value] of [
    ["OPENAI_API_KEY", originalOpenAiApiKey],
    ["PA_OPENAI_AGENT_API_KEY", originalPaOpenAiAgentApiKey],
    ["OPENAI_BASE_URL", originalOpenAiBaseUrl],
  ] as const) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  delete process.env.PA_OPENAI_AGENT_MODEL
})

test("current-info returns ok false without PA_OPENAI_AGENT_API_KEY and does not call fetch", async () => {
  delete process.env.PA_OPENAI_AGENT_API_KEY
  let fetchCalls = 0
  globalThis.fetch = (async () => {
    fetchCalls++
    throw new Error("should not call fetch")
  }) as typeof fetch

  const result = await currentInfo.execute(
    { query: "latest movie news", nowIso: "2026-04-26T12:00:00.000Z" }
  )

  assert.equal(fetchCalls, 0)
  assert.equal(result.ok, false)
  assert.equal(result.source, "openai-web-search")
  assert.equal(result.asOf, "2026-04-26T12:00:00.000Z")
  assert.match(result.summary, /PA_OPENAI_AGENT_API_KEY is not configured/)
  assert.deepEqual(result.sources, [])
})

test("current-info ignores global OPENAI_API_KEY when it is a SiliconFlow alias", async () => {
  process.env.OPENAI_API_KEY = "siliconflow-key"
  process.env.OPENAI_BASE_URL = "https://api.siliconflow.cn/v1"
  delete process.env.PA_OPENAI_AGENT_API_KEY
  let fetchCalls = 0
  globalThis.fetch = (async () => {
    fetchCalls++
    throw new Error("should not call fetch")
  }) as typeof fetch

  const result = await currentInfo.execute(
    { query: "latest movie news", nowIso: "2026-04-26T12:00:00.000Z" }
  )

  assert.equal(fetchCalls, 0)
  assert.equal(result.ok, false)
  assert.match(result.summary, /PA_OPENAI_AGENT_API_KEY is not configured/)
})

test("current-info calls Agents SDK hosted web_search and extracts citations", async () => {
  process.env.OPENAI_API_KEY = "siliconflow-key"
  process.env.OPENAI_BASE_URL = "https://api.siliconflow.cn/v1"
  process.env.PA_OPENAI_AGENT_API_KEY = "test-key"
  process.env.PA_OPENAI_AGENT_MODEL = "test-model"
  let requestBody: Record<string, unknown> | null = null
  let authorization = ""
  globalThis.fetch = (async (_url, init) => {
    authorization = new Headers(init?.headers).get("authorization") ?? ""
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response(
      JSON.stringify({
        id: "resp_test",
        object: "response",
        created_at: 1777224000,
        status: "completed",
        model: "test-model",
        output: [
          {
            type: "web_search_call",
            id: "ws_test",
            status: "completed",
            action: {
              type: "search",
              query: "what is current",
              sources: [{ title: "Example B", url: "https://example.com/b" }],
            },
          },
          {
            type: "message",
            id: "msg_test",
            status: "completed",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "Fresh sourced answer.",
                annotations: [
                  { type: "url_citation", title: "Example A", url: "https://example.com/a" },
                ],
              },
            ],
          },
        ],
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )
  }) as typeof fetch

  const result = await currentInfo.execute(
    {
      query: "what is current",
      nowIso: "2026-04-26T12:00:00.000Z",
      locale: "en-US",
      location: "Chicago, IL",
    }
  )

  assert.equal(authorization, "Bearer test-key")
  assert.ok(requestBody)
  const body = requestBody as Record<string, unknown>
  assert.equal(body.model, "test-model")
  assert.deepEqual(body.tools, [{ type: "web_search", search_context_size: "low", external_web_access: true }])
  assert.deepEqual(body.tool_choice, { type: "web_search" })
  assert.equal(result.ok, true)
  assert.equal(result.summary, "Fresh sourced answer.")
  assert.deepEqual(result.sources, [
    { title: "Example B", url: "https://example.com/b" },
    { title: "Example A", url: "https://example.com/a" },
  ])
})

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
  }
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
