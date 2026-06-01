import type { ResolvedVoiceProfile } from "./voice/voice-profiles/index.js"

export type CollabInviteSurfaceMode = "invite" | "clarify" | "declined_ack"

export function buildCollabInviteIntent(input: {
  jobTitle: string
  company: string
  mode: CollabInviteSurfaceMode
  voiceProfile: ResolvedVoiceProfile
  matchSummary?: string
}): string {
  const base =
    input.mode === "invite"
      ? `Invite the candidate to a quick (~5 min) partner-role prescreen for ${input.jobTitle} @ ${input.company}.`
      : input.mode === "clarify"
        ? "Clarify whether they want the quick partner prescreen — friend tone, one short question."
        : "Acknowledge they passed on the partner prescreen invite — stay warm, no pressure."

  const invariants: string[] = [
    "Compose ONE SMS only.",
    "Friend roommate tone — not HR, not formal interview register yet.",
  ]
  if (input.voiceProfile.invariants.noInterviewPromise) {
    invariants.push("Never promise they will get an interview or that they will pass.")
  }
  if (input.voiceProfile.invariants.noOversellLanguage) {
    invariants.push("No oversell (perfect fit, guaranteed, definitely, slam dunk).")
  }
  if (input.matchSummary?.trim()) {
    invariants.push(`Why it might fit (soft): ${input.matchSummary.trim()}`)
  }

  return [base, ...invariants].join("\n")
}

const ACCEPT_PATTERNS = [
  /\b(yes|yeah|yep|yup|sure|ok|okay|down|let'?s do|i'?m in|sounds good|why not)\b/i,
]
const DECLINE_PATTERNS = [
  /\b(no|nah|nope|pass|not now|not interested|skip|later)\b/i,
]

export type CollabInviteReplyIntent = "accept" | "decline" | "ambiguous"

export function detectCollabInviteReplyIntent(body: string): CollabInviteReplyIntent {
  const t = body.trim()
  if (!t) return "ambiguous"
  if (DECLINE_PATTERNS.some((p) => p.test(t))) return "decline"
  if (ACCEPT_PATTERNS.some((p) => p.test(t))) return "accept"
  return "ambiguous"
}

export function buildCollabInviteTemplate(input: {
  lang: "en" | "zh"
  jobTitle: string
  company: string
}): string {
  return `quick one — ${input.company} has a partner ${input.jobTitle} role and we can run a short ~5min screen first. wanna try? if it goes well I can intro you to the team — no guarantees on outcome tho`
}
