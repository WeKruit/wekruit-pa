/**
 * Phase 53 — Bug 2 fix: Language-lock runner (cold-start onboarding hole).
 *
 * BACKGROUND
 * ----------
 * Adam iMessage 2026-05-03 00:34 repro: user sent ZH-frame messages
 *   ("我想找工作", "swe的", "yoe1年的")
 * Claire's reply 2 came back EN+ZH-mixed ("yoe1 SWE. What kind of SWE..."),
 * which is wrong — the user is writing in Chinese-frame and the reply MUST
 * stay Chinese.
 *
 * RCA — DUAL CAUSE:
 *   A. The onboarding branch in `processInboundEvent` (index.ts:786-862)
 *      returns BEFORE the main-path post-gen lang-lock translate hook
 *      (index.ts:1140-1209). Cold-start users (onboardingState=undefined)
 *      thus never receive the post-gen safety net. Mirror of the Phase 53
 *      Bug A pattern (crisis-hotline cold-start hole — fixed via
 *      `crisis-guard-runner.ts`).
 *   B. `detectLang` (cjk-vs-ascii majority) misclassifies bilingual user
 *      input like "swe的" or "yoe1年的" as "en". Fix B introduces
 *      `detectUserLang` (any-CJK → "zh"). Used by callers; not this helper.
 *
 * SCOPE
 * -----
 * This module extracts the post-gen Qwen translate scaffolding (was inline
 * at index.ts:1140-1209) into a single helper, so BOTH the onboarding
 * branch and the main runAgentTurn path can call it. Single source of
 * truth for:
 *
 *   - Comparing reply-lang vs user-lang (mismatch → translate).
 *   - Reading `SILICONFLOW_API_KEY` (no key → fail-open, return original).
 *   - Calling Qwen2.5-7B-Instruct with a 5s AbortController timeout.
 *   - Verifying the translated output is non-empty AND lang-correct.
 *   - Emitting telemetry: `pa.voice.lang_translate.applied` /
 *     `.rejected` / `.http_error` / `.error`.
 *
 * DESIGN NOTES
 * ------------
 * - Pure helper signature — caller passes `userLang` (already-detected) +
 *   `reply`, gets back the (possibly translated) reply. NO mutation of
 *   orchestrator state.
 * - Caller is responsible for `detectUserLang(event.body)` — the helper
 *   does NOT re-detect because main-path callers already have the value
 *   computed (Bug B fix is in the caller).
 * - Helper is async because the Qwen fetch is async; defense-in-depth
 *   try/catch — translate failure NEVER breaks a turn.
 * - `callSite` is tagged in telemetry so we can dashboard cold-start vs
 *   main-path translate rates separately (mirror crisis-guard-runner).
 *
 * NOT IN SCOPE
 * ------------
 * Pre-gen langLock injection (system-prompt sandwich + user-message
 * directive at index.ts:1086-1120) is NOT extracted here — that is
 * caller-side concern (different signatures for onboarding vs main path).
 * The onboarding caller will mirror the same string templates inline.
 */

import { detectLang } from "./imperfection-injector/index.js"

/** Minimal store surface we need — subset of OrchestratorStore. */
export interface LangLockStore {
  log(...args: unknown[]): void
}

export interface RunLangLockGuardInput {
  store: LangLockStore
  /** User id for telemetry. */
  userId: string
  /** Turn id for telemetry. */
  turnId: string
  /**
   * The user's already-detected language (use `detectUserLang(event.body)`
   * — the zh-biased variant — for caller correctness on bilingual input).
   */
  userLang: "zh" | "en"
  /** Reply text after agent turn (BEFORE iMessage normalization). */
  reply: string
  /**
   * Where the call was made from — used in telemetry so we can dashboard
   * cold-start vs main-path translate rates separately.
   * Allowed values: "main" (post-rewrite path) | "onboarding" (cold-start).
   */
  callSite: "main" | "onboarding"
}

export interface RunLangLockGuardResult {
  /** Reply after possible translate — pass this to normalize. */
  reply: string
  /** True iff translate fired AND output was accepted (lang-correct). */
  applied: boolean
  /** Compact reason string for caller-side telemetry / debug. */
  reason: string
}

/**
 * Run the post-gen language-lock translate guard.
 *
 * Returns the (possibly translated) reply. NEVER throws — defense-in-depth
 * try/catch logs and falls through with the un-modified reply on any error.
 *
 * Behavior:
 *   - reply empty → no-op.
 *   - replyLang === userLang → no-op (already correct).
 *   - SILICONFLOW_API_KEY unset → no-op (fail-open).
 *   - Qwen translate succeeds AND output passes detectLang(translated) ===
 *     userLang → return translated reply (applied=true).
 *   - Qwen translate fails / times out / returns wrong-lang output → return
 *     ORIGINAL reply (applied=false). Original ships even on translate fail.
 */
