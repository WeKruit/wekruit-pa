/**
 * Firebase Analytics (GA4) for the recruiter SPA.
 *
 * Uses a SECONDARY Firebase app (initializeApp(cfg, "analytics")) so the
 * default app in firebase.ts (auth/firestore/functions) stays untouched.
 * Lazy + guarded: the firebase/analytics chunk only loads after init is
 * requested, skips entirely on localhost / unsupported browsers / missing
 * env, and every public function catches internally — analytics (including
 * ad blockers killing gtag) must never throw or reject into product code.
 *
 * Page views are NOT tracked here: GA4 enhanced measurement records SPA
 * history changes automatically. Only custom conversion events go through
 * trackEvent().
 */
import { initializeApp } from "firebase/app"
import type { Analytics } from "firebase/analytics"

// Public web-bundle identifiers (shipped to every browser by design).
const ANALYTICS_APP_ID = "1:876479962995:web:e31ee92140dad4b934ef06"
const MEASUREMENT_ID = "G-2R4NH6JVJM"

let initPromise: Promise<Analytics | null> | null = null

function analyticsDisabled(): boolean {
  if (typeof window === "undefined") return true
  const host = window.location.hostname
  return host === "localhost" || host === "127.0.0.1"
}

async function initInner(): Promise<Analytics | null> {
  const apiKey = import.meta.env.VITE_FIREBASE_API_KEY
  if (!apiKey || analyticsDisabled()) return null
  const { getAnalytics, isSupported } = await import("firebase/analytics")
  if (!(await isSupported())) return null
  const app = initializeApp(
    {
      apiKey,
      projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "wekruit-5f89b",
      appId: import.meta.env.VITE_FIREBASE_ANALYTICS_APP_ID || ANALYTICS_APP_ID,
      measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID || MEASUREMENT_ID,
    },
    "analytics",
  )
  return getAnalytics(app)
}

/** Idempotent (StrictMode-safe) init. Never throws, never rejects. */
export function initAnalytics(): Promise<Analytics | null> {
  if (!initPromise) {
    try {
      initPromise = initInner().catch(() => null)
    } catch {
      initPromise = Promise.resolve(null)
    }
  }
  return initPromise
}

/** Fire a custom GA4 event. No-op when analytics is unavailable; never throws or rejects. */
export async function trackEvent(name: string, params?: Record<string, unknown>): Promise<void> {
  try {
    const analytics = await initAnalytics()
    if (!analytics) return
    const { logEvent } = await import("firebase/analytics")
    logEvent(analytics, name, params)
  } catch {
    // Analytics failures (ad blockers, offline gtag) must never surface.
  }
}
