import admin from 'firebase-admin'
admin.initializeApp()
const db = admin.firestore()

console.log('=== matching-jobs-liveness-runs (post-trigger) ===')
const ls = await db.collection('matching-jobs-liveness-runs').orderBy('runAt', 'desc').limit(3).get()
console.log(`runs: ${ls.size}`)
ls.docs.forEach(d => {
  const data = d.data()
  console.log(`  runAt=${data.runAt} counters=${JSON.stringify(data.counters)}`)
})

// Adam outbound — check if any new match emails post-deploy (deploy was 10:39 PT = 17:39 UTC)
console.log('\n=== ADAM OUTBOUND (post 17:39 UTC) ===')
const ADAM_UID = 'e5d97cd8-1e1d-439d-8672-3008f8aeef2e'
const adamRecent = await db.collection('pa-outbound')
  .where('userId', '==', ADAM_UID)
  .orderBy('createdAt', 'desc')
  .limit(5)
  .get()
adamRecent.docs.forEach(d => {
  const data = d.data()
  const ts = data.createdAt?._seconds ? new Date(data.createdAt._seconds * 1000).toISOString() : data.createdAt
  console.log(`---\nid=${d.id}\nts=${ts}\nbody=${(data.body ?? '').slice(0, 800)}`)
})

// Reasoning quality survey — show ALL post-deploy match emails
const POST_DEPLOY_MS = Date.parse('2026-05-06T17:00:00Z')
console.log(`\n=== POST-DEPLOY MATCH EMAILS (all users, after ${new Date(POST_DEPLOY_MS).toISOString()}) ===`)
const recent = await db.collection('pa-outbound').orderBy('createdAt', 'desc').limit(60).get()
let count = 0
for (const d of recent.docs) {
  const data = d.data()
  const ts = data.createdAt?._seconds ? data.createdAt._seconds * 1000 : Date.parse(data.createdAt ?? '')
  if (ts < POST_DEPLOY_MS) continue
  const body = data.body ?? ''
  if (body.includes('为啥推') || body.includes('why:')) {
    count++
    if (count > 5) break
    console.log(`---\nuid=${data.userId.slice(0, 8)} createdAt=${new Date(ts).toISOString()}`)
    console.log(body.slice(0, 1500))
  }
}
console.log(`\n${count} match emails post-deploy`)
