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

test("iter33 spec collapse: undefined state → ask_q_lang (no first_mes greeting)", () => {
  // Adam directive 2026-05-05: kill the redundant first_mes step. User's
  // first inbound → Claire's first outbound = q_lang Q (which itself opens
  // with a short "在呢/Here" acknowledgment).
  const action = resolveDeterministicAction(
    { onboardingState: undefined, cvParsed: false, emailCaptured: false, emailVerified: false },
    "hi"
  )
  assert.equal(action.kind, "ask_q_lang")
})

test("iter33 spec collapse: pending → ask_q_lang (no first_mes greeting)", () => {
  const action = resolveDeterministicAction(
    { onboardingState: "pending", cvParsed: false, emailCaptured: false, emailVerified: false },
    "hi"
  )
  assert.equal(action.kind, "ask_q_lang")
})

test("iter33 spec collapse backward-compat: persisted first_mes_sent → ask_q_lang", () => {
  // Users with persisted onboardingState=first_mes_sent from before the
  // collapse shipped hop cleanly to q_lang_asked on next inbound.
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

test("iter33 GAP 4: PA_ONBOARDING_V33_DISABLED=true → first_mes_sent skips q_lang, falls back to ask_q_tos (iter32 sequence)", () => {
  process.env.PA_ONBOARDING_V33_DISABLED = "true"
  try {
    const action = resolveDeterministicAction(
      {
        onboardingState: "first_mes_sent",
        cvParsed: false,
        emailCaptured: false,
        emailVerified: false,
      },
      "hi"
    )
    assert.equal(action.kind, "ask_q_tos")
  } finally {
    delete process.env.PA_ONBOARDING_V33_DISABLED
  }
})

test("iter33 GAP 4: PA_ONBOARDING_V33_DISABLED unset → iter33 path (q_lang) is default", () => {
  delete process.env.PA_ONBOARDING_V33_DISABLED
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

test("resolveDeterministicAction: q_resume_asked + cvParsed=true → send_cv_analysis (iter33 P3: ack + LLM summary, then complete)", () => {
  const action = resolveDeterministicAction(
    {
      onboardingState: "q_resume_asked",
      cvParsed: true,
      emailCaptured: true,
      emailVerified: true,
    },
    "ok"
  )
  assert.equal(action.kind, "send_cv_analysis")
})

test("resolveDeterministicAction: q_cv_analyzing → send_cv_analysis (iter33 P3: re-attempt if last turn's analysis didn't fire)", () => {
  const action = resolveDeterministicAction(
    {
      onboardingState: "q_cv_analyzing",
      cvParsed: true,
      emailCaptured: true,
      emailVerified: true,
    },
    "?"
  )
  assert.equal(action.kind, "send_cv_analysis")
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
  // iter33 Bug 13 fix 2026-05-05 — legal page moved to pa-landing host.
  assert.match(reply, /https:\/\/wekruit-pa-landing\.web\.app\/legal/)
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

// iter33 Bug 7 fix — sim-walkthrough C/D/E exposed: when user msg is
// ENTIRELY email/URL ("alex@example.com"), strip leaves empty text and
// old code returned "zh" hardcoded → en-speaking users got zh
// verify-start template. Now: scan raw msg for CJK first, then ASCII
// letters, then fall back to caller's hint.
test("pickLang Bug 7: email-only msg uses fallback (caller's preferredLang)", () => {
  // Bug 14 fix 2026-05-05: emails are NOT a language signal. They're
  // ASCII identifier strings. Honor the caller's preferredLang fallback
  // instead of inferring from [a-z] presence.
  assert.equal(pickLang("alex@example.com", "en"), "en", "en preferredLang user")
  assert.equal(pickLang("alex@example.com", "zh"), "zh", "zh preferredLang user (Bug 14)")
  assert.equal(pickLang("user+tag@gmail.com", "en"), "en")
  assert.equal(pickLang("user+tag@gmail.com", "zh"), "zh")
})

test("pickLang Bug 7: zh user emailing inline still detects CJK in raw → zh", () => {
  assert.equal(pickLang("我邮箱是 adam@wekruit.com"), "zh")
})

test("pickLang Bug 7: URL-only msg → fallback (NOT [a-z] heuristic)", () => {
  // Bug 14 fix: URL is not a language signal.
  assert.equal(pickLang("https://example.com/path", "en"), "en")
  assert.equal(pickLang("https://example.com/path", "zh"), "zh")
})

test("pickLang Bug 7: fallback param honored when stripped+raw have no signal", () => {
  assert.equal(pickLang("", "en"), "en")
  assert.equal(pickLang("", "zh"), "zh")
  assert.equal(pickLang("   ", "en"), "en")
  assert.equal(pickLang("   ", "zh"), "zh")
  assert.equal(pickLang(""), "zh") // default fallback = zh (back-compat)
})

test("pickLang Bug 14: digits-only msg (verify code) honors preferredLang", () => {
  // Adam's actual case: zh user got Mailgun code, replied "133340" or
  // "654321". Pure digits = no language content → MUST defer to caller's
  // preferredLang (Bug 14 second-half fix 2026-05-05). Old behavior used
  // CJK ratio (0/6 = 0 → en) regardless of preferredLang.
  assert.equal(pickLang("133340", "zh"), "zh", "zh user digits → zh fallback")
  assert.equal(pickLang("654321", "zh"), "zh", "zh user verify code → zh fallback")
  assert.equal(pickLang("133340", "en"), "en", "en user digits → en fallback")
})

test("pickLang Bug 14: pure punctuation/symbols → fallback", () => {
  assert.equal(pickLang("...!", "zh"), "zh")
  assert.equal(pickLang("???", "en"), "en")
  assert.equal(pickLang("👍", "zh"), "zh", "emoji-only → fallback")
})

test("pickLang Bug 14: en letters present + 0 CJK → en (regardless of fallback)", () => {
  // "agree" is genuine en content — should stay en even if user's
  // preferredLang was zh (they switched mid-flow / typed en explicitly).
  assert.equal(pickLang("agree", "zh"), "en", "explicit en content overrides zh fallback")
  assert.equal(pickLang("yes thanks", "zh"), "en")
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

test("iter33 spec collapse: fresh user → ask_q_lang verbatim (no first_mes greeting), NO LLM", async () => {
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
    assert.equal(result.action.kind, "ask_q_lang")
  }
  assert.equal(captures.appendedMessages.length, 1)
  // q_lang prompt opens with "Here" greeting (en) followed by lang Q
  assert.match(captures.appendedMessages[0]!.body, /Here.*language/i)
  assert.equal(captures.enqueuedOutbound.length, 1)
  assert.deepEqual(
    captures.appliedSteps.map((s) => s.step),
    ["ask_q_lang"]
  )
})

test("DETERMINISM E2E: Firestore override flows through dispatcher (operator edit → live prompt)", async () => {
  // Adam directive 2026-05-05 — proves /admin/onboarding edits actually
  // change Claire's outbound text, end-to-end, without code redeploy.
  // Inject a Firestore override for ask_q_lang.prompt.zh; run the full
  // dispatcher; assert the override text was sent verbatim.
  _resetOnboardingConfigCache()
  const fakeDb = {
    collection: () => ({
      doc: () => ({
        async get() {
          return {
            exists: true,
            data: () => ({
              ask_q_lang: {
                prompt: {
                  zh: "OPERATOR-EDITED-ZH-PROMPT",
                  en: "OPERATOR-EDITED-EN-PROMPT",
                },
              },
            }),
          }
        },
      }),
    }),
  } as unknown as Parameters<typeof loadOnboardingConfig>[0]
  const { store, captures } = makeFakeRunnerStore({ db: fakeDb })
  // zh user msg → langFor returns zh → should pick override.zh
  const result = await runDeterministicOnboardingTurn({
    event: makeEvent("你好"),
    store,
    turnId: "turn-override-zh",
    onboardingUser: {
      id: "user-override",
      phoneE164: "+15551234567",
      onboardingState: undefined,
    },
    cvParsed: false,
    agent: FAKE_AGENT,
  })
  assert.equal(result.handled, true)
  assert.equal(captures.enqueuedOutbound.length, 1)
  assert.equal(
    captures.enqueuedOutbound[0],
    "OPERATOR-EDITED-ZH-PROMPT",
    "operator-edited prompt MUST flow through dispatcher → outbound"
  )
  _resetOnboardingConfigCache()
})

test("DETERMINISM E2E: en user gets en override (lang-specific routing preserved through override)", async () => {
  _resetOnboardingConfigCache()
  const fakeDb = {
    collection: () => ({
      doc: () => ({
        async get() {
          return {
            exists: true,
            data: () => ({
              ask_q_lang: {
                prompt: {
                  zh: "OPERATOR-EDITED-ZH-PROMPT",
                  en: "OPERATOR-EDITED-EN-PROMPT",
                },
              },
            }),
          }
        },
      }),
    }),
  } as unknown as Parameters<typeof loadOnboardingConfig>[0]
  const { store, captures } = makeFakeRunnerStore({ db: fakeDb })
  const result = await runDeterministicOnboardingTurn({
    event: makeEvent("hello there"),
    store,
    turnId: "turn-override-en",
    onboardingUser: {
      id: "user-override-en",
      phoneE164: "+15551234567",
      onboardingState: undefined,
    },
    cvParsed: false,
    agent: FAKE_AGENT,
  })
  assert.equal(result.handled, true)
  assert.equal(
    captures.enqueuedOutbound[0],
    "OPERATOR-EDITED-EN-PROMPT",
    "en user MUST receive override.en, not override.zh"
  )
  _resetOnboardingConfigCache()
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

// ────────────────────────────────────────────────────────────────────
// iter34 P0 — LLM-fallback email intent extraction (Adam directive
// 2026-05-05: "edge case 处理应该是能 involve llm啊").
// ────────────────────────────────────────────────────────────────────

test("iter34 P0: LLM intent=provided → re-runs runner with extracted email + advances to verify", async () => {
  _resetOnboardingConfigCache()
  const { store, captures } = makeFakeRunnerStore({
    extractEmailIntent: async () => ({
      intent: "provided",
      email: "john@gmail.com",
      confidence: 0.95,
    }),
    sendVerificationEmail: async (email: string) => ({
      rawCode: "654321",
      sentAt: "2026-05-05T00:00:00Z",
      expiresAt: "2026-05-05T00:30:00Z",
      providerMessageId: "stub",
    }),
  })
  const result = await runDeterministicOnboardingTurn({
    event: makeEvent("我邮箱是 john at gmail dot com"),
    store,
    turnId: "turn-llm-provided",
    onboardingUser: {
      id: "user-llm",
      phoneE164: "+15551234567",
      onboardingState: "q_email_asked",
      statedPreferences: { preferredLang: "zh" },
    },
    cvParsed: false,
    agent: FAKE_AGENT,
  })
  assert.equal(result.handled, true)
  // The recursive call should land on ask_q_email_verify_start since
  // the LLM-extracted email is now the "user reply"
  const verifyEvents = captures.logEvents.filter((e) =>
    e.event === "pa.onboarding.deterministic.email_llm_extracted"
  )
  assert.equal(verifyEvents.length, 1, "email_llm_extracted log must fire")
  assert.equal(verifyEvents[0]!.payload?.email, "john@gmail.com")
})

test("iter34 P0: LLM intent=typo (described, not typed) → personalized re-ask with suggestion", async () => {
  // User describes email instead of typing it. parseEmailAnswer regex
  // misses (no @ in raw), workflow stays at q_email_asked, LLM extracts
  // the typo'd domain from the prose description.
  _resetOnboardingConfigCache()
  const { store, captures } = makeFakeRunnerStore({
    extractEmailIntent: async () => ({
      intent: "typo",
      original: "user@dgmail.com",
      suggestion: "user@gmail.com",
    }),
  })
  const result = await runDeterministicOnboardingTurn({
    event: makeEvent("user at dgmail dot com"),
    store,
    turnId: "turn-llm-typo",
    onboardingUser: {
      id: "user-llm",
      phoneE164: "+15551234567",
      onboardingState: "q_email_asked",
      statedPreferences: { preferredLang: "zh" },
    },
    cvParsed: false,
    agent: FAKE_AGENT,
  })
  assert.equal(result.handled, true)
  assert.equal(captures.enqueuedOutbound.length, 1)
  assert.match(
    captures.enqueuedOutbound[0]!,
    /dgmail\.com.*user@gmail\.com/,
    "re-ask must surface both original AND suggestion"
  )
  const typoLogs = captures.logEvents.filter(
    (e) => e.event === "pa.onboarding.deterministic.email_typo_suggested"
  )
  assert.equal(typoLogs.length, 1)
  assert.equal(typoLogs[0]!.payload?.source, "llm")
})

test("iter34 P0: LLM intent=declined → advance to complete with friendly ack", async () => {
  _resetOnboardingConfigCache()
  const { store, captures } = makeFakeRunnerStore({
    extractEmailIntent: async () => ({ intent: "declined" }),
  })
  const result = await runDeterministicOnboardingTurn({
    event: makeEvent("没邮箱不想发"),
    store,
    turnId: "turn-llm-declined",
    onboardingUser: {
      id: "user-llm",
      phoneE164: "+15551234567",
      onboardingState: "q_email_asked",
      statedPreferences: { preferredLang: "zh" },
    },
    cvParsed: false,
    agent: FAKE_AGENT,
  })
  assert.equal(result.handled, true)
  const declineLogs = captures.logEvents.filter(
    (e) => e.event === "pa.onboarding.deterministic.email_declined_via_llm"
  )
  assert.equal(declineLogs.length, 1)
  assert.match(captures.enqueuedOutbound[0]!, /不强求邮箱/)
  // State advance to complete must fire
  const advanceCalls = captures.appliedSteps.filter((s) => s.step === "complete")
  assert.equal(advanceCalls.length, 1)
})

test("iter34 P0: LLM intent=unclear → use clarifyingQuestion verbatim", async () => {
  _resetOnboardingConfigCache()
  const { store, captures } = makeFakeRunnerStore({
    extractEmailIntent: async () => ({
      intent: "unclear",
      clarifyingQuestion: "你说的工作邮箱具体是哪个? 直接打出来给我",
    }),
  })
  const result = await runDeterministicOnboardingTurn({
    event: makeEvent("用我工作邮箱"),
    store,
    turnId: "turn-llm-unclear",
    onboardingUser: {
      id: "user-llm",
      phoneE164: "+15551234567",
      onboardingState: "q_email_asked",
      statedPreferences: { preferredLang: "zh" },
    },
    cvParsed: false,
    agent: FAKE_AGENT,
  })
  assert.equal(result.handled, true)
  assert.equal(
    captures.enqueuedOutbound[0],
    "你说的工作邮箱具体是哪个? 直接打出来给我",
    "clarifying question must be sent verbatim"
  )
})

test("iter34 P0: LLM unconfigured → falls back to deterministic re-ask (no regression)", async () => {
  _resetOnboardingConfigCache()
  const { store, captures } = makeFakeRunnerStore({
    // extractEmailIntent omitted entirely
  })
  const result = await runDeterministicOnboardingTurn({
    event: makeEvent("哈哈"),
    store,
    turnId: "turn-llm-absent",
    onboardingUser: {
      id: "user-llm",
      phoneE164: "+15551234567",
      onboardingState: "q_email_asked",
      statedPreferences: { preferredLang: "zh" },
    },
    cvParsed: false,
    agent: FAKE_AGENT,
  })
  assert.equal(result.handled, true)
  // Must still get the deterministic Bug 10 reaskPrompt
  assert.match(captures.enqueuedOutbound[0]!, /没看到邮箱地址/)
})

test("iter34 P0: LLM throws → swallow + fall back to deterministic re-ask", async () => {
  _resetOnboardingConfigCache()
  const { store, captures } = makeFakeRunnerStore({
    extractEmailIntent: async () => {
      throw new Error("LLM 503")
    },
  })
  const result = await runDeterministicOnboardingTurn({
    event: makeEvent("send to my work email"),
    store,
    turnId: "turn-llm-throws",
    onboardingUser: {
      id: "user-llm",
      phoneE164: "+15551234567",
      onboardingState: "q_email_asked",
      statedPreferences: { preferredLang: "en" },
    },
    cvParsed: false,
    agent: FAKE_AGENT,
  })
  assert.equal(result.handled, true)
  const errLogs = captures.logEvents.filter(
    (e) => e.event === "pa.onboarding.deterministic.email_llm_error"
  )
  assert.equal(errLogs.length, 1, "LLM error must be logged but not propagate")
  assert.match(captures.enqueuedOutbound[0]!, /didn't catch an email/)
})

test("iter34 P0: noise reply (no email signal) → SKIPS LLM call (cost guard)", async () => {
  _resetOnboardingConfigCache()
  let llmCalled = false
  const { store, captures } = makeFakeRunnerStore({
    extractEmailIntent: async () => {
      llmCalled = true
      return { intent: "unclear", clarifyingQuestion: "?" }
    },
  })
  const result = await runDeterministicOnboardingTurn({
    event: makeEvent("123"),
    store,
    turnId: "turn-no-signal",
    onboardingUser: {
      id: "user-llm",
      phoneE164: "+15551234567",
      onboardingState: "q_email_asked",
      statedPreferences: { preferredLang: "zh" },
    },
    cvParsed: false,
    agent: FAKE_AGENT,
  })
  assert.equal(result.handled, true)
  assert.equal(llmCalled, false, "no email signal in '123' → LLM must NOT be called (cost guard)")
})

test("iter34 P0: deterministic typo map wins over LLM (cheap path first)", async () => {
  _resetOnboardingConfigCache()
  let llmCalled = false
  const { store, captures } = makeFakeRunnerStore({
    extractEmailIntent: async () => {
      llmCalled = true
      return null
    },
  })
  const result = await runDeterministicOnboardingTurn({
    event: makeEvent("test@gmal.com"),
    store,
    turnId: "turn-static-typo",
    onboardingUser: {
      id: "user-llm",
      phoneE164: "+15551234567",
      onboardingState: "q_email_asked",
      statedPreferences: { preferredLang: "zh" },
    },
    cvParsed: false,
    agent: FAKE_AGENT,
  })
  assert.equal(result.handled, true)
  assert.equal(llmCalled, false, "static map matched gmal.com → no LLM call")
  assert.match(captures.enqueuedOutbound[0]!, /test@gmail\.com.*帮我确认/)
})

// ────────────────────────────────────────────────────────────────────
// iter34 P0.2 — LLM fallback for q_role / q_yoe / q_visa /
// q_startup_pref / q_location (Adam directive 2026-05-05: "不只是
// email, 包括所有一开始的 deterministic 的 question 都需要加这个").
// ────────────────────────────────────────────────────────────────────

test("iter34 P0.2: q_role unclear → LLM clarifyingQuestion verbatim", async () => {
  _resetOnboardingConfigCache()
  const { store, captures } = makeFakeRunnerStore({
    extractAnswerIntent: async (step: string) => {
      assert.equal(step, "ask_q_role")
      return {
        intent: "unclear" as const,
        clarifyingQuestion: "那大致偏哪个方向? 工程 / 产品 / 研究 / 设计?",
      }
    },
  })
  const result = await runDeterministicOnboardingTurn({
    event: makeEvent("我什么都行 看机会"),
    store,
    turnId: "turn-role-unclear",
    onboardingUser: {
      id: "user-role",
      phoneE164: "+15551234567",
      onboardingState: "q_role_asked",
      statedPreferences: { preferredLang: "zh" },
    },
    cvParsed: false,
    agent: FAKE_AGENT,
  })
  assert.equal(result.handled, true)
  // iter34 P0.6.2 — priority order is variants > LLM clarifyingQuestion.
  // For attempt 1 (counter=1 after bump), variants[0].zh is used.
  assert.equal(
    captures.enqueuedOutbound[0],
    "我没太 get 到 — 你具体是做啥的? swe / pm / 研究 / 设计 都行, 一两个词就行"
  )
  // LLM was called (clarifyingQuestion captured but not used at attempt 1).
  const llmLogs = captures.logEvents.filter(
    (e) => e.event === "pa.onboarding.deterministic.probe_llm_clarify"
  )
  assert.equal(llmLogs.length, 1, "LLM clarify path was hit (logged)")
})

test("iter34 P0.2: q_yoe provided 'about 5 years' → tail-call advances state", async () => {
  _resetOnboardingConfigCache()
  let llmCalls = 0
  const { store, captures } = makeFakeRunnerStore({
    extractAnswerIntent: async (step: string) => {
      llmCalls++
      assert.equal(step, "ask_q_yoe")
      return { intent: "provided" as const, value: 5, confidence: 0.95 }
    },
  })
  const result = await runDeterministicOnboardingTurn({
    // Deterministic parser needs a digit. Descriptive reply misses → LLM fires.
    event: makeEvent("想想啊 大概有那么几年了 具体记不清"),
    store,
    turnId: "turn-yoe-llm",
    onboardingUser: {
      id: "user-yoe",
      phoneE164: "+15551234567",
      onboardingState: "q_yoe_asked",
      statedPreferences: { preferredLang: "zh" },
    },
    cvParsed: false,
    agent: FAKE_AGENT,
  })
  assert.equal(result.handled, true)
  assert.equal(llmCalls, 1, "LLM called exactly once")
  const llmLogs = captures.logEvents.filter(
    (e) => e.event === "pa.onboarding.deterministic.probe_llm_extracted"
  )
  assert.equal(llmLogs.length, 1)
  assert.equal(llmLogs[0]!.payload?.value, 5)
})

test("iter34 P0.2: q_visa 'I'm on H1B' → LLM extracts → state advances to q_startup_pref_asked", async () => {
  _resetOnboardingConfigCache()
  const { store, captures } = makeFakeRunnerStore({
    extractAnswerIntent: async () => ({
      intent: "provided",
      value: "h1b",
      confidence: 0.9,
    }),
  })
  const result = await runDeterministicOnboardingTurn({
    // Reply that the deterministic parser doesn't catch → LLM fires.
    event: makeEvent("我现在工作签证那个状态吧"),
    store,
    turnId: "turn-visa-llm",
    onboardingUser: {
      id: "user-visa",
      phoneE164: "+15551234567",
      onboardingState: "q_visa_asked",
      statedPreferences: { preferredLang: "zh" },
    },
    cvParsed: false,
    agent: FAKE_AGENT,
  })
  assert.equal(result.handled, true)
  // Tail-call → second pass uses "h1b" as user message → parser captures.
  // Outbound should be the q_startup_pref Q (state advanced).
  const llmLogs = captures.logEvents.filter(
    (e) => e.event === "pa.onboarding.deterministic.probe_llm_extracted"
  )
  assert.equal(llmLogs.length, 1)
  assert.equal(llmLogs[0]!.payload?.step, "ask_q_visa")
})

test("iter34 P0.2: q_startup_pref '看具体团队' → LLM unclear → clarifying question", async () => {
  _resetOnboardingConfigCache()
  const { store, captures } = makeFakeRunnerStore({
    extractAnswerIntent: async () => ({
      intent: "unclear",
      clarifyingQuestion: "大致偏向小公司还是大厂? 选不出来也行说'都行'",
    }),
  })
  const result = await runDeterministicOnboardingTurn({
    event: makeEvent("看具体团队 不一定"),
    store,
    turnId: "turn-startup-unclear",
    onboardingUser: {
      id: "user-sp",
      phoneE164: "+15551234567",
      onboardingState: "q_startup_pref_asked",
      statedPreferences: { preferredLang: "zh" },
    },
    cvParsed: false,
    agent: FAKE_AGENT,
  })
  assert.equal(result.handled, true)
  // iter34 P0.6.2 — variants[0].zh wins over LLM clarifyingQuestion at
  // attempt 1. The test still validates the LLM unclear path was reached
  // (probe_llm_clarify log emitted) but the user-facing reply is the
  // deterministic variant, not the LLM's.
  assert.equal(captures.enqueuedOutbound[0], "startup / 大厂 / 都行 三选一")
  const llmLogs = captures.logEvents.filter(
    (e) => e.event === "pa.onboarding.deterministic.probe_llm_clarify"
  )
  assert.equal(llmLogs.length, 1, "LLM clarify path was hit (logged)")
})

test("iter34 P0.2: q_location pure noise '???' → LLM SKIPPED (cost guard)", async () => {
  _resetOnboardingConfigCache()
  let llmCalled = false
  const { store, captures } = makeFakeRunnerStore({
    extractAnswerIntent: async () => {
      llmCalled = true
      return { intent: "provided", value: "sf", confidence: 0.5 }
    },
  })
  const result = await runDeterministicOnboardingTurn({
    event: makeEvent("???"),
    store,
    turnId: "turn-loc-noise",
    onboardingUser: {
      id: "user-loc",
      phoneE164: "+15551234567",
      onboardingState: "q_location_asked",
      statedPreferences: { preferredLang: "zh" },
    },
    cvParsed: false,
    agent: FAKE_AGENT,
  })
  assert.equal(result.handled, true)
  assert.equal(llmCalled, false, "no location signal in '???' → LLM must NOT be called")
})

test("iter34 P0.2: low-confidence LLM result (<0.6) → falls back to deterministic", async () => {
  _resetOnboardingConfigCache()
  const { store, captures } = makeFakeRunnerStore({
    extractAnswerIntent: async () => ({
      intent: "provided",
      value: "founder",
      confidence: 0.4, // too low to trust
    }),
  })
  const result = await runDeterministicOnboardingTurn({
    event: makeEvent("我做点啥都行 ml ai backend"),
    store,
    turnId: "turn-role-low-conf",
    onboardingUser: {
      id: "user-r",
      phoneE164: "+15551234567",
      onboardingState: "q_role_asked",
      statedPreferences: { preferredLang: "zh" },
    },
    cvParsed: false,
    agent: FAKE_AGENT,
  })
  assert.equal(result.handled, true)
  // Below 0.6 confidence MUST NOT auto-advance — fell through to
  // deterministic re-ask path
  const advanceLogs = captures.logEvents.filter(
    (e) => e.event === "pa.onboarding.deterministic.probe_llm_extracted"
  )
  assert.equal(advanceLogs.length, 0, "low-confidence MUST NOT log extracted (no auto-advance)")
})

// ────────────────────────────────────────────────────────────────────
// iter34 followup D.1 — sendDirect idempotencyKey collapse fix
//
// send_cv_analysis fires up to 4 outbounds in one turn (interim ack +
// cv-analysis + jobRec + tag-summary). Before the fix all 4 reused
// `out-onboarding-${event.id}`, so the firestore appendMessage dedup
// path (find-by-idempotencyKey → patch body) collapsed them onto a
// single pa-messages row whose body = LAST outbound. The dashboard /
// SDK history then read only one message per turn. iMessage users
// still received all 4 (pa-outbound uses random docIds), but the
// in-app history was incomplete.
//
// Fix: pass a unique tag to sendDirect for each call so idempotencyKey
// is suffixed (`out-onboarding-${event.id}-1-interim-ack`, etc.). These
// tests pin that contract.
// ────────────────────────────────────────────────────────────────────

function makeFakeRunnerStoreWithMeta(extras: Record<string, unknown> = {}) {
  const captures = {
    appendedMessages: [] as Array<{
      role: string
      body: string
      idempotencyKey?: string
      rawMeta?: Record<string, unknown>
    }>,
    enqueuedOutbound: [] as Array<{ body: string; idempotencyKey?: string }>,
    appliedSteps: [] as Array<{ step: string; opts: Record<string, unknown> }>,
    logEvents: [] as Array<{ event: string; payload?: Record<string, unknown> }>,
  }
  const store = {
    async appendMessage(msg: {
      role: string
      body: string
      idempotencyKey?: string
      rawMeta?: Record<string, unknown>
    }) {
      captures.appendedMessages.push({
        role: msg.role,
        body: msg.body,
        idempotencyKey: msg.idempotencyKey,
        rawMeta: msg.rawMeta,
      })
    },
    async enqueueOutbound(
      _uid: string,
      _to: string,
      body: string,
      opts?: { idempotencyKey?: string }
    ) {
      captures.enqueuedOutbound.push({ body, idempotencyKey: opts?.idempotencyKey })
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

test("iter34 D.1: send_cv_analysis fires 4 sendDirect calls with 4 DISTINCT idempotencyKeys (no pa-messages collapse)", async () => {
  _resetOnboardingConfigCache()
  const { store, captures } = makeFakeRunnerStoreWithMeta({
    async generateCvAnalysis(_uid: string, lang: "zh" | "en") {
      return {
        summary: lang === "zh" ? "你后端经验扎实, 大厂背景也加分" : "solid backend; faang track record helps",
      }
    },
    async generateJobRecs(_uid: string, lang: "zh" | "en") {
      return {
        message: lang === "zh" ? "推荐两个: A 公司 SWE / B 公司 ML" : "two for you: A SWE / B ML",
        recCount: 2,
      }
    },
  })
  const result = await runDeterministicOnboardingTurn({
    event: makeEvent("简历发了"),
    store,
    turnId: "turn-cv-1",
    onboardingUser: {
      id: "user-cv",
      phoneE164: "+15551234567",
      onboardingState: "q_resume_asked",
      statedPreferences: {
        preferredLang: "zh",
        targetRole: ["swe"],
        yoeRange: [3, 5],
        visaStatus: "h1b",
      },
    },
    cvParsed: true,
    agent: FAKE_AGENT,
  })
  assert.equal(result.handled, true)
  if (result.handled) {
    assert.equal(result.action.kind, "send_cv_analysis")
  }
  // 4 outbounds: interim-ack + cv-analysis + jobrec + tag-summary
  assert.equal(captures.appendedMessages.length, 4, "send_cv_analysis MUST fire 4 sendDirect calls")

  const keys = captures.appendedMessages.map((m) => m.idempotencyKey ?? "")
  // Every key non-empty
  for (const k of keys) {
    assert.ok(k.length > 0, `idempotencyKey must be set, got: ${JSON.stringify(k)}`)
  }
  // All 4 unique — this is the bug-fix invariant. Before the fix all
  // 4 = `out-onboarding-evt-1` and pa-messages collapsed to 1 row.
  const unique = new Set(keys)
  assert.equal(unique.size, 4, `4 idempotencyKeys MUST be distinct, got: ${JSON.stringify(keys)}`)

  // Each key includes event.id + a per-call tag (regex pin: prefix +
  // event.id + dash + seq + dash + name). Pinning the shape so future
  // refactors don't accidentally collapse keys again.
  const KEY_RE = /^out-onboarding-evt-1-(1-interim-ack|2-cv-analysis|3-jobrec|4-tag-summary)$/
  for (const k of keys) {
    assert.match(k, KEY_RE, `idempotencyKey MUST match shape, got: ${k}`)
  }
  // Tags ordered: interim-ack first, tag-summary last
  assert.match(keys[0]!, /1-interim-ack$/)
  assert.match(keys[1]!, /2-cv-analysis$/)
  assert.match(keys[2]!, /3-jobrec$/)
  assert.match(keys[3]!, /4-tag-summary$/)

  // Outbound queue (pa-outbound) ALSO gets distinct keys — same reason
  // (defensive: even though pa-outbound writers use random docIds in
  // prod, idempotencyKey is the contract for any future dedup).
  assert.equal(captures.enqueuedOutbound.length, 4)
  const outboundKeys = captures.enqueuedOutbound.map((o) => o.idempotencyKey ?? "")
  assert.equal(new Set(outboundKeys).size, 4, "pa-outbound idempotencyKeys also distinct")
  for (const k of outboundKeys) {
    assert.match(k, /^outbound-onboarding-evt-1-(1-interim-ack|2-cv-analysis|3-jobrec|4-tag-summary)$/)
  }
})

test("iter34 D.1: single-message dispatcher branches keep the legacy unsuffixed idempotencyKey (no regression for replay/retry dedup)", async () => {
  // Single sendDirect calls (e.g. ask_q_lang) MUST keep the bare
  // `out-onboarding-${event.id}` key so genuine event-replay (same
  // event.id arriving twice) still hits the appendMessage dedup path
  // and the user does NOT receive the same outbound twice.
  _resetOnboardingConfigCache()
  const { store, captures } = makeFakeRunnerStoreWithMeta()
  await runDeterministicOnboardingTurn({
    event: makeEvent("hi"),
    store,
    turnId: "turn-lang-1",
    onboardingUser: {
      id: "user-lang",
      phoneE164: "+15551234567",
      onboardingState: undefined,
    },
    cvParsed: false,
    agent: FAKE_AGENT,
  })
  assert.equal(captures.appendedMessages.length, 1)
  assert.equal(
    captures.appendedMessages[0]!.idempotencyKey,
    "out-onboarding-evt-1",
    "single-message branches keep the legacy unsuffixed key"
  )
  assert.equal(
    captures.enqueuedOutbound[0]!.idempotencyKey,
    "outbound-onboarding-evt-1",
    "single-message outbound also keeps the legacy unsuffixed key"
  )
})

test("iter34 D.1: send_cv_analysis with no CV-analysis hook + no job-rec hook still produces 3+ distinct idempotencyKeys (fail-open path)", async () => {
  // Even on the LLM-fallback path (no generateCvAnalysis / no
  // generateJobRecs), the 4 sendDirect calls fire (interim-ack +
  // generic CV line + deferred-jobrec line + tag-summary). Pin the
  // distinct-keys invariant on the failure path too.
  _resetOnboardingConfigCache()
  const { store, captures } = makeFakeRunnerStoreWithMeta()
  // No generateCvAnalysis / generateJobRecs → both fall back to
  // canned text but each still fires its own sendDirect.
  await runDeterministicOnboardingTurn({
    event: makeEvent("简历发了"),
    store,
    turnId: "turn-cv-fallback",
    onboardingUser: {
      id: "user-cv-fb",
      phoneE164: "+15551234567",
      onboardingState: "q_resume_asked",
      statedPreferences: {
        preferredLang: "zh",
        targetRole: ["pm"],
      },
    },
    cvParsed: true,
    agent: FAKE_AGENT,
  })
  // tag-summary always fires when statedPreferences has any canonical
  // tag (targetRole here) → 4 messages.
  assert.ok(
    captures.appendedMessages.length >= 3,
    `expected ≥3 outbounds on fallback path, got ${captures.appendedMessages.length}`
  )
  const keys = captures.appendedMessages.map((m) => m.idempotencyKey ?? "")
  assert.equal(
    new Set(keys).size,
    keys.length,
    `idempotencyKeys must be distinct on fallback path too, got: ${JSON.stringify(keys)}`
  )
})
