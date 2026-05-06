import { initializeApp, type FirebaseApp } from "firebase/app"
import { getAuth } from "firebase/auth"
import { getFirestore } from "firebase/firestore"
import { getFunctions } from "firebase/functions"

const cfg = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
}

let app: FirebaseApp | null = null

export function getFirebaseApp(): FirebaseApp {
  if (app) return app
  if (!cfg.apiKey || !cfg.projectId) {
    throw new Error("Set VITE_FIREBASE_* in apps/dashboard-web/.env.local")
  }
  app = initializeApp(cfg)
  return app
}

export const auth = () => getAuth(getFirebaseApp())
export const db = () => getFirestore(getFirebaseApp())
// v1.6 Phase 59 (DASH-02) — callable Cloud Functions client (us-central1
// matches every CF onCall registration in apps/functions/src/index.ts).
export const functions = () => getFunctions(getFirebaseApp(), "us-central1")
