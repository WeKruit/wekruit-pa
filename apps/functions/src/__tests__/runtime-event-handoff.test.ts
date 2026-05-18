import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import {
  enqueueRuntimeEventHandoff,
  sanitizeRuntimeEventContext,
} from "../runtime-event-handoff.js"

type Store = Map<string, Map<string, Record<string, unknown>>>

function fakeFirestore() {
  const store: Store = new Map()
  function col(name: string): Map<string, Record<string, unknown>> {
    if (!store.has(name)) store.set(name, new Map())
    return store.get(name)!
  }
  const db = {
    collection(name: string) {
      return {
        doc(id: string) {
          return {
            id,
            async get() {
              const data = col(name).get(id)
              return { exists: data !== undefined, id, data: () => data }
            },
            async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
              col(name).set(id, opts?.merge ? { ...(col(name).get(id) ?? {}), ...data } : { ...data })
            },
          }
        },
      }
    },
  } as unknown as Firestore
  return { db, store }
}

test("runtime event handoff removes producer-written candidate drafts before Claire sees context", async () => {
  const { db, store } = fakeFirestore()
  await db.collection(PA_COLLECTIONS.users).doc("u1").set({ phoneE164: "+15555550123" })

  const result = await enqueueRuntimeEventHandoff(db, {
    userId: "u1",
    source: "cv_ingest",
    eventKind: "resume_parse_completed",
    idempotencyKey: "resume-1",
    requireExistingSession: false,
    context: {
      resumeId: "resume-1",
      content: "legacy content body",
      composedRecommendationMessage: "producer rec copy",
      sourceNotes: "producer notes",
      proposedMessage: "send this stale producer draft",
      nested: {
        renderedTemplate: "template copy that must not leak",
        facts: ["React", "Node"],
      },
    },
    nowIso: () => "2026-05-18T00:00:00.000Z",
  })

  assert.equal(result.ok, true)
  if (!result.ok) return
  const row = store.get(PA_COLLECTIONS.inboundEvents)?.get(result.eventId)
  assert.ok(row)
  assert.doesNotMatch(String(row!.body), /producer draft|template copy|producer rec copy|legacy content body/)
  assert.doesNotMatch(String(row!.body), /Keep the candidate's established language/)
  assert.match(String(row!.body), /English-only/)
  const meta = row!.rawMeta as Record<string, unknown>
  assert.equal(meta.preferredLanguage, "en")
  assert.deepEqual(meta.context, {
    resumeId: "resume-1",
    nested: { facts: ["React", "Node"] },
  })
  assert.deepEqual(meta.removedCandidateDraftContextKeys, [
    "content",
    "composedRecommendationMessage",
    "sourceNotes",
    "proposedMessage",
    "nested.renderedTemplate",
  ])
})

test("sanitizeRuntimeEventContext redacts draft-like keys recursively", () => {
  const out = sanitizeRuntimeEventContext({
    eventKind: "x",
    content: "legacy body",
    messageTemplate: "legacy template",
    items: [{ candidateVisibleMessage: "old copy", title: "Role" }],
  })
  assert.deepEqual(out.context, {
    eventKind: "x",
    items: [{ title: "Role" }],
  })
  assert.deepEqual(out.removedDraftKeys, ["content", "messageTemplate", "items[0].candidateVisibleMessage"])
})
