import { readFileSync } from "node:fs"
import { applicationDefault, cert, getApps, initializeApp } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"

function credentialSource() {
  const jsonEnv = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  if (jsonEnv && jsonEnv.trim().length > 0) {
    const serviceAccount = JSON.parse(jsonEnv)
    const clientEmail = serviceAccount.client_email
    return {
      credential: cert(serviceAccount),
      clientEmail,
      label: `service account ${clientEmail ?? "unknown"}`,
    }
  }
  const path = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || process.env.GOOGLE_APPLICATION_CREDENTIALS
  if (path) {
    const serviceAccount = JSON.parse(readFileSync(path, "utf8"))
    const clientEmail = serviceAccount.client_email
    return {
      credential: cert(serviceAccount),
      clientEmail,
      label: `service account ${clientEmail ?? "unknown"} from ${path}`,
    }
  }
  return {
    credential: applicationDefault(),
    clientEmail: undefined,
    label: "application default credentials",
  }
}

const source = credentialSource()
if (!getApps().length) {
  initializeApp({ credential: source.credential })
}

const db = getFirestore()
const docId = `local_smoke_${Date.now()}`
const ref = db.collection("pa-audit-events").doc(docId)

try {
  await ref.set({
    id: docId,
    kind: "turn_state",
    actor: "system",
    createdAt: new Date().toISOString(),
    message: "Local Admin SDK smoke check",
    meta: { source: "scripts/check-firestore-admin.mjs" },
  })
  await ref.get()
  await ref.delete()
  console.log(`[firestore-smoke] ok (${source.label})`)
} catch (e) {
  const message = e instanceof Error ? e.message : String(e)
  console.error(`[firestore-smoke] failed (${source.label})`)
  console.error(message)
  console.error("")
  console.error("This is an IAM/service-account issue. Admin SDK bypasses Firestore Security Rules.")
  console.error("Grant this service account a Firestore-capable role in project wekruit-5f89b, e.g.:")
  console.error("- Cloud Datastore User (read/write Firestore)")
  console.error("- Firebase Admin / Editor for local testing")
  if (source.clientEmail) {
    console.error("")
    console.error("Suggested least-privilege local-test command:")
    console.error(
      `gcloud projects add-iam-policy-binding wekruit-5f89b --member="serviceAccount:${source.clientEmail}" --role="roles/datastore.user"`
    )
  }
  process.exit(1)
}