export async function runLangLockGuard(
  input: RunLangLockGuardInput
): Promise<RunLangLockGuardResult> {
  const { store, userId, turnId, userLang, reply, callSite } = input

  if (reply.length === 0) {
    return { reply, applied: false, reason: "empty_reply" }
  }

  try {
    const replyLang = detectLang(reply)
    if (replyLang === userLang) {
      return { reply, applied: false, reason: "already_correct_lang" }
    }

    const sfKey = process.env.SILICONFLOW_API_KEY?.trim() || ""
    if (!sfKey) {
      store.log("pa.voice.lang_translate.no_api_key", {
        userId,
        turnId,
        callSite,
        replyLang,
        userLang,
      })
      return { reply, applied: false, reason: "no_api_key" }
    }

    const translatePrompt =
      userLang === "zh"
        ? `Rewrite the following message in Chinese (中文) only. Keep the casual texting tone, brevity, and meaning EXACT. Do NOT add or remove content. Do NOT use any English words except code/URLs/proper nouns. Output ONLY the rewritten message, no preface.\n\n${reply}`
        : `Rewrite the following message in English only. Keep the casual texting tone, brevity, and meaning EXACT. Do NOT add or remove content. Do NOT use any Chinese characters (汉字). Output ONLY the rewritten message, no preface.\n\n${reply}`

    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 5000)
    try {
      const resp = await fetch("https://api.siliconflow.cn/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sfKey}`,
        },
        body: JSON.stringify({
          model: "Qwen/Qwen2.5-7B-Instruct",
          messages: [{ role: "user", content: translatePrompt }],
          max_tokens: 200,
          temperature: 0.2,
        }),
        signal: ac.signal,
      })

      if (!resp.ok) {
        store.log("pa.voice.lang_translate.http_error", {
          userId,
          turnId,
          callSite,
          status: resp.status,
        })
        return { reply, applied: false, reason: `http_${resp.status}` }
      }

      const j = (await resp.json()) as {
        choices?: { message?: { content?: string } }[]
      }
      const translated = (j.choices?.[0]?.message?.content ?? "").trim()
      const translatedLang = detectLang(translated)

      if (translated.length > 0 && translatedLang === userLang) {
        store.log("pa.voice.lang_translate.applied", {
          userId,
          turnId,
          callSite,
          fromLang: replyLang,
          toLang: userLang,
          beforeLen: reply.length,
          afterLen: translated.length,
        })
        return { reply: translated, applied: true, reason: "translated" }
      }

      store.log("pa.voice.lang_translate.rejected", {
        userId,
        turnId,
        callSite,
        reason: translated.length === 0 ? "empty" : "still_wrong_lang",
        translatedLang,
      })
      return {
        reply,
        applied: false,
        reason: translated.length === 0 ? "empty_translation" : "still_wrong_lang",
      }
    } finally {
      clearTimeout(timer)
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    store.log("pa.voice.lang_translate.error", {
      userId,
      turnId,
      callSite,
      error: msg,
    })
    return { reply, applied: false, reason: `error_${msg.slice(0, 32)}` }
  }
}

/**
 * Build the langLock pre-gen system-prompt sandwich strings.
 * Mirrors index.ts:1093-1098 so both onboarding + main paths share copy.
 *
 * Returns `{ open, close }` — caller wraps own systemPrompt as
 * `${open}\n\n${baseSystemPrompt}${close}`.
 */
export function buildLangLockSandwich(userLang: "zh" | "en"): {
  open: string
  close: string
} {
  const open =
    userLang === "zh"
      ? "[LANGUAGE-LOCK · TOP-PRIORITY]\nuser_input_language: zh (Chinese)\nABSOLUTE RULE: You MUST reply in Chinese (中文). Do NOT switch to English unless the token is a code symbol, URL, or proper noun (人名/公司名). NEVER reply in English when the user wrote Chinese.\n[/LANGUAGE-LOCK]"
      : "[LANGUAGE-LOCK · TOP-PRIORITY]\nuser_input_language: en (English)\nABSOLUTE RULE: You MUST reply in English. Do NOT switch to Chinese / use Chinese characters (汉字) at all. NEVER reply in Chinese when the user wrote English. Casual register is fine; language must be English.\n[/LANGUAGE-LOCK]"
  const close =
    userLang === "zh"
      ? "\n\n[FINAL-REMINDER]\nThe user just wrote in Chinese. Your reply MUST be in Chinese (中文). 不要用英文回复中文输入。\n[/FINAL-REMINDER]"
      : "\n\n[FINAL-REMINDER]\nThe user just wrote in English. Your reply MUST be in English. Do not output any Chinese characters (汉字).\n[/FINAL-REMINDER]"
  return { open, close }
}

/**
 * Build the user-message langLock directive (mirrors index.ts:1118-1120).
 * Caller appends to userMessage before runAgentTurn.
 */
export function buildLangLockUserDirective(userLang: "zh" | "en"): string {
  return userLang === "en"
    ? "\n\n[SYSTEM-DIRECTIVE: Reply in English only. Do not output any Chinese characters.]"
    : "\n\n[SYSTEM-DIRECTIVE: 用中文回复。Reply only in Chinese.]"
}
