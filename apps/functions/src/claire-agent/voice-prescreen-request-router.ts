import type { CollabRole } from "./tools/matching-tools.js"

const VOICE_WORDS = new Set(["call", "phone", "voice", "ring"])
const PRESCREEN_WORDS = new Set(["prescreen", "pre", "screen", "interview", "interviewing"])
const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "at",
  "can",
  "could",
  "do",
  "for",
  "have",
  "help",
  "i",
  "it",
  "let",
  "me",
  "my",
  "now",
  "on",
  "please",
  "quick",
  "that",
  "the",
  "this",
  "to",
  "wanna",
  "want",
  "we",
  "with",
  "yes",
])

export type VoicePrescreenRoleResolution =
  | { kind: "one"; role: CollabRole }
  | { kind: "ambiguous"; roles: CollabRole[] }
  | { kind: "none"; roles: CollabRole[] }
  | { kind: "no_startable_roles"; roles: CollabRole[] }

function tokens(text: string): string[] {
  return String(text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2)
}

export function isExplicitVoicePrescreenRequest(text: string): boolean {
  const t = tokens(text)
  const hasVoice = t.some((token) => VOICE_WORDS.has(token))
  const hasPrescreen = t.some((token) => PRESCREEN_WORDS.has(token)) || text.toLowerCase().includes("pre-screen")
  return hasVoice && hasPrescreen
}

function roleLabel(role: CollabRole): string {
  const title = role.title.trim() || "this role"
  const company = role.company.trim()
  return company ? `${title} @ ${company}` : title
}

function isStartable(role: CollabRole): boolean {
  return role.status !== "passed" && role.status !== "not_passed" && role.status !== "under_review"
}

function scoreRole(text: string, role: CollabRole): number {
  const queryTokens = new Set(tokens(text).filter((token) => !STOPWORDS.has(token)))
  const titleTokens = new Set(tokens(role.title))
  const companyTokens = new Set(tokens(role.company))
  let score = 0
  for (const token of queryTokens) {
    if (companyTokens.has(token)) score += 6
    if (titleTokens.has(token)) score += 3
  }
  return score
}

export function resolveVoicePrescreenRole(
  text: string,
  roles: CollabRole[],
): VoicePrescreenRoleResolution {
  const startable = roles.filter(isStartable)
  if (startable.length === 0) return { kind: "no_startable_roles", roles }
  const scored = startable
    .map((role) => ({ role, score: scoreRole(text, role) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
  if (scored.length === 0) return { kind: "none", roles: startable }
  const topScore = scored[0]!.score
  const top = scored.filter((item) => item.score === topScore).map((item) => item.role)
  if (top.length === 1) return { kind: "one", role: top[0]! }
  return { kind: "ambiguous", roles: top }
}

export function voicePrescreenRoleClarificationText(resolution: VoicePrescreenRoleResolution): string {
  const choices =
    resolution.kind === "no_startable_roles"
      ? []
      : (resolution.kind === "one" ? [resolution.role] : resolution.roles).filter(isStartable).slice(0, 5).map(roleLabel)
  if (choices.length === 0) {
    return "I can't start a phone prescreen from the roles I have here. Which role should I call you about?"
  }
  const joined = choices.length === 1 ? choices[0]! : `${choices.slice(0, -1).join(", ")} or ${choices.at(-1)!}`
  return `Which role should I call you about: ${joined}?`
}
