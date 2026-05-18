import { readFileSync } from "node:fs"
import { applicationDefault, cert, getApps, initializeApp } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"

function credentialSource() {
  const jsonEnv = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  if (jsonEnv && jsonEnv.trim().length > 0) {
    return { credential: cert(JSON.parse(jsonEnv)) }
  }
  const path = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || process.env.GOOGLE_APPLICATION_CREDENTIALS
  if (path) return { credential: cert(JSON.parse(readFileSync(path, "utf8"))) }
  return { credential: applicationDefault() }
}

if (!getApps().length) initializeApp({ ...credentialSource(), projectId: "wekruit-5f89b" })

const db = getFirestore()

console.log("=== layoff_employers — query for WeKruit LLC / noah.liu@wekruit.com ===\n")

const byCompany = await db
  .collection("layoff_employers")
  .where("companyName", "==", "WeKruit LLC")
  .get()

const byEmail = await db
  .collection("layoff_employers")
  .where("workEmailLower", "==", "noah.liu@wekruit.com")
  .get()

console.log(`Hits by companyName == "WeKruit LLC":  ${byCompany.size}`)
console.log(`Hits by workEmailLower == "noah.liu@wekruit.com":  ${byEmail.size}\n`)

const all = new Map()
for (const d of byCompany.docs) all.set(d.id, d)
for (const d of byEmail.docs) all.set(d.id, d)

if (all.size === 0) {
  console.log("NO MATCH FOUND. Listing 10 most-recent layoff_employers for context:")
  const recent = await db
    .collection("layoff_employers")
    .orderBy("registeredAt", "desc")
    .limit(10)
    .get()
  for (const d of recent.docs) {
    const x = d.data()
    console.log(`  ${d.id}: ${x.companyName ?? "?"} / ${x.workEmailLower ?? x.workEmail ?? "?"} / ${x.verificationStatus ?? "?"}`)
  }
} else {
  for (const [id, doc] of all) {
    const x = doc.data()
    console.log(`--- ${id} ---`)
    console.log(JSON.stringify({
      companyName: x.companyName,
      companyLinkedin: x.companyLinkedin,
      workEmail: x.workEmail,
      workEmailLower: x.workEmailLower,
      contactName: x.contactName,
      roleAtCompany: x.roleAtCompany,
      stage: x.stage,
      rolesHiring: x.rolesHiring,
      notes: x.notes,
      verificationStatus: x.verificationStatus,
      registeredAt: x.registeredAt?.toDate?.()?.toISOString() ?? x.registeredAt ?? null,
      registeredByUid: x.registeredByUid,
    }, null, 2))
  }
}
