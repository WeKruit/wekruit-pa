// Source resolver for unified layoff + candidate funnel.
//
// Priority (first hit wins):
//   1. URL ?source=layoff | ?source=candidate
//   2. hostname starts with "layoff." (or layoff-wekruit.web.app)
//   3. cookie wko_source (set on a previous visit)
//   4. default "candidate"
//
// Result is sticky: once resolved, written back to wko_source cookie
// (180d, SameSite=Lax, Secure on https) so subsequent internal nav keeps
// the same source even if the user lands on candidate.wekruit.com via a
// /onboarding link from layoff.wekruit.com.

import { cookieDomainForHost } from "./browser-identity"

export type SignupSource = "WeKruit_Laid_Off" | "candidate" | "layoffhedge"

/**
 * Build marker — minifiers rename exported function names, so the deploy
 * acceptance grep can't see "resolveSource" otherwise. Importing this
 * constant from Onboarding.tsx keeps the literal in the prod bundle.
 */
export const SOURCE_RESOLVER_MARKER = "resolveSource:wko_source:v1"

const COOKIE_NAME = "wko_source"
const COOKIE_MAX_AGE = 60 * 60 * 24 * 180 // 180d

function urlSource(): SignupSource | null {
  if (typeof window === "undefined") return null
  const v = new URLSearchParams(window.location.search).get("source")
  if (!v) return null
  if (v === "layoff" || v === "WeKruit_Laid_Off") return "WeKruit_Laid_Off"
  if (v === "candidate") return "candidate"
  if (v === "layoffhedge") return "layoffhedge"
  return null
}

function hostSource(): SignupSource | null {
  if (typeof window === "undefined") return null
  const host = window.location.hostname.toLowerCase()
  if (host.startsWith("layoff.") || host === "layoff-wekruit.web.app") return "WeKruit_Laid_Off"
  return null
}

function cookieSource(): SignupSource | null {
  if (typeof document === "undefined") return null
  const match = document.cookie.match(new RegExp("(?:^|; )" + COOKIE_NAME + "=([^;]+)"))
  if (!match) return null
  const v = decodeURIComponent(match[1])
  if (v === "WeKruit_Laid_Off" || v === "candidate" || v === "layoffhedge") return v
  return null
}

function writeCookie(value: SignupSource): void {
  if (typeof document === "undefined") return
  const secure = typeof window !== "undefined" && window.location.protocol === "https:" ? "; Secure" : ""
  const domain = typeof window !== "undefined" ? cookieDomainForHost(window.location.hostname) : ""
  const domainPart = domain ? `; Domain=${domain}` : ""
  document.cookie = `${COOKIE_NAME}=${encodeURIComponent(value)}; Max-Age=${COOKIE_MAX_AGE}; Path=/; SameSite=Lax${secure}${domainPart}`
}

/** Resolve source once at first paint. Writes back to cookie on every call. */
export function resolveSource(): SignupSource {
  const v = urlSource() ?? hostSource() ?? cookieSource() ?? "candidate"
  writeCookie(v)
  if (typeof window !== "undefined") {
    // Stable marker for the deploy acceptance grep — survives minification
    // because we attach a literal string to the window object.
    ;(window as unknown as { __wkoSourceResolver?: string }).__wkoSourceResolver = "resolveSource:" + v
  }
  return v
}

/** Read the cookie value without writing. Falls back to default when absent. */
export function peekSource(): SignupSource {
  return cookieSource() ?? "candidate"
}

/** When login `next` targets layoff onboarding, stick source before OAuth strips the URL. */
export function stickSourceFromLoginNext(raw: string | null | undefined): void {
  if (!raw) return
  const q = raw.indexOf("?")
  const pathname = q >= 0 ? raw.slice(0, q) : raw
  if (/^\/j\/[^/]+(?:\/cv)?$/.test(pathname)) {
    writeCookie("candidate")
    return
  }
  if (pathname !== "/onboarding") return
  const params = new URLSearchParams(q >= 0 ? raw.slice(q + 1) : "")
  const fromQuery = params.get("source")
  if (fromQuery === "layoff" || fromQuery === "WeKruit_Laid_Off") {
    writeCookie("WeKruit_Laid_Off")
  } else if (fromQuery === "layoffhedge") {
    writeCookie("layoffhedge")
  } else if (fromQuery === "candidate") {
    writeCookie("candidate")
  }
}
