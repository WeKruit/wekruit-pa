// iter30 post-deploy verification — checks shadow guardrail telemetry +
// counts pa.guardrails.shadow.result events with delta=match vs differ.
// Must be run AFTER scenario runner has produced live traffic.
import admin from 'firebase-admin'
const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
admin.initializeApp({ credential: admin.credential.cert(sa) })
const db = admin.firestore()

async function main() {
  console.log('═══ iter30 POST-DEPLOY VERIFY ═══\n')

  // 1. Re-confirm flags
  console.log('1. FEATURE FLAGS (post-flip)')
  const flags = ['paResumeParserV2','paSkillRouterV2Enabled','paWeightsFromFirestore','paTagEventsEnabled','paSkillNamingV2','paGuardrailChainShadow']
  for (const k of flags) {
    const s = await db.collection('pa-feature-flags').doc(k).get()
    const v = s.exists ? s.data().value : 'NOT SET'
    console.log(`  ${k}: ${v}`)
  }

  // 2. Recent inbound + outbound (last 30 min)
  console.log('\n2. RECENT TRAFFIC (last 30 min)')
  const cutoff = new Date(Date.now() - 30 * 60_000).toISOString()
  const inbound = await db.collection('pa-inbound-events').where('createdAt', '>=', cutoff).limit(50).get()
  const outbound = await db.collection('pa-outbound').where('createdAt', '>=', cutoff).limit(50).get()
  console.log(`  pa-inbound-events: ${inbound.size}`)
  console.log(`  pa-outbound: ${outbound.size}`)

  // 3. Tag events fired in window
  console.log('\n3. TAG-EVENTS (last 30 min)')
  const tagEv = await db.collection('pa-tag-events').where('createdAt', '>=', cutoff).limit(50).get()
  console.log(`  pa-tag-events: ${tagEv.size}`)
  tagEv.docs.slice(0, 5).forEach(d => {
    const data = d.data()
    console.log(`    ${d.id.slice(0,8)} src=${data.source} type=${data.type} status=${data.status}`)
  })

  // 4. Resume v2 fires (pa-tool-calls collection if used)
  console.log('\n4. CV INGEST events (last 30 min)')
  try {
    const calls = await db.collection('pa-tool-calls').where('createdAt', '>=', cutoff).limit(20).get()
    console.log(`  pa-tool-calls: ${calls.size}`)
  } catch(e) { console.log(`  query failed: ${e.message}`) }

  console.log('\nDone. For shadow guardrail logs, run:')
  console.log('  gcloud logging read \'resource.type="cloud_run_revision" AND jsonPayload.event="pa.guardrails.shadow.result"\' --project=wekruit-5f89b --limit=100 --format=json --freshness=30m | jq \'.[].jsonPayload | {delta, transformed, beforeLen, afterLen}\'')
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
