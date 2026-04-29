import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import {
  PLAYBOOK_CACHE_TTL_MS,
  _clearPlaybookCache,
  getCachedPlaybooks,
  matchCachedPlaybooks,
} from "./playbook-cache.js"

// Minimal fake — listPlaybooks() iterates docs from `pa-playbooks` collection
// and reads each via .data(). Returns sorted by playbookKey.
function fakeFirestore(docs: Record<string, Record<string, unknown>>) {
  let getCalls = 0
  const db = {
    collection(_name: string) {
      return {
        async get() {
          getCalls++
          return {
            empty: Object.keys(docs).length === 0,
            docs: Object.entries(docs).map(([id, raw]) => ({
              id,
              data: () => raw,
            })),
          }
        },
        doc(id: string) {
          return {
            id,
            async get() {
              const raw = docs[id]
              return { id, exists: raw != null, data: () => raw ?? {} }
            },
          }
        },
      }
    },
  }
  return {
    db: db as unknown as Firestore,
    callCount: () => getCalls,
  }
}

test("getCachedPlaybooks reads Firestore on first call, then serves from cache", async () => {
  _clearPlaybookCache()
  const { db, callCount } = fakeFirestore({
    headhunter: {
      playbookKey: "headhunter",
      name: "Headhunter",
      regexTriggers: ["想换"],
      addendum: "BODY",
      enabled: true,
    },
  })
  const r1 = await getCachedPlaybooks(db, 30_000)
  assert.equal(r1.length, 1)
  assert.equal(callCount(), 1)
  // Second call within TTL → cache hit, no extra Firestore read.
  const r2 = await getCachedPlaybooks(db, 30_000)
  assert.equal(r2.length, 1)
  assert.equal(callCount(), 1)
})

test("getCachedPlaybooks refreshes after TTL expires", async () => {
  _clearPlaybookCache()
  const { db, callCount } = fakeFirestore({
    headhunter: {
      playbookKey: "headhunter",
      name: "Headhunter",
      regexTriggers: ["想换"],
      addendum: "BODY",
      enabled: true,
    },
  })
  await getCachedPlaybooks(db, 1) // 1ms TTL
  await new Promise((r) => setTimeout(r, 5))
  await getCachedPlaybooks(db, 1)
  assert.equal(callCount(), 2)
})

test("matchCachedPlaybooks returns matched + addendum when message hits a trigger", async () => {
  _clearPlaybookCache()
  const { db } = fakeFirestore({
    headhunter: {
      playbookKey: "headhunter",
      name: "Headhunter",
      regexTriggers: ["想换", "offer"],
      addendum: "PLAYBOOK BODY",
      enabled: true,
    },
  })
  const r = await matchCachedPlaybooks(db, "我想换工作")
  assert.equal(r.matched.length, 1)
  assert.equal(r.matched[0]!.playbookKey, "headhunter")
  assert.equal(r.addendum, "PLAYBOOK BODY")
})

test("matchCachedPlaybooks returns empty result on benign message", async () => {
  _clearPlaybookCache()
  const { db } = fakeFirestore({
    headhunter: {
      playbookKey: "headhunter",
      name: "Headhunter",
      regexTriggers: ["想换"],
      addendum: "BODY",
      enabled: true,
    },
  })
  const r = await matchCachedPlaybooks(db, "今天天气真好")
  assert.equal(r.matched.length, 0)
  assert.equal(r.addendum, "")
})

test("matchCachedPlaybooks swallows Firestore errors and returns empty result", async () => {
  _clearPlaybookCache()
  const failingDb = {
    collection() {
      return {
        async get() {
          throw new Error("firestore offline")
        },
      }
    },
  } as unknown as Firestore
  const r = await matchCachedPlaybooks(failingDb, "我想换工作")
  assert.equal(r.matched.length, 0)
  assert.equal(r.addendum, "")
})

test("PLAYBOOK_CACHE_TTL_MS is 30s (matches feature-flag pattern)", () => {
  assert.equal(PLAYBOOK_CACHE_TTL_MS, 30_000)
})
