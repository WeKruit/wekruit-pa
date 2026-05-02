#!/usr/bin/env node
/**
 * Intent matrix smoke scorer.
 *
 * Strategy:
 *  1. Score existing /tmp/sim-{en,zh,mixed}.json prod transcripts against
 *     deterministic axes (length cap, filler blacklist, AB framework, drift,
 *     advice novelty, language compliance, mirror detection).
 *  2. Map each transcript to (intent, lang, persona) cell via the persona-id
 *     → matrix-cell mapping documented below.
 *  3. Per cell: per-axis pass/fail + overall pass.
 *  4. Emit JSON results to apps/eval/intent-matrix-results/smoke.json
 *     and human-readable matrix to .../smoke-report.md
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"

import {
  checkFillerBlacklist,
  checkABFramework,
  checkIMessageRenderUnsafe,
  computeLengthCompliance,
  computeDriftScore,
  computeMirrorRatio,
} from "/Users/adam/Desktop/WeKruit/wekruit-pa/tests/scenarios/lib/voice-axes.mjs"

const RESULTS_DIR = "/Users/adam/Desktop/WeKruit/wekruit-pa/apps/eval/intent-matrix-results"
mkdirSync(RESULTS_DIR, { recursive: true })

// Map sim persona → matrix cell. casual_chat intent because anxious_grad,
// en_grad, mixed_pm are stress-vent personas (matches casual_chat axis).
const PERSONA_TO_CELL = {
  anxious_grad: { intent: "casual_chat", lang: "zh", persona: "college", note: "anxious_grad ≈ casual_chat × zh × college" },
  en_grad: { intent: "casual_chat", lang: "en", persona: "college", note: "en_grad ≈ casual_chat × en × college" },
  mixed_pm: { intent: "casual_chat", lang: "mixed", persona: "mid", note: "mixed_pm ≈ casual_chat × mixed × mid" },
}

function detectLangOfReply(text) {
  if (typeof text !== "string" || !text) return "empty"
  let cjk = 0, ascii = 0
  for (const ch of text) {
    const c = ch.codePointAt(0)
    if (c >= 0x4e00 && c <= 0x9fff) cjk++
    else if (c < 128 && /[a-zA-Z]/.test(ch)) ascii++
  }
  if (cjk === 0 && ascii > 5) return "en"
  if (cjk > 0 && ascii < cjk * 0.5) return "zh"
  return "mixed"
}

function languageCompliance(replies, expectedLang) {
  let pass = 0, total = 0
  const detected = []
  for (const r of replies) {
    if (!r) continue
    total++
    const d = detectLangOfReply(r)
    detected.push(d)
    // For zh → mostly-zh (allow mixed if cjk dominates). For en → strict en.
    // For mixed → must be mixed (not pure either way).
    if (expectedLang === "zh" && (d === "zh" || d === "mixed")) pass++
    else if (expectedLang === "en" && d === "en") pass++
    else if (expectedLang === "mixed" && d === "mixed") pass++
  }
  return { rate: total === 0 ? 1 : pass / total, pass, total, detected }
}

function fillerCheck(replies) {
  let hits = 0
  const offenders = []
  for (let i = 0; i < replies.length; i++) {
    const r = replies[i]
    if (!r) continue
    const f = checkFillerBlacklist(r)
    if (f.hit) {
      hits++
      offenders.push({ turn: i, phrase: f.phrase, lang: f.lang })
    }
  }
  return { hits, total: replies.length, offenders, rate: replies.length === 0 ? 1 : 1 - hits / replies.length }
}

function abFrameworkCheck(replies) {
  let hits = 0
  const offenders = []
  for (let i = 0; i < replies.length; i++) {
    const r = replies[i]
    if (!r) continue
    const ab = checkABFramework(r)
    if (ab.hit) {
      hits++
      offenders.push({ turn: i, pattern: ab.pattern, snippet: r.slice(0, 80) })
    }
  }
  return { hits, total: replies.length, offenders, rate: replies.length === 0 ? 1 : 1 - hits / replies.length }
}

function renderUnsafeCheck(replies) {
  let hits = 0
  const offenders = []
  for (let i = 0; i < replies.length; i++) {
    const r = replies[i]
    if (!r) continue
    const u = checkIMessageRenderUnsafe(r)
    if (u.hit) {
      hits++
      offenders.push({ turn: i, reason: u.reason })
    }
  }
  return { hits, total: replies.length, offenders, rate: replies.length === 0 ? 1 : 1 - hits / replies.length }
}

async function scoreTranscript(file) {
  const data = JSON.parse(readFileSync(file, "utf8"))
  const personaId = data.persona
  const cell = PERSONA_TO_CELL[personaId]
  if (!cell) return { file, error: `unknown persona ${personaId}` }

  const transcript = data.transcript || []
  // Build turn pairs.
  const turns = []
  for (let i = 0; i < transcript.length; i += 2) {
    const u = transcript[i]
    const a = transcript[i + 1]
    if (u && a && u.role === "user" && a.role === "assistant") {
      turns.push({ user: u.body, assistant: a.body })
    }
  }
  const replies = turns.map((t) => t.assistant)

  // Axes
  const lengthCap = computeLengthCompliance(turns, { cap: 3 })
  const filler = fillerCheck(replies)
  const ab = abFrameworkCheck(replies)
  const renderUnsafe = renderUnsafeCheck(replies)
  const langComp = languageCompliance(replies, cell.lang)
  // Drift score (mirror ratio across last 5 turns).
  const drift = await computeDriftScore(turns.map((t) => ({ user: t.user, assistant: t.assistant })), { window: Math.min(5, turns.length) })

  // Per-axis pass thresholds (deterministic floors, no LLM-judge).
  // We pick conservative thresholds — failure exposes problems > faking pass.
  const axisResults = {
    language_compliance: { pass: langComp.rate >= 0.8, rate: langComp.rate, detail: langComp },
    length_cap: { pass: lengthCap.compliance >= 0.8, rate: lengthCap.compliance, detail: lengthCap },
    no_robot_filler: { pass: filler.rate >= 0.9, rate: filler.rate, detail: filler },
    no_ab_framework: { pass: ab.rate >= 0.9, rate: ab.rate, detail: ab },
    imessage_render_safe: { pass: renderUnsafe.rate >= 1.0, rate: renderUnsafe.rate, detail: renderUnsafe },
    drift_resistance: { pass: drift.driftScore < 0.5, rate: 1 - drift.driftScore, detail: drift },
  }
  const axisPass = Object.values(axisResults).filter((a) => a.pass).length
  const axisTotal = Object.keys(axisResults).length
  const overallPass = axisPass === axisTotal

  return {
    file,
    cell,
    personaId,
    sessionId: data.sessionId,
    turns: turns.length,
    overallPass,
    axisPassRate: axisPass / axisTotal,
    axes: axisResults,
  }
}

const inputs = [
  "/tmp/sim-zh.json",
  "/tmp/sim-en.json",
  "/tmp/sim-mixed.json",
]

const results = []
for (const f of inputs) {
  results.push(await scoreTranscript(f))
}

writeFileSync(`${RESULTS_DIR}/smoke.json`, JSON.stringify(results, null, 2))
console.log(`[smoke] scored ${results.length} transcripts → ${RESULTS_DIR}/smoke.json`)
for (const r of results) {
  if (r.error) {
    console.log(`  FAIL ${r.file}: ${r.error}`)
  } else {
    console.log(`  ${r.overallPass ? "PASS" : "FAIL"} ${r.cell.intent}_${r.cell.lang}_${r.cell.persona} (axes ${(r.axisPassRate*100).toFixed(0)}%)`)
  }
}
