/**
 * iter32 — tests for the deterministic onboarding dispatcher.
 *
 * Adam directive 2026-05-04: pre-runtime onboarding goes through
 * configured phrases, NOT the LLM. Tests cover the resolver (state +
 * gate inputs → action), the composer (action → reply text), the
 * end-to-end runner (dispatches reply, advances state, fires Mailgun),
 * and the strict CV + email-verified gates.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { createHash } from "node:crypto"
import {
  resolveDeterministicAction,
  composeDeterministicReply,
  runDeterministicOnboardingTurn,
  loadOnboardingConfig,
  _resetOnboardingConfigCache,
  DEFAULT_ONBOARDING_CONFIG,
  pickLang,
} from "./onboarding-deterministic.js"

// ────────────────────────────────────────────────────────────────────
// resolveDeterministicAction
// ────────────────────────────────────────────────────────────────────

test("resolveDeterministicAction: undefined state → send_first_mes", () => {
  const action = resolveDeterministicAction(
    { onboardingState: undefined, cvParsed: false, emailCaptured: false, emailVerified: false },
    "hi"
  )
  assert.equal(action.kind, "send_first_mes")
})

test("resolveDeterministicAction: pending → send_first_mes", () => {
  const action = resolveDeterministicAction(
    { onboardingState: "pending", cvParsed: false, emailCaptured: false, emailVerified: false },
    "hi"
  )
  assert.equal(action.kind, "send_first_mes")
})

test("resolveDeterministicAction: first_mes_sent → ask_q_lang (iter33 P1)", () => {
  const action = resolveDeterministicAction(
    {
      onboardingState: "first_mes_sent",
      cvParsed: false,
      emailCaptured: false,
      emailVerified: false,
    },
    "hi"
  )
  assert.equal(action.kind, "ask_q_lang")
})

test("resolveDeterministicAction: q_lang_asked → ask_q_email (iter33 P2 reorder)", () => {
  const action = resolveDeterministicAction(
    {
      onboardingState: "q_lang_asked",
      cvParsed: false,
      emailCaptured: false,
      emailVerified: false,
    },
    "中文"
  )
  assert.equal(action.kind, "ask_q_email")
})

test("resolveDeterministicAction: q_tos_asked + 同意 → ask_q_role (iter33 P2 reorder)", () => {
  const action = resolveDeterministicAction(
    {
      onboardingState: "q_tos_asked",
      cvParsed: false,
      emailCaptured: false,
      emailVerified: false,
    },
    "同意"
  )
  assert.equal(action.kind, "ask_q_role")
})

test("resolveDeterministicAction: q_tos_asked + no → ask_q_tos_decline", () => {
  const action = resolveDeterministicAction(
    {
      onboardingState: "q_tos_asked",
      cvParsed: false,
      emailCaptured: false,
      emailVerified: false,
    },
    "no thanks"
  )
  assert.equal(action.kind, "ask_q_tos_decline")
})

test("resolveDeterministicAction: q_tos_asked + ambiguous → ask_q_tos_reask", () => {
  const action = resolveDeterministicAction(
    {
      onboardingState: "q_tos_asked",
      cvParsed: false,
      emailCaptured: false,
      emailVerified: false,
    },
    "what does that mean"
  )
  assert.equal(action.kind, "ask_q_tos_reask")
})

test("resolveDeterministicAction: q_role_asked + parseable role → ask_q_yoe", () => {
  const action = resolveDeterministicAction(
    {
      onboardingState: "q_role_asked",
      cvParsed: false,
      emailCaptured: false,
      emailVerified: false,
    },
    "swe — backend"
  )
  assert.equal(action.kind, "ask_q_yoe")
})

test("resolveDeterministicAction: q_role_asked + non-answer → re-ask q_role", () => {
  const action = resolveDeterministicAction(
    {
      onboardingState: "q_role_asked",
      cvParsed: false,
      emailCaptured: false,
      emailVerified: false,
    },
    "hmm idk yet"
  )
  assert.equal(action.kind, "ask_q_role")
})

test("resolveDeterministicAction: q_resume_asked + cvParsed=false → wait_for_resume_upload", () => {
  const action = resolveDeterministicAction(
    {
      onboardingState: "q_resume_asked",
      cvParsed: false,
      emailCaptured: false,
      emailVerified: false,
    },
    "ok i'll send"
  )
  assert.equal(action.kind, "wait_for_resume_upload")
})

test("resolveDeterministicAction: q_resume_asked + cvParsed=true → complete (iter32: final step, email already verified upstream)", () => {
  const action = resolveDeterministicAction(
    {
      onboardingState: "q_resume_asked",
      cvParsed: true,
      emailCaptured: true,
      emailVerified: true,
    },
    "ok"
  )
  assert.equal(action.kind, "complete")
})

test("resolveDeterministicAction: q_email_asked + valid email → ask_q_email_verify_start (carries email)", () => {
  const action = resolveDeterministicAction(
    {
      onboardingState: "q_email_asked",
      cvParsed: true,
      emailCaptured: false,
      emailVerified: false,
    },
    "user@example.com"
  )
  assert.equal(action.kind, "ask_q_email_verify_start")
  if (action.kind === "ask_q_email_verify_start") {
    assert.equal(action.email, "user@example.com")
  }
})

test("resolveDeterministicAction: q_email_asked + no email → re-ask (Adam directive: email required)", () => {
  const action = resolveDeterministicAction(
    {
      onboardingState: "q_email_asked",
      cvParsed: true,
      emailCaptured: false,
      emailVerified: false,
    },
    "actually skip that"
  )
  assert.equal(action.kind, "ask_q_email")
})

test("resolveDeterministicAction: q_email_verifying + 6-digit code → verify_email_code", () => {
  const action = resolveDeterministicAction(
    {
      onboardingState: "q_email_verifying",
      cvParsed: true,
      emailCaptured: true,
      emailVerified: false,
    },
    "123456"
  )
  assert.equal(action.kind, "verify_email_code")
  if (action.kind === "verify_email_code") {
    assert.equal(action.candidate, "123456")
  }
})

test("resolveDeterministicAction: q_email_verifying + non-code → ask_q_email_verify_retry", () => {
  const action = resolveDeterministicAction(
    {
      onboardingState: "q_email_verifying",
      cvParsed: true,
      emailCaptured: true,
      emailVerified: false,
    },
    "hmm let me check my email"
  )
  assert.equal(action.kind, "ask_q_email_verify_retry")
})

test("resolveDeterministicAction: complete + all gates → skip (agent runtime activates)", () => {
  const action = resolveDeterministicAction(
    {
      onboardingState: "complete",
      cvParsed: true,
      emailCaptured: true,
      emailVerified: true,
    },
    "hey"
  )
  assert.equal(action.kind, "skip")
})

test("resolveDeterministicAction: vent keyword mid-probe → vent_ack (state stays)", () => {
  const action = resolveDeterministicAction(
    {
      onboardingState: "q_role_asked",
      cvParsed: false,
      emailCaptured: false,
      emailVerified: false,
    },
    "fuck this i just got laid off"
  )
  assert.equal(action.kind, "vent_ack")
})

test("resolveDeterministicAction: zh vent → vent_ack", () => {
  const action = resolveDeterministicAction(
    {
      onboardingState: "q_yoe_asked",
      cvParsed: false,
      emailCaptured: false,
      emailVerified: false,
    },
    "操,我服了,心累"
  )
  assert.equal(action.kind, "vent_ack")
})

// ────────────────────────────────────────────────────────────────────
// composeDeterministicReply — picks the right phrase + lang
// ────────────────────────────────────────────────────────────────────

test("composeDeterministicReply: send_first_mes zh", () => {
  const reply = composeDeterministicReply(
    { kind: "send_first_mes" },
    DEFAULT_ONBOARDING_CONFIG,
    "在吗"
  )
  assert.match(reply, /在呢/)
})

test("composeDeterministicReply: send_first_mes en", () => {
  const reply = composeDeterministicReply(
    { kind: "send_first_mes" },
    DEFAULT_ONBOARDING_CONFIG,
    "hey there"
  )
  assert.match(reply, /Here/i)
})

test("composeDeterministicReply: ask_q_tos includes /legal link", () => {
  const reply = composeDeterministicReply(
    { kind: "ask_q_tos" },
    DEFAULT_ONBOARDING_CONFIG,
    "hi"
  )
  assert.match(reply, /https:\/\/wekruit-pa\.web\.app\/legal/)
})

test("composeDeterministicReply: ask_q_tos_decline is respectful (no pressure)", () => {
  const reply = composeDeterministicReply(
    { kind: "ask_q_tos_decline" },
    DEFAULT_ONBOARDING_CONFIG,
    "no"
  )
  assert.match(reply, /totally ok|完全 ok/i)
})

test("composeDeterministicReply: ask_q_email zh contains 邮箱", () => {
  const reply = composeDeterministicReply(
    { kind: "ask_q_email" },
    DEFAULT_ONBOARDING_CONFIG,
    "好的"
  )
  assert.match(reply, /邮箱/)
})

test("composeDeterministicReply: ask_q_email en contains 'email'", () => {
  const reply = composeDeterministicReply(
    { kind: "ask_q_email" },
    DEFAULT_ONBOARDING_CONFIG,
    "ok"
  )
  assert.match(reply, /email/i)
})

test("composeDeterministicReply: vent_ack is short + non-probing", () => {
  const reply = composeDeterministicReply(
    { kind: "vent_ack" },
    DEFAULT_ONBOARDING_CONFIG,
    "fuck this"
  )
  // Cap at 60 chars — en register tends longer than zh for similar content.
  assert.ok(reply.length <= 60, `vent ack should be short (got ${reply.length} chars: "${reply}")`)
  assert.ok(!/\?/.test(reply), `vent ack must NOT contain a question mark (got "${reply}")`)
})

test("composeDeterministicReply: wait_for_resume_upload uses waiting prompt", () => {
  const reply = composeDeterministicReply(
    { kind: "wait_for_resume_upload" },
    DEFAULT_ONBOARDING_CONFIG,
    "ok"
  )
  assert.match(reply, /resume|简历/i)
  assert.match(reply, /attach|附件/i)
})

test("composeDeterministicReply: skip + complete return empty (caller handles)", () => {
  const skipReply = composeDeterministicReply(
    { kind: "skip" },
    DEFAULT_ONBOARDING_CONFIG,
    "ok"
  )
  const completeReply = composeDeterministicReply(
    { kind: "complete" },
    DEFAULT_ONBOARDING_CONFIG,
    "ok"
  )
  assert.equal(skipReply, "")
  assert.equal(completeReply, "")
})

// ────────────────────────────────────────────────────────────────────
// pickLang
// ────────────────────────────────────────────────────────────────────

test("pickLang: zh-heavy → zh", () => {
  assert.equal(pickLang("你好啊"), "zh")
})

test("pickLang: en-heavy → en", () => {
  assert.equal(pickLang("hello there"), "en")
})

test("pickLang: empty → zh (Claire's first_mes is zh)", () => {
  assert.equal(pickLang(""), "zh")
})

test("pickLang: mixed at threshold → zh when >=30% CJK", () => {
  // "ok 你好" — 2 CJK out of 4 non-ws chars = 50% → zh
  assert.equal(pickLang("ok 你好"), "zh")
})

// ────────────────────────────────────────────────────────────────────
// loadOnboardingConfig — Firestore override merge
// ────────────────────────────────────────────────────────────────────

test("loadOnboardingConfig: no db → returns DEFAULT_ONBOARDING_CONFIG", async () => {
  _resetOnboardingConfigCache()
  const cfg = await loadOnboardingConfig(undefined)
  assert.equal(cfg.send_first_mes!.prompt.zh, DEFAULT_ONBOARDING_CONFIG.send_first_mes!.prompt.zh)
})

test("loadOnboardingConfig: firestore override field-by-field merge", async () => {
  _resetOnboardingConfigCache()
  const fakeDb = {
    collection: () => ({
      doc: () => ({
        async get() {
          return {
            exists: true,
            data: () => ({
              ask_q_role: {
                prompt: { zh: "OVERRIDE-ZH", en: "OVERRIDE-EN" },
              },
            }),
          }
        },
      }),
    }),
  } as unknown as Parameters<typeof loadOnboardingConfig>[0]
  const cfg = await loadOnboardingConfig(fakeDb)
  // Override took effect
  assert.equal(cfg.ask_q_role!.prompt.zh, "OVERRIDE-ZH")
  // Other fields untouched
  assert.equal(cfg.send_first_mes!.prompt.zh, DEFAULT_ONBOARDING_CONFIG.send_first_mes!.prompt.zh)
  _resetOnboardingConfigCache()
})

test("loadOnboardingConfig: firestore error → falls back to DEFAULT silently", async () => {
  _resetOnboardingConfigCache()
  const fakeDb = {
    collection: () => ({
      doc: () => ({
        async get() {
          throw new Error("transient")
        },
      }),
    }),
  } as unknown as Parameters<typeof loadOnboardingConfig>[0]
  const cfg = await loadOnboardingConfig(fakeDb)
  assert.equal(cfg.send_first_mes!.prompt.zh, DEFAULT_ONBOARDING_CONFIG.send_first_mes!.prompt.zh)
  _resetOnboardingConfigCache()
})

// ────────────────────────────────────────────────────────────────────
// runDeterministicOnboardingTurn — end-to-end with fake store
// ────────────────────────────────────────────────────────────────────

function makeFakeRunnerStore(extras: Record<string, unknown> = {}) {
  const captures = {
    appendedMessages: [] as Array<{ role: string; body: string }>,
    enqueuedOutbound: [] as string[],
    appliedSteps: [] as Array<{ step: string; opts: Record<string, unknown> }>,
    logEvents: [] as Array<{ event: string; payload?: Record<string, unknown> }>,
  }
  const store = {
    async appendMessage(msg: { role: string; body: string }) {
      captures.appendedMessages.push({ role: msg.role, body: msg.body })
    },
    async enqueueOutbound(_uid: string, _to: string, body: string) {
      captures.enqueuedOutbound.push(body)
    },
    async applyOnboarding(
      _uid: string,
      _phone: string,
      step: string,
      opts: Record<string, unknown> = {}
    ) {
      captures.appliedSteps.push({ step, opts })
    },
    async getTosVersion() {
      return "v1.0"
    },
    log(event: string, payload?: Record<string, unknown>) {
      captures.logEvents.push({ event, payload })
    },
    nowIso() {
      return "2026-05-04T18:00:00.000Z"
    },
    ...extras,
  }
  return { store, captures }
}

const FAKE_AGENT = { id: "claire" } as unknown as Parameters<
  typeof runDeterministicOnboardingTurn
>[0]["agent"]

function makeEvent(body: string, userId = "user-1", sessionId = "ses-1") {
  return {
    id: "evt-1",
    userId,
    sessionId,
    channel: "imessage" as const,
    externalChatId: "+15551234567",
    from: "+15551234567",
    body,
    status: "pending" as const,
    createdAt: "2026-05-04T18:00:00.000Z",
    idempotencyKey: "idem-1",
    rawMeta: {},
  }
}

test("runDeterministicOnboardingTurn: fresh user → send_first_mes verbatim, NO LLM", async () => {
  _resetOnboardingConfigCache()
  const { store, captures } = makeFakeRunnerStore()
  const result = await runDeterministicOnboardingTurn({
    event: makeEvent("hi"),
    store,
    turnId: "turn-1",
    onboardingUser: {
      id: "user-1",
      phoneE164: "+15551234567",
      onboardingState: undefined,
    },
    cvParsed: false,
    agent: FAKE_AGENT,
  })
  assert.equal(result.handled, true)
  if (result.handled) {
    assert.equal(result.action.kind, "send_first_mes")
  }
  assert.equal(captures.appendedMessages.length, 1)
  assert.match(captures.appendedMessages[0]!.body, /Here/i)
  assert.equal(captures.enqueuedOutbound.length, 1)
  assert.deepEqual(
    captures.appliedSteps.map((s) => s.step),
    ["send_first_mes"]
  )
})

test("runDeterministicOnboardingTurn: ToS accept → ask_q_role + writes tosAcceptedVersion=v1.0 (iter33 P2 reorder)", async () => {
  _resetOnboardingConfigCache()
  const { store, captures } = makeFakeRunnerStore()
  const result = await runDeterministicOnboardingTurn({
    event: makeEvent("同意"),
    store,
    turnId: "turn-2",
    onboardingUser: {
      id: "user-1",
      phoneE164: "+15551234567",
      onboardingState: "q_tos_asked",
    },
    cvParsed: false,
    agent: FAKE_AGENT,
  })
  assert.equal(result.handled, true)
  const advance = captures.appliedSteps.find((s) => s.step === "ask_q_role")
  assert.ok(advance, "applyOnboarding(ask_q_role) must fire")
  assert.equal(advance!.opts.tosAcceptedVersion, "v1.0")
  assert.match(captures.appendedMessages[0]!.body, /role|kinda|方向|做啥/i)
})

test("runDeterministicOnboardingTurn: ToS decline → state stays + decline reply", async () => {
  _resetOnboardingConfigCache()
  const { store, captures } = makeFakeRunnerStore()
  await runDeterministicOnboardingTurn({
    event: makeEvent("no thanks"),
    store,
    turnId: "turn-3",
    onboardingUser: {
      id: "user-1",
      phoneE164: "+15551234567",
      onboardingState: "q_tos_asked",
    },
    cvParsed: false,
    agent: FAKE_AGENT,
  })
  const declineApply = captures.appliedSteps.find(
    (s) => s.step === "ask_q_tos" && s.opts.tosDeclined === true
  )
  assert.ok(declineApply, "applyOnboarding(ask_q_tos, tosDeclined=true) must fire")
  assert.equal(declineApply!.opts.suspendedForVent, true, "suspendedForVent must be true so state stays")
  assert.match(captures.appendedMessages[0]!.body, /totally ok|完全 ok/i)
})

test("runDeterministicOnboardingTurn: q_resume_asked + cvParsed=false → wait reply, NO state advance", async () => {
  _resetOnboardingConfigCache()
  const { store, captures } = makeFakeRunnerStore()
  await runDeterministicOnboardingTurn({
    event: makeEvent("k sending now"),
    store,
    turnId: "turn-4",
    onboardingUser: {
      id: "user-1",
      phoneE164: "+15551234567",
      onboardingState: "q_resume_asked",
    },
    cvParsed: false,
    agent: FAKE_AGENT,
  })
  // No applyOnboarding call (CV gate holds)
  assert.equal(captures.appliedSteps.length, 0, "state must NOT advance until CV parsed")
  assert.match(captures.appendedMessages[0]!.body, /attach|附件/i)
  const logHit = captures.logEvents.find(
    (e) => e.event === "pa.onboarding.deterministic.cv_wait"
  )
  assert.ok(logHit, "cv_wait log event must fire")
})

test("runDeterministicOnboardingTurn: q_email_asked + valid email → fires Mailgun + advances to q_email_verifying", async () => {
  _resetOnboardingConfigCache()
  const sentMailgun: Array<{ email: string }> = []
  const { store, captures } = makeFakeRunnerStore({
    async sendVerificationEmail(email: string) {
      sentMailgun.push({ email })
      return {
        rawCode: "987654",
        sentAt: "2026-05-04T18:00:00.000Z",
        expiresAt: "2026-05-04T18:30:00.000Z",
        providerMessageId: "msg_abc",
      }
    },
  })
  await runDeterministicOnboardingTurn({
    event: makeEvent("user@example.com"),
    store,
    turnId: "turn-5",
    onboardingUser: {
      id: "user-1",
      phoneE164: "+15551234567",
      onboardingState: "q_email_asked",
    },
    cvParsed: true,
    agent: FAKE_AGENT,
  })
  assert.equal(sentMailgun.length, 1, "Mailgun must fire once")
  assert.equal(sentMailgun[0]!.email, "user@example.com")
  const advance = captures.appliedSteps.find((s) => s.step === "ask_q_email_verify")
  assert.ok(advance, "applyOnboarding(ask_q_email_verify) must fire")
  const ev = advance!.opts.emailVerification as { codeHash: string; email: string }
  const expectedHash = createHash("sha256").update("987654").digest("hex")
  assert.equal(ev.codeHash, expectedHash)
  assert.equal(ev.email, "user@example.com")
  assert.match(captures.appendedMessages[0]!.body, /6/)
})

test("runDeterministicOnboardingTurn: q_email_verifying + correct code → ask_q_tos + verifiedAt (iter33 P2: verify→ToS, then ToS→role)", async () => {
  _resetOnboardingConfigCache()
  const correctCode = "654321"
  const codeHash = createHash("sha256").update(correctCode).digest("hex")
  const { store, captures } = makeFakeRunnerStore({
    async getUserEmailVerification() {
      return {
        codeHash,
        email: "user@example.com",
        sentAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        attempts: 0,
      }
    },
  })
  await runDeterministicOnboardingTurn({
    event: makeEvent(correctCode),
    store,
    turnId: "turn-6",
    onboardingUser: {
      id: "user-1",
      phoneE164: "+15551234567",
      onboardingState: "q_email_verifying",
    },
    cvParsed: false,
    agent: FAKE_AGENT,
  })
  const advance = captures.appliedSteps.find(
    (s) => s.step === "ask_q_tos" && s.opts.emailVerificationVerified === true
  )
  assert.ok(advance, "applyOnboarding(ask_q_tos, emailVerificationVerified=true) must fire")
  assert.match(captures.appendedMessages[0]!.body, /verified|✓|验过/i)
  // ack + ToS prompt chained
  assert.match(captures.appendedMessages[0]!.body, /privacy|隐私|legal|协议/i)
})

test("runDeterministicOnboardingTurn: q_email_verifying + wrong code → bumps attempts, stays", async () => {
  _resetOnboardingConfigCache()
  const codeHash = createHash("sha256").update("654321").digest("hex")
  const { store, captures } = makeFakeRunnerStore({
    async getUserEmailVerification() {
      return {
        codeHash,
        email: "user@example.com",
        sentAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        attempts: 2,
      }
    },
  })
  await runDeterministicOnboardingTurn({
    event: makeEvent("000000"),
    store,
    turnId: "turn-7",
    onboardingUser: {
      id: "user-1",
      phoneE164: "+15551234567",
      onboardingState: "q_email_verifying",
    },
    cvParsed: true,
    agent: FAKE_AGENT,
  })
  const failed = captures.appliedSteps.find(
    (s) => s.step === "ask_q_email_verify" && s.opts.emailVerificationFailed === true
  )
  assert.ok(failed, "applyOnboarding(ask_q_email_verify, emailVerificationFailed=true) must fire")
  assert.match(captures.appendedMessages[0]!.body, /try again|不对/i)
})

test("runDeterministicOnboardingTurn: q_email_verifying + expired challenge → re-issue code in place (iter32: do NOT bypass)", async () => {
  _resetOnboardingConfigCache()
  const codeHash = createHash("sha256").update("654321").digest("hex")
  const sentMailgun: Array<{ email: string }> = []
  const { store, captures } = makeFakeRunnerStore({
    async getUserEmailVerification() {
      return {
        codeHash,
        email: "user@example.com",
        sentAt: new Date(Date.now() - 60 * 60_000).toISOString(),
        expiresAt: new Date(Date.now() - 30 * 60_000).toISOString(),
        attempts: 1,
      }
    },
    async sendVerificationEmail(email: string) {
      sentMailgun.push({ email })
      return {
        rawCode: "789012",
        sentAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        providerMessageId: "msg_reissue",
      }
    },
  })
  await runDeterministicOnboardingTurn({
    event: makeEvent("654321"),
    store,
    turnId: "turn-8",
    onboardingUser: {
      id: "user-1",
      phoneE164: "+15551234567",
      onboardingState: "q_email_verifying",
    },
    cvParsed: false,
    agent: FAKE_AGENT,
  })
  // Mailgun re-fires
  assert.equal(sentMailgun.length, 1, "Mailgun must re-fire on expired")
  // State stays at q_email_verifying — applyOnboarding called with same step
  const reissue = captures.appliedSteps.find(
    (s) => s.step === "ask_q_email_verify" && s.opts.emailVerification !== undefined
  )
  assert.ok(reissue, "applyOnboarding(ask_q_email_verify, fresh emailVerification) must fire on reissue")
  // The new code's hash differs from the old hash
  const newHash = createHash("sha256").update("789012").digest("hex")
  assert.equal((reissue!.opts.emailVerification as { codeHash: string }).codeHash, newHash)
  // Reply mentions code resent
  assert.match(captures.appendedMessages[0]!.body, /resent|新的|fresh/i)
  const logEv = captures.logEvents.find(
    (e) => e.event === "pa.onboarding.deterministic.email_verify_reissued"
  )
  assert.equal(logEv?.payload?.reason, "expired")
})

test("runDeterministicOnboardingTurn: vent ack does NOT advance state, NO LLM", async () => {
  _resetOnboardingConfigCache()
  const { store, captures } = makeFakeRunnerStore()
  await runDeterministicOnboardingTurn({
    event: makeEvent("fuck this i give up"),
    store,
    turnId: "turn-9",
    onboardingUser: {
      id: "user-1",
      phoneE164: "+15551234567",
      onboardingState: "q_role_asked",
    },
    cvParsed: false,
    agent: FAKE_AGENT,
  })
  assert.equal(captures.appliedSteps.length, 0, "state MUST NOT advance on vent")
  assert.equal(captures.appendedMessages.length, 1)
  assert.ok(
    captures.appendedMessages[0]!.body.length <= 60,
    `vent ack should be short (got "${captures.appendedMessages[0]!.body}")`
  )
  const log = captures.logEvents.find(
    (e) => e.event === "pa.onboarding.deterministic.vent_suspended"
  )
  assert.ok(log, "vent_suspended log event must fire")
})

test("runDeterministicOnboardingTurn: complete + all gates → handled=false (caller activates agent runtime)", async () => {
  _resetOnboardingConfigCache()
  const { store } = makeFakeRunnerStore()
  const result = await runDeterministicOnboardingTurn({
    event: makeEvent("hey"),
    store,
    turnId: "turn-10",
    onboardingUser: {
      id: "user-1",
      phoneE164: "+15551234567",
      onboardingState: "complete",
      statedPreferences: {
        contactEmail: "user@example.com",
        contactEmailVerifiedAt: "2026-05-04T17:00:00.000Z",
      },
    },
    cvParsed: true,
    agent: FAKE_AGENT,
  })
  assert.equal(result.handled, false, "handled=false signals caller to activate agent runtime")
})
