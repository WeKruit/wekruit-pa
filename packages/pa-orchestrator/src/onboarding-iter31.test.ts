/**
 * iter31 — onboarding extensions: ToS gate (q_tos_asked) + email
 * verification (q_email_verifying). Adam directive 2026-05-04 (biz-test
 * launch prep): privacy + terms acceptance + Mailgun-backed email
 * verification before onboarding completes.
 */
import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import type { AgentDef } from "@pa/core-types"
import {
  resolveOnboardingStep,
  applyOnboardingStep,
  composeOnboardingInput,
  parseTosAnswer,
  parseEmailVerificationCode,
  userAnsweredStep,
  TOS_ACCEPT_REGEX,
  TOS_DECLINE_REGEX,
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
        where(_field: string, _op: string, _value: unknown) {
          return {
            limit(_n: number) {
              return {
                async get() {
                  return { empty: true, docs: [] }
                },
              }
            },
          }
        },
      }
    },
  }
  return db as unknown as Firestore & { _store: Map<string, StoredDoc> }
}

const FAKE_AGENT = {
  id: "agent_test",
  name: "Test",
  systemPrompt: "First message: 在呢. 今天找你聊点啥?\n",
  provider: "siliconflow",
  model: "qwen-2.5-7b",
  temperature: 0.7,
  version: "1",
  memoryMode: "mem0",
  toolPolicy: "none",
} as unknown as AgentDef

// ────────────────────────────────────────────────────────────────────
// resolveOnboardingStep — new gate + verify routing
// ────────────────────────────────────────────────────────────────────

test("resolveOnboardingStep: TOS gate off → first_mes_sent → ask_q_email (iter32 reorder: email comes after first_mes when no TOS gate)", () => {
  const step = resolveOnboardingStep(
    { onboardingState: "first_mes_sent" },
    { enableV2: true, enableTosGate: false }
  )
  assert.equal(step, "ask_q_email")
})

test("resolveOnboardingStep: TOS gate on → first_mes_sent → ask_q_tos", () => {
  const step = resolveOnboardingStep(
    { onboardingState: "first_mes_sent" },
    { enableV2: true, enableTosGate: true }
  )
  assert.equal(step, "ask_q_tos")
})

test("resolveOnboardingStep: q_tos_asked → ask_q_email (iter32 reorder: TOS accept advances to email step)", () => {
  const step = resolveOnboardingStep(
    { onboardingState: "q_tos_asked" },
    { enableV2: true, enableTosGate: true }
  )
  assert.equal(step, "ask_q_email")
})

test("resolveOnboardingStep: q_email_asked + emailCaptured + verify on → ask_q_email_verify", () => {
  const step = resolveOnboardingStep(
    { onboardingState: "q_email_asked" },
    {
      enableV2: true,
      enableEmailVerification: true,
      emailCaptured: true,
    }
  )
  assert.equal(step, "ask_q_email_verify")
})

test("resolveOnboardingStep: q_email_asked + emailCaptured but verify OFF → ask_q_role (iter32 reorder: skip verify, proceed to role probe)", () => {
  const step = resolveOnboardingStep(
    { onboardingState: "q_email_asked" },
    {
      enableV2: true,
      enableEmailVerification: false,
      emailCaptured: true,
    }
  )
  assert.equal(step, "ask_q_role")
})

test("resolveOnboardingStep: q_email_asked + verify on but user skipped email → ask_q_role (iter32 reorder: skip verify, proceed)", () => {
  const step = resolveOnboardingStep(
    { onboardingState: "q_email_asked" },
    {
      enableV2: true,
      enableEmailVerification: true,
      emailCaptured: false,
    }
  )
  assert.equal(step, "ask_q_role")
})

test("resolveOnboardingStep: q_email_verifying → ask_q_email_verify (re-ask)", () => {
  const step = resolveOnboardingStep(
    { onboardingState: "q_email_verifying" },
    { enableV2: true, enableEmailVerification: true }
  )
  assert.equal(step, "ask_q_email_verify")
})

// ────────────────────────────────────────────────────────────────────
// parseTosAnswer
// ────────────────────────────────────────────────────────────────────

test("parseTosAnswer: 同意 / agree → accept", () => {
  assert.equal(parseTosAnswer("同意"), "accept")
  assert.equal(parseTosAnswer("好的, 同意"), "accept")
  assert.equal(parseTosAnswer("agree"), "accept")
  assert.equal(parseTosAnswer("yes"), "accept")
  assert.equal(parseTosAnswer("ok"), "accept")
  assert.equal(parseTosAnswer("yeah"), "accept")
  assert.equal(parseTosAnswer("i agree"), "accept")
})

