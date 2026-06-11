/**
 * Firebase Analytics (GA4) for the candidate SPA.
 *
 * Uses a SECONDARY Firebase app (`initializeApp(cfg, "analytics")`) so the
 * default app in ./firebase.js (auth/firestore/functions) stays untouched.
 * The analytics appId/measurementId are public web-bundle constants for the
 * wekruit-5f89b GA4 web stream, overridable via env for other environments.
 *
 * Guarantees:
 * - lazy: `firebase/analytics` is dynamically imported on first use only
 * - guarded: skips entirely on localhost, SSR, missing API key, or
 *   unsupported environments (`isSupported()`), and survives ad blockers
 * - never throws / never rejects: every public function catches internally
 * - single-init: module-level promise (React StrictMode safe)
 *
 * Page views are NOT tracked manually — GA4 enhanced measurement handles SPA
 * history events. Only custom conversion events go through trackEvent().
 */
import { initializeApp } from "firebase/app"
import { onAuthStateChanged } from "firebase/auth"
import type { Analytics } from "firebase/analytics"
import { auth } from "./firebase.js"

const ANALYTICS_APP_ID =
  import.meta.env.VITE_FIREBASE_ANALYTICS_APP_ID || "1:876479962995:web:80abdb40549d11a934ef06"
const MEASUREMENT_ID = import.meta.env.VITE_FIREBASE_MEASUREMENT_ID || "G-5Z7FEXLK9Y"

let initPromise: Promise<Analytics | null> | null = null

function shouldSkip(): boolean {
  if (typeof window === "undefined") return true
  const host = window.location.hostname
  if (host === "localhost" || host === "127.0.0.1") return true
  if (!import.meta.env.VITE_FIREBASE_API_KEY) return true
  return false
}

export function initAnalytics(): Promise<Analytics | null> {
  if (initPromise) return initPromise
  try {
    initPromise = (async () => {
      try {
        if (shouldSkip()) return null
        const { getAnalytics, isSupported } = await import("firebase/analytics")
        const supported = await isSupported().catch(() => false)
        if (!supported) return null
        const app = initializeApp(
          {
            apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
            projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "wekruit-5f89b",
            appId: ANALYTICS_APP_ID,
            measurementId: MEASUREMENT_ID,
          },
          "analytics",
        )
        return getAnalytics(app)
      } catch {
        return null
      }
    })()
  } catch {
    initPromise = Promise.resolve(null)
  }
  return initPromise
}

export async function trackEvent(name: string, params?: Record<string, unknown>): Promise<void> {
  try {
    const analytics = await initAnalytics()
    if (!analytics) return
    const { logEvent } = await import("firebase/analytics")
    logEvent(analytics, name, params)
  } catch {
    // Swallow everything (ad blockers, gtag failures) — analytics must never
    // surface as an unhandled rejection or break a user flow.
  }
}

/**
 * Attach/clear the GA4 user identity. GA ToS: `uid` MUST be an opaque internal
 * id (Firebase uid) — never email, phone, name, or LinkedIn URL. Same rule for
 * `props` values. Fire-and-forget, same never-throw contract as trackEvent.
 */
export async function setAnalyticsUser(uid: string | null, props?: Record<string, string>): Promise<void> {
  try {
    const analytics = await initAnalytics()
    if (!analytics) return
    const { setUserId, setUserProperties } = await import("firebase/analytics")
    setUserId(analytics, uid)
    if (props) setUserProperties(analytics, props)
  } catch {
    // Swallow everything — identity tagging must never break an auth flow.
  }
}

let identitySubscribed = false

/**
 * Mirror the DEFAULT app's auth state into GA4 userId (uid on sign-in, null on
 * sign-out) so retention/funnel reports stitch sessions across devices.
 * Subscribes once per module load; safe to call multiple times. `firebase/auth`
 * is already statically bundled via ./firebase.js, so the static import adds
 * no weight — analytics itself stays lazily imported inside setAnalyticsUser.
 */
export function initAnalyticsIdentity(): void {
  if (identitySubscribed) return
  identitySubscribed = true
  try {
    if (typeof window === "undefined") return
    // auth() throws when VITE_FIREBASE_* env keys are absent — skip entirely.
    if (!import.meta.env.VITE_FIREBASE_API_KEY) return
    onAuthStateChanged(auth(), (user) => {
      void setAnalyticsUser(user ? user.uid : null)
    })
  } catch {
    // Never throw — analytics identity is best-effort only.
  }
}
