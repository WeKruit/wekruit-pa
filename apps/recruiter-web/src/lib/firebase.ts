import { initializeApp, type FirebaseApp } from "firebase/app"
import { getAuth } from "firebase/auth"
import { getFunctions } from "firebase/functions"
import { getFirestore } from "firebase/firestore"
import { getStorage } from "firebase/storage"

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
    throw new Error("Set VITE_FIREBASE_* env keys")
  }
  app = initializeApp(cfg)
  return app
}

export const db = () => getFirestore(getFirebaseApp())
export const auth = () => getAuth(getFirebaseApp())
export const functions = () => getFunctions(getFirebaseApp(), "us-central1")
export const storage = () => getStorage(getFirebaseApp())
