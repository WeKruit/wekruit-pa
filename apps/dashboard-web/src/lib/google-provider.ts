import { GoogleAuthProvider } from "firebase/auth"

/**
 * Fresh provider each sign-in attempt so no stale OAuth params (e.g. hd) stick between tries.
 * Do not set `hd` here — Firestore rules enforce @wekruit.com; forcing `hd` breaks personal Gmail.
 */
export function createGoogleProvider() {
  const p = new GoogleAuthProvider()
  p.addScope("profile")
  p.addScope("email")
  p.setCustomParameters({ prompt: "select_account" })
  return p
}
