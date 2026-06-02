import { useEffect, useState } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { onAuthStateChanged } from "firebase/auth"
import { auth } from "./firebase.js"
import { ssoBootstrapPromise } from "./auth-redirect-bootstrap.js"
import {
  candidateLoginPath,
  isCandidateHost,
  onboardingDestination,
  redirectToCandidatePortal,
} from "./browser-identity.js"
import {
  CandidateVerifyError,
  candidateVerifyErrorMessage,
  verifyCandidateMagicLinkSession,
} from "./candidate-verify.js"
import { clearPortalCache, mergePortalCache, readPortalCache } from "./portal-cache.js"

export type CandidatePortalGateState =
  | { status: "loading" }
  | { status: "signed_out" }
  | { status: "redirecting_onboarding" }
  | { status: "verify_error"; message: string }
  | { status: "ready" }

async function verifySessionWithRetry() {
  try {
    return await verifyCandidateMagicLinkSession()
  } catch (firstErr) {
    await new Promise((resolve) => window.setTimeout(resolve, 400))
    return await verifyCandidateMagicLinkSession().catch(() => {
      throw firstErr
    })
  }
}

/**
 * Gate /me*, requiring magic-link auth plus portal-ready (Claire inbound + resume).
 * Redirects unsigned users to /login?next=… and signed-in users who are not portal-ready
 * to onboarding (layoff vs candidate source aware). Verify failures while authed show
 * an inline error instead of bouncing back to login.
 */
export function useCandidatePortalGate(): CandidatePortalGateState {
  const navigate = useNavigate()
  const location = useLocation()
  const [state, setState] = useState<CandidatePortalGateState>({ status: "loading" })

  useEffect(() => {
    let cancelled = false
    let unsubscribe: (() => void) | null = null
    const nextPath = `${location.pathname}${location.search}${location.hash}`

    // Wait for any cross-domain SSO bootstrap to settle before reacting to
    // Firebase auth state. Without this, the gate sees `null` immediately,
    // redirects to /login, and the bootstrapped signInWithCustomToken lands
    // on the wrong page ~300ms later — making cross-domain SSO feel broken.
    void ssoBootstrapPromise
      .catch(() => null)
      .then(() => {
        if (cancelled) return
        unsubscribe = onAuthStateChanged(auth(), (user) => {
      if (cancelled) return
      if (!user) {
        setState({ status: "signed_out" })
        if (isCandidateHost()) {
          navigate(candidateLoginPath(nextPath), { replace: true })
        } else {
          redirectToCandidatePortal(nextPath)
        }
        return
      }

      // Optimistic render from cache. If we have portalReady=true for this
      // uid, set state=ready immediately so the portal paints without
      // waiting on the verify callable. Background verify still runs to
      // detect invalidation (e.g. portalReady flipped to false server-side).
      const cached = readPortalCache(user.uid)
      if (cached?.portalReady === true) {
        setState({ status: "ready" })
      } else {
        setState({ status: "loading" })
      }

      void (async () => {
        try {
          const verified = await verifySessionWithRetry()
          if (cancelled) return
          if (!verified.portalReady) {
            // Stale cache — invalidate so next render hits the slow path.
            clearPortalCache(user.uid)
            const onboardingPath = onboardingDestination()
            setState({ status: "redirecting_onboarding" })
            if (!isCandidateHost()) {
              redirectToCandidatePortal(onboardingPath)
              return
            }
            navigate(onboardingPath, { replace: true })
            return
          }
          // Confirm ready (no-op if already ready from cache).
          mergePortalCache(user.uid, {
            portalReady: true,
            candidateId: verified.candidateId,
          })
          setState({ status: "ready" })
        } catch (err) {
          if (cancelled) return
          // Don't override a cached-ready optimistic render on transient
          // network errors. Only flip to verify_error when no cache existed.
          if (cached?.portalReady === true) {
            // eslint-disable-next-line no-console
            console.warn("candidate-portal-gate.background_verify_failed", err)
            return
          }
          const reason =
            err instanceof CandidateVerifyError ? err.reason : "verify_failed"
          const message =
            err instanceof CandidateVerifyError
              ? candidateVerifyErrorMessage(reason)
              : "We couldn't verify your session. Please try again in a moment."
          setState({ status: "verify_error", message })
        }
      })()
        })
      })

    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [location.pathname, location.search, location.hash, navigate])

  return state
}
