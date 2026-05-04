#!/usr/bin/env node
/**
 * iter32 new-user walkthrough simulator.
 *
 * Adam directive 2026-05-04 ("can you run some onboarding and new user
 * simulation?"): walks a fictional new user through every turn of the
 * deterministic onboarding flow, prints the actual reply Claire would
 * send. Uses the in-memory fake store + the real
 * runDeterministicOnboardingTurn so the transcript matches what biz
 * testers will see post-deploy.
 *
 * Runs 4 walkthroughs:
 *   A. Happy path — zh user, all answers correct, full sequence
 *   B. Happy path — en user, all answers correct, full sequence
 *   C. ToS decline → re-engage → accept → continue
 *   D. Email-verify miss + miss + correct → continue
 *
 * Usage: node apps/functions/scripts/sim-new-user-walkthrough.mjs
 */
import { createHash, randomUUID } from "node:crypto"
import { runDeterministicOnboardingTurn } from "@pa/pa-orchestrator"

// ────────────────────────────────────────────────────────────────────
// In-memory store. Tracks state across turns so subsequent inbounds
// see the advance from the prior turn.
// ────────────────────────────────────────────────────────────────────
function makeStore({ knownVerificationCode = "654321" } = {}) {
  let user = {
    id: "user-walkthrough",
    phoneE164: "+15551234567",
    onboardingState: undefined,
    statedPreferences: {},
    emailVerification: undefined,
    tosAcceptance: undefined,
  }
  let cvParsed = false

  return {
    get user() {
      return user
    },
    setCvParsed(v) {
      cvParsed = v
    },
    cvParsed: () => cvParsed,
    async appendMessage() {},
    async enqueueOutbound(_uid, _to, body) {
      // captured per-turn via the runner's return; nothing to do here
      this._lastOutbound = body
    },
    _lastOutbound: null,
    async applyOnboarding(_uid, _phone, step, opts = {}) {
      // Advance state per the iter32 sequence + handle special opts.
      if (opts.suspendedForVent) return
      if (opts.emailVerificationFailed) {
        user = {
          ...user,
          emailVerification: {
            ...(user.emailVerification ?? {}),
            attempts: (user.emailVerification?.attempts ?? 0) + 1,
          },
        }
        return
      }
      const TRANSITIONS = {
        send_first_mes: "first_mes_sent",
        ask_q_tos: "q_tos_asked",
        ask_q_email: "q_email_asked",
        ask_q_email_verify: "q_email_verifying",
        ask_q_role: "q_role_asked",
        ask_q_yoe: "q_yoe_asked",
        ask_q_visa: "q_visa_asked",
        ask_q_startup_pref: "q_startup_pref_asked",
        ask_q_location: "q_location_asked",
        ask_q_resume: "q_resume_asked",
        complete: "complete",
      }
      const next = TRANSITIONS[step] ?? user.onboardingState
      const updates = { onboardingState: next }
      if (opts.tosAcceptedVersion) {
        updates.tosAcceptance = {
          version: opts.tosAcceptedVersion,
          acceptedAt: new Date().toISOString(),
        }
      }
      if (opts.tosDeclined) {
        updates.tosAcceptance = {
          version: "declined",
          declinedAt: new Date().toISOString(),
        }
      }
      if (opts.emailVerification) {
        updates.emailVerification = {
          ...opts.emailVerification,
          attempts: 0,
        }
      }
      if (opts.emailVerificationVerified) {
        updates.emailVerification = null
        updates.statedPreferences = {
          ...(user.statedPreferences ?? {}),
          contactEmailVerifiedAt: new Date().toISOString(),
        }
      }
      user = { ...user, ...updates }
    },
    async getTosVersion() {
      return "v1.0"
    },
    async getUserEmailVerification() {
      return user.emailVerification ?? null
    },
    async sendVerificationEmail(email) {
      return {
        rawCode: knownVerificationCode,
        sentAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        providerMessageId: "msg_sim",
      }
    },
    log() {},
    nowIso() {
      return new Date().toISOString()
    },
  }
}

