import admin from 'firebase-admin'
admin.initializeApp()
const db = admin.firestore()

const { runQaEvaluator, makeFirestoreStore, makeProductionIntegrations } = await import('../../../apps/functions/src/qa-evaluator-weekly.ts')

const ADAM = 'e5d97cd8-1e1d-439d-8672-3008f8aeef2e'

console.log('=== RUN QA EVALUATOR FOR ADAM (force-user mode) ===')
const result = await runQaEvaluator({
  store: makeFirestoreStore(db),
  integrations: makeProductionIntegrations({
    siliconflowApiKey: process.env.SILICONFLOW_API_KEY ?? '',
  }),
  forceUserIds: [ADAM],
  minSampleForAlert: 999,
  log: (msg, ctx) => console.log(`[${msg}] ${JSON.stringify(ctx ?? {}).slice(0, 250)}`),
  errorLog: (msg, ctx) => console.warn(`[${msg}] ${JSON.stringify(ctx ?? {}).slice(0, 250)}`),
})

console.log('\n=== RESULT ===')
console.log(JSON.stringify({
  runId: result.runId,
  sampleSize: result.sampleSize,
  hardFilterPassRate: result.hardFilterPassRate,
  top3AcceptableRate: result.top3AcceptableRate,
  passes: result.passes,
  durationMs: result.durationMs,
}, null, 2))

console.log('\n=== ADAM PAIRS ===')
const runDoc = await db.collection('pa-qa-evaluator-runs').doc(result.runId).get()
const pairs = runDoc.data()?.pairs ?? []
pairs.forEach((p, i) => {
  console.log(`\n${i+1}. ${p.jobTitle ?? '(no title)'} @ ${p.companyName ?? '(no company)'}`)
  console.log(`   hardFilterPass=${p.hardFilterPass} top3Acceptable=${p.top3Acceptable}`)
  console.log(`   reasoning: ${(p.reasoning ?? '').slice(0, 200)}`)
})
