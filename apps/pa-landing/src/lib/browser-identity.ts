export const GLOBAL_UID_KEY = "wkr_uid"
export const CLAIM_EMAIL_KEY = "wkr_claim_email"
export const ONBOARDING_CANDIDATE_ID_KEY = "wkr_candidate_id"

const COOKIE_MAX_AGE = 60 * 60 * 24 * 180
const CANDIDATE_ORIGIN = "https://candidate.wekruit.com"

function storage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function cookieDomainForHost(hostname: string): string {
  const host = hostname.toLowerCase()
  if (host === "wekruit.com" || host.endsWith(".wekruit.com")) return ".wekruit.com"
  return ""
}

export function readCookieValue(cookieString: string, name: string): string | null {
  const encodedName = encodeURIComponent(name)
  for (const part of cookieString.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=")
    if (rawKey !== encodedName) continue
    return decodeURIComponent(rawValue.join("="))
  }
  return null
}

export function setSharedCookie(name: string, value: string): void {
  const secure = window.location.protocol === "https:" ? "; Secure" : ""
  const domain = cookieDomainForHost(window.location.hostname)
  const domainPart = domain ? `; Domain=${domain}` : ""
  document.cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value)}; Max-Age=${COOKIE_MAX_AGE}; Path=/; SameSite=Lax${secure}${domainPart}`
}

export function getSharedCookie(name: string): string | null {
  return readCookieValue(document.cookie, name)
}

export function readStoredValue(key: string): string | null {
  const local = storage()?.getItem(key)
  if (local) return local
  const cookie = getSharedCookie(key)
  if (cookie) {
    storage()?.setItem(key, cookie)
    return cookie
  }
  return null
}

export function rememberStoredValue(key: string, value: string | null | undefined): void {
  const clean = value?.trim()
  if (!clean) return
  storage()?.setItem(key, clean)
  setSharedCookie(key, clean)
}

export function getBrowserUid(): string {
  const existing = readStoredValue(GLOBAL_UID_KEY)
  if (existing) return existing
  const value = crypto.randomUUID()
  rememberStoredValue(GLOBAL_UID_KEY, value)
  return value
}

export function rememberCandidateProfileSession(input: {
  candidateId?: string | null
  email?: string | null
  browserUid?: string | null
}): void {
  rememberStoredValue(GLOBAL_UID_KEY, input.browserUid ?? getBrowserUid())
  rememberStoredValue(ONBOARDING_CANDIDATE_ID_KEY, input.candidateId)
  rememberStoredValue(CLAIM_EMAIL_KEY, input.email)
}

export function candidateProfilePath(): string {
  return "/me/profile"
}

export function candidateLoginPath(next = candidateProfilePath()): string {
  return `/login?next=${encodeURIComponent(next)}`
}

export function isCandidateHost(hostname = window.location.hostname): boolean {
  const host = hostname.toLowerCase()
  return host.startsWith("candidate.") || host === "wekruit-pa-landing.web.app" || host === "localhost" || host === "127.0.0.1"
}

export function candidateProfileDestination(): string {
  if (isCandidateHost()) return candidateLoginPath(candidateProfilePath())
  return `${CANDIDATE_ORIGIN}${candidateLoginPath(candidateProfilePath())}`
}
