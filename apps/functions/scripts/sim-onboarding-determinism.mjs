#!/usr/bin/env node
/**
 * iter33 spec collapse 2026-05-05 — Onboarding determinism stress sim.
 *
 * Adam directive: "需要测试,保证我们现在这个 workflow 一定是 deterministic 的,
 * 我们换顺序要会按正常走".
 *
 * Strategy:
 *   1. Build a fixed walkthrough script (same user msgs in same order)
 *   2. Run it N=20 times against runDeterministicOnboardingTurn
 *   3. Hash each run's full transcript (claire replies + state transitions)
 *   4. Assert all 20 hashes identical
 *
 * Anything non-deterministic (Math.random, Date.now without fixed seed,
 * shared mutable state, async race) WILL surface here as hash mismatch.
 *
 * Usage:
 *   node apps/functions/scripts/sim-onboarding-determinism.mjs
 *   node apps/functions/scripts/sim-onboarding-determinism.mjs --runs=50
 */
import { createHash, randomUUID } from "node:crypto"
import { runDeterministicOnboardingTurn } from "@pa/pa-orchestrator"

const RUNS = parseInt(
  (process.argv.find((a) => a.startsWith("--runs=")) ?? "--runs=20").split("=")[1],
  10
)

// Deterministic broker store. NO Date.now in user-facing transitions —
// applyOnboarding marks state changes without timestamps. Mailgun stub
// returns a fixed code so verify-success path is reproducible.
function makeStore({ knownVerificationCode = "654321" } = {}) {
  let user = {
    id: "user-determinism",
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
    async enqueueOutbound() {},
    async applyOnboarding(_uid, _phone, step, opts = {}) {
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
      if (opts.emailVerification) {
        user = {
          ...user,
          emailVerification: { ...opts.emailVerification, attempts: 0 },
        }
      }
      if (opts.emailVerificationVerified) {
        user = {
          ...user,
          statedPreferences: {
            ...user.statedPreferences,
            contactEmailVerifiedAt: "FIXED-TS",
          },
        }
      }
      if (opts.statedPreferencesPatch) {
        user = {
          ...user,
          statedPreferences: { ...user.statedPreferences, ...opts.statedPreferencesPatch },
        }
      }
      if (opts.tosAcceptance) {
        user = { ...user, tosAcceptance: opts.tosAcceptance }
      }
      const stateMap = {
        send_first_mes: "first_mes_sent",
        ask_q_tos: "q_tos_asked",
        ask_q_email: "q_email_asked",
        ask_q_email_verify_start: "q_email_verifying",
        verify_email_code: "q_tos_asked",
        ask_q_role: "q_role_asked",
        ask_q_yoe: "q_yoe_asked",
        ask_q_visa: "q_visa_asked",
        ask_q_startup_pref: "q_startup_pref_asked",
        ask_q_location: "q_location_asked",
        ask_q_resume: "q_resume_asked",
        send_cv_analysis: "complete",
        complete: "complete",
      }
      if (stateMap[step]) {
        user = { ...user, onboardingState: stateMap[step] }
      }
    },
    async getMessageHistory() {
      return []
    },
    async readPriorAskedStep() {
      return undefined
    },
    async getRuntimeMode() {
      return "auto"
    },
    async getTosVersion() {
      return "v1.0"
    },
    async sendVerificationEmail(email) {
      return {
        rawCode: knownVerificationCode,
        sentAt: "FIXED-TS",
        expiresAt: "FIXED-TS+30m",
        providerMessageId: "FIXED-MID",
      }
    },
    async getUserEmailVerification() {
      return user.emailVerification ?? null
    },
    log() {},
    db: undefined,
    // FIXED — never ticks in this sim. Anything reading wall clock is
    // forced to use this instead so stress runs are bit-stable.
    nowIso: () => "2026-05-05T00:00:00.000Z",
    nowMs: () => 1735689600000,
    randomId: () => "FIXED-RID",
  }
}

async function runOne(seed) {
  const store = makeStore()
  // Fixed agent stub
  const agent = {
    name: "claire",
    instructions: "(stub)",
    model: "qwen2.5-7b-instruct",
  }
  // Capture each turn's claire reply via a wrapping enqueueOutbound spy
  const transcript = []
  const wrappedStore = {
    ...store,
    enqueueOutbound: async (_uid, _to, body) => {
      transcript.push(`[claire] ${body}`)
    },
  }
  // Re-bind getter: spread loses get user accessor
  Object.defineProperty(wrappedStore, "user", {
    get: () => store.user,
  })

  // Fixed user message script — happy path en flow
  const script = [
    "hi",
    "english please",
    "alex@example.com",
    "654321",
    "agree",
    "swe backend",
    "5 years",
    "us citizen",
    "startup",
    "remote",
    "sent it",
  ]

  for (let i = 0; i < script.length; i++) {
    const userMsg = script[i]
    transcript.push(`[user-${i}] ${userMsg}`)
    transcript.push(`[state] ${wrappedStore.user.onboardingState ?? "pending"}`)
    // Trigger CV upload signal at script position 10 (after q_resume_asked)
    if (i === 10) wrappedStore.setCvParsed(true)
    const event = {
      id: `event-${i}-${seed}`,
      userId: "user-determinism",
      phone: "+15551234567",
      body: userMsg,
      receivedAt: "FIXED-TS",
      raw: { source: "stress" },
      rawMeta: {},
    }
    await runDeterministicOnboardingTurn({
      event,
      store: wrappedStore,
      turnId: `turn-${i}`,
      onboardingUser: {
        id: wrappedStore.user.id,
        phoneE164: wrappedStore.user.phoneE164,
        onboardingState: wrappedStore.user.onboardingState,
        statedPreferences: wrappedStore.user.statedPreferences,
      },
      cvParsed: wrappedStore.cvParsed(),
      agent,
    })
  }
  return transcript.join("\n")
}

const main = async () => {
  console.log(`▶ Running deterministic walkthrough × ${RUNS}…`)
  const results = []
  for (let r = 0; r < RUNS; r++) {
    const transcript = await runOne(r)
    const hash = createHash("sha256").update(transcript).digest("hex").slice(0, 16)
    results.push({ r, hash, len: transcript.length })
  }
  const firstHash = results[0].hash
  const allMatch = results.every((x) => x.hash === firstHash)
  console.log("")
  console.log("┌─────┬──────────────────┬──────────┐")
  console.log("│ run │ sha256 (16-char) │ bytes    │")
  console.log("├─────┼──────────────────┼──────────┤")
  for (const r of results) {
    const marker = r.hash === firstHash ? "  " : "✘ "
    console.log(`│${marker}${String(r.r).padStart(3)} │ ${r.hash} │ ${String(r.len).padStart(8)} │`)
  }
  console.log("└─────┴──────────────────┴──────────┘")
  console.log("")
  if (allMatch) {
    console.log(`✓ All ${RUNS} runs produced byte-identical transcripts.`)
    console.log(`  Workflow is DETERMINISTIC under fixed input.`)
    process.exit(0)
  } else {
    const distinct = new Set(results.map((r) => r.hash)).size
    console.error(`✘ ${distinct} distinct transcript hashes across ${RUNS} runs — NON-DETERMINISTIC`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error("stress sim fatal:", err)
  process.exit(2)
})
