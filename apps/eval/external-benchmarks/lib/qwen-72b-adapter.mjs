/**
 * Phase 39 — Qwen-72B raw adapter (comparison arm).
 *
 * Identical surface to qwen-7b-adapter but routes to Qwen2.5-72B-Instruct.
 * Used as the "Qwen-72B raw" comparison per Phase 39 success criterion:
 * Claire stack ≥ Qwen-72B raw on ≥ 1 of 5 benchmarks.
 *
 * @typedef {import("./sf-client.mjs").ChatMessage} ChatMessage
 *
 * @typedef {Object} AdapterChatOpts
 * @property {number} [temperature]
 * @property {number} [max_tokens]
 * @property {number} [top_p]
 * @property {string} [benchmark]
 * @property {typeof fetch} [fetchImpl]
 *
 * @typedef {Object} AdapterChatResult
 * @property {string} text
 * @property {{ inputTokens: number, outputTokens: number, costUSD: number }} usage
 * @property {{ arm: string, model: string }} meta
 */

import { chatCompletion as defaultChatCompletion } from "./sf-client.mjs"

export const QWEN_72B_MODEL = "Qwen/Qwen2.5-72B-Instruct"
export const QWEN_72B_ARM = "qwen-72b-raw"

/**
 * @param {{ ledger: ReturnType<import("./cost-ledger.mjs").createLedger>, chatImpl?: typeof defaultChatCompletion }} args
 */
export function createQwen72bAdapter({ ledger, chatImpl = defaultChatCompletion }) {
  if (!ledger) throw new Error("createQwen72bAdapter: ledger required")

  /**
   * @param {{ messages: ChatMessage[], opts?: AdapterChatOpts }} args
   * @returns {Promise<AdapterChatResult>}
   */
  async function chat({ messages, opts = {} }) {
    const result = await chatImpl({
      messages,
      opts: {
        model: QWEN_72B_MODEL,
        temperature: opts.temperature,
        max_tokens: opts.max_tokens,
        top_p: opts.top_p,
        fetchImpl: opts.fetchImpl,
      },
    })

    const charge = ledger.charge({
      model: QWEN_72B_MODEL,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      benchmark: opts.benchmark || undefined,
      arm: QWEN_72B_ARM,
    })

    return {
      text: result.text,
      usage: {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        costUSD: charge.costUsd,
      },
      meta: {
        arm: QWEN_72B_ARM,
        model: QWEN_72B_MODEL,
      },
    }
  }

  return { chat, arm: QWEN_72B_ARM, model: QWEN_72B_MODEL }
}
