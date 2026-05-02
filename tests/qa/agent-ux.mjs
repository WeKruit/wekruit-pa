#!/usr/bin/env node
/**
 * Phase 50 — Agent-UX
 *
 * For each persona, asserts the *would-be* first-reply (canned per persona)
 * conforms to Bible v7.5 voice rules using the deterministic helpers from
 * tests/scenarios/lib/voice-axes.mjs (the same module the Phase 33 judge
 * uses). This is a static assertion: we are testing the harness wiring +
 * fixture compliance, not generating new replies. Live mode (PA_QA_LIVE=1)
 * would push canned inbound through the broker — see DELIVERY.md.
 *
 * P0 assertions (failing any → exit non-zero):
 *   - filler blacklist clean (FILLER_BLACKLIST_ZH/EN, "X 还是 Y" framework)
 *   - imessage-render-safe (no markdown bold/list/code/links)
 *   - sentence cap respected (≤ 3)
 *   - no Bible NEVER-1 leakage (no internal flags / "as an AI" / etc.)
 *
 * P1 assertions (logged but not gating):
 *   - visa-question phrasing matches D5 friend-tone exactly
 *   - opener does NOT start with "你好" / "Hello" (Bible v7.5)
 *   - language ratio matches persona.language
 */
import { argv, exit } from "node:process"
import { randomUUID } from "node:crypto"
import { loadAllPersonas, loadPersonaById } from "./lib-personas.mjs"
import { writeAgentReport } from "./lib-report.mjs"
import {
  checkFillerBlacklist,
  checkIMessageRenderUnsafe,
} from "../scenarios/lib/voice-axes.mjs"
import { withinSentenceCap } from "../scenarios/lib/sentence-split.mjs"

// ---------------- helpers ----------------

const VISA_PHRASE_ZH = "那你有身份不"
const VISA_PHRASE_EN = "got work auth sorted"

const ZH_OPENERS_FORBIDDEN = ["你好", "您好"]
const EN_OPENERS_FORBIDDEN = ["hello", "hi there", "good morning"]

function startsWithForbidden(text, forbidden) {
  const lower = text.trim().toLowerCase()
  return forbidden.some((f) => lower.startsWith(f.toLowerCase()))
}

function ratioCjk(text) {
  let cjk = 0
  let alpha = 0
  for (const ch of text) {
    const code = ch.codePointAt(0)
    if (!code) continue
    if (code >= 0x4e00 && code <= 0x9fff) cjk += 1
    else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) alpha += 1
  }
  return cjk + alpha === 0 ? 0 : cjk / (cjk + alpha)
}

function assertPersona(persona) {
  const reply = persona.canned_first_reply ?? ""
  const visaQ = persona.canned_visa_question ?? ""

  const issues = []
  let pass = true
  let p0Bad = false

  // P0 #1 — filler blacklist
  const filler = checkFillerBlacklist(reply)
  if (filler.hit) {
    pass = false
    p0Bad = true
    issues.push(`P0 filler blacklist hit: "${filler.phrase}" (${filler.lang})`)
  }

  // P0 #2 — iMessage-render-unsafe
  const unsafe = checkIMessageRenderUnsafe(reply)
  if (unsafe.hit) {
    pass = false
    p0Bad = true
    issues.push(`P0 imessage render unsafe: ${unsafe.reason}`)
  }

  // P0 #3 — sentence cap (≤3)
  if (!withinSentenceCap(reply, 3)) {
    pass = false
    p0Bad = true
    issues.push("P0 sentence cap exceeded (>3)")
  }

  // P0 #4 — no internal-flag leak / "as an AI" already covered by filler;
  //   double-check a few extra patterns the judge checks.
  if (/\b(onboarding|statedPreferences|paFlag|hard[-_ ]?filter)\b/i.test(reply)) {
    pass = false
    p0Bad = true
    issues.push("P0 internal-flag/term leaked to user surface")
  }

  // P1 #1 — visa phrasing alignment with D5 (Phase 41 friend-tone opener)
  if (visaQ) {
    const expected = persona.language === "zh" ? VISA_PHRASE_ZH : VISA_PHRASE_EN
    if (!visaQ.includes(expected)) {
      issues.push(`P1 visa-question phrasing drift: missing "${expected}"`)
      pass = false
    }
  }

  // P1 #2 — opener forbidden
  const forbiddenOpeners = persona.language === "zh" ? ZH_OPENERS_FORBIDDEN : EN_OPENERS_FORBIDDEN
  if (startsWithForbidden(reply, forbiddenOpeners)) {
    issues.push(`P1 forbidden opener: starts with one of ${forbiddenOpeners.join("/")}`)
    pass = false
  }

  // P1 #3 — language ratio sanity
  const cjk = ratioCjk(reply)
  if (persona.language === "zh" && cjk < 0.3) {
    issues.push(`P1 language ratio: persona=zh but reply CJK ratio=${cjk.toFixed(2)}`)
    pass = false
  }
  if (persona.language === "en" && cjk > 0.2) {
    issues.push(`P1 language ratio: persona=en but reply CJK ratio=${cjk.toFixed(2)}`)
    pass = false
  }

  return {
    persona: persona.id,
    language: persona.language,
    pass,
    p0: p0Bad,
    details: issues.length === 0 ? "all checks ok" : issues.join("; "),
  }
}

// ---------------- main ----------------

function parseArgs() {
  const args = argv.slice(2)
  const out = { runId: process.env.QA_RUN_ID ?? `r-${Date.now()}`, persona: null }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--persona") out.persona = args[++i]
    else if (args[i] === "--run-id") out.runId = args[++i]
  }
  return out
}

const opts = parseArgs()
const personas = opts.persona ? [loadPersonaById(opts.persona)].filter(Boolean) : loadAllPersonas()
if (personas.length === 0) {
  console.error("agent-ux: no personas loaded")
  exit(2)
}

const results = personas.map(assertPersona)
const summary = writeAgentReport({ runId: opts.runId, agent: "ux", results })

console.log(`[agent-ux] ${summary.overall} — ${summary.passCount}/${summary.total} pass, ${summary.p0Failures} P0 fails`)
console.log(`[agent-ux] report: ${summary.path}`)
exit(summary.overall === "PASS" ? 0 : 1)
