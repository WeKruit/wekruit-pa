import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { Firestore } from "firebase-admin/firestore"

import { resolveAgentVersion } from "./version-resolver.js"
import { loadSeedAgents } from "./seed.js"

function makeFakeDb(initial: Record<string, Record<string, unknown>> = {}) {
  const docs = new Map<string, Record<string, unknown>>(Object.entries(initial))
  const db = {
    collection(_name: string) {
      return {
        doc(id: string) {
          return {
            async get() {
              const data = docs.get(id)
              return { exists: data !== undefined, data: () => data, id }
            },
          }
        },
      }
    },
  } as unknown as Firestore
  return { db, docs }
}

describe("resolveAgentVersion", () => {
  it("resolves flag override (seed.json key)", async () => {
    const seed = loadSeedAgents()
    const target = seed[0]!
    const { db } = makeFakeDb()
    const r = await resolveAgentVersion(db, {
      getFlag: async () => target.version ?? target.id,
      env: { PA_AGENT_REGISTRY_VERSION: "ignored" },
    })
    assert.equal(r.source, "flag")
    assert.ok(r.agent)
    assert.equal(r.agent!.id, target.id)
  })

  it("resolves env override when flag is empty", async () => {
    const seed = loadSeedAgents()
    const target = seed[0]!
    const { db } = makeFakeDb()
    const r = await resolveAgentVersion(db, {
      getFlag: async () => "",
      env: { PA_AGENT_REGISTRY_VERSION: target.id },
    })
    assert.equal(r.source, "env")
    assert.ok(r.agent)
    assert.equal(r.agent!.id, target.id)
  })

  it("falls back to seed default (isDefault) when neither flag nor env set", async () => {
    const { db } = makeFakeDb()
    const r = await resolveAgentVersion(db, {
      getFlag: async () => null,
      env: {},
    })
    assert.equal(r.source, "default")
    assert.ok(r.agent)
    assert.equal(r.agent!.isDefault, true)
  })

  it("returns null agent when flag points at unknown version (caller falls back)", async () => {
    const { db } = makeFakeDb()
    const r = await resolveAgentVersion(db, {
      getFlag: async () => "totally-bogus-version-string",
      env: {},
    })
    assert.equal(r.source, "flag")
    assert.equal(r.agent, null)
  })

  it("resolves firestore: prefix from pa_agents collection", async () => {
    const seed = loadSeedAgents()
    const target = seed[0]!
    // Stub the doc so the resolver fetches a Firestore-shaped result.
    const { db } = makeFakeDb({
      [target.id]: { ...target, version: "fs-pinned" },
    })
    const r = await resolveAgentVersion(db, {
      getFlag: async () => `firestore:agents/${target.id}/versions/fs-pinned`,
      env: {},
    })
    assert.equal(r.source, "flag")
    assert.ok(r.agent, "expected agent resolved from firestore")
    assert.equal(r.agent!.version, "fs-pinned")
  })

  it("returns null agent when firestore version does not match", async () => {
    const seed = loadSeedAgents()
    const target = seed[0]!
    const { db } = makeFakeDb({
      [target.id]: { ...target, version: "v-other" },
    })
    const r = await resolveAgentVersion(db, {
      getFlag: async () => `firestore:agents/${target.id}/versions/v-pinned`,
      env: {},
    })
    assert.equal(r.source, "flag")
    assert.equal(r.agent, null)
  })
})
