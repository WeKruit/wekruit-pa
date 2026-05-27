import { peekSource, type SignupSource } from "./source.js"
import { canonicalizePublicJobPath } from "./public-job-slugs.js"

export const GLOBAL_UID_KEY = "wkr_uid"
export const CLAIM_EMAIL_KEY = "wkr_claim_email"
export const ONBOARDING_CANDIDATE_ID_KEY = "wkr_candidate_id"
export const LOGIN_NEXT_SESSION_KEY = "wkr_login_next"
export const ONBOARDING_INTENT_KEY = "wkr_onboarding_intent"
export const RETURN_JOB_PATH_KEY = "wkr_return_job_path"

const COOKIE_MAX_AGE = 60 * 60 * 24 * 180
export const CANDIDATE_ORIGIN = "https://wekruit.com"

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

export function clearSharedCookie(name: string): void {
  const secure = window.location.protocol === "https:" ? "; Secure" : ""
  const domain = cookieDomainForHost(window.location.hostname)
  const domainPart = domain ? `; Domain=${domain}` : ""
  document.cookie = `${encodeURIComponent(name)}=; Max-Age=0; Path=/; SameSite=Lax${secure}${domainPart}`
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

export function forgetStoredValue(key: string): void {
  storage()?.removeItem(key)
  clearSharedCookie(key)
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

/** Public job gates are pre-portal flows and must survive first login. */
export function isPublicJobPath(pathname: string): boolean {
  return /^\/j\/[^/]+(?:\/cv)?$/.test(pathname)
}

export type OnboardingIntent = "generic_onboarding" | "job_prescreen"

export type OnboardingIntentState = {
  intent: OnboardingIntent
  returnPath: string | null
}

function splitAppPath(path: string): { pathname: string; search: string; to: string } {
  const q = path.indexOf("?")
  const pathname = (q >= 0 ? path.slice(0, q) : path) || "/onboarding"
  const search = q >= 0 ? path.slice(q) : ""
  return { pathname, search, to: `${pathname}${search}` }
}

/** Persist post-login destination across OAuth redirects that strip query params. */
export function rememberLoginNext(next: string): void {
  const clean = next.trim()
  if (!clean.startsWith("/") || clean.startsWith("//")) return
  try {
    window.sessionStorage.setItem(LOGIN_NEXT_SESSION_KEY, clean)
  } catch {
    // ignore private mode
  }
}

export function readRememberedLoginNext(): string | null {
  try {
    const value = window.sessionStorage.getItem(LOGIN_NEXT_SESSION_KEY)
    return value?.trim() || null
  } catch {
    return null
  }
}

export function clearRememberedLoginNext(): void {
  try {
    window.sessionStorage.removeItem(LOGIN_NEXT_SESSION_KEY)
  } catch {
    // ignore
  }
}

/**
 * Post-login routing (Adam 2026-05-20): only honor `/me*` when portal-ready
 * (inbound Claire iMessage + resume on file). Public job pages are pre-portal
 * interview gates, so keep `/j/:jobId` and `/j/:jobId/cv` through first login.
 */
export function resolvePostLoginDestination(
  nextDest: LoginNextDestination,
  portalReady: boolean,
  source: SignupSource = peekSource(),
): string {
  if (portalReady) {
    if (nextDest.isOnboarding) return "/me"
    return nextDest.to
  }
  if (isPublicJobPath(nextDest.pathname)) return nextDest.to
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
  const remembered =
    !raw || !raw.startsWith("/") || raw.startsWith("//") ? readRememberedLoginNext() : null
  const candidate = raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : remembered
  if (!candidate) {
    const split = splitAppPath(fallback)
    return {
      ...split,
      isOnboarding: split.pathname === "/onboarding",
    }
  }
  try {
    const url = new URL(candidate, CANDIDATE_ORIGIN)
    const pathname = canonicalizePublicJobPath(url.pathname || "/onboarding")
    const search = url.search
    return {
      pathname,
      search,
      to: `${pathname}${search}`,
      isOnboarding: pathname === "/onboarding",
    }
  } catch {
    const rawSplit = splitAppPath(candidate)
    const split = {
      ...rawSplit,
      pathname: canonicalizePublicJobPath(rawSplit.pathname),
      to: "",
    }
    split.to = `${split.pathname}${split.search}`
    return {
      ...split,
      isOnboarding: split.pathname === "/onboarding",
    }
  }
}

export function deriveOnboardingIntentFromPath(
  path: string | null | undefined,
): OnboardingIntentState {
  const dest = parseLoginNextPath(path, onboardingDestination("candidate"))
  if (isPublicJobPath(dest.pathname)) {
    return {
      intent: "job_prescreen",
      returnPath: dest.to,
    }
  }
  return {
    intent: "generic_onboarding",
    returnPath: null,
  }
}

export function rememberOnboardingIntentForPath(path: string | null | undefined): void {
  const state = deriveOnboardingIntentFromPath(path)
  rememberStoredValue(ONBOARDING_INTENT_KEY, state.intent)
  if (state.returnPath) {
    rememberStoredValue(RETURN_JOB_PATH_KEY, state.returnPath)
  } else {
    forgetStoredValue(RETURN_JOB_PATH_KEY)
  }
}

export function readRememberedReturnJobPath(): string | null {
  const stored = readStoredValue(RETURN_JOB_PATH_KEY)
  if (!stored) return null
  const state = deriveOnboardingIntentFromPath(stored)
  return state.returnPath
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
 * Optional cross-host hop to candidate.wekruit.com (e.g. layoff done → /me pipeline).
 * Layoff login/onboarding stay on layoff.wekruit.com — do not use for auth entry.
 */
export function redirectToCandidatePortal(next = "/me"): void {
  window.location.replace(candidatePortalLoginUrl(next))
}

/** Onboarding path for the current signup source (layoff cookie/query vs candidate). */
export function onboardingDestination(source: SignupSource = peekSource()): string {
  return source === "WeKruit_Laid_Off" ? "/onboarding?source=layoff" : "/onboarding"
}

/** Login-first entry for layoff candidate signup (auth on candidate origin). */
export function layoffSignupLoginPath(): string {
  return `/login?next=${encodeURIComponent(onboardingDestination("WeKruit_Laid_Off"))}`
}

export function candidateProfileDestination(): string {
  if (isCandidateHost()) return candidateLoginPath(candidateProfilePath())
  return candidatePortalLoginUrl(candidateProfilePath())
}