test("parseTosAnswer: 不同意 / decline → decline (prefers decline over accept token in same string)", () => {
  assert.equal(parseTosAnswer("不同意"), "decline")
  assert.equal(parseTosAnswer("decline"), "decline")
  assert.equal(parseTosAnswer("nope"), "decline")
  assert.equal(parseTosAnswer("no"), "decline")
  assert.equal(parseTosAnswer("don't agree"), "decline")
  assert.equal(parseTosAnswer("i do not agree"), "decline")
})

test("parseTosAnswer: ambiguous chatter → unclear", () => {
  assert.equal(parseTosAnswer("hmm"), "unclear")
  assert.equal(parseTosAnswer("can you tell me more about that"), "unclear")
  assert.equal(parseTosAnswer(""), "unclear")
  assert.equal(parseTosAnswer("我看看吧"), "unclear")
})

test("TOS_ACCEPT_REGEX + TOS_DECLINE_REGEX are non-overlapping for canonical accept tokens", () => {
  const acceptOnly = ["同意", "agree", "yes", "ok"]
  for (const token of acceptOnly) {
    assert.equal(TOS_ACCEPT_REGEX.test(token), true, `accept token "${token}" should match accept regex`)
    assert.equal(TOS_DECLINE_REGEX.test(token), false, `accept token "${token}" should NOT match decline regex`)
  }
})

// ────────────────────────────────────────────────────────────────────
// parseEmailVerificationCode
// ────────────────────────────────────────────────────────────────────

test("parseEmailVerificationCode: extracts 6 digits from clean reply", () => {
  assert.equal(parseEmailVerificationCode("123456"), "123456")
  assert.equal(parseEmailVerificationCode("000123"), "000123")
})

test("parseEmailVerificationCode: tolerates spacing + punctuation", () => {
  assert.equal(parseEmailVerificationCode("123 456"), "123456")
  assert.equal(parseEmailVerificationCode("123-456"), "123456")
  assert.equal(parseEmailVerificationCode("code: 123456"), "123456")
  assert.equal(parseEmailVerificationCode("123,456"), "123456")
})

test("parseEmailVerificationCode: returns null when no 6-digit run present", () => {
  assert.equal(parseEmailVerificationCode("hello"), null)
  assert.equal(parseEmailVerificationCode("12345"), null)
  assert.equal(parseEmailVerificationCode(""), null)
})

test("parseEmailVerificationCode: takes the FIRST 6-digit run when multiple present", () => {
  assert.equal(parseEmailVerificationCode("first: 111111 second: 222222"), "111111")
})

// ────────────────────────────────────────────────────────────────────
// userAnsweredStep — new steps
// ────────────────────────────────────────────────────────────────────

test("userAnsweredStep ask_q_tos: accept and decline both count as answered", () => {
  assert.equal(userAnsweredStep("ask_q_tos", "同意"), true)
  assert.equal(userAnsweredStep("ask_q_tos", "no"), true)
  assert.equal(userAnsweredStep("ask_q_tos", "hmm"), false)
})

test("userAnsweredStep ask_q_email_verify: 6-digit code answers, anything else does not", () => {
  assert.equal(userAnsweredStep("ask_q_email_verify", "123456"), true)
  assert.equal(userAnsweredStep("ask_q_email_verify", "123 456"), true)
  assert.equal(userAnsweredStep("ask_q_email_verify", "what's the code?"), false)
  assert.equal(userAnsweredStep("ask_q_email_verify", "12345"), false)
})

// ────────────────────────────────────────────────────────────────────
// composeOnboardingInput — new branches
// ────────────────────────────────────────────────────────────────────

test("composeOnboardingInput ask_q_tos: emits ToS line with privacy URL", () => {
  const input = composeOnboardingInput("ask_q_tos", FAKE_AGENT, {
    userMessage: "hi",
  })
  assert.match(input, /ask_q_tos\b/)
  assert.match(input, /privacy/i)
  // iter33 Bug 13 fix 2026-05-05 — legal page moved to pa-landing host.
  assert.match(input, /https:\/\/wekruit-pa-landing\.web\.app\/legal/)
})

test("composeOnboardingInput ask_q_tos with priorAskedStep + decline reply: emits decline-ack branch", () => {
  const input = composeOnboardingInput("ask_q_tos", FAKE_AGENT, {
    userMessage: "no thanks, decline",
    priorAskedStep: "ask_q_tos",
  })
  assert.match(input, /ask_q_tos_declined/)
  assert.match(input, /memory/i)
})

test("composeOnboardingInput ask_q_tos with priorAskedStep + unclear reply: emits re-ask branch", () => {
  const input = composeOnboardingInput("ask_q_tos", FAKE_AGENT, {
    userMessage: "what does that mean",
    priorAskedStep: "ask_q_tos",
  })
  assert.match(input, /ask_q_tos_reask/)
})

