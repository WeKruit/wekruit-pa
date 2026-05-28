import {
  onIdTokenChanged,
  signInWithCustomToken,
  type User,
  type Unsubscribe,
} from "firebase/auth"
import { auth } from "./firebase.js"

/**
 * Cross-domain SSO client for the admin dashboard at `wekruit-pa.web.app`
 * and any other `*.wekruit.com` surface that mounts this app. Mirrors the
 * pa-landing helper at `apps/pa-landing/src/lib/cross-domain-sso.ts`.
 *
 * Companion to `apps/functions/src/cross-domain-sso.ts` — see that file for
 * the protocol overview. Duplicated here so the admin SPA can ship without
 * pulling in the pa-landing source tree.
 */

// Same-origin paths proxied by Firebase Hosting rewrites in firebase.json. Going
// through cloudfunctions.net would make the request cross-site and the browser
// would refuse to honor Set-Cookie Domain=.wekruit.com on the response.
const SSO_BASE_URL = ((): string => {
  const explicit = import.meta.env.VITE_PA_SSO_BASE_URL
  if (typeof explicit === "string" && explicit.length > 0) return explicit.replace(/\/$/, "")
  return ""
})()

const SSO_LOGIN_URL = `${SSO_BASE_URL}/_sso/login`
const SSO_BOOTSTRAP_URL = `${SSO_BASE_URL}/_sso/bootstrap`
const SSO_LOGOUT_URL = `${SSO_BASE_URL}/_sso/logout`

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
      // best-effort
    }
  })
}

export async function clearSsoCookie(): Promise<void> {
  safeSessionStorage()?.removeItem(SSO_BOOTSTRAP_TRIED_KEY)
  try {
    await fetch(SSO_LOGOUT_URL, { method: "POST", credentials: "include" })
  } catch {
    // ignore
  }
}
