import admin from 'firebase-admin'
const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
admin.initializeApp({ credential: admin.credential.cert(sa) })
const db = admin.firestore()

const ADMIN_USER_ID = 'e5d97cd8-1e1d-439d-8672-3008f8aeef2e'
const cutoff = Date.parse('2026-05-04T05:42:36.335Z') - 60_000
const snap = await db.collection('pa-messages').where('userId', '==', ADMIN_USER_ID).limit(500).get()
const all = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
  .filter((m) => {
    const ts = typeof m.createdAt === 'string' ? Date.parse(m.createdAt) : (m.createdAt?.toDate ? m.createdAt.toDate().getTime() : 0)
    return ts >= cutoff
  })
  .sort((a, b) => {
    const ta = typeof a.createdAt === 'string' ? Date.parse(a.createdAt) : (a.createdAt?.toDate ? a.createdAt.toDate().getTime() : 0)
    const tb = typeof b.createdAt === 'string' ? Date.parse(b.createdAt) : (b.createdAt?.toDate ? b.createdAt.toDate().getTime() : 0)
    return ta - tb
  })
console.log(`Total messages since cutoff: ${all.length}`)

// Search for missing user texts as substrings
const missing = ['我想试试别的方法', '想躺平', 'Stripe 还在招吗']
for (const q of missing) {
  const found = all.filter((m) => (m.body || '').includes(q.split(' ')[0]) && m.role === 'user')
  console.log(`\nQuery="${q}" -> ${found.length} fuzzy hits`)
  for (const f of found.slice(0, 5)) console.log(`  [${f.role}] body="${(f.body || '').slice(0, 80)}" createdAt=${f.createdAt}`)
}

// Print user messages chronologically
console.log('\n=== ALL USER MESSAGES (chronological) ===')
const usrs = all.filter((m) => m.role === 'user')
for (const u of usrs) console.log(`  body="${(u.body || '').slice(0, 60)}" createdAt=${u.createdAt}`)
process.exit(0)
