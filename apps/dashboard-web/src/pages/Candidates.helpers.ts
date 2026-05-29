export {
  classifyCandidateProfile,
  deriveCandidateSource,
  hasReachableIdentity,
  isDemoPreviewProfile,
  isInternalOperatorProfile,
  isRealCandidateAccount,
  isSyntheticTestProfile,
  type CandidateClass,
  type CandidateListUserDoc,
  type CandidateProfileExternalSource as ExternalSource,
  type SourceKind,
} from "@pa/core-types"

export function isValidE164Phone(value?: string): boolean {
  return typeof value === "string" && /^\+[1-9]\d{7,14}$/.test(value)
}

export function digitsOnly(value?: string): string {
  return (value ?? "").replace(/\D/g, "")
}

export function phoneSearchDigits(value: string): string | null {
  const digits = digitsOnly(value)
  return digits.length >= 3 ? digits : null
}

export function normalizeCandidatePhoneLookup(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const digits = digitsOnly(trimmed)
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`
  if (trimmed.startsWith("+") && digits.length >= 8) return `+${digits}`
  return null
}

export function matchesPhoneSearch(phoneE164: string | undefined, search: string): boolean {
  const queryDigits = phoneSearchDigits(search)
  if (!queryDigits || !phoneE164) return false
  return digitsOnly(phoneE164).includes(queryDigits)
}

export function previewCandidateDrawerText(value: unknown, max = 400): string | undefined {
  if (value === undefined || value === null || value === "") return undefined
  const raw =
    typeof value === "string"
      ? value
      : (() => {
          try {
            return JSON.stringify(value, null, 2)
          } catch {
            return String(value)
          }
        })()
  if (!raw) return undefined
  return raw.length > max ? `${raw.slice(0, max)}...` : raw
}
