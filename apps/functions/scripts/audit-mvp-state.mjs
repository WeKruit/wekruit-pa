import admin from 'firebase-admin'
const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
admin.initializeApp({ credential: admin.credential.cert(sa) })
const db = admin.firestore()

async function main() {
  console.log('═══ iter30 MVP STATE AUDIT ═══\n')

  // 1. Feature flags
  console.log('1. FEATURE FLAGS (pa-feature-flags)')
  const flagsSnap = await db.collection('pa-feature-flags').limit(50).get()
  const flagState = {}
  flagsSnap.docs.forEach(d => { flagState[d.id] = d.data() })
  const iter30Flags = ['paResumeParserV2','paSkillRouterV2Enabled','paSkillsLlmFallbackEnabled','paWeightsFromFirestore','paGuardrailChainShadow','paTagEventsEnabled','paSkillNamingV2','paHumanizeRuntimeEnabled']
  iter30Flags.forEach(f => {
    const v = flagState[f]
    console.log(`  ${f}: ${v ? JSON.stringify(v).slice(0,120) : 'NOT SET (default OFF)'}`)
  })

  // 2. Playbook collection state
  console.log('\n2. PLAYBOOKS (pa-playbooks)')
  const playSnap = await db.collection('pa-playbooks').get()
  console.log(`  total docs: ${playSnap.size}`)
  playSnap.docs.forEach(d => {
    const data = d.data()
    console.log(`  ${d.id}: regexTriggers=${(data.regexTriggers||[]).length} addendum_len=${(data.addendum||'').length} hasV2_intentDescription=${!!data.intentDescription} hasV2_priority=${typeof data.priority==='number'} composableWith=${(data.composableWith||[]).length}`)
  })

  // 3. 19 skills loaded?
  console.log('\n3. SKILLS V2 status')
  const knownSkillKeys = ['headhunter','vent_support','motivation_nudge','jd_roast','interview_prep','negotiation','rejection_processing','post_offer_decision','referral_request','silence_anchor','cv_followup','layoff_processing','company_research','career_pivot','return_to_work','daily_batch_reply','am_i_ai_check','boundary_test','mom_test']
  const presentKeys = playSnap.docs.map(d => d.id)
  const missing = knownSkillKeys.filter(k => !presentKeys.includes(k))
  console.log(`  expected 19, present ${playSnap.size}, missing: [${missing.join(', ')}]`)

  // 4. Match weights
  console.log('\n4. MATCH WEIGHT TABLES (pa-match-weight-tables)')
  const weightTables = await db.collection('pa-match-weight-tables').get()
  console.log(`  tables: ${weightTables.size}`)
  for (const t of weightTables.docs) {
    const items = await db.collection(`pa-match-weight-tables/${t.id}/items`).get()
    console.log(`  ${t.id}: ${items.size} items`)
  }

  // 5. Tag pipeline state
  console.log('\n5. TAG PIPELINE')
  const canonical = await db.collection('pa-canonical-tags').limit(5).get()
  console.log(`  pa-canonical-tags: ${canonical.size} sampled`)
  const tagEvents = await db.collection('pa-tag-events').limit(5).get()
  console.log(`  pa-tag-events: ${tagEvents.size} sampled`)
  const entityTags = await db.collection('pa-entity-tags').limit(5).get()
  console.log(`  pa-entity-tags: ${entityTags.size} root docs sampled`)

  // 6. Recent live traffic
  console.log('\n6. RECENT LIVE TRAFFIC (last 24h)')
  const cutoff = new Date(Date.now() - 24*3600*1000).toISOString()
  const inbound = await db.collection('pa-inbound-events').orderBy('createdAt','desc').limit(20).get()
  const recent = inbound.docs.filter(d => (d.get('createdAt')||'') >= cutoff)
  console.log(`  pa-inbound-events last 24h (sample 20): ${recent.length}`)
  const outbound = await db.collection('pa-outbound').orderBy('createdAt','desc').limit(20).get()
  const recentOut = outbound.docs.filter(d => (d.get('createdAt')||'') >= cutoff)
  console.log(`  pa-outbound last 24h (sample 20): ${recentOut.length}`)

  // 7. Real users (post-cleanup)
  console.log('\n7. REAL USERS (post-cleanup)')
  const allUsers = await db.collection('pa-users').get()
  const real = allUsers.docs.filter(d => d.get('testMode') !== true)
  console.log(`  total: ${allUsers.size}, testMode=true: ${allUsers.size - real.length}, real: ${real.length}`)

  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
