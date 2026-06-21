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
  "Hey! I'm Claire from WeKruit. This call's being recorded so our team can " +
  "review and improve. You can say STOP anytime to end it. Ready when you are."

const EN_PROFESSIONAL =
  "Hi, this is Claire from WeKruit. This call will be recorded for quality " +
  "purposes. You can say STOP at any time to end the call. Are you ready to begin?"

const ZH_CASUAL =
  "嗨！我是 WeKruit 的 Claire。我们这通电话会录音用于团队回顾。任何时候说 STOP 就可以结束。准备好就可以开始啦。"

const ZH_PROFESSIONAL =
  "你好，我是 WeKruit 的 Claire。本次通话将被录音以便质量管理。任何时候说 STOP 即可挂断。请问准备好开始了吗？"

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
