import { useEffect, useState } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { onAuthStateChanged } from "firebase/auth"
import { auth } from "./firebase.js"
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
 * Gate /me*, requiring magic-link auth plus inbound Claire iMessage.
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
    const nextPath = `${location.pathname}${location.search}`

    const unsubscribe = onAuthStateChanged(auth(), (user) => {
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

      setState({ status: "loading" })
      void (async () => {
        try {
          const verified = await verifySessionWithRetry()
          if (cancelled) return
          if (!verified.claireConversationStarted) {
            const onboardingPath = onboardingDestination()
            setState({ status: "redirecting_onboarding" })
            if (!isCandidateHost()) {
              redirectToCandidatePortal(onboardingPath)
              return
            }
            navigate(onboardingPath, { replace: true })
            return
          }
          setState({ status: "ready" })
        } catch (err) {
          if (cancelled) return
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

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [location.pathname, location.search, navigate])

  return state
}
