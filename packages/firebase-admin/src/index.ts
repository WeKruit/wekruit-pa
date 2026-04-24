import fs from "node:fs"
import { applicationDefault, cert, getApps, initializeApp, type App } from "firebase-admin/app"
import { getAuth } from "firebase-admin/auth"
import { getFirestore } from "firebase-admin/firestore"
import { getStorage } from "firebase-admin/storage"

let app: App | null = null

function initFromEnv(): App {
  if (getApps().length) return getApps()[0]!
  const jsonEnv = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  if (jsonEnv && jsonEnv.trim().length > 0) {
    const serviceAccount = JSON.parse(jsonEnv) as Record<string, unknown>
    return initializeApp({ credential: cert(serviceAccount as Parameters<typeof cert>[0]) })
  }
  const path = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || process.env.GOOGLE_APPLICATION_CREDENTIALS
  if (path) {
    const raw = fs.readFileSync(path, "utf8")
    const serviceAccount = JSON.parse(raw) as Record<string, unknown>
    return initializeApp({ credential: cert(serviceAccount as Parameters<typeof cert>[0]) })
  }
  return initializeApp({ credential: applicationDefault() })
}

/**
 * Idempotent init for Node workers. Preferred order:
 * 1. `FIREBASE_SERVICE_ACCOUNT_JSON` — raw JSON (Infisical / ATM-injected)
 * 2. `FIREBASE_SERVICE_ACCOUNT_PATH` or `GOOGLE_APPLICATION_CREDENTIALS` — file path
 * 3. Application Default Credentials
 */
export function getFirebaseApp(): App {
  if (app) return app
  app = initFromEnv()
  return app
}

export { getAuth, getFirestore, getStorage }