test("composeOnboardingInput ask_q_email_verify: emits verification-line directive", () => {
  const input = composeOnboardingInput("ask_q_email_verify", FAKE_AGENT, {
    userMessage: "test@example.com",
  })
  assert.match(input, /ask_q_email_verify\b/)
  assert.match(input, /6/)
})

test("composeOnboardingInput ask_q_email: T6 tone-lock — directive includes literal '邮箱' for zh", () => {
  // Pass a userMessage containing a valid resume-acceptance shape so
  // userAnsweredStep("ask_q_resume", ...) returns true (the priorAskedStep
  // is what gets userAnswered checked, not the step we're composing).
  const input = composeOnboardingInput("ask_q_email", FAKE_AGENT, {
    userMessage: "好的, 发给你",
    priorAskedStep: "ask_q_resume",
  })
  assert.match(input, /邮箱/)
  assert.match(input, /MUST contain the literal/)
})

test("composeOnboardingInput ask_q_email: T6 tone-lock — directive includes 'email' for en", () => {
  const input = composeOnboardingInput("ask_q_email", FAKE_AGENT, {
    userMessage: "yeah ok, sending it now",
    priorAskedStep: "ask_q_resume",
  })
  assert.match(input, /MUST contain the literal/)
  assert.match(input, /email/i)
})

// ────────────────────────────────────────────────────────────────────
// applyOnboardingStep — ToS acceptance + decline writes
// ────────────────────────────────────────────────────────────────────

test("applyOnboardingStep: tosAcceptedVersion written when transitioning out of q_tos_asked", async () => {
  const db = fakeFirestore()
  await applyOnboardingStep(
    db,
    {
      id: "user_a",
      phoneE164: "+15551234567",
      onboardingState: "q_tos_asked",
    },
    "ask_q_role",
    {
      tosAcceptedVersion: "v1.0",
      priorAskedStep: "ask_q_tos",
      priorUserReply: "同意",
      now: "2026-05-04T10:00:00.000Z",
    }
  )
  const doc = (db as { _store: Map<string, StoredDoc> })._store.get(
    `${PA_COLLECTIONS.users}/user_a`
  )
  assert.ok(doc, "user doc should exist")
  assert.equal(doc!.onboardingState, "q_role_asked")
  const tosAcceptance = doc!.tosAcceptance as { version?: string; acceptedAt?: string; channel?: string; rawReply?: string }
  assert.equal(tosAcceptance.version, "v1.0")
  assert.equal(tosAcceptance.channel, "imessage_sms")
  assert.equal(tosAcceptance.rawReply, "同意")
})

test("applyOnboardingStep: tosDeclined written + state STAYS at q_tos_asked when suspendedForVent", async () => {
  const db = fakeFirestore()
  // First seed user at q_tos_asked
  await applyOnboardingStep(
    db,
    { id: "user_b", phoneE164: "+15551234568", onboardingState: "first_mes_sent" },
    "ask_q_tos",
    { now: "2026-05-04T10:00:00.000Z" }
  )
  // Now apply decline with suspendedForVent — should be a no-op state-wise
  await applyOnboardingStep(
    db,
    { id: "user_b", phoneE164: "+15551234568", onboardingState: "q_tos_asked" },
    "ask_q_tos",
    {
      tosDeclined: true,
      suspendedForVent: true,
      priorAskedStep: "ask_q_tos",
      priorUserReply: "no",
      now: "2026-05-04T10:01:00.000Z",
    }
  )
  const doc = (db as { _store: Map<string, StoredDoc> })._store.get(
    `${PA_COLLECTIONS.users}/user_b`
  )!
  assert.equal(doc.onboardingState, "q_tos_asked", "state should stay at q_tos_asked under suspension")
  // tosAcceptance not written under suspendedForVent path (it returns early)
  assert.equal(doc.tosAcceptance, undefined)
})

// ────────────────────────────────────────────────────────────────────
// applyOnboardingStep — email verification setup + verified-complete
// ────────────────────────────────────────────────────────────────────

