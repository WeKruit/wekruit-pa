/**
 * Phase A.5 — Voice Profile Registry. One Claire, many purposes.
 */
import type { Lang } from "../../onboarding/question.js"
import {
  readStylePreference,
  type VoiceStylePreference,
} from "@pa/memory"
import type { InjectionType } from "../imperfection-injector/types.js"
import { FILLER_BLACKLIST_EN, FILLER_BLACKLIST_ZH } from "./filler-blacklists.js"
import { PROFESSIONAL_PRESCREEN_PREFIX } from "./professional-prefix.js"

export { PROFESSIONAL_PRESCREEN_PREFIX } from "./professional-prefix.js"

export type VoiceProfileId =
  | "friend_onboarding"
  | "friend_general_chat"
  | "friend_find_match_reply"
  | "friend_prescreen_invite"
  | "friend_post_pass"
  | "friend_support"
  | "professional_prescreen"

export type SlangBudgetMode = "mirror_user" | "fixed_low" | "off"
export type EmojiPolicy = "banned" | "sparse" | "allowed"

export type VoiceProfileChoreography = {
  reactionsAllowed: boolean
  reactionMaxPerN: number
  preCallNarration: boolean
  ackThenAsk: { allowed: boolean; rate: number }
  imperfectionArms: InjectionType[]
  imperfectionRate: number
  mirroringEnabled: boolean
  splitProbability: number
  emoji: EmojiPolicy
  slangBudget: SlangBudgetMode
}

export type VoiceProfile = {
  id: VoiceProfileId
  purpose: string
  prefix: Record<Lang, string>
  choreography: VoiceProfileChoreography
  fillerBlacklist: readonly string[]
  invariants: {
    mirrorScoreMax: number
    repeatAdviceMax: number
    lengthCapChars: number
    noInterviewPromise?: boolean
    noOversellLanguage?: boolean
  }
}

export type ResolvedVoiceProfile = VoiceProfile & {
  resolvedEmoji: EmojiPolicy
  resolvedSlangBudget: SlangBudgetMode
  userStylePreference: VoiceStylePreference | null
}

const FRIEND_CHOREO_BASE: VoiceProfileChoreography = {
  reactionsAllowed: true,
  reactionMaxPerN: 5,
  preCallNarration: true,
  ackThenAsk: { allowed: true, rate: 0.5 },
  imperfectionArms: ["hesitate", "self_correct"],
  imperfectionRate: 0.25,
  mirroringEnabled: true,
  splitProbability: 0.35,
  emoji: "sparse",
  slangBudget: "mirror_user",
}

