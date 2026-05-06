import admin from 'firebase-admin'
admin.initializeApp()
const db = admin.firestore()

// Try multiple potential collection names
for (const col of ['matching-jobs-liveness-runs', 'pa-liveness-runs', 'liveness-runs', 'pa-rerank-runs', 'pa-qa-evaluator-runs']) {
  try {
    const snap = await db.collection(col).limit(3).get()
    console.log(`${col}: ${snap.size} docs`)
    snap.docs.forEach(d => console.log(`  ${d.id}: ${JSON.stringify(d.data()).slice(0, 200)}`))
  } catch (e) { console.log(`${col}: ${e.message?.slice(0, 80)}`) }
}