// ────────────────────────────────────────────────────────────────────
// Capture-aware appendMessage so we can print Claire's reply.
// ────────────────────────────────────────────────────────────────────
function makeStoreWithCapture(opts = {}) {
  const store = makeStore(opts)
  let lastReply = null
  store.appendMessage = async (msg) => {
    if (msg.role === "assistant") lastReply = msg.body
  }
  store.lastReply = () => lastReply
  store.clearReply = () => {
    lastReply = null
  }
  return store
}

function makeEvent(body, sessionId = "ses-w") {
  return {
    id: `evt-${randomUUID().slice(0, 8)}`,
    userId: "user-walkthrough",
    sessionId,
    channel: "imessage",
    externalChatId: "+15551234567",
    from: "+15551234567",
    body,
    status: "pending",
    createdAt: new Date().toISOString(),
    idempotencyKey: `idem-${randomUUID().slice(0, 8)}`,
    rawMeta: {},
  }
}

const FAKE_AGENT = { id: "claire", name: "Claire" }

const RESET = "\x1b[0m"
const DIM = "\x1b[2m"
const BOLD = "\x1b[1m"
const CYAN = "\x1b[36m"
const GREEN = "\x1b[32m"
const YELLOW = "\x1b[33m"
const MAGENTA = "\x1b[35m"

function turnHeader(n, label) {
  console.log(
    `\n${DIM}─── T${n}${label ? ` · ${label}` : ""} ───${RESET}`
  )
}

async function turn(store, userBody, label) {
  store.clearReply()
  const result = await runDeterministicOnboardingTurn({
    event: makeEvent(userBody),
    store,
    turnId: `turn-${randomUUID().slice(0, 8)}`,
    onboardingUser: {
      id: store.user.id,
      phoneE164: store.user.phoneE164,
      onboardingState: store.user.onboardingState,
      statedPreferences: store.user.statedPreferences,
    },
    cvParsed: store.cvParsed(),
    agent: FAKE_AGENT,
  })
  console.log(`${CYAN}user${RESET}    ${userBody}`)
  if (result.handled === false) {
    console.log(
      `${MAGENTA}claire${RESET}  ${DIM}(onboarding complete — agent runtime would activate here)${RESET}`
    )
  } else {
    const reply = store.lastReply()
    const stateAfter = store.user.onboardingState ?? "(undefined)"
    console.log(`${MAGENTA}claire${RESET}  ${reply ?? "(no reply)"}`)
    console.log(
      `${DIM}        action=${result.action.kind}  state→${stateAfter}${RESET}`
    )
  }
  return result
}

function header(label) {
  console.log(`\n${BOLD}${YELLOW}━━━ ${label} ━━━${RESET}`)
}

// ────────────────────────────────────────────────────────────────────
// Walkthroughs
// ────────────────────────────────────────────────────────────────────

async function walkthroughZhHappy() {
  header("Walkthrough A — Happy path (zh, all answers correct)")
  const store = makeStoreWithCapture()
  let n = 0
  await turn(store, "你好", `T${n++}`)
  await turn(store, "在不", `T${n++}`)
  await turn(store, "同意", `T${n++}`) // ToS accept → email step
  await turn(store, "我邮箱是 adam@wekruit.com", `T${n++}`) // email captured → verify
  await turn(store, "654321", `T${n++}`) // verified → role question
  await turn(store, "swe 后端", `T${n++}`) // role → yoe
  await turn(store, "5年", `T${n++}`) // yoe → visa
  await turn(store, "h1b", `T${n++}`) // visa → startup
  await turn(store, "大厂稳一点", `T${n++}`) // startup → location
  await turn(store, "湾区", `T${n++}`) // location → resume
  await turn(store, "好我去发简历", `T${n++}`) // CV gate hold
  // Simulate Sendblue webhook → cv-ingest writes parsedCandidateResumes
  store.setCvParsed(true)
  console.log(
    `${DIM}        [out-of-band: user uploads CV, cv-ingest pipeline parses it, parsedCandidateResumes row written]${RESET}`
  )
  await turn(store, "发了", `T${n++}`) // → complete
  await turn(store, "你能帮我看下 JD 吗", `T${n++}`) // agent runtime activates
}

