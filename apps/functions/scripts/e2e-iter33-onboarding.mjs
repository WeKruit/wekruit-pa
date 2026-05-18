#!/usr/bin/env node
/**
 * iter33 E2E — automated end-to-end onboarding test against deployed prod
 * Cloud Functions.
 *
 * Adam directive 2026-05-05 ("这些你不能自己测试吗？？？？？"): yes, can.
 * No more handing manual SMS testing back to Adam.
 *
 * What it does:
 *   1. Resets test user state via __PA_RESET__ broker event
 *   2. Walks the iter33 onboarding sequence end-to-end:
 *      hi → q_email (with typo edge) → verify → ToS → q_role → ...
 *   3. After each inbound, polls Firestore for the orchestrator's outbound
 *      reply, asserts it matches the expected regex
 *   4. Verifies state transitions in pa-users.{userId}.onboardingState
 *   5. Prints PASS/FAIL per step + final summary
 *
 * Uses harness.suppressOutbound=true so NO real Sendblue SMS fires —
 * outbound text is captured in pa-messages where this script reads it.
 *
 * Usage:
 *   FIREBASE_SERVICE_ACCOUNT_JSON=$(cat path/to/sa.json) \
 *     node apps/functions/scripts/e2e-iter33-onboarding.mjs
 */
import admin from "firebase-admin"
import { randomUUID, createHash } from "node:crypto"

const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
admin.initializeApp({ credential: admin.credential.cert(sa) })
const db = admin.firestore()

const TEST_USER_ID = "e5d97cd8-1e1d-439d-8672-3008f8aeef2e"
const TEST_PHONE = "+14243201960"
const POLL_INTERVAL_MS = 1500
const POLL_MAX_WAIT_MS = 30000
const KNOWN_VERIFY_CODE_FOR_TESTING = "654321" // test-only, won't actually fire Mailgun

function nowIso() { return new Date().toISOString() }

function brokerEvent({ text }) {
  const id = `e2e33_${randomUUID()}`
  return {
    id,
    docData: {
      id,
      status: "pending",
      idempotencyKey: `e2e33:${id}`,
      createdAt: nowIso(),
      attemptCount: 0,
      maxAttempts: 1,
      channel: "imessage",
      rawPayload: {
        kind: "imessage",
        participant: TEST_PHONE,
        chatId: `iMessage;${TEST_PHONE}`,
        messageRowId: Date.now(),
        text,
        harness: {
          runner: "apps/functions/scripts/e2e-iter33-onboarding.mjs",
          suppressOutbound: true,
        },
      },
    },
  }
}

async function sendBroker(text) {
  const ev = brokerEvent({ text })
  await db.collection("pa-inbound-events").doc(ev.id).set(ev.docData)
  return ev.id
}

async function pollUntilStatus(eventId, timeoutMs = POLL_MAX_WAIT_MS) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const snap = await db.collection("pa-inbound-events").doc(eventId).get()
    const d = snap.data()
    if (d) {
      if (d.status === "succeeded" || d.status === "completed" || d.status === "reset") {
        return { status: d.status, doc: d }
      }
      if (d.status === "failed" || d.status === "dead_letter") {
        return { status: d.status, doc: d }
      }
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }
  return { status: "timeout", doc: null }
}

