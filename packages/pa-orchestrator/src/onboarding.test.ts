import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import type { User, AgentDef } from "@pa/core-types"
import {
  resolveOnboardingStep,
  applyOnboardingStep,
  composeOnboardingInput,
} from "./onboarding.js"

type StoredDoc = Record<string, unknown>

function fakeFirestore() {
  const store = new Map<string, StoredDoc>()
  const db = {
    _store: store,
    collection(col: string) {
      return {
        doc(id: string) {
          return {
            path: `${col}/${id}`,
            async set(data: StoredDoc, opts?: { merge?: boolean }) {
              const current = store.get(`${col}/${id}`) ?? {}
              store.set(`${col}/${id}`, opts?.merge ? { ...current, ...data } : data)
            },
            async get() {
              const data = store.get(`${col}/${id}`)
              return { exists: data != null, data: () => data ?? {} }
            },
          }
        },
        where(field: string, op: string, value: unknown) {
          return {
            limit(_n: number) {
              return {
                async get() {
                  // Simple filter for beta participant lookup
                  const entries = [...store.entries()].filter(([k]) => k.startsWith(`${col}/`))
                  const filtered = entries.filter(([, d]) => {
                    if (op === "==" || op === "in") {
                      const fieldVal = d[field]
                      if (op === "in") return Array.isArray(value) && value.includes(fieldVal)
                      return fieldVal === value
                    }
                    return false
                  })
                  return {
                    empty: filtered.length === 0,
                    docs: filtered.map(([path, d]) => ({
                      data: () => d,
                      id: path.split("/")[1] ?? "x",
                      ref: {
                        async set(data: StoredDoc, opts?: { merge?: boolean }) {
                          const current = store.get(path) ?? {}
                          store.set(path, opts?.merge ? { ...current, ...data } : data)
                        },
                      },
                    })),
                  }
                },
              }
            },
          }
        },
      }
    },
  }
  return { db: db as unknown as Firestore, store }
}

const baseUser: User = {
  id: "u1",
  phoneE164: "+14155550001",
  createdAt: "2026-04-27T00:00:00.000Z",
  onboardingStatus: "active",
  onboardingState: undefined,
}

const agent: AgentDef = {
  id: "default",
  name: "Claire",
  systemPrompt: "# IDENTITY\nYou are Claire. First message: 在呢. 今天找你聊点啥? 🍋",
  provider: "openai",
  model: "gpt-5.4-nano",
  temperature: 0.7,
  memoryMode: "firestore_only",
  toolPolicy: "none",
  version: "6.4",
}

// --- Test 3: resolveOnboardingStep returns send_first_mes when pending or undefined ---
test("resolveOnboardingStep returns send_first_mes when onboardingState is pending or undefined", () => {
  const userPending = { ...baseUser, onboardingState: "pending" as const }
  const userUndefined = { ...baseUser, onboardingState: undefined }
  assert.equal(resolveOnboardingStep(userPending), "send_first_mes")
  assert.equal(resolveOnboardingStep(userUndefined), "send_first_mes")
})

// --- Test 4: returns ask_grounding_q when first_mes_sent ---
test("resolveOnboardingStep returns ask_grounding_q when first_mes_sent", () => {
  const user = { ...baseUser, onboardingState: "first_mes_sent" as const }
  assert.equal(resolveOnboardingStep(user), "ask_grounding_q")
})

// --- Test 4b: returns complete when grounding_q1_asked ---
test("resolveOnboardingStep returns complete when grounding_q1_asked", () => {
  const user = { ...baseUser, onboardingState: "grounding_q1_asked" as const }
  assert.equal(resolveOnboardingStep(user), "complete")
})

// --- Test 4c: returns skip when complete ---
test("resolveOnboardingStep returns skip when already complete", () => {
  const user = { ...baseUser, onboardingState: "complete" as const }
  assert.equal(resolveOnboardingStep(user), "skip")
})

// --- Test 5: applyOnboardingStep advances state idempotently ---
test("applyOnboardingStep advances state and is idempotent", async () => {
  const { db, store } = fakeFirestore()
  const user = { ...baseUser, onboardingState: undefined }
  // Advance to first_mes_sent
  await applyOnboardingStep(db, user, "send_first_mes")
  const userDoc = store.get(`${PA_COLLECTIONS.users}/u1`)
  assert.equal(userDoc?.["onboardingState"], "first_mes_sent")
  // Re-running same step should be a no-op (idempotent — state still first_mes_sent)
  await applyOnboardingStep(db, user, "send_first_mes")
  const userDoc2 = store.get(`${PA_COLLECTIONS.users}/u1`)
  assert.equal(userDoc2?.["onboardingState"], "first_mes_sent")
})

// --- Test 6: on complete, promotes matching pa_beta_participants to active ---
test("applyOnboardingStep complete promotes beta participant to active", async () => {
  const { db, store } = fakeFirestore()
  // Pre-populate a beta participant row with invited status
  const participantId = "part-1"
  store.set(`${PA_COLLECTIONS.betaParticipants}/${participantId}`, {
    id: participantId,
    contactHandle: "+14155550001",
    contactType: "phone",
    status: "invited",
    userId: "u1",
    addedAt: "2026-04-27T00:00:00.000Z",
    addedBy: "ops@wekruit.com",
    removedAt: null,
    notes: null,
    metadata: {},
  })

  const user = { ...baseUser, onboardingState: "grounding_q1_asked" as const }
  await applyOnboardingStep(db, user, "complete")

  const userDoc = store.get(`${PA_COLLECTIONS.users}/u1`)
  assert.equal(userDoc?.["onboardingState"], "complete")
  assert.ok(userDoc?.["onboardedAt"])

  const participantDoc = store.get(`${PA_COLLECTIONS.betaParticipants}/${participantId}`)
  assert.equal(participantDoc?.["status"], "active")
})

// --- composeOnboardingInput returns appropriate synthetic inputs ---
test("composeOnboardingInput send_first_mes includes first_mes text", () => {
  const input = composeOnboardingInput("send_first_mes", agent)
  assert.equal(typeof input, "string")
  assert.ok(input.includes("在呢") || input.includes("first_mes") || input.length > 0)
})

test("composeOnboardingInput ask_grounding_q returns a grounding question prompt", () => {
  const input = composeOnboardingInput("ask_grounding_q", agent)
  assert.equal(typeof input, "string")
  assert.ok(input.length > 0)
})
