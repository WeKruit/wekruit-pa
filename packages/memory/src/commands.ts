export type MemoryCommand =
  | { kind: "remember"; content: string }
  | { kind: "list" }
  | { kind: "forget"; query: string }
  | { kind: "clear_request" }
  | { kind: "clear_confirm" }

export type FactLike = { id: string; content: string }

const REMEMBER_PREFIXES = ["记住", "remember "]
const FORGET_PREFIXES = ["忘记", "forget "]

export function parseMemoryCommand(raw: string): MemoryCommand | null {
  const text = raw.trim()
  if (!text) return null
  if (text === "我的记忆" || text.toLowerCase() === "my memory") return { kind: "list" }
  if (text === "清空记忆" || text.toLowerCase() === "clear memory") return { kind: "clear_request" }
  if (text === "确认清空记忆" || text.toLowerCase() === "confirm clear memory") {
    return { kind: "clear_confirm" }
  }
  for (const prefix of REMEMBER_PREFIXES) {
    if (text.toLowerCase().startsWith(prefix.toLowerCase())) {
      const content = text.slice(prefix.length).trim()
      return content ? { kind: "remember", content } : null
    }
  }
  for (const prefix of FORGET_PREFIXES) {
    if (text.toLowerCase().startsWith(prefix.toLowerCase())) {
      const query = text.slice(prefix.length).trim()
      return query ? { kind: "forget", query } : null
    }
  }
  return null
}

export function shouldRejectMemoryFact(content: string): { reject: boolean; reason?: string } {
  const text = content.toLowerCase()
  if (/\bsk-[a-z0-9_-]{6,}/i.test(content) || text.includes("api key") || text.includes("secret key")) {
    return { reject: true, reason: "secret" }
  }
  if (/\b\d{3}-\d{2}-\d{4}\b/.test(content) || text.includes("ssn") || text.includes("social security")) {
    return { reject: true, reason: "government_id" }
  }
  const digits = content.replace(/\D/g, "")
  if (digits.length >= 13 && digits.length <= 19 && /(信用卡|credit card|card number|卡号)/i.test(content)) {
    return { reject: true, reason: "payment" }
  }
  return { reject: false }
}

export function findMatchingFacts<T extends FactLike>(facts: T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  return facts.filter((fact) => fact.content.toLowerCase().includes(q))
}
