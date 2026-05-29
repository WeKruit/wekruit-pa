export const REFERRAL_SLUG_STORAGE_KEY = "pa_referrer_slug"

const REFERRAL_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/

export function normalizeReferralSlug(value: unknown): string | null {
  if (typeof value !== "string") return null
  const slug = value.trim().toLowerCase()
  if (!REFERRAL_SLUG_RE.test(slug)) return null
  return slug
}

export function rememberReferralSlug(value: unknown): string | null {
  const slug = normalizeReferralSlug(value)
  if (!slug) return null
  try {
    window.localStorage.setItem(REFERRAL_SLUG_STORAGE_KEY, slug)
  } catch {
    /* ignore private mode */
  }
  return slug
}

export function readReferralSlug(): string | null {
  try {
    return normalizeReferralSlug(window.localStorage.getItem(REFERRAL_SLUG_STORAGE_KEY))
  } catch {
    return null
  }
}

export function clearReferralSlug(value?: unknown): void {
  const slug = normalizeReferralSlug(value)
  try {
    if (!slug || window.localStorage.getItem(REFERRAL_SLUG_STORAGE_KEY) === slug) {
      window.localStorage.removeItem(REFERRAL_SLUG_STORAGE_KEY)
    }
  } catch {
    /* ignore private mode */
  }
}
