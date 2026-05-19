import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS, type PracticeQuestionBankItem } from "@pa/core-types"
import { listPracticeQuestions } from "./practice-question-bank.js"

const NOW = "2026-05-19T12:00:00.000Z"

function item(overrides: Partial<PracticeQuestionBankItem>): PracticeQuestionBankItem {
  return {
    schemaVersion: 1,
    id: overrides.id ?? "pq_default",
    status: overrides.status ?? "active",
    kind: overrides.kind ?? "behavioral",
    conversationMode: overrides.conversationMode ?? "behavioral_screen",
    title: overrides.title ?? "Question",
    prompt: overrides.prompt ?? "Prompt",
    companyStyle: overrides.companyStyle ?? [],
    roleFamilies: overrides.roleFamilies ?? [],
    categories: overrides.categories ?? [],
    tags: overrides.tags ?? [],
    keyConcepts: overrides.keyConcepts ?? [],
    evaluation: overrides.evaluation ?? { rubric: [], followUps: [], expectedSignals: [], redFlags: [] },
    sourceRefs: overrides.sourceRefs ?? ["test:source"],
    contentFingerprint: overrides.contentFingerprint ?? overrides.id ?? "fp_default",
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: "test",
    updatedBy: "test",
    ...overrides,
  }
}

function makeFakeFirestore(rows: PracticeQuestionBankItem[]): Firestore {
  type Filter = { field: string; op: "=="; value: unknown }
  function query(filters: Filter[] = [], limitValue?: number) {
    return {
      where(field: string, op: "==", value: unknown) {
        return query([...filters, { field, op, value }], limitValue)
      },
      limit(count: number) {
        return query(filters, count)
      },
      async get() {
        const docs = rows
          .filter((row) => filters.every((filter) => row[filter.field as keyof PracticeQuestionBankItem] === filter.value))
          .slice(0, limitValue)
          .map((row) => ({ id: row.id, data: () => row }))
        return { empty: docs.length === 0, docs }
      },
      doc(id: string) {
        const found = rows.find((row) => row.id === id)
        return {
          async get() {
            return { exists: Boolean(found), data: () => found }
          },
        }
      },
    }
  }
  return {
    collection(name: string) {
      assert.equal(name, PA_COLLECTIONS.practiceQuestionBank)
      return query()
    },
  } as unknown as Firestore
}

test("listPracticeQuestions applies limit after shared Claire practice filters", async () => {
  const db = makeFakeFirestore([
    item({
      id: "pq_behavior_only",
      title: "Behavior only",
      conversationMode: "behavioral_screen",
      tags: ["practice"],
    }),
    item({
      id: "pq_eval_data_case",
      title: "Eval data case",
      kind: "data_case",
      conversationMode: "data_case_discussion",
      tags: ["practice", "eval", "prescreen"],
    }),
  ])

  const rows = await listPracticeQuestions(db, {
    conversationMode: "data_case_discussion",
    tags: ["eval"],
    limit: 1,
  })

  assert.deepEqual(rows.map((row) => row.id), ["pq_eval_data_case"])
})
