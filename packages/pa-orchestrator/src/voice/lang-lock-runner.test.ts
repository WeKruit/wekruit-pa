/**
 * Adam 2026-05-03 01:22 spec — lang-lock-runner mixed-register tests.
 *
 * Contract (mirrors injector.detectUserLang 3-class):
 *   - userLang === "mixed" → guard is a no-op (returns reply unchanged,
 *     applied=false, reason="mixed_register_bypass") AND fires telemetry
 *     `pa.voice.lang_translate.bypass_mixed`. NO Qwen translate call —
 *     the model's emitted reply ships verbatim so user-written English
 *     tokens (proper nouns, acronyms, tech terms) are preserved.
 *   - userLang === "zh" / "en" branches behave as before (translate when
 *     reply lang differs; fail-open when SILICONFLOW_API_KEY missing).
 *   - buildLangLockSandwich + buildLangLockUserDirective return empty
 *     strings for "mixed" so the pre-gen pipeline becomes a pass-through.
 */
import assert from "node:assert/strict"
import test, { describe } from "node:test"

import {
  runLangLockGuard,
  buildLangLockSandwich,
  buildLangLockUserDirective,
  type LangLockStore,
} from "./lang-lock-runner.js"

function makeStore(): LangLockStore & { logs: Array<[string, unknown]> } {
  const logs: Array<[string, unknown]> = []
  return {
    logs,
    log(...args: unknown[]) {
      const [evt, payload] = args
      logs.push([String(evt), payload])
    },
  }
}

describe("runLangLockGuard — mixed branch (Adam 2026-05-03 01:22 spec)", () => {
  test("userLang='mixed' returns reply unchanged + fires bypass telemetry, NO translate", async () => {
    const store = makeStore()
    // We deliberately do NOT set SILICONFLOW_API_KEY; if the mixed branch
    // failed to short-circuit, we'd see a no_api_key reason or an http call.
    delete process.env.SILICONFLOW_API_KEY
    const reply = "你可以聊聊 Nvidia 的硬件团队，他们 hires SWE 也比较多。"
    const r = await runLangLockGuard({
      store,
      userId: "u_test",
      turnId: "t_test",
      userLang: "mixed",
      reply,
      callSite: "main",
    })
    assert.equal(r.reply, reply, "reply unchanged on mixed bypass")
    assert.equal(r.applied, false)
    assert.equal(r.reason, "mixed_register_bypass")
    const bypassLogs = store.logs.filter(([evt]) => evt === "pa.voice.lang_translate.bypass_mixed")
    assert.equal(bypassLogs.length, 1, "bypass telemetry emitted exactly once")
    const payload = bypassLogs[0]![1] as Record<string, unknown>
    assert.equal(payload.userId, "u_test")
    assert.equal(payload.turnId, "t_test")
    assert.equal(payload.callSite, "main")
    assert.equal(payload.replyLen, reply.length)
  })

  test("userLang='mixed' with empty reply → empty_reply (mixed bypass does NOT mask the empty guard)", async () => {
    const store = makeStore()
    const r = await runLangLockGuard({
      store,
      userId: "u_test",
      turnId: "t_test",
      userLang: "mixed",
      reply: "",
      callSite: "onboarding",
    })
    assert.equal(r.reply, "")
    assert.equal(r.applied, false)
    assert.equal(r.reason, "empty_reply")
    // No bypass log because we short-circuited on empty earlier
    assert.equal(
      store.logs.filter(([evt]) => evt === "pa.voice.lang_translate.bypass_mixed").length,
      0
    )
  })
})

describe("runLangLockGuard — pure-zh / pure-en branches (regression)", () => {
  test("userLang='zh' + reply already zh → already_correct_lang (no translate, no bypass)", async () => {
    const store = makeStore()
    delete process.env.SILICONFLOW_API_KEY
    const r = await runLangLockGuard({
      store,
      userId: "u_test",
      turnId: "t_test",
      userLang: "zh",
      reply: "好的，我来帮你看看。",
      callSite: "main",
    })
    assert.equal(r.applied, false)
    assert.equal(r.reason, "already_correct_lang")
    assert.equal(
      store.logs.filter(([evt]) => evt === "pa.voice.lang_translate.bypass_mixed").length,
      0,
      "mixed-bypass telemetry must NOT fire on pure-zh"
    )
  })

  test("userLang='en' + reply already en → already_correct_lang", async () => {
    const store = makeStore()
    delete process.env.SILICONFLOW_API_KEY
    const r = await runLangLockGuard({
      store,
      userId: "u_test",
      turnId: "t_test",
      userLang: "en",
      reply: "Sounds good — let me look at that.",
      callSite: "main",
    })
    assert.equal(r.applied, false)
    assert.equal(r.reason, "already_correct_lang")
  })

  test("userLang='zh' + reply en + no SILICONFLOW_API_KEY → no_api_key (fail-open)", async () => {
    const store = makeStore()
    delete process.env.SILICONFLOW_API_KEY
    const reply = "Sounds good — let me look at that."
    const r = await runLangLockGuard({
      store,
      userId: "u_test",
      turnId: "t_test",
      userLang: "zh",
      reply,
      callSite: "main",
    })
    assert.equal(r.applied, false)
    assert.equal(r.reason, "no_api_key")
    assert.equal(r.reply, reply, "fail-open: original reply still returned")
  })
})

describe("buildLangLockSandwich — mixed branch", () => {
  test("'mixed' returns empty open + close strings (no-op pre-gen sandwich)", () => {
    const { open, close } = buildLangLockSandwich("mixed")
    assert.equal(open, "")
    assert.equal(close, "")
  })

  test("'zh' / 'en' still produce non-empty sandwiches (regression guard)", () => {
    const zh = buildLangLockSandwich("zh")
    assert.ok(zh.open.length > 0 && zh.close.length > 0, "zh sandwich non-empty")
    assert.match(zh.open, /中文/)
    const en = buildLangLockSandwich("en")
    assert.ok(en.open.length > 0 && en.close.length > 0, "en sandwich non-empty")
    assert.match(en.open, /English/)
  })
})

describe("buildLangLockUserDirective — mixed branch", () => {
  test("'mixed' returns empty string (user message unmodified)", () => {
    assert.equal(buildLangLockUserDirective("mixed"), "")
  })

  test("'zh' / 'en' still produce directives (regression guard)", () => {
    assert.match(buildLangLockUserDirective("zh"), /中文/)
    assert.match(buildLangLockUserDirective("en"), /English/)
  })
})
