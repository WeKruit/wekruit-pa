/**
 * Phase 39 — Qwen-7B raw adapter.
 *
 * Single `chat({ messages, opts })` interface used by all benchmark runners.
 * Wraps SiliconFlow `Qwen/Qwen2.5-7B-Instruct` chat completion. Charges the
 * shared cost ledger on every successful call.
 *
 * @typedef {import("./sf-client.mjs").ChatMessage} ChatMessage
 * @typedef {import("./cost-ledger.mjs").BudgetExceededError} BudgetExceededError
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

export const QWEN_7B_MODEL = "Qwen/Qwen2.5-7B-Instruct"
export const QWEN_7B_ARM = "qwen-7b-raw"

/**
 * Create a Qwen-7B raw adapter bound to a cost ledger.
 *
 * @param {{ ledger: ReturnType<import("./cost-ledger.mjs").createLedger>, chatImpl?: typeof defaultChatCompletion }} args
 */
export function createQwen7bAdapter({ ledger, chatImpl = defaultChatCompletion }) {
  if (!ledger) throw new Error("createQwen7bAdapter: ledger required")

  /**
   * @param {{ messages: ChatMessage[], opts?: AdapterChatOpts }} args
   * @returns {Promise<AdapterChatResult>}
   */
  async function chat({ messages, opts = {} }) {
    const result = await chatImpl({
      messages,
      opts: {
        model: QWEN_7B_MODEL,
        temperature: opts.temperature,
        max_tokens: opts.max_tokens,
        top_p: opts.top_p,
        fetchImpl: opts.fetchImpl,
      },
    })

    const charge = ledger.charge({
      model: QWEN_7B_MODEL,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      benchmark: opts.benchmark || undefined,
      arm: QWEN_7B_ARM,
    })

    return {
      text: result.text,
      usage: {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        costUSD: charge.costUsd,
      },
      meta: {
        arm: QWEN_7B_ARM,
        model: QWEN_7B_MODEL,
      },
    }
  }

  return { chat, arm: QWEN_7B_ARM, model: QWEN_7B_MODEL }
}
