/**
 * v2.1 S2 — Recording consent prompt (Lock L8).
 *
 * Lock L8 (verbatim): "Recording consent prompt at call start; storage
 * `WEKRUIT_VOICE_RECORDINGS_BUCKET=wekruit-voice-recordings`."
 *
 * The first agent utterance MUST be a consent line. Localized by
 * `VoiceUserProfile.preferredLang`; defaults to `en`. Persona-toned by
 * `VoicePrescreenConfig.voiceMode`.
 */

import type { VoiceCallContext } from "./voice-context-types.js"

const EN_CASUAL =
  "hey, it's Claire from WeKruit! quick heads up before we dive in — i record " +
  "these so the team can follow up, and you can just say STOP anytime to end it. " +
  "cool? okay, let's get into it."

const EN_PROFESSIONAL =
  "hi, this is Claire from WeKruit — really glad we could connect. quick heads " +
  "up, these calls are recorded so we can follow up properly, and you can say STOP " +
  "any time to end it. sound good? great, let's get started."

const ZH_CASUAL =
  "嗨，我是 WeKruit 的 Claire！开始前先说一句——我会录音方便团队后续跟进，你任何时候说 STOP 就能结束哈。可以吗？那我们就开始啦。"

const ZH_PROFESSIONAL =
  "你好，我是 WeKruit 的 Claire，很高兴能跟你聊聊。开始前先说明一下——我会录音以便后续跟进，你任何时候说 STOP 都可以结束。可以吗？好的，那我们就开始吧。"

export function buildConsentPrompt(ctx: VoiceCallContext): string {
  const lang = ctx.userProfile.preferredLang ?? "en"
  const mode =
    ctx.purpose === "prescreen"
      ? ctx.prescreenConfig.voiceMode ?? "professional_prescreen"
      : "casual_onboarding"
  if (lang === "zh") {
    return mode === "casual_onboarding" ? ZH_CASUAL : ZH_PROFESSIONAL
  }
  return mode === "casual_onboarding" ? EN_CASUAL : EN_PROFESSIONAL
}
