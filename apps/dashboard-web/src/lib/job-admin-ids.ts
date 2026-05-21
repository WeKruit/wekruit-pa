import { normalizeCompanyName } from "@pa/core-types"

function trimTrailingDashes(value: string): string {
  let end = value.length
  while (end > 0 && value.charCodeAt(end - 1) === 45) end--
  return value.slice(0, end)
}

function randomIdSegment(): string {
  if (typeof globalThis.crypto !== "undefined" && "randomUUID" in globalThis.crypto) {
    return globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 8)
  }
  return Math.random().toString(36).slice(2, 10)
}

export function suggestCompanyId(displayName: string): string {
  return normalizeCompanyName(displayName)
}

export function buildJobIdStem(companyId: string, title: string): string {
  const normalizedCompanyId = normalizeCompanyName(companyId) || "company"
  const normalizedTitle = normalizeCompanyName(title) || "job"
  return trimTrailingDashes(`${normalizedCompanyId}-${normalizedTitle}`.slice(0, 90))
}

export function suggestJobId(companyId: string, title: string): string {
  return `${buildJobIdStem(companyId, title)}-${randomIdSegment()}`
}
