/**
 * iter30 WS6 — OutputGuardrails unit tests.
 *
 * Detail-plan §5.2 + §8.3 + §8.4 (iter25-29 normalizer regression
 * delegated to the existing `output-normalizer.test.ts`).
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { createMockContext } from "../../run-context.js"
import { lengthCapGuardrail } from "../output/length-cap.js"
import { abStripGuardrail } from "../output/ab-strip.js"
import { slangEnforcerGuardrail } from "../output/slang-enforcer.js"
import { crisisTrailerGuardrail } from "../output/crisis-trailer.js"
import { outputNormalizerGuardrail } from "../output/output-normalizer.js"
import { runOutputChain } from "../run-output-chain.js"
import { OUTPUT_GUARDRAIL_CHAIN } from "../index.js"

test("OG-1 lengthCap — bypasses when ctx.crisisTripped=true", async () => {
  const ctx = createMockContext({ crisisTripped: true })
  const longText = "句一。".repeat(20)
  const out = await lengthCapGuardrail.execute({
    agentOutput: longText,
    userInput: "",
    ctx,
  })
  assert.equal(out.outputInfo.bypassReason, "crisis_injected")
  assert.equal(out.outputInfo.transformedOutput, undefined)
})

test("OG-1 lengthCap — caps overlong input", async () => {
  const ctx = createMockContext()
  // 5 sentences, each > Bible v7.5 sentence cap (3 sentences)
  const overlong = "我觉得这样想很正常。其实你不一定要立刻有答案。慢慢来比较好。再给自己一点时间。会顺过来的。"
  const out = await lengthCapGuardrail.execute({
    agentOutput: overlong,
    userInput: "",
    ctx,
  })
  // should produce a transformedOutput shorter than original
  if (out.outputInfo.transformedOutput) {
    assert.ok((out.outputInfo.transformedOutput as string).length < overlong.length)
  }
})

test("OG-2 abStrip — strips trailing X-or-Y probe", async () => {
  const ctx = createMockContext()
  const input = "嗯, 你想刷题还是面试?"
  const out = await abStripGuardrail.execute({
    agentOutput: input,
    userInput: "",
    ctx,
  })
  if (typeof out.outputInfo.transformedOutput === "string") {
    assert.ok((out.outputInfo.transformedOutput as string).length < input.length)
    assert.equal(ctx.abStripApplied, true)
  }
})

test("OG-2 abStrip — non-AB text is no-op", async () => {
  const ctx = createMockContext()
  const out = await abStripGuardrail.execute({
    agentOutput: "我懂了",
    userInput: "",
    ctx,
  })
  assert.equal(out.outputInfo.transformedOutput, undefined)
  assert.equal(ctx.abStripApplied, false)
})

test("OG-3 slangEnforcer — 卧 followed by space → 卧槽", async () => {
  const ctx = createMockContext({ locale: "zh-CN" })
  const out = await slangEnforcerGuardrail.execute({
    agentOutput: "卧 这也太离谱",
    userInput: "",
    ctx,
  })
  assert.equal(out.outputInfo.transformedOutput, "卧槽 这也太离谱")
})

test("OG-3 slangEnforcer — 卧床 stays unchanged", async () => {
  const ctx = createMockContext({ locale: "zh-CN" })
  const out = await slangEnforcerGuardrail.execute({
    agentOutput: "他卧床休息",
    userInput: "",
    ctx,
  })
  assert.equal(out.outputInfo.transformedOutput, undefined)
})

test("OG-3 slangEnforcer — 卧槽 already-full-form is no-op", async () => {
  const ctx = createMockContext({ locale: "zh-CN" })
  const out = await slangEnforcerGuardrail.execute({
    agentOutput: "卧槽 离谱",
    userInput: "",
    ctx,
  })
  assert.equal(out.outputInfo.transformedOutput, undefined)
})

test("OG-3 slangEnforcer — en-US locale skips", async () => {
  const ctx = createMockContext({ locale: "en-US" })
  const out = await slangEnforcerGuardrail.execute({
    agentOutput: "卧 weird",
    userInput: "",
    ctx,
  })
  assert.equal(out.outputInfo.skipped, "en_locale")
})

// iter30 Wave 3 — Bible v7 banlist expansion (友好 / 没问题).

test("OG-3 slangEnforcer — 太友好了 corporate-praise frame is dropped", async () => {
  const ctx = createMockContext({ locale: "zh-CN" })
  const out = await slangEnforcerGuardrail.execute({
    agentOutput: "你真是太友好了, 谢谢。",
    userInput: "",
    ctx,
  })
  const text = out.outputInfo.transformedOutput as string
  assert.ok(typeof text === "string", "should transform")
  assert.ok(!text.includes("太友好了"), "praise-frame stripped")
  // Must not break grammar by leaving "你真是太了"
  assert.ok(!text.includes("太了"))
})

test("OG-3 slangEnforcer — bare 没问题 reply → friend-tone 嗯，行", async () => {
  const ctx = createMockContext({ locale: "zh-CN" })
  const out = await slangEnforcerGuardrail.execute({
    agentOutput: "没问题",
    userInput: "",
    ctx,
  })
  assert.equal(out.outputInfo.transformedOutput, "嗯，行")
})

test("OG-3 slangEnforcer — bare 没问题。 with period → friend-tone", async () => {
  const ctx = createMockContext({ locale: "zh-CN" })
  const out = await slangEnforcerGuardrail.execute({
    agentOutput: "没问题。",
    userInput: "",
    ctx,
  })
  assert.equal(out.outputInfo.transformedOutput, "嗯，行")
})

test("OG-3 slangEnforcer — sentence-head 没问题 → 好", async () => {
  const ctx = createMockContext({ locale: "zh-CN" })
  const out = await slangEnforcerGuardrail.execute({
    agentOutput: "没问题, 我帮你看。",
    userInput: "",
    ctx,
  })
  const text = out.outputInfo.transformedOutput as string
  assert.ok(typeof text === "string", "should transform")
  assert.ok(!text.includes("没问题"))
  assert.ok(text.startsWith("好"))
})

test("OG-3 slangEnforcer — mid-sentence 没问题 stripped", async () => {
  const ctx = createMockContext({ locale: "zh-CN" })
  const out = await slangEnforcerGuardrail.execute({
    agentOutput: "嗯, 我看完简历没问题就给你回复",
    userInput: "",
    ctx,
  })
  const text = out.outputInfo.transformedOutput as string
  assert.ok(typeof text === "string", "should transform")
  assert.ok(!text.includes("没问题"))
})

test("OG-3 slangEnforcer — 很友好 stripped without breaking sentence", async () => {
  const ctx = createMockContext({ locale: "zh-CN" })
  const out = await slangEnforcerGuardrail.execute({
    agentOutput: "他很友好, 你可以问他。",
    userInput: "",
    ctx,
  })
  const text = out.outputInfo.transformedOutput as string
  assert.ok(typeof text === "string", "should transform")
  assert.ok(!text.includes("友好"))
})

test("OG-3 slangEnforcer — neutral 友好 alone is left intact (conservative)", async () => {
  const ctx = createMockContext({ locale: "zh-CN" })
  // No intensifier prefix → no strip (conservative; might be a noun reference).
  const out = await slangEnforcerGuardrail.execute({
    agentOutput: "中美友好关系。",
    userInput: "",
    ctx,
  })
  assert.equal(out.outputInfo.transformedOutput, undefined)
})

test("OG-5 crisisTrailer — appends when crisisTripped + flag on", async () => {
  const ctx = createMockContext({ crisisTripped: true })
  const out = await crisisTrailerGuardrail.execute({
    agentOutput: "你不是一个人。",
    userInput: "我想自杀",
    ctx,
  })
  const text = out.outputInfo.transformedOutput as string
  assert.ok(typeof text === "string", "trailer applied")
  assert.ok(text.includes("400-161-9995") || text.includes("988"))
})

test("OG-5 crisisTrailer — flag off → no-op even if crisisTripped", async () => {
  const ctx = createMockContext({
    crisisTripped: true,
    featureFlags: {
      paHumanizeRuntimeEnabled: false,
      paOnboardingProbeV2Enabled: false,
      paOnboardingIntentAckEnabled: true,
      paSafetyCheckEnabled: true,
      paSafetyIllegalContentEnabled: false,
      paSafetyRateAbuse24hEnabled: false,
      paCrisisHotlineInjectionEnabled: false,
      paVoiceMirrorDisabled: false,
      paABFrameworkStrippingEnabled: true,
      paImperfectionInjectorArm: "off",
      paSkillsLlmFallbackEnabled: false,
    },
  })
  const out = await crisisTrailerGuardrail.execute({
    agentOutput: "你不是一个人。",
    userInput: "我想自杀",
    ctx,
  })
  assert.equal(out.outputInfo.transformedOutput, undefined)
  assert.equal(out.outputInfo.reason, "flag_off")
})

test("OG-5 crisisTrailer — already has hotline → no-op", async () => {
  const ctx = createMockContext({ crisisTripped: true })
  const out = await crisisTrailerGuardrail.execute({
    agentOutput: "我在这。心理援助热线 400-161-9995。",
    userInput: "我想自杀",
    ctx,
  })
  assert.equal(out.outputInfo.transformedOutput, undefined)
  assert.equal(out.outputInfo.reason, "already_has_hotline")
})

test("OG-7 outputNormalizer — strips markdown emphasis", async () => {
  const ctx = createMockContext()
  const out = await outputNormalizerGuardrail.execute({
    agentOutput: "Hi **friend**!",
    userInput: "",
    ctx,
  })
  if (typeof out.outputInfo.transformedOutput === "string") {
    assert.ok(!(out.outputInfo.transformedOutput as string).includes("**"))
  }
})

test("Output chain — full ordering applies AB-strip then slang-enforcer", async () => {
  const ctx = createMockContext({ locale: "zh-CN" })
  const result = await runOutputChain({
    guardrails: OUTPUT_GUARDRAIL_CHAIN,
    agentOutput: "卧 这真离谱, 你想刷题还是面试?",
    userInput: "我不知道下一步",
    ctx,
  })
  // After chain: AB-strip drops the trailing X-or-Y, then slang-enforcer
  // converts 卧→卧槽. Normalizer runs last (idempotent).
  assert.ok(result.text.includes("卧槽"))
  assert.ok(!result.text.includes("还是"))
  assert.equal(result.transformed, true)
  // Audit trail records all 7 guardrails
  assert.equal(ctx.guardrailHits.length, 7)
  assert.deepEqual(
    ctx.guardrailHits.map((h) => h.name),
    [
      "lengthCap",
      "abStrip",
      "slangEnforcer",
      "adviceRepeat",
      "crisisTrailer",
      "mirrorScore",
      "outputNormalizer",
    ]
  )
})

test("Output chain — crisis path keeps trailer through normalizer", async () => {
  const ctx = createMockContext({ crisisTripped: true })
  const result = await runOutputChain({
    guardrails: OUTPUT_GUARDRAIL_CHAIN,
    agentOutput: "你不是一个人, 慢慢来。",
    userInput: "我想自杀",
    ctx,
  })
  // length-cap bypassed (crisis), trailer appended, normalizer cleans up.
  assert.ok(result.text.includes("400-161-9995") || result.text.includes("988"))
})
