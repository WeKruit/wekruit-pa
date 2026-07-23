import { getRedirectResult, type UserCredential, type User } from "firebase/auth"
import { auth, hasFirebaseConfig } from "./firebase.js"
import { bootstrapSsoFromCookie, registerSsoCookieRefresh } from "./cross-domain-sso.js"

/** Start consuming Google OAuth redirect result as early as possible (before React mounts). */
export const redirectResultPromise: Promise<UserCredential | null> = hasFirebaseConfig()
  ? getRedirectResult(auth()).catch(() => null)
  : Promise.resolve(null)

/**
 * Restore the per-origin Firebase session from the shared `.wekruit.com`
 * cookie if available. Runs in parallel with redirect-result consumption so
 * the user is signed in as soon as either path resolves.
 */
export const ssoBootstrapPromise: Promise<User | null> = hasFirebaseConfig()
  ? bootstrapSsoFromCookie().catch(() => null)
  : Promise.resolve(null)

/** Mirror every ID-token refresh into the shared cookie. Side-effect only. */
if (hasFirebaseConfig()) registerSsoCookieRefresh()