const PROFILES: Record<VoiceProfileId, VoiceProfile> = {
  friend_onboarding: {
    id: "friend_onboarding",
    purpose: "shared_onboarding_slots",
    prefix: { zh: "", en: "" },
    choreography: { ...FRIEND_CHOREO_BASE },
    fillerBlacklist: [...FILLER_BLACKLIST_EN, ...FILLER_BLACKLIST_ZH],
    invariants: { mirrorScoreMax: 0.35, repeatAdviceMax: 0, lengthCapChars: 600 },
  },
  friend_general_chat: {
    id: "friend_general_chat",
    purpose: "default_retention_chat",
    prefix: { zh: "", en: "" },
    choreography: { ...FRIEND_CHOREO_BASE },
    fillerBlacklist: [...FILLER_BLACKLIST_EN, ...FILLER_BLACKLIST_ZH],
    invariants: { mirrorScoreMax: 0.35, repeatAdviceMax: 0, lengthCapChars: 600 },
  },
  friend_find_match_reply: {
    id: "friend_find_match_reply",
    purpose: "job_recommendation_delivery",
    prefix: { zh: "", en: "" },
    choreography: { ...FRIEND_CHOREO_BASE, preCallNarration: false },
    fillerBlacklist: [...FILLER_BLACKLIST_EN, ...FILLER_BLACKLIST_ZH],
    invariants: { mirrorScoreMax: 0.35, repeatAdviceMax: 0, lengthCapChars: 800 },
  },
  friend_prescreen_invite: {
    id: "friend_prescreen_invite",
    purpose: "collab_job_prescreen_invite",
    prefix: {
      en: [
        "[VOICE PROFILE: FRIEND PRESCREEN INVITE]",
        "You are inviting the candidate to try a quick partner-role screen.",
        "Friend tone — NOT professional prescreen register yet.",
        "NEVER promise they will get an interview or that they will pass.",
        "NEVER oversell ('perfect fit', 'guaranteed', 'definitely').",
        "Mention it's a short Q&A; if they do well you can intro them to the team.",
      ].join("\n"),
      zh: [
        "[VOICE PROFILE: FRIEND PRESCREEN INVITE]",
        "You are inviting the candidate to try a quick partner-role screen.",
        "Friend tone — NOT professional prescreen register yet.",
        "NEVER promise they will get an interview or that they will pass.",
        "NEVER oversell ('perfect fit', 'guaranteed', 'definitely').",
        "Mention it's a short Q&A; if they do well you can intro them to the team.",
      ].join("\n"),
    },
    choreography: {
      ...FRIEND_CHOREO_BASE,
      reactionsAllowed: false,
      ackThenAsk: { allowed: true, rate: 0.4 },
    },
    fillerBlacklist: [...FILLER_BLACKLIST_EN, ...FILLER_BLACKLIST_ZH],
    invariants: {
      mirrorScoreMax: 0.35,
      repeatAdviceMax: 0,
      lengthCapChars: 500,
      noInterviewPromise: true,
      noOversellLanguage: true,
    },
  },
  friend_post_pass: {
    id: "friend_post_pass",
    purpose: "post_prescreen_pass_celebration",
    prefix: { zh: "", en: "" },
    choreography: { ...FRIEND_CHOREO_BASE, reactionsAllowed: true },
    fillerBlacklist: [...FILLER_BLACKLIST_EN, ...FILLER_BLACKLIST_ZH],
    invariants: { mirrorScoreMax: 0.35, repeatAdviceMax: 0, lengthCapChars: 500 },
  },
  friend_support: {
    id: "friend_support",
    purpose: "help_and_clarification",
    prefix: { zh: "", en: "" },
    choreography: { ...FRIEND_CHOREO_BASE, splitProbability: 0.25 },
    fillerBlacklist: [...FILLER_BLACKLIST_EN, ...FILLER_BLACKLIST_ZH],
    invariants: { mirrorScoreMax: 0.35, repeatAdviceMax: 0, lengthCapChars: 600 },
  },
  professional_prescreen: {
    id: "professional_prescreen",
    purpose: "prescreen_pipeline",
    prefix: PROFESSIONAL_PRESCREEN_PREFIX,
    choreography: {
      reactionsAllowed: false,
      reactionMaxPerN: 99,
      preCallNarration: false,
      ackThenAsk: { allowed: false, rate: 0 },
      imperfectionArms: [],
      imperfectionRate: 0,
      mirroringEnabled: false,
      splitProbability: 0.1,
      emoji: "banned",
      slangBudget: "off",
    },
    fillerBlacklist: [...FILLER_BLACKLIST_EN, ...FILLER_BLACKLIST_ZH],
    invariants: { mirrorScoreMax: 0.2, repeatAdviceMax: 0, lengthCapChars: 700 },
  },
}

export const ALL_VOICE_PROFILE_IDS = Object.keys(PROFILES) as VoiceProfileId[]

export function getVoiceProfile(id: VoiceProfileId): VoiceProfile {
  return PROFILES[id]
}

function emojiFromPreference(pref: VoiceStylePreference | null, profileDefault: EmojiPolicy): EmojiPolicy {
  if (!pref) return profileDefault
  if (pref.emoji_tolerance === "none") return "banned"
  if (pref.emoji_tolerance === "expressive" && profileDefault !== "banned") return "allowed"
  return profileDefault === "banned" ? "banned" : "sparse"
}

function slangFromPreference(pref: VoiceStylePreference | null, profileDefault: SlangBudgetMode): SlangBudgetMode {
  if (!pref || profileDefault === "off") return profileDefault
  if (pref.preferred_register === "formal") return "fixed_low"
  return profileDefault
}

export async function resolveProfileForUser(
  profileId: VoiceProfileId,
  userId: string
): Promise<ResolvedVoiceProfile> {
  const base = getVoiceProfile(profileId)
  let pref: VoiceStylePreference | null = null
  try {
    pref = await readStylePreference(userId)
  } catch {
    pref = null
  }
  return {
    ...base,
    resolvedEmoji: emojiFromPreference(pref, base.choreography.emoji),
    resolvedSlangBudget: slangFromPreference(pref, base.choreography.slangBudget),
    userStylePreference: pref,
  }
}

/** Map legacy VoiceMode → profile id */
export function voiceModeToProfileId(mode: "casual_onboarding" | "professional_prescreen"): VoiceProfileId {
  return mode === "professional_prescreen" ? "professional_prescreen" : "friend_onboarding"
}

export function injectVoiceProfilePrefix(systemPrompt: string, profile: VoiceProfile, lang: Lang): string {
  const prefix = profile.prefix[lang] ?? profile.prefix.en ?? ""
  if (!prefix.length) return systemPrompt
  return `${prefix}\n\n${systemPrompt}`
}
