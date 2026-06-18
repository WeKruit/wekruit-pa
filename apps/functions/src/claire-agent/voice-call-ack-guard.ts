const LOW_INFO_AFFIRMATIVE = new Set([
  "sure",
  "yes",
  "yeah",
  "yep",
  "yup",
  "ok",
  "okay",
  "sounds good",
  "sg",
  "go ahead",
  "lets do it",
  "let's do it",
  "that works",
  "works",
  "works for me",
  "cool",
  "bet",
  "alright",
  "all right",
])

function normalizeAck(text: string): string {
  return (text ?? "")
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ")
}

function normalizeSearch(text: string): string {
  return (text ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
}

export function isLowInfoAffirmative(text: string): boolean {
  return LOW_INFO_AFFIRMATIVE.has(normalizeAck(text))
}

function isActualCallOffer(text: string): boolean {
  return /reply yes and i['\u2019]?ll call now/.test(text) || /i can call you at .*number ending/.test(text)
}

function isActualRolePullOffer(text: string): boolean {
  return (
    /\bwant me to (pull|find|show|recommend)\b.*\b(roles|jobs|matches)\b/.test(text) ||
    /\bshould i (pull|find|show|recommend)\b.*\b(roles|jobs|matches)\b/.test(text)
  )
}

function isPhonePrescreenRoleChoice(text: string): boolean {
  const hasVoiceOrPrescreen = /\b(phone|call|voice|prescreen|screen)\b/.test(text)
  const asksForRoleChoice =
    /\bwhich one do you want\b/.test(text) ||
    /\bwhich role\b/.test(text) ||
    /\bdo you mean\b.*\b(screen|role|martini|agent|full-stack|product)\b/.test(text) ||
    /\bexact\b.*\b(role|screen)\b/.test(text) ||
    /\bpick another\b.*\b(role|screen)\b/.test(text) ||
    /\brun next\b/.test(text) ||
    /\bcall you about\b/.test(text)
  return hasVoiceOrPrescreen && asksForRoleChoice
}

export function shouldHoldVoiceCallAckFromMatching(
  userText: string,
  recentAssistantMessages: readonly string[],
): boolean {
  if (!isLowInfoAffirmative(userText)) return false
  const recent = recentAssistantMessages
    .slice(-3)
    .map(normalizeSearch)
    .filter(Boolean)
  if (recent.length === 0) return false
  const last = recent[recent.length - 1] ?? ""
  if (isActualCallOffer(last)) return false
  if (isActualRolePullOffer(last) && !isPhonePrescreenRoleChoice(last)) return false
  return recent.some(isPhonePrescreenRoleChoice)
}

function extractChoiceList(recentAssistantMessages: readonly string[]): string {
  const last = recentAssistantMessages[recentAssistantMessages.length - 1] ?? ""
  const match = /which one do you want:\s*([\s\S]+?)\s*\??$/i.exec(last.trim())
  return match?.[1]?.trim() ?? ""
}

export function buildVoiceCallAckClarifier(recentAssistantMessages: readonly string[]): string {
  const choices = extractChoiceList(recentAssistantMessages)
  if (choices) {
    return `got it - reading that as yes to the phone screen, not as a request for new jobs. which role should i call you about: ${choices}?`
  }
  return "got it - reading that as yes to the phone screen, not as a request for new jobs. which role should i call you about?"
}
