import {
  onIdTokenChanged,
  signInWithCustomToken,
  type User,
  type Unsubscribe,
} from "firebase/auth"
import { auth } from "./firebase.js"

/**
 * Cross-domain SSO client for *.wekruit.com.
 *
 * Companion to `apps/functions/src/cross-domain-sso.ts`. Restores per-origin
 * Firebase sessions from the shared `.wekruit.com` `wkr_session` cookie so a
 * user who signed in on `candidate.wekruit.com` stays signed in when they
 * navigate to `www.wekruit.com` (or any other wekruit.com subdomain) without
 * having to re-authenticate.
 *
 * Three pieces:
 *   - `bootstrapSsoFromCookie()` — call on app boot before React mounts.
 *     If this origin's IndexedDB has no Firebase session, asks `paSsoBootstrap`
 *     for a custom token derived from the shared cookie and consumes it via
 *     `signInWithCustomToken`. No-op when already signed in or when the
 *     shared cookie is absent / invalid.
 *   - `registerSsoCookieRefresh()` — call once during app init. Mirrors every
 *     Firebase ID-token refresh to `paSsoLogin` so the shared cookie stays
 *     fresh across subdomains and survives token rotation.
 *   - `clearSsoCookie()` — call before `signOut()` so the next bootstrap on
 *     any other subdomain returns 401 and tears down the cross-domain session.
 */

const SSO_BASE_URL = ((): string => {
  const explicit = import.meta.env.VITE_PA_SSO_BASE_URL
  if (typeof explicit === "string" && explicit.length > 0) return explicit.replace(/\/$/, "")
  return "https://us-central1-wekruit-5f89b.cloudfunctions.net"
})()

const SSO_LOGIN_URL = `${SSO_BASE_URL}/paSsoLogin`
const SSO_BOOTSTRAP_URL = `${SSO_BASE_URL}/paSsoBootstrap`
const SSO_LOGOUT_URL = `${SSO_BASE_URL}/paSsoLogout`

// One bootstrap attempt per tab session. Without this every SPA navigation
// would re-fetch `paSsoBootstrap` even though Firebase already wrote a session
// to IndexedDB on the first restore — wasteful and turns into a paper-cut on
// pages with no auth at all.
const SSO_BOOTSTRAP_TRIED_KEY = "wkr_sso_bootstrap_tried"

function safeSessionStorage(): Storage | null {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

export async function bootstrapSsoFromCookie(): Promise<User | null> {
  if (typeof window === "undefined") return null
  // If Firebase already has a session on this origin, no work to do.
  if (auth().currentUser) return auth().currentUser
  const ss = safeSessionStorage()
  if (ss?.getItem(SSO_BOOTSTRAP_TRIED_KEY)) return null
  ss?.setItem(SSO_BOOTSTRAP_TRIED_KEY, "1")
  try {
    const res = await fetch(SSO_BOOTSTRAP_URL, {
      method: "GET",
      credentials: "include",
    })
    if (!res.ok) return null
    const body = (await res.json()) as { customToken?: string }
    if (!body.customToken) return null
    const cred = await signInWithCustomToken(auth(), body.customToken)
    return cred.user
  } catch {
    return null
  }
}

export function registerSsoCookieRefresh(): Unsubscribe {
  return onIdTokenChanged(auth(), async (user) => {
    if (!user) return
    try {
      const idToken = await user.getIdToken()
      await fetch(SSO_LOGIN_URL, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken }),
      })
    } catch {
      // Best-effort: failure means the cookie won't refresh this round; the
      // next token rotation (~1h) will retry. Existing cookie stays valid up
      // to its 5-day max and bootstrap on other subdomains keeps working.
    }
  })
}

export async function clearSsoCookie(): Promise<void> {
  safeSessionStorage()?.removeItem(SSO_BOOTSTRAP_TRIED_KEY)
  try {
    await fetch(SSO_LOGOUT_URL, { method: "POST", credentials: "include" })
  } catch {
    // ignore — cookie expiry will eventually catch up even if logout fails.
  }
}
