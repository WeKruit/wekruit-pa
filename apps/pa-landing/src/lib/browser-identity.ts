import { peekSource, type SignupSource } from "./source.js"

export const GLOBAL_UID_KEY = "wkr_uid"
export const CLAIM_EMAIL_KEY = "wkr_claim_email"
export const ONBOARDING_CANDIDATE_ID_KEY = "wkr_candidate_id"

const COOKIE_MAX_AGE = 60 * 60 * 24 * 180
export const CANDIDATE_ORIGIN = "https://candidate.wekruit.com"

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

/** Parsed post-login destination from the `?next=` login query param. */
export type LoginNextDestination = {
  pathname: string
  search: string
  /** Path + query for redirects (e.g. `/onboarding?source=layoff`). */
  to: string
  /** True when `next` targets onboarding regardless of query string. */
  isOnboarding: boolean
}

/** Candidate portal home and sub-routes — require inbound Claire iMessage before entry. */
export function isCandidatePortalPath(pathname: string): boolean {
  return pathname === "/me" || pathname.startsWith("/me/")
}

/**
 * Post-login routing (Adam 2026-05-20): only honor `/me*` when Claire inbound
 * conversation has started; otherwise send to onboarding.
 */
export function resolvePostLoginDestination(
  nextDest: LoginNextDestination,
  claireConversationStarted: boolean,
  source: SignupSource = peekSource(),
): string {
  if (claireConversationStarted) {
    if (nextDest.isOnboarding) return "/me"
    return nextDest.to
  }
  if (nextDest.isOnboarding) return nextDest.to
  if (isCandidatePortalPath(nextDest.pathname)) return onboardingDestination(source)
  return onboardingDestination(source)
}

/**
 * Parse a safe in-app `next` path from `/login?next=...`.
 * Rejects open redirects (`//evil.com`) and normalizes pathname vs search.
 */
export function parseLoginNextPath(
  raw: string | null | undefined,
  fallback = onboardingDestination(peekSource()),
): LoginNextDestination {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) {
    return {
      pathname: fallback,
      search: "",
      to: fallback,
      isOnboarding: fallback === "/onboarding",
    }
  }
  try {
    const url = new URL(raw, CANDIDATE_ORIGIN)
    const pathname = url.pathname || fallback
    const search = url.search
    return {
      pathname,
      search,
      to: `${pathname}${search}`,
      isOnboarding: pathname === "/onboarding",
    }
  } catch {
    const q = raw.indexOf("?")
    const pathname = (q >= 0 ? raw.slice(0, q) : raw) || fallback
    const search = q >= 0 ? raw.slice(q) : ""
    return {
      pathname,
      search,
      to: `${pathname}${search}`,
      isOnboarding: pathname === "/onboarding",
    }
  }
}

export function isCandidateHost(hostname = window.location.hostname): boolean {
  const host = hostname.toLowerCase()
  return host.startsWith("candidate.") || host === "wekruit-pa-landing.web.app" || host === "localhost" || host === "127.0.0.1"
}

export function isLayoffHost(hostname = window.location.hostname): boolean {
  const host = hostname.toLowerCase()
  return host.startsWith("layoff.") || host === "layoff-wekruit.web.app"
}

export function candidatePortalUrl(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`
  return `${CANDIDATE_ORIGIN}${normalized}`
}

/** Full candidate-origin login URL (Firebase session must live on candidate host). */
export function candidatePortalLoginUrl(next = "/me"): string {
  const normalized = next.startsWith("/") ? next : `/${next}`
  return candidatePortalUrl(candidateLoginPath(normalized))
}

/**
 * Leave layoff (or any non-candidate host) for the candidate portal.
 * Always routes through /login on candidate.wekruit.com so auth cookies attach
 * to the correct Firebase origin before /me or /onboarding.
 */
export function redirectToCandidatePortal(next = "/me"): void {
  window.location.replace(candidatePortalLoginUrl(next))
}

/** Onboarding path for the current signup source (layoff cookie/query vs candidate). */
export function onboardingDestination(source: SignupSource = peekSource()): string {
  return source === "WeKruit_Laid_Off" ? "/onboarding?source=layoff" : "/onboarding"
}

export function candidateProfileDestination(): string {
  if (isCandidateHost()) return candidateLoginPath(candidateProfilePath())
  return candidatePortalLoginUrl(candidateProfilePath())
}
