/**
 * Phase 39 — Claire-stack adapter (composes Phase 35-38 modules in-process).
 *
 * Same `chat({ messages, opts })` interface as qwen-7b-adapter so benchmark
 * runners are arm-agnostic. Internally:
 *
 *   1. Call Qwen-7B base via sf-client to get raw draft
 *   2. Phase 35 detectors (`runAllDetectors`) — apply F1/F2 strip on result
 *   3. Phase 36 ImperfectionInjector (`injectImperfection`) — turn-onset
 *      injection per arm (default `control` for benchmark — no injection)
 *   4. Phase 37 FSM (`runFsm`) — compute strategy directive (logged in meta;
 *      drives next-turn prompt context — runner consumes via opts.history)
 *   5. Phase 38 Memory Policy (`runMemoryPolicy`) — compute repeat score;
 *      if `triggered`, single re-roll with diversity nudge
 *
 * 1 re-roll max → fail-open after that.
 *
 * Imports from `@pa/pa-orchestrator/dist/voice/...` since the package's
 * `exports` field only exposes the root entry. Direct `dist/` paths are
 * stable post-`npm run build --workspace=@pa/pa-orchestrator`.
 *
 * @typedef {import("./sf-client.mjs").ChatMessage} ChatMessage
 * @typedef {import("./sf-client.mjs").ChatResult} ChatResult
 *
 * @typedef {Object} AdapterChatOpts
 * @property {number} [temperature]
 * @property {number} [max_tokens]
 * @property {number} [top_p]
 * @property {string} [benchmark]
 * @property {string} [userId]
 * @property {string[]} [history]      // last N Claire replies for F4 + memory
 * @property {string} [userLang]       // "zh" | "en" | "mixed"
 * @property {number} [turnNumber]     // 1-indexed for FSM stage mapping
 * @property {typeof fetch} [fetchImpl]
 *
 * @typedef {Object} ClaireStackResult
 * @property {string} text
 * @property {{ inputTokens: number, outputTokens: number, costUSD: number }} usage
 * @property {{
 *   arm: "claire-stack",
 *   model: string,
 *   pipeline: string[],
 *   detectorTriggered: string[],
 *   injectorApplied: boolean,
 *   uxState: string|null,
 *   strategy: string|null,
 *   repeatTriggered: boolean,
 *   reroll: boolean,
 * }} meta
 */

import { chatCompletion as defaultChatCompletion } from "./sf-client.mjs"

// Direct imports of Phase 35-38 compiled modules (post `npm run build --workspace=@pa/pa-orchestrator`).
// We import via relative paths since `@pa/pa-orchestrator` package exports
// only the root entry; subpath imports require explicit `exports` map.
// Resolved via the workspace symlink in node_modules.
// eslint-disable-next-line import/no-relative-packages
import { runAllDetectors } from "../../../../packages/pa-orchestrator/dist/voice/detectors/index.js"
// eslint-disable-next-line import/no-relative-packages
import { injectImperfection } from "../../../../packages/pa-orchestrator/dist/voice/imperfection-injector/index.js"
// eslint-disable-next-line import/no-relative-packages
import { runFsm } from "../../../../packages/pa-orchestrator/dist/voice/fsm/index.js"
// eslint-disable-next-line import/no-relative-packages
import { runMemoryPolicy } from "../../../../packages/pa-orchestrator/dist/voice/memory-policy/index.js"

import { QWEN_7B_MODEL } from "./qwen-7b-adapter.mjs"

export const CLAIRE_STACK_ARM = "claire-stack"

/**
 * Apply F1 verb-mirror strip — drops sentence boundaries that overlap
 * heavily with the user turn. Simple rule: walk sentences, drop those
 * whose char-3gram set intersects the user turn ratio > threshold.
 *
 * Conservative — only trims first matching sentence to keep replies
 * substantive (don't strip the entire reply).
 *
 * @param {string} text
 * @param {string} userTurn
 * @returns {string}
 */
function stripVerbMirrorEcho(text, userTurn) {
  if (!text || !userTurn) return text
  // Split by zh/en sentence terminators (terminator + optional whitespace).
  const sentences = splitSentences(text)
  if (sentences.length <= 1) return text

  // Build user 3-gram set
  /** @type {Set<string>} */
  const userGrams = new Set()
  for (let i = 0; i + 3 <= userTurn.length; i++) {
    userGrams.add(userTurn.slice(i, i + 3))
  }

  /** @type {string[]} */
  const kept = []
  for (const s of sentences) {
    if (!s.trim()) continue
    /** @type {Set<string>} */
    const grams = new Set()
    for (let i = 0; i + 3 <= s.length; i++) grams.add(s.slice(i, i + 3))
    if (grams.size === 0) {
      kept.push(s)
      continue
    }
    let overlap = 0
    for (const g of grams) if (userGrams.has(g)) overlap += 1
    const ratio = overlap / grams.size
    // Drop sentence with high overlap; keep otherwise.
    if (ratio < 0.5) kept.push(s)
  }
  // Fail-open: if we'd drop everything, return original.
  if (kept.length === 0) return text
  return kept.join(" ").trim()
}

