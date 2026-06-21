/**
 * v2.1 S2 — voice-agent public surface.
 *
 * Internal modules are exported here so adjacent sprints (S3/S4/S5) can
 * extend behavior without reaching into deep paths.
 */

export { runCli } from "./cli.js"
export { startWorker } from "./worker.js"
export {
  registerEventHandlers,
  EVENT_NAMES,
  type RegisterSinks,
  type RegisterEventHandlersResult,
  type SpecEventName,
} from "./event-handlers.js"
export {
  createTurnLoop,
  type TurnLoopDeps,
  type TurnEvent,
  type OnUserCommitInput,
  type OnUserCommitOutput,
  type RunTurnActionLite,
  type RunTurnResultLite,
  type VoicePipelineLite,
} from "./turn-loop.js"
export {
  redactForVoice,
  hasVoicePiiConsent,
  type PiiHandlerInput,
  type PiiHandlerOutput,
  type PiiHandoffToken,
  type PiiKind,
} from "./pii-handler.js"
export { buildConsentPrompt } from "./consent-prompt.js"
export type {
  VoiceCallContext,
  VoiceCallPurpose,
  VoicePrescreenCallContext,
  VoiceOnboardingCallContext,
  VoiceUserProfile,
  VoiceJobBrief,
  VoicePrescreenConfig,
  VoicePrescreenQuestionConfig,
  VoiceLang,
} from "./voice-context-types.js"
