/**
 * Phase 53 — Bug 2 fix: Language-lock runner (cold-start onboarding hole).
 *
 * BACKGROUND
 * ----------
 * Historical: a cold-start onboarding hole let replies drift away from the
 * user's input language. The product is now English-only, so this guard
 * normalizes every non-mixed reply to English.
 *
 * RCA — DUAL CAUSE:
 *   A. The onboarding branch in `processInboundEvent` (index.ts:786-862)
 *      returns BEFORE the main-path post-gen lang-lock translate hook
 *      (index.ts:1140-1209). Cold-start users (onboardingState=undefined)
 *      thus never receive the post-gen safety net. Mirror of the Phase 53
 *      Bug A pattern (crisis-hotline cold-start hole — fixed via
 *      `crisis-guard-runner.ts`).
 *   B. `detectLang` (cjk-vs-ascii majority) misclassifies code-switched
 *      user input (an ASCII token + CJK suffix) as "en". `detectUserLang`
 *      adds a 3rd "mixed" class. Used by callers; not this helper.
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
   * — the 3-class variant — for caller correctness on bilingual input).
   * "mixed" = code-switched user input; guard becomes a no-op so the reply
   * can naturally mirror the user's zh-frame + en-token register instead
   * of being hard-locked to one language.
   */
  userLang: "zh" | "en" | "mixed"
  /** Reply text after agent turn (BEFORE iMessage normalization). */
  reply: string
  /**
   * Where the call was made from — used in telemetry so we can dashboard
   * pre-rewrite (LLM raw output) vs post-rewrite (after rewriter +
   * imperfection injector) vs cold-start onboarding translate rates
   * separately.
   *
   * Bug 7 fix (2026-05-03): "post_rewrite" added because the rewriter
   * (`rewriteIfOff`, index.ts ~line 1308) uses a ZH-heavy prompt with
   * Chinese FAILURE EXAMPLEs that demonstrably rewrites EN drafts into
   * ZH for pure-EN users (production log evidence: en_grad sim turn
   * b56746f2, no `lang_translate.applied` event but f3_lang_lock
   * detector triggered post-rewrite). The first guard call (callSite=
   * "main", before rewriter) cannot fix this because the rewriter runs
   * AFTER it. We add a second post-rewrite call so EN users always get
   * EN final visible reply. zh_translate (the working Adam 02:00 path)
   * is preserved by the first guard.
   *
   * Allowed values:
   *   "main"         — pre-rewrite, on raw runAgentTurn output
   *   "post_rewrite" — post-rewrite + injector + mixed-mirror, before
   *                    crisis guard. Bug 7 fix.
   *   "onboarding"   — cold-start onboarding branch.
   */
  callSite: "main" | "post_rewrite" | "onboarding"
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

  // Adam 2026-05-03 01:22 spec — mixed-register bypass. When the user wrote
  // a code-switched message (an ASCII proper noun amid a CJK frame), the reply
  // MUST mirror naturally (zh frame + en tokens preserved). Hard-locking to
  // pure-zh would scrub legitimate English tokens (proper nouns, role
  // acronyms, tech terms) the user expects to see echoed back. Skip translate
  // entirely so the model's emitted reply ships verbatim.
  if (userLang === "mixed") {
    store.log("pa.voice.lang_translate.bypass_mixed", {
      userId,
      turnId,
      callSite,
      replyLen: reply.length,
    })
    return { reply, applied: false, reason: "mixed_register_bypass" }
  }

  // The product is English-only: the target output language is ALWAYS
  // English regardless of userLang. (mixed already bypassed above.)
  const targetLang = "en"

  try {
    const replyLang = detectLang(reply)
    if (replyLang === targetLang) {
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

    const translatePrompt = `Rewrite the following message in English only. Keep the casual texting tone, brevity, and meaning EXACT. Do NOT add or remove content. Do NOT use any non-English characters. Output ONLY the rewritten message, no preface.\n\n${reply}`

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

      if (translated.length > 0 && translatedLang === targetLang) {
        store.log("pa.voice.lang_translate.applied", {
          userId,
          turnId,
          callSite,
          fromLang: replyLang,
          toLang: targetLang,
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
 *
 * Adam 2026-05-03 01:22 spec — "mixed" branch returns empty strings so the
 * sandwich becomes a no-op. The model is free to mirror the user's
 * code-switched register (zh frame + en tokens) without being clamped to
 * either pure language. Mirrors runLangLockGuard's mixed bypass — both
 * pre-gen and post-gen guards must agree, otherwise the post-gen translate
 * would undo a faithfully-mirrored reply.
 */
export function buildLangLockSandwich(userLang: "zh" | "en" | "mixed"): {
  open: string
  close: string
} {
  if (userLang === "mixed") {
    // No sandwich — let the model mirror naturally. Empty strings are safe to
    // concatenate at the call site (`${open}\n\n${prompt}${close}`); the
    // resulting prompt is just the base systemPrompt with extra whitespace.
    return { open: "", close: "" }
  }
  // Product is English-only: every non-mixed input gets the English lock.
  const open =
    "[LANGUAGE-LOCK · TOP-PRIORITY]\nABSOLUTE RULE: You MUST reply in English. Do NOT switch to any other language or use any non-English characters at all. Casual register is fine; language must be English.\n[/LANGUAGE-LOCK]"
  const close =
    "\n\n[FINAL-REMINDER]\nYour reply MUST be in English. Do not output any non-English characters.\n[/FINAL-REMINDER]"
  return { open, close }
}

/**
 * Build the user-message langLock directive (mirrors index.ts:1118-1120).
 * Caller appends to userMessage before runAgentTurn.
 *
 * Adam 2026-05-03 01:22 spec — "mixed" returns empty string so the user
 * message is unchanged. Pairs with buildLangLockSandwich's mixed branch.
 */
export function buildLangLockUserDirective(userLang: "zh" | "en" | "mixed"): string {
  if (userLang === "mixed") return ""
  // Product is English-only: every non-mixed input gets the English directive.
  return "\n\n[SYSTEM-DIRECTIVE: Reply in English only. Do not output any non-English characters.]"
}
