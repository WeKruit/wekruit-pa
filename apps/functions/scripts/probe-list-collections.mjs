import admin from "firebase-admin"
admin.initializeApp()
const db = admin.firestore()

const cols = await db.listCollections()
for (const c of cols) {
  console.log(c.id)
}
