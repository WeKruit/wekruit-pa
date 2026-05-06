import admin from 'firebase-admin'
admin.initializeApp()
const db = admin.firestore()

const { queryMatchingJobsV16 } = await import('../../../apps/job-rec/src/tools/query-matching-jobs-v16.ts')
const { composeNuancedReason } = await import('../src/lib/match-nuanced-reason.ts')

const ADAM = 'e5d97cd8-1e1d-439d-8672-3008f8aeef2e'
const lang = 'zh'

const cv = await db.collection('parsedCandidateResumes').where('userId', '==', ADAM).orderBy('createdAt', 'desc').limit(1).get()
const cvData = cv.docs[0]?.data()
const wh = cvData?.workHistory ?? cvData?.experiences ?? []
const projects = cvData?.projects ?? []
const topSkills = cvData?.topSkills ?? cvData?.candidateProfile?.skills ?? []

const res = await queryMatchingJobsV16({ userId: ADAM, limit: 10 }, { db, log: () => {} })
const visible = res.jobs.slice(0, 2)

console.log('============================================')
console.log('  ADAM SMS BODY (live render, no Slack/Mailgun, just stdout)')
console.log('============================================\n')

const reasons = await Promise.all(visible.map(j =>
  composeNuancedReason({
    lang,
    workHistory: wh.slice(0, 3),
    projects: projects.slice(0, 2),
    topSkills: topSkills.slice(0, 12),
    job: {
      title: j.jobTitle,
      company: j.companyName,
      requiredSkills: j.requiredSkills,
      seniorityLevel: j.seniorityLevel,
      jobDescription: null,
    },
    matchedSkills: j.matchedSkills ?? [],
  }, { openaiApiKey: process.env.PA_OPENAI_AGENT_API_KEY ?? '', timeoutMs: 8000 })
))

const lines = []
lines.push(lang === 'zh' ? '先给你看两个对得上的岗位:' : 'two roles that line up for you:')
visible.forEach((j, i) => {
  const tag = j.companyName ? ` @ ${j.companyName}` : ''
  const url = j.atsApplyUrl ? `\n${j.atsApplyUrl}` : ''
  const nuanced = reasons[i]
  const reason = nuanced && nuanced.length > 0
    ? `\n${lang === 'zh' ? '为啥推' : 'why'}: ${nuanced}`
    : (j.reason ? `\n${j.reason}` : '')
  lines.push(`• ${j.jobTitle}${tag}${url}${reason}`)
})
lines.push(lang === 'zh' ? '先看看, 不准就告诉我我再找; 之后每天会再给你新的' : "see if these fit — if not lmk, i'll keep digging; daily fresh batch from here")

console.log(lines.join('\n'))
console.log('\n============================================')
console.log(`(jobs available in V16: ${res.jobs.length}, hard-filter: ${JSON.stringify(res.hardFilter)})`)
