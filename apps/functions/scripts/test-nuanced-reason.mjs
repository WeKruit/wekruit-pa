import admin from 'firebase-admin'
admin.initializeApp()
const db = admin.firestore()

const { queryMatchingJobsV16 } = await import('../../../apps/job-rec/src/tools/query-matching-jobs-v16.ts')
const { composeNuancedReason } = await import('./../src/lib/match-nuanced-reason.ts')

const ADAM = 'e5d97cd8-1e1d-439d-8672-3008f8aeef2e'

const cv = await db.collection('parsedCandidateResumes').where('userId', '==', ADAM).orderBy('createdAt', 'desc').limit(1).get()
const cvData = cv.docs[0]?.data()
const wh = cvData?.workHistory ?? cvData?.experiences ?? []
const projects = cvData?.projects ?? []
const topSkills = cvData?.topSkills ?? cvData?.candidateProfile?.skills ?? []

const res = await queryMatchingJobsV16({ userId: ADAM, limit: 2 }, { db, log: () => {} })
const jobs = res.jobs

console.log('=== ADAM NUANCED REASON TEST ===')
for (const j of jobs) {
  console.log(`\n--- ${j.jobTitle} @ ${j.companyName} ---`)
  console.log(`V16 template reason: ${j.reason}`)
  const nuanced = await composeNuancedReason({
    lang: 'zh',
    workHistory: wh.slice(0, 3),
    projects: projects.slice(0, 2),
    topSkills: topSkills.slice(0, 12),
    job: {
      title: j.jobTitle,
      company: j.companyName,
      requiredSkills: j.requiredSkills,
      seniorityLevel: j.seniorityLevel,
      jobDescription: j.jobDescription ?? null,
    },
    matchedSkills: j.matchedSkills ?? [],
  }, { openaiApiKey: process.env.PA_OPENAI_AGENT_API_KEY ?? process.env.OPENAI_API_KEY ?? '' })
  console.log(`LLM nuanced reason: ${nuanced ?? '(null — fallback to template)'}`)
}
