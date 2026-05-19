#!/usr/bin/env node
import { initializeApp, getApps, applicationDefault } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"

if (!getApps().length) initializeApp({ credential: applicationDefault() })
const db = getFirestore()

const KEEPERS = {
  U7AwKT8nLDRa35DkuBxq: "indolencorlol",
  UThMpnAGzjaWnxDsKEMH: "adam.ylol",
  itYEwzaJjVPjWbN01fzk: "admin1",
}

async function main() {
  for (const [uid, label] of Object.entries(KEEPERS)) {
    const total = (await db.collection("pa-messages").where("userId", "==", uid).count().get()).data().count
    const userCount = (
      await db
        .collection("pa-messages")
        .where("userId", "==", uid)
        .where("role", "==", "user")
        .count()
        .get()
    ).data().count
    const assistantCount = (
      await db
        .collection("pa-messages")
        .where("userId", "==", uid)
        .where("role", "==", "assistant")
        .count()
        .get()
    ).data().count
    const systemCount = (
      await db
        .collection("pa-messages")
        .where("userId", "==", uid)
        .where("role", "==", "system")
        .count()
        .get()
    ).data().count
    const unknown = total - userCount - assistantCount - systemCount
    console.log(
      `${label.padEnd(14)} (${uid}): total=${total}  user=${userCount}  assistant=${assistantCount}  system=${systemCount}  other=${unknown}`
    )

    // Print a couple samples of each
    if (assistantCount > 0) {
      const sample = await db
        .collection("pa-messages")
        .where("userId", "==", uid)
        .where("role", "==", "assistant")
        .limit(2)
        .get()
      for (const d of sample.docs) {
        const data = d.data()
        const preview = String(data.body || "").slice(0, 80).replace(/\n/g, " ")
        console.log(`    assistant ${data.createdAt}: ${preview}`)
      }
    }
    if (userCount > 0) {
      const sample = await db
        .collection("pa-messages")
        .where("userId", "==", uid)
        .where("role", "==", "user")
        .limit(2)
        .get()
      for (const d of sample.docs) {
        const data = d.data()
        const preview = String(data.body || "").slice(0, 80).replace(/\n/g, " ")
        console.log(`    user      ${data.createdAt}: ${preview}`)
      }
    }
    console.log("")
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
