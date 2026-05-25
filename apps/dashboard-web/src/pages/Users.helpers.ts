export function normalizePhoneLookup(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const digits = trimmed.replace(/\D/g, "")
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`
  if (trimmed.startsWith("+") && digits.length >= 8) return `+${digits}`
  return null
}
