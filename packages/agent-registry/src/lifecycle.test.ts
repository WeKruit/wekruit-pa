import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS, type AgentDef } from "@pa/core-types"
import { buildAgentSystemPrompt, publishAgentVersion, rollbackAgentVersion, setDefaultAgent } from "./lifecycle.js"

type QueryFilter = { field: string; op: string; value: unknown }

function fakeFirestore(seed: Record<string, Record<string, Record<string, unknown>>>) {
  const store = new Map(Object.entries(seed).map(([name, docs]) => [name, new Map(Object.entries(docs))]))
  const collectionMap = (name: string) => {
    let rows = store.get(name)
    if (!rows) {
      rows = new Map()
      store.set(name, rows)
    }
    return rows
  }
  const docRef = (collectionName: string, id: string) => ({
    id,
    async get() {
      const data = collectionMap(collectionName).get(id)
      return { id, exists: data != null, data: () => data }
    },
    async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
      const current = collectionMap(collectionName).get(id) ?? {}
      collectionMap(collectionName).set(id, opts?.merge ? { ...current, ...data } : { ...data })
    },
  })
  const db = {
    collection(collectionName: string) {
      const query = {
        filters: [] as QueryFilter[],
        max: Infinity,
        where(field: string, op: string, value: unknown) {
          this.filters.push({ field, op, value })
          return this
        },
        limit(n: number) {
          this.max = n
          return this
        },
        doc(id: string) {
          return docRef(collectionName, id)
        },
        async get() {
          const rows = [...collectionMap(collectionName).entries()].filter(([, data]) =>
            this.filters.every((f) => {
              if (f.op !== "==") throw new Error(`unsupported op ${f.op}`)
              return data[f.field] === f.value
            })
          )
          return {
            empty: rows.length === 0,
            docs: rows.slice(0, this.max).map(([id, data]) => ({ id, data: () => data })),
          }
        },
      }
      return query
    },
  }
  return { db: db as unknown as Firestore, store }
}

function agent(id: string, patch: Partial<AgentDef> = {}): AgentDef {
  return {
    id,
    name: id,
    systemPrompt: "Base prompt.",
    provider: "openai",
    model: "gpt-4o-mini",
    temperature: 0.7,
    version: "1",
    status: "published",
    memoryMode: "firestore_only",
    toolPolicy: "none",
    ...patch,
  }
}

test("setDefaultAgent enforces a single default and blocks failed model probes", async () => {
  const { db, store } = fakeFirestore({
    [PA_COLLECTIONS.agents]: {
      old: agent("old", { isDefault: true }) as unknown as Record<string, unknown>,
      next: agent("next") as unknown as Record<string, unknown>,
      bad: agent("bad", { modelProbe: { status: "failed", error: "404" } }) as unknown as Record<string, unknown>,
    },
  })

  await setDefaultAgent(db, "next")

  assert.equal(store.get(PA_COLLECTIONS.agents)?.get("old")?.isDefault, false)
  assert.equal(store.get(PA_COLLECTIONS.agents)?.get("next")?.isDefault, true)
  await assert.rejects(() => setDefaultAgent(db, "bad"), /model probe failed/)
})

test("publish and rollback agent versions snapshot runtime config", async () => {
  const { db, store } = fakeFirestore({
    [PA_COLLECTIONS.agents]: {
      default: agent("default", { systemPrompt: "Published prompt.", version: "1" }) as unknown as Record<string, unknown>,
    },
  })

  const version = await publishAgentVersion(db, "default", "tester")
  await db.collection(PA_COLLECTIONS.agents).doc("default").set({ systemPrompt: "Broken draft." }, { merge: true })
  await rollbackAgentVersion(db, "default", version, "tester")

  assert.equal(version, "2")
  assert.equal(store.get(PA_COLLECTIONS.agents)?.get("default")?.systemPrompt, "Published prompt.")
  assert.equal(store.get(PA_COLLECTIONS.agentVersions)?.has("default_v2"), true)
})

test("buildAgentSystemPrompt composes explicit persona controls", () => {
  const prompt = buildAgentSystemPrompt(
    agent("persona", {
      persona: {
        tone: "warm and direct",
        style: ["concise", "operator-safe"],
        boundaries: ["Do not invent tool results."],
        goals: ["Reduce operator toil."],
      },
    })
  )

  assert.match(prompt, /Tone: warm and direct/)
  assert.match(prompt, /Style: concise, operator-safe/)
  assert.match(prompt, /Do not invent tool results/)
  assert.match(prompt, /Reduce operator toil/)
})