/**
 * Apply F2 length cap — truncate to first N sentences.
 * @param {string} text
 * @param {number} cap
 * @returns {string}
 */
function stripLengthCap(text, cap = 3) {
  if (!text) return text
  const sentences = splitSentences(text)
  if (sentences.length <= cap) return text
  return sentences.slice(0, cap).join(" ").trim()
}

/**
 * Minimal sentence splitter — terminator + lookahead to capture each
 * sentence as `[content][terminator]`. Mirrors Phase 33 helper roughly.
 * @param {string} text
 * @returns {string[]}
 */
function splitSentences(text) {
  if (!text) return []
  // Walk char-by-char, accumulating until a terminator. Greedy regex
  // approach hits trouble because `[^terminator]+` is greedy across
  // intervening whitespace+terminator-runs of different chars.
  /** @type {string[]} */
  const out = []
  let buf = ""
  const terminators = new Set(["。", "！", "？", "!", "?", "."])
  for (const ch of text) {
    buf += ch
    if (terminators.has(ch)) {
      const trimmed = buf.trim()
      if (trimmed.length > 0) out.push(trimmed)
      buf = ""
    }
  }
  const tail = buf.trim()
  if (tail.length > 0) out.push(tail)
  return out
}

/**
 * Build messages array for re-roll with diversity nudge listing prior
 * advice to avoid.
 *
 * @param {ChatMessage[]} originalMessages
 * @param {string[]} priorReplies
 * @returns {ChatMessage[]}
 */
function buildDiversityRerollMessages(originalMessages, priorReplies) {
  if (!priorReplies || priorReplies.length === 0) return originalMessages
  const recent = priorReplies.slice(-3)
  const nudge = {
    role: /** @type {"system"} */ ("system"),
    content: `Avoid repeating these prior replies (paraphrase or skip — be novel):\n${recent
      .map((r, i) => `(${i + 1}) ${r.slice(0, 200)}`)
      .join("\n")}`,
  }
  return [nudge, ...originalMessages]
}

/**
 * Create a Claire-stack adapter bound to a cost ledger + Phase 35-38 modules.
 *
 * Module fns are injectable for tests via `deps`. Defaults to real imports.
 *
 * @param {{
 *   ledger: ReturnType<import("./cost-ledger.mjs").createLedger>,
 *   chatImpl?: typeof defaultChatCompletion,
 *   deps?: {
 *     runAllDetectors?: typeof runAllDetectors,
 *     injectImperfection?: typeof injectImperfection,
 *     runFsm?: typeof runFsm,
 *     runMemoryPolicy?: typeof runMemoryPolicy,
 *   }
 * }} args
 */