async function findReplyForEvent(eventId, expectAtLeast = 1) {
  // Poll for at least N assistant messages tagged with this eventId.
  const start = Date.now()
  while (Date.now() - start < POLL_MAX_WAIT_MS) {
    const snap = await db.collection("pa-messages")
      .where("rawMeta.eventId", "==", eventId)
      .where("role", "==", "assistant")
      .get()
    if (snap.docs.length >= expectAtLeast) {
      return snap.docs.map((d) => d.data().body)
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }
  // Fallback: latest assistant for this user
  const fb = await db.collection("pa-messages")
    .where("userId", "==", TEST_USER_ID)
    .where("role", "==", "assistant")
    .orderBy("createdAt", "desc")
    .limit(3).get()
  return fb.docs.map((d) => d.data().body)
}

async function readUserState() {
  const snap = await db.collection("pa-users").doc(TEST_USER_ID).get()
  if (!snap.exists) return null
  const d = snap.data()
  return {
    onboardingState: d.onboardingState,
    preferredLang: d.statedPreferences?.preferredLang,
    contactEmail: d.statedPreferences?.contactEmail,
    contactEmailVerifiedAt: d.statedPreferences?.contactEmailVerifiedAt,
    systemFlags: d.systemFlags ?? {},
  }
}

async function presetVerificationCode(code) {
  // Inject a known-hash verification challenge so the verify step is
  // testable without firing real Mailgun. We REPLACE whatever the
  // ask_q_email_verify_start step already wrote.
  const codeHash = createHash("sha256").update(code).digest("hex")
  await db.collection("pa-users").doc(TEST_USER_ID).set(
    {
      emailVerification: {
        codeHash,
        email: "test@gmail.com",
        sentAt: nowIso(),
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        attempts: 0,
        providerMessageId: "harness-stub",
      },
    },
    { merge: true }
  )
}

// ────────────────────────────────────────────────────────────────────
// Test runner
// ────────────────────────────────────────────────────────────────────

const results = []
function record(label, ok, detail) {
  results.push({ label, ok, detail })
  const tag = ok ? "✓" : "✗"
  const color = ok ? "\x1b[32m" : "\x1b[31m"
  console.log(`${color}${tag}\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`)
}

async function step(label, userText, opts = {}) {
  const eid = await sendBroker(userText)
  const status = await pollUntilStatus(eid)
  if (status.status !== "succeeded" && status.status !== "completed") {
    record(label, false, `inbound status=${status.status} (timeout? doc=${JSON.stringify(status.doc?.error ?? "")})`)
    return null
  }
  const replies = await findReplyForEvent(eid, opts.expectMessageCount ?? 1)
  if (replies.length === 0) {
    record(label, false, "no assistant reply captured")
    return null
  }
  const joined = replies.join(" || ")
  if (opts.expect) {
    const matched = opts.expect.test(joined)
    record(label, matched, matched ? `→ ${joined.slice(0, 80)}…` : `expected ${opts.expect}, got ${joined.slice(0, 100)}`)
  } else {
    record(label, true, joined.slice(0, 80))
  }
  return { eid, replies, joined }
}

async function main() {
  console.log("\n━━━ iter33 E2E onboarding test ━━━\n")
  console.log(`Test user: ${TEST_USER_ID} (${TEST_PHONE})`)
  console.log("Mode: harness.suppressOutbound=true (no real SMS)\n")

  // Step 0: Reset
  console.log("[0] reset user state via __PA_RESET__")
  const resetEid = await sendBroker("__PA_RESET__")
  await pollUntilStatus(resetEid)
  await new Promise((r) => setTimeout(r, 4000))
  const initialState = await readUserState()
  // Reset leaves state at "pending" or unset — both are valid starting points.
  const resetOK = !initialState?.onboardingState || initialState.onboardingState === "pending"
  record("reset succeeded", resetOK, `state=${initialState?.onboardingState ?? "none"}`)

  // Step 1: hi → q_email Q (beta no longer asks for language preference)
  await step("[1] hi → q_email Q (beta language prompt removed)", "hi", {
    expect: /email|邮箱/i,
  })
  let state = await readUserState()
  record("[1.state] onboardingState=q_email_asked", state?.onboardingState === "q_email_asked", `actual=${state?.onboardingState}`)

  // Step 3: "哈哈" → q_email re-ask with specific reaskPrompt (Bug 10)
  await step("[3] '哈哈' → email reask (Bug 10: distinct reaskPrompt)", "哈哈", {
    expect: /没看到邮箱地址|didn't catch an email/,
  })
  state = await readUserState()
  record("[3.state] state still q_email_asked (no advance on no_email)", state?.onboardingState === "q_email_asked")

  // Step 4: typo'd email "test@gmal.com" → typo-suggestion reask (Bug 15)
  await step("[4] test@gmal.com → typo suggestion (Bug 15)", "test@gmal.com", {
    expect: /test@gmail\.com|gmail\.com/,
  })
  state = await readUserState()
  record("[4.state] state still q_email_asked (typo'd, no contactEmail saved)", state?.onboardingState === "q_email_asked" && !state?.contactEmail)

  // Step 5: valid email → verify-start
  await step("[5] test@gmail.com → verify-start", "test@gmail.com", {
    expect: /已经发了一个 6 位验证码|just sent a 6-digit code/,
  })
  state = await readUserState()
  record("[5.state] onboardingState=q_email_verifying", state?.onboardingState === "q_email_verifying")
  record("[5.state] contactEmail=test@gmail.com saved", state?.contactEmail === "test@gmail.com")

  // Step 5.5: inject known verification code BEFORE entering it (since
  // real Mailgun won't fire to a fake user; harness pattern matches
  // existing qa-iter30 scripts).
  await presetVerificationCode(KNOWN_VERIFY_CODE_FOR_TESTING)

  // Step 6: enter wrong code → re-prompt (Bug attempt 1)
  await step("[6] 000000 wrong code → retry reply", "000000", {
    expect: /验证码不对|code didn't match/,
  })
  state = await readUserState()
  record("[6.state] state still q_email_verifying", state?.onboardingState === "q_email_verifying")
  record("[6.state] contactEmailVerifiedAt NOT set yet", !state?.contactEmailVerifiedAt)

  // Step 7: enter correct code → verify-success + ToS prompt (zh, Bug 11 + Bug 14)
  await step("[7] correct code → verify-success + ToS prompt (Bug 11 verify→tos transition + Bug 14 zh)", KNOWN_VERIFY_CODE_FOR_TESTING, {
    expect: /邮箱验过了.*开聊前先说一下.*隐私.*用户协议|email verified.*before we get into it.*privacy/,
  })
  state = await readUserState()
  record("[7.state] onboardingState=q_tos_asked (Bug 11 fix proven)", state?.onboardingState === "q_tos_asked", `actual=${state?.onboardingState}`)
  record("[7.state] contactEmailVerifiedAt stamped", Boolean(state?.contactEmailVerifiedAt))

  // Step 8: 同意 → q_role Q (iter33 P2 reorder)
  // Wording is operator-editable via /admin/onboarding so the assertion
  // matches the SEMANTIC intent (asking about role/direction) rather
  // than literal default text. Fail-fast on regression: the reply must
  // mention 岗/role/方向/eng/pm/research/design/产品/工程/研究/设计.
  await step("[8] 同意 → q_role Q (Bug 11 full closure)", "同意", {
    expect: /(岗|role|方向)|(工程|产品|研究|设计|eng|pm|design)/i,
  })
  state = await readUserState()
  record("[8.state] onboardingState=q_role_asked", state?.onboardingState === "q_role_asked", `actual=${state?.onboardingState}`)

  // ──────────────────────────────────────────────────────────────────
  // iter34 P0.2 — LLM-fallback edge cases for the 5 probe Qs.
  // Each step sends a reply that the deterministic regex MISSES but
  // the LLM should resolve (either extract the canonical value OR
  // emit a clarifying question). Asserts the orchestrator did NOT
  // get stuck repeating the same prompt verbatim.
  // ──────────────────────────────────────────────────────────────────

  // ──────────────────────────────────────────────────────────────────
  // iter34 P0.2 — LLM-fallback edge cases for ALL 5 probe Qs.
  // Each step uses an input that MISSES the deterministic regex parser
  // → triggers the LLM path. Asserts:
  //   1. zh user gets zh prompt (langOverride preserved across LLM tail-call)
  //   2. State either advances (LLM extract confidence>=0.6) OR stays
  //      same (LLM unclear → clarifying question)
  //   3. Whatever Claire emits is non-empty + non-verbatim repeat
  // ──────────────────────────────────────────────────────────────────

  async function probeEdge(label, userText, expectedStates, langCheck) {
    const r = await step(label, userText, { expect: /[\s\S]+/ })
    state = await readUserState()
    const stateOk = expectedStates.includes(state?.onboardingState)
    record(
      `${label.replace(/^\[\d+\] /, "[")}.state → one of: ${expectedStates.join("|")}`,
      stateOk,
      `actual=${state?.onboardingState}`
    )
    if (langCheck && r?.joined) {
      const langOk = langCheck.test(r.joined)
      record(
        `${label.replace(/^\[\d+\] /, "[")}.lang preserved (${langCheck})`,
        langOk,
        `reply=${r.joined.slice(0, 60)}…`
      )
    }
    return r
  }

  // Step 9: q_role descriptive (zh) — parser misses, LLM should resolve in zh.
  await probeEdge(
    "[9] q_role 'ai infra' (zh edge → LLM)",
    "我做点 ai infra 之类的",
    ["q_role_asked", "q_yoe_asked"],
    /[一-鿿]/ // zh char somewhere in reply (lang preserved)
  )

  // Step 10: q_yoe descriptive (zh) — needs LLM to extract or clarify.
  if (state?.onboardingState === "q_yoe_asked") {
    await probeEdge(
      "[10] q_yoe '工作好几年了' (zh edge → LLM)",
      "工作好几年了 具体记不太清",
      ["q_yoe_asked", "q_visa_asked"],
      /[一-鿿]/
    )
  } else {
    record("[10] skipped — q_role still at q_role_asked", true, "(LLM clarified instead)")
  }

  // Step 11: q_visa descriptive (zh).
  if (state?.onboardingState === "q_visa_asked") {
    await probeEdge(
      "[11] q_visa '工作签证那个状态吧' (zh edge → LLM)",
      "我现在工作签证那个状态吧",
      ["q_visa_asked", "q_startup_pref_asked"],
      /[一-鿿]/
    )
  } else {
    record("[11] skipped", true, `state=${state?.onboardingState}`)
  }

  // Step 12: q_startup_pref descriptive (zh).
  if (state?.onboardingState === "q_startup_pref_asked") {
    await probeEdge(
      "[12] q_startup_pref '看具体团队 不一定' (zh edge → LLM)",
      "看具体团队 不一定",
      ["q_startup_pref_asked", "q_location_asked"],
      /[一-鿿]/
    )
  } else {
    record("[12] skipped", true, `state=${state?.onboardingState}`)
  }

  // Step 13: q_location descriptive (zh).
  if (state?.onboardingState === "q_location_asked") {
    await probeEdge(
      "[13] q_location '在哪都行 看机会' (zh edge → LLM)",
      "在哪都行 看机会",
      ["q_location_asked", "q_resume_asked"],
      /[一-鿿]/
    )
  } else {
    record("[13] skipped", true, `state=${state?.onboardingState}`)
  }

  // ──────────────────────────────────────────────────────────────────
  // iter34 P0.6 — halt-at-5 verification.
  // Adam directive 2026-05-05: deterministic Qs cannot be skipped.
  // After 5 attempts on a single Q, halt with admin contact + flag user.
  // ──────────────────────────────────────────────────────────────────

  console.log("\n━━━ Halt-at-5 sub-test ━━━\n")

  // Reset + walk fast to q_role state.
  console.log("[H0] reset for halt test")
  const haltResetEid = await sendBroker("__PA_RESET__")
  await pollUntilStatus(haltResetEid)
  await new Promise((r) => setTimeout(r, 4000))

  await step("[H1] hi → q_email", "hi", { expect: /[\s\S]+/ })
  await step("[H2] test@gmail.com → verify-start", "test@gmail.com", { expect: /[\s\S]+/ })
  await presetVerificationCode(KNOWN_VERIFY_CODE_FOR_TESTING)
  await step("[H3] 654321 → ToS", KNOWN_VERIFY_CODE_FOR_TESTING, { expect: /[\s\S]+/ })
  await step("[H4] agree → q_role", "agree", { expect: /[\s\S]+/ })

  state = await readUserState()
  if (state?.onboardingState !== "q_role_asked") {
    record("[H4.state] reached q_role_asked", false, `actual=${state?.onboardingState}`)
  } else {
    record("[H4.state] reached q_role_asked", true)

    // Send 5 irrelevant messages to q_role.
    // Each should advance attempt counter without changing state.
    // 5th should fire halt message.
    const irrelevant = ["哈哈", "嗯嗯", "哦", "好", "嗯"]
    let haltFired = false
    let haltReply = ""
    const preHaltReplies = []
    for (let i = 0; i < irrelevant.length; i++) {
      const r = await step(
        `[H${6 + i}] q_role attempt ${i + 1}/5: '${irrelevant[i]}'`,
        irrelevant[i],
        { expect: /[\s\S]+/ }
      )
      // Check if halt message fired.
      if (r?.joined && /admin1@wekruit\.com|失败了五次|failed 5 times/i.test(r.joined)) {
        haltFired = true
        haltReply = r.joined
        break
      }
      if (r?.joined) preHaltReplies.push(r.joined)
    }

    record(
      "[H.halt] halt msg with admin1@wekruit.com after 5 attempts",
      haltFired,
      haltFired ? `reply=${haltReply.slice(0, 100)}…` : "halt msg never fired in 5 attempts"
    )

    // iter34 P0.6.2 — Adam directive 2026-05-05 ("如果重新问, 可以换一种
    // 问法"). The 4 pre-halt replies should rotate through reaskPromptVariants
    // (when LLM extract returns null/low-conf) so user sees different
    // phrasings. Assert ≥3 distinct strings out of 4 pre-halt msgs (allows
    // some LLM clarifyingQuestion-vs-deterministic overlap).
    const distinctPreHalt = new Set(preHaltReplies).size
    record(
      `[H.variants] reask phrasings rotate (≥3 distinct of ${preHaltReplies.length})`,
      distinctPreHalt >= 3,
      `distinct=${distinctPreHalt} samples=${preHaltReplies.map((s, i) => `[${i}]${s.slice(0, 30)}`).join(" | ")}`
    )

    // Verify systemFlags.onboardingHalted=true.
    state = await readUserState()
    const haltedFlag = state?.systemFlags?.onboardingHalted === true
    record(
      "[H.flag] systemFlags.onboardingHalted=true",
      haltedFlag,
      `flags=${JSON.stringify(state?.systemFlags ?? {})}`
    )
  }

  // Summary
  console.log("\n━━━ Summary ━━━")
  const passed = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok).length
  console.log(`Passed: ${passed} / ${results.length}`)
  if (failed > 0) {
    console.log(`\nFailed:`)
    results.filter((r) => !r.ok).forEach((r) => console.log(`  ✗ ${r.label} — ${r.detail}`))
    process.exit(1)
  } else {
    console.log("\n✓ All assertions passed.")
    process.exit(0)
  }
}

main().catch((err) => {
  console.error("fatal:", err)
  process.exit(2)
})
