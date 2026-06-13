/**
 * Email magic-link sign-in for the operator dashboard — an alternative to the
 * Google popup for @wekruit.com operators. Uses the same Firebase project as
 * the candidate app (where email-link sign-in is already enabled in prod), so
 * no backend or Firebase-console change is needed. The dashboard APIs already
 * gate on an @wekruit.com email regardless of provider, so a link token
 * authenticates identically to a Google one.
 */
import {
  isSignInWithEmailLink,
  sendSignInLinkToEmail,
  signInWithEmailLink,
} from "firebase/auth"
import { auth } from "./firebase.js"

const MAGIC_EMAIL_KEY = "wk_admin_magic_email"
const ADMIN_EMAIL_DOMAIN = "@wekruit.com"

export function isAdminEmail(email: string): boolean {
  return email.trim().toLowerCase().endsWith(ADMIN_EMAIL_DOMAIN)
}

/** Send a one-time sign-in link. Caller must pre-validate with isAdminEmail. */
export async function sendAdminMagicLink(email: string): Promise<void> {
  const target = email.trim().toLowerCase()
  await sendSignInLinkToEmail(auth(), target, {
    url: `${window.location.origin}/`,
    handleCodeInApp: true,
  })
  try {
    window.localStorage.setItem(MAGIC_EMAIL_KEY, target)
  } catch {
    // private mode — completion will prompt for the email instead
  }
}

/**
 * If the current URL is an email sign-in link, complete it. Returns true when a
 * link was present (whether or not it succeeded throws). Safe no-op otherwise,
 * so it can run unconditionally during auth bootstrap.
 */
export async function completeAdminMagicLink(): Promise<boolean> {
  if (!isSignInWithEmailLink(auth(), window.location.href)) return false
  let stored = ""
  try {
    stored = (window.localStorage.getItem(MAGIC_EMAIL_KEY) ?? "").trim().toLowerCase()
  } catch {
    // private mode
  }
  if (!stored) {
    stored = (window.prompt("Confirm the @wekruit.com email this sign-in link was sent to") ?? "")
      .trim()
      .toLowerCase()
  }
  if (!stored) return false
  await signInWithEmailLink(auth(), stored, window.location.href)
  try {
    window.localStorage.removeItem(MAGIC_EMAIL_KEY)
  } catch {
    // private mode
  }
  // Strip the link params so a refresh doesn't re-run completion.
  window.history.replaceState({}, "", "/")
  return true
}