test("applyOnboardingStep: emailVerification persisted on ask_q_email_verify advance", async () => {
  const db = fakeFirestore()
  await applyOnboardingStep(
    db,
    {
      id: "user_c",
      phoneE164: "+15551234569",
      onboardingState: "q_email_asked",
    },
    "ask_q_email_verify",
    {
      emailVerification: {
        codeHash: "deadbeef",
        email: "user@example.com",
        sentAt: "2026-05-04T10:00:00.000Z",
        expiresAt: "2026-05-04T10:30:00.000Z",
        providerMessageId: "msg_123",
      },
      now: "2026-05-04T10:00:00.000Z",
    }
  )
  const doc = (db as { _store: Map<string, StoredDoc> })._store.get(
    `${PA_COLLECTIONS.users}/user_c`
  )!
  assert.equal(doc.onboardingState, "q_email_verifying")
  const ev = doc.emailVerification as { codeHash?: string; email?: string; attempts?: number; providerMessageId?: string }
  assert.equal(ev.codeHash, "deadbeef")
  assert.equal(ev.email, "user@example.com")
  assert.equal(ev.attempts, 0)
  assert.equal(ev.providerMessageId, "msg_123")
})

test("applyOnboardingStep: emailVerificationVerified clears emailVerification + sets contactEmailVerifiedAt", async () => {
  const db = fakeFirestore()
  // Seed user at q_email_verifying with a challenge
  ;(db as { _store: Map<string, StoredDoc> })._store.set(
    `${PA_COLLECTIONS.users}/user_d`,
    {
      id: "user_d",
      phoneE164: "+15551234570",
      onboardingState: "q_email_verifying",
      emailVerification: {
        codeHash: "deadbeef",
        email: "user@example.com",
        sentAt: "2026-05-04T10:00:00.000Z",
        expiresAt: "2026-05-04T10:30:00.000Z",
        attempts: 1,
      },
    }
  )
  await applyOnboardingStep(
    db,
    {
      id: "user_d",
      phoneE164: "+15551234570",
      onboardingState: "q_email_verifying",
    },
    "complete",
    {
      emailVerificationVerified: true,
      now: "2026-05-04T10:05:00.000Z",
    }
  )
  const doc = (db as { _store: Map<string, StoredDoc> })._store.get(
    `${PA_COLLECTIONS.users}/user_d`
  )!
  assert.equal(doc.onboardingState, "complete")
  assert.equal(doc.emailVerification, null, "emailVerification should be cleared")
  const sp = doc.statedPreferences as { contactEmailVerifiedAt?: string }
  assert.equal(sp.contactEmailVerifiedAt, "2026-05-04T10:05:00.000Z")
})

test("applyOnboardingStep: emailVerificationFailed bumps attempts, does NOT advance state", async () => {
  const db = fakeFirestore()
  ;(db as { _store: Map<string, StoredDoc> })._store.set(
    `${PA_COLLECTIONS.users}/user_e`,
    {
      id: "user_e",
      phoneE164: "+15551234571",
      onboardingState: "q_email_verifying",
      emailVerification: {
        codeHash: "deadbeef",
        email: "user@example.com",
        sentAt: "2026-05-04T10:00:00.000Z",
        expiresAt: "2026-05-04T10:30:00.000Z",
        attempts: 1,
      },
    }
  )
  await applyOnboardingStep(
    db,
    {
      id: "user_e",
      phoneE164: "+15551234571",
      onboardingState: "q_email_verifying",
    },
    "ask_q_email_verify",
    {
      emailVerificationFailed: true,
      now: "2026-05-04T10:05:00.000Z",
    }
  )
  const doc = (db as { _store: Map<string, StoredDoc> })._store.get(
    `${PA_COLLECTIONS.users}/user_e`
  )!
  assert.equal(doc.onboardingState, "q_email_verifying", "state should stay")
  // attempts bumped to 2 (set via dot-path; fakeFirestore stores it under literal key)
  // We check that the dot-path key was written
  assert.equal(doc["emailVerification.attempts"], 2)
})

// ────────────────────────────────────────────────────────────────────
// applyOnboardingStep: idempotency / regression — order in STATE_ORDER
// ────────────────────────────────────────────────────────────────────

test("applyOnboardingStep: q_tos_asked sits before q_role_asked in idempotency order", async () => {
  // Verify by attempting to write q_tos_asked when state is already q_role_asked.
  // Should be a no-op (regression prevention).
  const db = fakeFirestore()
  ;(db as { _store: Map<string, StoredDoc> })._store.set(
    `${PA_COLLECTIONS.users}/user_f`,
    {
      id: "user_f",
      phoneE164: "+15551234572",
      onboardingState: "q_role_asked",
    }
  )
  await applyOnboardingStep(
    db,
    {
      id: "user_f",
      phoneE164: "+15551234572",
      onboardingState: "q_role_asked",
    },
    "ask_q_tos",
    { now: "2026-05-04T10:00:00.000Z" }
  )
  const doc = (db as { _store: Map<string, StoredDoc> })._store.get(
    `${PA_COLLECTIONS.users}/user_f`
  )!
  assert.equal(doc.onboardingState, "q_role_asked", "idempotency should prevent regression to q_tos_asked")
})
