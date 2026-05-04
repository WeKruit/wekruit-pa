// iter30 final-closure — flip 5 Firestore flags to 100% ON.
// paGuardrailChainShadow is env-based, set via firebase functions:config.
import admin from 'firebase-admin'
const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
admin.initializeApp({ credential: admin.credential.cert(sa) })
const db = admin.firestore()

const ACTOR = 'claude-code-iter30-final-closure'
const REASON = 'iter30 final closure — flip 100% per Adam directive 2026-05-03'

const flips = [
  { key: 'paSkillNamingV2', value: true, type: 'bool', scope: 'global' },
  { key: 'paWeightsFromFirestore', value: true, type: 'bool', scope: 'global' },
  { key: 'paTagEventsEnabled', value: true, type: 'bool', scope: 'global' },
  { key: 'paSkillRouterV2Enabled', value: true, type: 'bool', scope: 'global' },
  { key: 'paResumeParserV2', value: true, type: 'bool', scope: 'global' },
]

async function setFlag(key, next) {
  const flagRef = db.collection('pa-feature-flags').doc(key)
  const auditRef = db.collection('pa-feature-flags-audit').doc()
  const nowIso = new Date().toISOString()
  await db.runTransaction(async (t) => {
    const cur = await t.get(flagRef)
    const prev = cur.exists ? cur.data() : null
    const version = (prev?.version ?? 0) + 1
    const action = prev ? 'flag.update' : 'flag.create'
    t.set(flagRef, {
      key,
      value: next.value,
      type: next.type,
      scope: next.scope,
      allowlist: prev?.allowlist ?? [],
      blocklist: prev?.blocklist ?? [],
      bucketStrategy: prev?.bucketStrategy ?? null,
      updatedAt: nowIso,
      updatedBy: ACTOR,
      reason: REASON,
      version,
    })
    t.set(auditRef, {
      actor: ACTOR,
      action,
      key,
      oldValue: prev?.value ?? null,
      newValue: next.value,
      reason: REASON,
      ts: nowIso,
    })
  })
}

async function main() {
  console.log('═══ iter30 FLAG FLIP — 5 Firestore flags ═══\n')
  for (const f of flips) {
    await setFlag(f.key, f)
    const after = await db.collection('pa-feature-flags').doc(f.key).get()
    const d = after.data()
    console.log(`✓ ${f.key} → value=${d.value} version=${d.version}`)
  }
  console.log('\nDone. paGuardrailChainShadow remains env-only (set via firebase functions config + redeploy).')
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
