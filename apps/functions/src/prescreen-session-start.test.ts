import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { runPreScreenForUser } from "./prescreen-session-start.js"

type FakeDoc = { exists: boolean; data: Record<string, unknown> }

function makeFakeDb(seed: Record<string, Record<string, unknown>>) {
  const docs = new Map<string, FakeDoc>()
  for (const [path, data] of Object.entries(seed)) docs.set(path, { exists: true, data })
  const sets: Array<{ path: string; data: Record<string, unknown>; options?: unknown }> = []

  function docRef(collection: string, id: string) {
    const path = `${collection}/${id}`
    return {
      id,
      async get() {
        const doc = docs.get(path) ?? { exists: false, data: {} }
        return { exists: doc.exists, data: () => (doc.exists ? doc.data : undefined) }
      },
      async set(data: Record<string, unknown>, options?: unknown) {
        const prev = docs.get(path)
        const merge = Boolean((options as { merge?: boolean } | undefined)?.merge)
        docs.set(path, { exists: true, data: merge ? { ...(prev?.data ?? {}), ...data } : data })
        sets.push({ path, data, options })
      },
    }
  }

  const db = {
    collection(collection: string) {
      const filters: Array<{ field: string; value: unknown }> = []
      const query = {
        where(field: string, _op: string, value: unknown) {
          filters.push({ field, value })
          return query
        },
        async get() {
          const out = []
          for (const [path, doc] of docs.entries()) {
            if (!path.startsWith(`${collection}/`) || !doc.exists) continue
            if (filters.every((f) => doc.data[f.field] === f.value)) {
              const id = path.slice(collection.length + 1)
              out.push({ id, data: () => doc.data, ref: docRef(collection, id) })
            }
          }
          return { docs: out }
        },
      }
      return {
        doc(id: string) {
          return docRef(collection, id)
        },
        where: query.where,
      }
    },
  }

  return { db: db as never, docs, sets }
}

const prescreenConfig = {
  version: 1,
  jobTitle: "Technical Account Manager",
  company: "Rain",
  threshold: 0.65,
  confidenceThreshold: 0.7,
  maxClarifyRounds: 2,
  voiceMode: "professional_prescreen",
  questions: [
    {
      qId: "role_fit",
      type: "MUST_HAVE",
      weight: 1,
      matchThreshold: 0.85,
      prompt: { en: "What recent work best matches this technical account management role?", zh: "What recent work best matches this technical account management role?" },
      clarifyPrompt: { en: "Share the closest customer or API support project.", zh: "Share the closest customer or API support project." },
      keywords: [{ keyword: "role_fit", weight: 1, hint: "role fit" }],
    },
  ],
}

describe("runPreScreenForUser session boundaries", () => {
  it("starts a fresh work session and supersedes older active prescreens for the user", async () => {
    const { db, docs } = makeFakeDb({
      "pa-jobs/job-new": { prescreenConfig },
      "pa-prescreen-sessions/ps_old": {
        sessionId: "ps_old",
        userId: "u1",
        jobId: "job-old",
        terminal: null,
        currentQId: "role_fit",
      },
    })
    const sent: string[] = []
    const result = await runPreScreenForUser({
      db,
      jobId: "job-new",
      userId: "u1",
      toE164: "+13054507715",
      markStarted: async () => undefined,
      sendSms: async ({ content }) => {
        sent.push(content)
        return {
          status: "queued",
          from_number: null,
          number: "+13054507715",
          content,
          service: "iMessage",
          is_outbound: true,
        }
      },
    })

    assert.equal(result.ok, true)
    assert.equal(result.reason, "started")
    assert.match(sent[0], /Technical Account Manager/)
    assert.equal(docs.get("pa-prescreen-sessions/ps_old")?.data.terminal, "PAUSE")
    assert.match(String(docs.get("pa-prescreen-sessions/ps_old")?.data.terminalReason), /superseded_by_new_prescreen_session/)
    const started = [...docs.entries()].find(([path, doc]) => path !== "pa-prescreen-sessions/ps_old" && path.startsWith("pa-prescreen-sessions/") && doc.data.userId === "u1")
    assert.ok(started, "fresh prescreen session was written")
    assert.equal((started[1].data.workSession as { status?: string }).status, "active")
  })
})
