import { createContext, useContext, useEffect, useState, type ReactNode } from "react"
import { onAuthStateChanged, signOut, type User } from "firebase/auth"
import { auth } from "./firebase.js"
import { redirectResultPromise } from "./auth-redirect-bootstrap.js"
import {
  getRecruiterProfile,
  isRecruiterProfileRejection,
  type RecruiterSession,
} from "./recruiter-board-api.js"

const PENDING_KEY = "wk_recruiter_access_pending_v2"

function hasPendingClaim(): boolean {
  try {
    if (window.sessionStorage.getItem(PENDING_KEY)) return true
  } catch { /* */ }
  try {
    if (window.localStorage.getItem(PENDING_KEY)) return true
  } catch { /* */ }
  return false
}

interface SessionState {
  session: RecruiterSession | null
  authReady: boolean
  profileLoadFailed: boolean
  setSession: (s: RecruiterSession | null) => void
  retryProfile: () => void
}

const Ctx = createContext<SessionState>({
  session: null,
  authReady: false,
  profileLoadFailed: false,
  setSession: () => undefined,
  retryProfile: () => undefined,
})

export function useRecruiterSession(): SessionState {
  return useContext(Ctx)
}

export function RecruiterSessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<RecruiterSession | null>(null)
  const [authReady, setAuthReady] = useState(false)
  const [profileLoadFailed, setProfileLoadFailed] = useState(false)
  const [retryToken, setRetryToken] = useState(0)

  useEffect(() => {
    let active = true
    let handlingUid: string | null = null

    const resolve = async (user: User | null) => {
      if (!user) {
        if (!active) return
        setSession(null)
        setProfileLoadFailed(false)
        setAuthReady(true)
        return
      }
      if (handlingUid === user.uid) return
      handlingUid = user.uid

      if (hasPendingClaim()) {
        if (active) setAuthReady(true)
        return
      }

      try {
        const next = await getRecruiterProfile()
        if (active) {
          setProfileLoadFailed(false)
          setSession(next)
        }
      } catch (e) {
        if (!isRecruiterProfileRejection(e)) {
          handlingUid = null
          if (active) setProfileLoadFailed(true)
          return
        }
        await signOut(auth()).catch(() => undefined)
        if (active) {
          setSession(null)
          setProfileLoadFailed(false)
        }
      } finally {
        if (active) setAuthReady(true)
      }
    }

    const unsubscribe = onAuthStateChanged(auth(), (user) => {
      void resolve(user)
    })
    void redirectResultPromise
      .then((result) => resolve(result?.user ?? auth().currentUser))
      .catch(() => {
        if (active) setAuthReady(true)
      })
    return () => {
      active = false
      unsubscribe()
    }
  }, [retryToken])

  return (
    <Ctx.Provider
      value={{
        session,
        authReady,
        profileLoadFailed,
        setSession,
        retryProfile: () => setRetryToken((n) => n + 1),
      }}
    >
      {children}
    </Ctx.Provider>
  )
}