export function createClaireStackAdapter({ ledger, chatImpl = defaultChatCompletion, deps = {} }) {
  if (!ledger) throw new Error("createClaireStackAdapter: ledger required")

  const _runAllDetectors = deps.runAllDetectors || runAllDetectors
  const _injectImperfection = deps.injectImperfection || injectImperfection
  const _runFsm = deps.runFsm || runFsm
  const _runMemoryPolicy = deps.runMemoryPolicy || runMemoryPolicy

  /**
   * @param {{ messages: ChatMessage[], opts?: AdapterChatOpts }} args
   * @returns {Promise<ClaireStackResult>}
   */
  async function chat({ messages, opts = {} }) {
    /** @type {string[]} */
    const pipeline = ["draft"]

    // Step 1 — Qwen-7B base draft
    const draft = await chatImpl({
      messages,
      opts: {
        model: QWEN_7B_MODEL,
        temperature: opts.temperature,
        max_tokens: opts.max_tokens,
        top_p: opts.top_p,
        fetchImpl: opts.fetchImpl,
      },
    })

    let totalInputTokens = draft.usage.inputTokens
    let totalOutputTokens = draft.usage.outputTokens
    let cost = ledger.charge({
      model: QWEN_7B_MODEL,
      inputTokens: draft.usage.inputTokens,
      outputTokens: draft.usage.outputTokens,
      benchmark: opts.benchmark || undefined,
      arm: CLAIRE_STACK_ARM,
    })
    let totalCostUsd = cost.costUsd

    let cleaned = draft.text
    const lastUser = messages.filter((m) => m.role === "user").pop()?.content || ""

    // Step 2 — Phase 35 detectors → strip on F1/F2 trigger
    pipeline.push("detector")
    const detectorResults = await _runAllDetectors({
      turn: { user: lastUser, assistant: cleaned },
      history: { claireReplies: opts.history || [] },
    })
    /** @type {string[]} */
    const detectorTriggered = []
    for (const r of detectorResults) {
      if (!r.triggered) continue
      detectorTriggered.push(r.id)
      if (r.id === "f1_verb_mirror" && r.suggested_action === "strip") {
        cleaned = stripVerbMirrorEcho(cleaned, lastUser)
      } else if (r.id === "f2_length_cap" && r.suggested_action === "strip") {
        cleaned = stripLengthCap(cleaned, 3)
      }
      // F3 regenerate / F4 reject_resample handled below via memory-policy
      // re-roll path (single shared re-roll budget)
    }

    // Step 3 — Phase 36 ImperfectionInjector (turn-onset only, arm-aware)
    pipeline.push("injector")
    const injectorResult = _injectImperfection({
      text: cleaned,
      lang: opts.userLang === "zh" ? "zh" : opts.userLang === "en" ? "en" : undefined,
      userId: opts.userId,
      arm: process.env.PA_IMPERFECTION_ARM === "low"
        ? "low"
        : process.env.PA_IMPERFECTION_ARM === "high"
          ? "high"
          : "off",
    })
    cleaned = injectorResult.injected

    // Step 4 — Phase 37 FSM (compute strategy + directive; logged only)
    pipeline.push("fsm")
    const fsmResult = _runFsm(
      {
        turn: { user: lastUser },
        history: { userTurns: [], claireReplies: opts.history || [] },
        turnNumber: opts.turnNumber || 1,
      },
      { userLang: opts.userLang === "zh" || opts.userLang === "en" || opts.userLang === "mixed" ? opts.userLang : undefined }
    )

    // Step 5 — Phase 38 Memory Policy (repeat score; re-roll if triggered)
    pipeline.push("memory")
    let repeatTriggered = false
    let reroll = false
    if (opts.userId) {
      const memResult = await _runMemoryPolicy(
        {
          userId: opts.userId,
          turnId: `bench-${Date.now()}`,
          claireReply: cleaned,
          userLang: opts.userLang === "zh" || opts.userLang === "en" || opts.userLang === "mixed" ? opts.userLang : "en",
          currentStrategy: fsmResult.preferredNext || undefined,
          currentUxState: fsmResult.uxState || undefined,
        },
        // Empty deps → memory-policy degrades gracefully (no firestore in bench)
        {}
      )
      repeatTriggered = !!memResult?.advice?.repeatScore?.triggered
    }

    // Step 6 — single re-roll on F3/F4/repeat trigger (max 1 retry)
    if (
      repeatTriggered ||
      detectorTriggered.includes("f4_advice_repeat") ||
      detectorTriggered.includes("f3_lang_lock")
    ) {
      reroll = true
      pipeline.push("reroll")
      const rerollMessages = buildDiversityRerollMessages(messages, opts.history || [])
      const rerollDraft = await chatImpl({
        messages: rerollMessages,
        opts: {
          model: QWEN_7B_MODEL,
          temperature: opts.temperature,
          max_tokens: opts.max_tokens,
          top_p: opts.top_p,
          fetchImpl: opts.fetchImpl,
        },
      })
      totalInputTokens += rerollDraft.usage.inputTokens
      totalOutputTokens += rerollDraft.usage.outputTokens
      const rerollCharge = ledger.charge({
        model: QWEN_7B_MODEL,
        inputTokens: rerollDraft.usage.inputTokens,
        outputTokens: rerollDraft.usage.outputTokens,
        benchmark: opts.benchmark || undefined,
        arm: CLAIRE_STACK_ARM,
      })
      totalCostUsd += rerollCharge.costUsd
      cleaned = rerollDraft.text
      // Apply minimal post-process: F2 cap on re-roll
      cleaned = stripLengthCap(cleaned, 3)
    }

    return {
      text: cleaned,
      usage: {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        costUSD: totalCostUsd,
      },
      meta: {
        arm: CLAIRE_STACK_ARM,
        model: QWEN_7B_MODEL,
        pipeline,
        detectorTriggered,
        injectorApplied: !!injectorResult.applied,
        uxState: fsmResult.uxState || null,
        strategy: fsmResult.preferredNext || null,
        repeatTriggered,
        reroll,
      },
    }
  }

  return { chat, arm: CLAIRE_STACK_ARM, model: QWEN_7B_MODEL }
}

// Exported for tests + reuse.
export { stripVerbMirrorEcho, stripLengthCap, buildDiversityRerollMessages }