async function walkthroughEnHappy() {
  header("Walkthrough B — Happy path (en, all answers correct)")
  const store = makeStoreWithCapture()
  let n = 0
  await turn(store, "hey there", `T${n++}`)
  await turn(store, "what's up?", `T${n++}`)
  await turn(store, "agree", `T${n++}`)
  await turn(store, "alex@example.com works", `T${n++}`)
  await turn(store, "654321", `T${n++}`)
  await turn(store, "pm — product manager", `T${n++}`)
  await turn(store, "8 years", `T${n++}`)
  await turn(store, "us citizen", `T${n++}`)
  await turn(store, "startup vibe", `T${n++}`)
  await turn(store, "NYC or remote", `T${n++}`)
  await turn(store, "ok sending", `T${n++}`)
  store.setCvParsed(true)
  console.log(
    `${DIM}        [out-of-band: user uploads CV, cv-ingest pipeline parses it]${RESET}`
  )
  await turn(store, "sent", `T${n++}`)
  await turn(store, "got any pm roles in fintech?", `T${n++}`)
}

async function walkthroughTosDeclineThenAccept() {
  header("Walkthrough C — ToS decline → re-engage → accept")
  const store = makeStoreWithCapture()
  let n = 0
  await turn(store, "hey", `T${n++}`)
  await turn(store, "lol idk", `T${n++}`) // → ToS prompt
  await turn(store, "no thanks i don't agree", `T${n++}`) // decline
  await turn(store, "actually how does this work", `T${n++}`) // unclear → re-ask
  await turn(store, "agree", `T${n++}`) // accept → email
  await turn(store, "alex@example.com", `T${n++}`) // verify
  await turn(store, "654321", `T${n++}`) // verified
  console.log(
    `${DIM}        [continues with role probe — truncating walkthrough here for brevity]${RESET}`
  )
}

async function walkthroughVerifyMissThenCorrect() {
  header("Walkthrough D — Email verify: 2 wrong codes, then correct")
  const store = makeStoreWithCapture()
  let n = 0
  await turn(store, "hi", `T${n++}`)
  await turn(store, "yes", `T${n++}`) // first_mes_sent → ToS
  await turn(store, "agree", `T${n++}`)
  await turn(store, "alex@example.com", `T${n++}`) // → verify
  await turn(store, "111111", `T${n++}`) // wrong
  await turn(store, "222222", `T${n++}`) // wrong
  await turn(store, "654321", `T${n++}`) // correct
  console.log(
    `${DIM}        [verified — would now continue with role probe]${RESET}`
  )
}

async function walkthroughVent() {
  header("Walkthrough E — Vent mid-probe (state stays)")
  const store = makeStoreWithCapture()
  let n = 0
  await turn(store, "hey", `T${n++}`)
  await turn(store, "yo", `T${n++}`)
  await turn(store, "agree", `T${n++}`)
  await turn(store, "alex@example.com", `T${n++}`)
  await turn(store, "654321", `T${n++}`)
  // Now at q_role_asked. User vents.
  await turn(store, "fuck this i just got laid off i'm exhausted", `T${n++}`)
  console.log(
    `${DIM}        [vent ack, state stayed at q_role_asked. User can continue when ready.]${RESET}`
  )
  await turn(store, "ok let me try. swe backend i guess", `T${n++}`)
}

async function main() {
  await walkthroughZhHappy()
  await walkthroughEnHappy()
  await walkthroughTosDeclineThenAccept()
  await walkthroughVerifyMissThenCorrect()
  await walkthroughVent()
  console.log(
    `\n${BOLD}${GREEN}✓ All walkthroughs complete.${RESET} Run 'less' or scroll up to read transcripts.`
  )
}

main().catch((err) => {
  console.error("walkthrough fatal:", err)
  process.exit(1)
})
