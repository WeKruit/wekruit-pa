import { getRedirectResult, type UserCredential } from "firebase/auth"
import { auth } from "./firebase.js"

/** Start consuming Google OAuth redirect result as early as possible (before React mounts). */
export const redirectResultPromise: Promise<UserCredential | null> = getRedirectResult(auth())
