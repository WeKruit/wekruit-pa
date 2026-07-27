/**
 * headhunter-mcp/shortlist.ts — let an MCP client (Claude Code / Cowork) rank a job's candidates
 * itself, instead of consuming a rank our batch judge already fixed.
 *
 * WHY. The batch evaluator's job is TRIAGE: it runs unattended over hundreds of submissions, must
 * stay cheap and deterministic, and writes the auditable record the flywheel learns from. It is
 * deliberately not the place for nuanced comparison. Measured on the Photon board 2026-07-27, its
 * checklist scored implementation specifics only — so a self-authored résumé asserting the right
 * nouns outranked a verified Microsoft Office-of-the-CTO engineer, because school, employer
 * calibre, seniority and corroboration were captured but never graded.
 *
 * A smarter model can weigh those against each other. What it cannot do is read 250 full profiles:
 * that is why this file is two tools, not one.
 *
 *   list_job_shortlist    — COMPACT row per candidate (~200 tokens). ~120 rows fits a context
 *                           window with room to reason. Everything needed to RANK, nothing more.
 *   get_candidate_evidence — the FULL bundle for one candidate, fetched only for those worth a
 *                           closer look. Same list-cheap/detail-on-open shape the recruiter
 *                           submissions list uses.
 *
 * Both are READ-ONLY. `record_job_ranking` (in tools.ts) writes the client's ranking back as an
 * auditable artifact so a human judgement becomes flywheel data rather than a lost chat message.
 *
 * NO SILENT CAPS: every response reports what was dropped and why, so a truncated view can never
 * read as "this is everyone".
 */
import type { Firestore } from "firebase-admin/firestore"
import { lookupSchoolPrior } from "@wekruit/shared-tags"
import { extractChecklistGroups, renderJdBlocks } from "../recruiter-submission-eval.js"

type Db = Firestore
type Rec = Record<string, unknown>

const SUBMISSIONS = "pa-recruiter-submissions"
const JOBS = "pa-jobs"
const USERS = "pa-users"

const rec = (v: unknown): Rec => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {})
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "")
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/**
 * Employer calibre for an engineering hire — about the engineering bar, not brand size. Matched on
 * the WHOLE name (modulo a legal suffix) because substring matching promoted "Block Green" off
 * Square/Block on the first run.
 */
const TIER_A = new Set([
  "google", "alphabet", "deepmind", "google deepmind", "openai", "anthropic", "meta", "facebook",
  "apple", "amazon", "aws", "amazon web services", "microsoft", "netflix", "nvidia", "stripe",
  "databricks", "snowflake", "palantir", "jane street", "two sigma", "citadel", "hudson river trading",
  "jump trading", "figma", "ramp", "plaid", "airbnb", "uber", "lyft", "coinbase", "cloudflare",
  "datadog", "confluent", "hashicorp", "mongodb", "elastic", "twilio", "discord", "slack", "linkedin",
  "dropbox", "square", "block", "robinhood", "doordash", "instacart", "pinterest", "reddit", "spotify",
  "tesla", "spacex", "qualcomm", "arm", "intel", "amd", "broadcom", "vmware", "oracle", "salesforce",
  "adobe", "jpmorgan", "jpmorganchase", "goldman sachs", "morgan stanley", "xai", "scale ai", "waymo",
  "samsung research america", "ibm research", "bell labs",
])
const TIER_B =
  /\b(convex|vercel|supabase|planetscale|neon|clickhouse|temporal|modal|replicate|hugging face|mistral|cohere|perplexity|groq|cerebras|sambanova|together ai|langchain|posthog|retool|notion|airtable|asana|atlassian|shopify|zapier|segment|amplitude|mixpanel|braze|gusto|rippling|deel|brex|mercury|affirm|chime|wise|revolut|monzo|nubank)\b/i

/** A student chapter is not the company it is named after ("Google Developer Group on Campus"). */
const NOT_EMPLOYMENT =
  /\b(developer group|student|campus|chapter|club|society|association|hackathon|ambassador|community|meetup|conference|scholars?|bootcamp)\b/i

const SENIOR = /\b(staff|principal|senior|lead|architect|head of|distinguished|founding engineer|cto|vp engineering)\b/i
const JUNIOR = /\b(intern|internship|student|teaching assistant|apprentice|trainee|incoming)\b/i

/** Stack signals, matched against DESCRIBED work only — never a skills inventory. */
const STACK: Array<[string, RegExp]> = [
  ["rust", /\brust\b/i],
  ["swift", /\bswift\b/i],
  ["typescript_node", /\b(typescript|node\.?js|nestjs|express)\b/i],
  ["microservices", /\bmicroservice/i],
  ["distributed", /\bdistributed\b/i],
  ["messaging", /\b(kafka|rabbitmq|sqs|pub\/?sub|message queue|messaging|sms|twilio)\b/i],
  ["concurrency", /\b(high[- ]concurrency|concurren|throughput|qps|latency)\b/i],
  ["infra", /\b(kubernetes|k8s|redis|grpc|terraform)\b/i],
  ["python", /\bpython\b/i],
  ["golang", /\b(golang|\bgo\b)\b/i],
  ["java", /\b(java|spring boot)\b/i],
  ["cpp", /\b(c\+\+|cpp)\b/i],
]

function employerTier(name: string): "A" | "B" | null {
  if (!name || NOT_EMPLOYMENT.test(name)) return null
  const bare = name
    .replace(/\b(inc|llc|ltd|corp|corporation|co|plc|gmbh|labs?|technologies|technology)\b\.?/gi, "")
    .replace(/[.,()]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
  if (TIER_A.has(bare)) return "A"
  if (TIER_B.test(bare)) return "B"
  return null
}

export interface ShortlistRow {
  submissionId: string
  candidateId?: string
  name: string
  currentRole: string
  currentCompany: string
  /** Best employer calibre anywhere in the verified history, plus the role that earned the tier — an internship at a tier-A shop is not a senior role there. */
  bestEmployer?: { name: string; tier: "A" | "B"; role?: string; intern?: true }
  yoe?: number
  school?: { name: string; strength: string }
  /** Stack signals found in DESCRIBED work — an empty list means undescribed, not unskilled. */
  describedStack: string[]
  seniority: "senior" | "mid" | "junior" | "unknown"
  aiVerdict?: string
  aiHard?: string
  aiGaps?: string[]
  /** What the judge actually had. A weak score against thin evidence means UNKNOWN, not bad. */
  evidence: { profileRoles: number; describedRoles: number; resume: boolean; research: boolean }
  /** Background pillars the batch judge extracted but never graded into its tally. */
  pillars?: { school?: string; gpa?: string; degree?: string; company?: string }
  /** Set once this candidate has been reviewed through record_candidate_reviews. */
  claudeReview?: { verdict: string; score: number; needsHumanAttention: boolean }
  linkedinUrl?: string
}

/** The rubric the client must judge AGAINST — sent once per call, not once per candidate. */
export interface ShortlistJobBrief {
  jobId: string
  title?: string
  company?: string
  location?: string
  compensation?: string
  descriptionMd?: string
  checklist: Array<{ kind: string; heading: string; items: string[] }>
}

export interface ShortlistResult {
  jobId: string
  jobTitle?: string
  job?: ShortlistJobBrief
  returned: number
  totalSubmissions: number
  dropped: { count: number; reasons: Record<string, number>; sample: string[] }
  /** Stated so a thin row is never mistaken for a weak candidate. */
  evidenceCaveat: string
  rows: ShortlistRow[]
  /** Present when the caller passed a URL or free text instead of a jobId. */
  resolvedFrom?: string
  /** Present when the query matched several jobs — pick one and call again. */
  jobCandidates?: JobMatch[]
}

/**
 * Deterministic extreme-mismatch drop. Conservative ON PURPOSE — it only fires when EVERY signal
 * is absent, so it removes the clearly-irrelevant and never adjudicates a close call. Ranking is
 * the client's job; this only keeps the payload inside a context window.
 */
function dropReason(row: ShortlistRow, requireEngineering: boolean): string | null {
  if (!requireEngineering) return null
  const noStack = row.describedStack.length === 0
  const noEmployer = !row.bestEmployer
  const noImpl = !row.aiHard || row.aiHard.startsWith("0/")
  const noEvidence = row.evidence.describedRoles === 0 && !row.evidence.resume
  if (noStack && noEmployer && noImpl && noEvidence) return "no_evidence_of_any_kind"
  const nonEng = /\b(marketing|sales|recruit|account executive|customer success|hr\b|human resources|paralegal|nurse|pharmac|teacher|barista|driver)\b/i
  if (nonEng.test(row.currentRole) && noStack && noEmployer && noImpl) return "non_engineering_role_no_offsetting_signal"
  return null
}

export async function runListJobShortlist(args: {
  db: Db
  /** A jobId, a pasted job URL, or plain words ("photon backend") — resolved before anything else. */
  jobId: string
  limit?: number
  requireEngineering?: boolean
  filter?: "all" | "unreviewed" | "needs_attention"
  includeJd?: boolean
}): Promise<ShortlistResult> {
  const limit = Math.max(1, Math.min(args.limit ?? 120, 250))
  const requireEngineering = args.requireEngineering ?? true
  const filter = args.filter ?? "all"

  // Accept whatever the caller has to hand. Only resolve when the literal string is not already a
  // job — a valid id must never be reinterpreted as a search term.
  let jobId = str(args.jobId)
  let resolvedNote: string | undefined
  // Treat the literal string as an id when EITHER a job doc or any submission carries it. Keying
  // only on the job doc broke a job whose pa-jobs row is missing but whose board is populated —
  // it silently returned zero candidates, which reads as "nobody applied".
  const literalIsJob =
    (await args.db.collection(JOBS).doc(jobId).get()).exists ||
    !(await args.db.collection(SUBMISSIONS).where("jobId", "==", jobId).limit(1).get()).empty
  if (!literalIsJob) {
    const found = await runFindJob({ db: args.db, query: jobId })
    if (found.resolved) {
      resolvedNote = `resolved "${jobId}" -> ${found.resolved.jobId} (${found.resolved.matchedVia})`
      jobId = found.resolved.jobId
    } else {
      // Ambiguous or unknown: say so rather than score against a guessed rubric.
      return {
        jobId,
        returned: 0,
        totalSubmissions: 0,
        dropped: { count: 0, reasons: {}, sample: [] },
        evidenceCaveat: found.note ?? "job not resolved",
        rows: [],
        ...(found.matches.length ? { jobCandidates: found.matches } : {}),
      } as ShortlistResult
    }
  }
  args = { ...args, jobId }

  // The JD + rubric are per-JOB, so the cost is paid once rather than per candidate. Without them
  // a client is ranking against its own idea of the role instead of the one we are hiring for.
  let job: ShortlistJobBrief | undefined
  if (args.includeJd !== false) {
    const jobSnap = await args.db.collection(JOBS).doc(args.jobId).get()
    if (jobSnap.exists) {
      const j = (jobSnap.data() ?? {}) as Rec
      const groups = extractChecklistGroups(j)
      job = {
        jobId: args.jobId,
        title: str(j.title) || undefined,
        company: str(j.company) || str(rec(rec(j.recruiterBoard).label).company) || undefined,
        location: str(j.location) || undefined,
        compensation: str(j.compSummary) || str(j.compensation) || undefined,
        descriptionMd: (renderJdBlocks(j) || str(j.descriptionMd)).slice(0, 8000) || undefined,
        checklist: groups.map((g) => ({ kind: g.kind, heading: g.heading, items: g.items.map((i) => i.text) })),
      }
    }
  }

  const snap = await args.db.collection(SUBMISSIONS).where("jobId", "==", args.jobId).get()
  const built: ShortlistRow[] = []
  let jobTitle: string | undefined

  for (const doc of snap.docs) {
    const s = doc.data() ?? {}
    jobTitle ??= str(s.jobTitleSnapshot) || undefined
    const cand = rec(s.candidate)
    const ai = rec(s.aiEvaluation)
    const research = rec(ai.research)
    const checklist = rec(ai.checklist)
    const hard = rec(checklist.hard)

    const candidateId = str(s.candidateId) || undefined
    const user = candidateId
      ? ((await args.db.collection(USERS).doc(candidateId).get()).data() ?? {})
      : {}
    const tags = rec(user.tags)
    const roles = arr(user.experienceHighlights).map(rec)

    // Best employer across the verified history, not just the current line.
    let bestEmployer: ShortlistRow["bestEmployer"]
    for (const c of arr(research.companies).map(rec)) {
      const t = employerTier(str(c.name))
      if (!t) continue
      const role = str(c.role)
      const intern = JUNIOR.test(role)
      // Prefer a tier-A over a tier-B, and a real role over an internship at the same tier —
      // "Software Engineer Intern @ Google" must not read as "engineer at Google".
      const better =
        !bestEmployer ||
        (t === "A" && bestEmployer.tier === "B") ||
        (t === bestEmployer.tier && bestEmployer.intern && !intern)
      if (better) bestEmployer = { name: str(c.name), tier: t, ...(role ? { role } : {}), ...(intern ? { intern: true } as const : {}) }
    }
    const currentCompany = str(tags.recentCompany) || str(cand.currentCompany) || ""
    if (!bestEmployer) {
      const t = employerTier(currentCompany)
      if (t) bestEmployer = { name: currentCompany, tier: t }
    }

    let school: ShortlistRow["school"]
    for (const ed of arr(research.education).map(rec)) {
      const p = lookupSchoolPrior(str(ed.school), ["software_engineering"])
      const rank = ["unknown", "solid", "strong", "elite"].indexOf(p.strength)
      const held = school ? ["unknown", "solid", "strong", "elite"].indexOf(school.strength) : -1
      if (rank > held) school = { name: str(ed.school), strength: p.strength }
    }

    const describedRoles = roles.filter((r) => str(r.description).length > 0)
    const describedText = `${describedRoles.map((r) => `${str(r.title)} ${str(r.description)}`).join(" ")} ${str(cand.notes)}`
    const describedStack = STACK.filter(([, re]) => re.test(describedText)).map(([k]) => k)

    const currentRole = str(tags.recentRoleTitle) || str(cand.currentRole) || ""
    const seniority: ShortlistRow["seniority"] = SENIOR.test(currentRole)
      ? "senior"
      : JUNIOR.test(currentRole)
        ? "junior"
        : currentRole
          ? "mid"
          : "unknown"

    const yoeNum = Number.parseFloat(str(cand.yoe))

    built.push({
      submissionId: doc.id,
      candidateId,
      name: str(cand.name),
      currentRole,
      currentCompany,
      ...(bestEmployer ? { bestEmployer } : {}),
      ...(Number.isFinite(yoeNum) ? { yoe: yoeNum } : {}),
      ...(school ? { school } : {}),
      describedStack,
      seniority,
      ...(str(ai.verdict) ? { aiVerdict: str(ai.verdict) } : {}),
      ...(typeof hard.met === "number" ? { aiHard: `${hard.met}/${hard.total ?? 4}` } : {}),
      ...(arr(hard.gaps).length ? { aiGaps: arr(hard.gaps).map((g) => str(g)).slice(0, 4) } : {}),
      ...(str(rec(rec(ai.background).school).verdict) || str(rec(rec(ai.background).gpa).verdict)
        ? {
            pillars: {
              school: str(rec(rec(ai.background).school).verdict) || undefined,
              gpa: str(rec(rec(ai.background).gpa).verdict) || undefined,
              degree: str(rec(rec(ai.background).degree).verdict) || undefined,
              company: str(rec(rec(ai.background).company).verdict) || undefined,
            },
          }
        : {}),
      ...(str(rec(s.claudeReview).verdict)
        ? {
            claudeReview: {
              verdict: str(rec(s.claudeReview).verdict),
              score: Number(rec(s.claudeReview).score) || 0,
              needsHumanAttention: rec(s.claudeReview).needsHumanAttention === true,
            },
          }
        : {}),
      evidence: {
        profileRoles: roles.length,
        describedRoles: describedRoles.length,
        resume: Boolean(str(cand.resumeUrl) || str(s.resumeUrl)),
        research: arr(research.companies).length > 0,
      },
      ...(str(cand.linkedinUrl) || str(cand.link) ? { linkedinUrl: str(cand.linkedinUrl) || str(cand.link) } : {}),
    })
  }

  const dropReasons: Record<string, number> = {}
  const dropSample: string[] = []
  const kept = built.filter((row) => {
    if (filter === "unreviewed" && row.claudeReview) {
      dropReasons.already_reviewed = (dropReasons.already_reviewed ?? 0) + 1
      return false
    }
    if (filter === "needs_attention" && !row.claudeReview?.needsHumanAttention) {
      dropReasons.not_flagged_for_attention = (dropReasons.not_flagged_for_attention ?? 0) + 1
      return false
    }
    const reason = dropReason(row, requireEngineering)
    if (!reason) return true
    dropReasons[reason] = (dropReasons[reason] ?? 0) + 1
    if (dropSample.length < 8) dropSample.push(`${row.name} — ${reason}`)
    return false
  })

  // Order by evidence richness so the client reads the best-documented first; it does the ranking.
  kept.sort((a, b) => {
    const score = (r: ShortlistRow) =>
      (r.bestEmployer?.tier === "A" ? 3 : r.bestEmployer ? 2 : 0) +
      (r.seniority === "senior" ? 2 : r.seniority === "mid" ? 1 : 0) +
      r.describedStack.length * 0.5
    return score(b) - score(a)
  })

  const overflow = Math.max(0, kept.length - limit)
  if (overflow > 0) dropReasons.over_limit = overflow

  return {
    jobId: args.jobId,
    ...(jobTitle ? { jobTitle } : {}),
    ...(job ? { job } : {}),
    ...(resolvedNote ? { resolvedFrom: resolvedNote } : {}),
    returned: Math.min(kept.length, limit),
    totalSubmissions: snap.size,
    dropped: { count: built.length - kept.length + overflow, reasons: dropReasons, sample: dropSample },
    evidenceCaveat:
      "aiHard/aiVerdict come from a checklist that grades implementation specifics only — it does NOT grade school, employer calibre, seniority or corroboration. Weigh those yourself. " +
      "ABSENCE IS NOT A NEGATIVE: an empty describedStack, or a low aiHard against evidence.describedRoles=0, means WE HOLD NO DESCRIPTION — not that the candidate lacks the skill. Call get_candidate_evidence before penalising anyone on thin evidence. " +
      "pillars.gpa is 'unknown' for essentially every candidate (LinkedIn does not carry GPA — measured 258/258 unknown on this board), so treating a missing GPA as a mark against someone rejects the entire pool uniformly and tells you nothing. pillars.school and pillars.company DO discriminate and are worth weighing. " +
      "A self-authored résumé asserting the right keywords is WEAKER evidence than a corroborated role at a named company, not stronger — check evidence.research and evidence.profileRoles before trusting a claim.",
    rows: kept.slice(0, limit),
  }
}

export interface CandidateEvidence {
  submissionId: string
  candidateId?: string
  name: string
  currentRole: string
  currentCompany: string
  yoe?: number
  linkedinUrl?: string
  workHistorySummary?: string
  building?: string
  roles: Array<{ title?: string; company?: string; dates?: string; description?: string; current?: boolean }>
  research?: { subjectName?: string; headline?: string; companies: Rec[]; education: Rec[]; signals: string[]; risks: string[] }
  recruiterNotes?: string
  resumeUrl?: string
  aiEvaluation?: { verdict?: string; confidence?: number; summary?: string; reasons?: string[]; checklist?: Rec; background?: Rec }
}

/** The full bundle for ONE candidate — call it only for candidates worth a closer look. */
export async function runGetCandidateEvidence(args: {
  db: Db
  submissionId: string
}): Promise<CandidateEvidence | { error: string }> {
  const doc = await args.db.collection(SUBMISSIONS).doc(args.submissionId).get()
  if (!doc.exists) return { error: `submission_not_found:${args.submissionId}` }
  const s = doc.data() ?? {}
  const cand = rec(s.candidate)
  const ai = rec(s.aiEvaluation)
  const candidateId = str(s.candidateId) || undefined
  const user = candidateId ? ((await args.db.collection(USERS).doc(candidateId).get()).data() ?? {}) : {}
  const tags = rec(user.tags)

  const roles = arr(user.experienceHighlights)
    .map(rec)
    .map((r) => ({
      title: str(r.title) || undefined,
      company: str(r.company) || undefined,
      dates: str(r.startDate) ? `${str(r.startDate)}–${str(r.endDate) || "now"}` : undefined,
      description: str(r.description) || undefined,
      current: r.currentRole === true ? true : undefined,
    }))
    // Newest first: the stored array is oldest-first, which reads as an intern-only career.
    .reverse()

  const research = rec(ai.research)
  return {
    submissionId: doc.id,
    ...(candidateId ? { candidateId } : {}),
    name: str(cand.name),
    currentRole: str(tags.recentRoleTitle) || str(cand.currentRole),
    currentCompany: str(tags.recentCompany) || str(cand.currentCompany),
    ...(Number.isFinite(Number.parseFloat(str(cand.yoe))) ? { yoe: Number.parseFloat(str(cand.yoe)) } : {}),
    ...(str(cand.linkedinUrl) || str(cand.link) ? { linkedinUrl: str(cand.linkedinUrl) || str(cand.link) } : {}),
    ...(str(tags.workHistorySummary) ? { workHistorySummary: str(tags.workHistorySummary) } : {}),
    ...(str(rec(user.ycIntake).building) ? { building: str(rec(user.ycIntake).building) } : {}),
    roles,
    ...(arr(research.companies).length
      ? {
          research: {
            subjectName: str(research.subjectName) || undefined,
            headline: str(research.headline) || undefined,
            companies: arr(research.companies).map(rec),
            education: arr(research.education).map(rec),
            signals: arr(research.signals).map((x) => str(x)),
            risks: arr(research.risks).map((x) => str(x)),
          },
        }
      : {}),
    ...(str(cand.notes) ? { recruiterNotes: str(cand.notes) } : {}),
    ...(str(cand.resumeUrl) ? { resumeUrl: str(cand.resumeUrl) } : {}),
    ...(str(ai.verdict)
      ? {
          aiEvaluation: {
            verdict: str(ai.verdict),
            confidence: typeof ai.confidence === "number" ? ai.confidence : undefined,
            summary: str(ai.summary) || undefined,
            reasons: arr(ai.reasons).map((x) => str(x)),
            checklist: rec(ai.checklist),
            background: rec(ai.background),
          },
        }
      : {}),
  }
}

/**
 * Persist the client's ranking as an auditable artifact.
 *
 * A ranking that lives only in a chat window teaches the system nothing. Writing it keeps rule 9
 * (HITL corrections become flywheel data): the batch judge's verdict and a smarter reviewer's
 * ordering sit side by side, which is exactly the disagreement set an eval should be built from.
 * Never mutates submission status — ranking is an opinion, advancing is a decision.
 */
export async function runRecordJobRanking(args: {
  db: Db
  jobId: string
  actor: string
  now: string
  rationale?: string
  ranking: Array<{ submissionId: string; rank: number; note?: string }>
}): Promise<{ ok: true; jobId: string; recorded: number; rankingId: string }> {
  const rankingId = `${args.jobId}:${args.now}`
  const rows = args.ranking
    .filter((r) => str(r.submissionId))
    .map((r) => ({
      submissionId: str(r.submissionId),
      rank: Math.max(1, Math.floor(r.rank)),
      ...(str(r.note) ? { note: str(r.note).slice(0, 600) } : {}),
    }))
    .sort((a, b) => a.rank - b.rank)

  await args.db.collection("pa-job-rankings").doc(rankingId).set({
    rankingId,
    jobId: args.jobId,
    actor: args.actor,
    source: "headhunter_mcp",
    ...(args.rationale ? { rationale: args.rationale.slice(0, 4000) } : {}),
    ranking: rows,
    createdAt: args.now,
  })
  return { ok: true, jobId: args.jobId, recorded: rows.length, rankingId }
}

export type ReviewGrade = "strong" | "adequate" | "weak" | "unknown"

export interface CandidateReviewInput {
  submissionId: string
  verdict: "advance" | "borderline" | "reject"
  /** 0-100. Comparable ACROSS candidates on one job — the checklist tally is not. */
  score: number
  needsHumanAttention: boolean
  attentionReason?: string
  reasons?: string[]
  dimensions?: {
    experience?: ReviewGrade
    companies?: ReviewGrade
    school?: ReviewGrade
    gpa?: ReviewGrade
    skills?: ReviewGrade
  }
}

/**
 * Record a reviewer's own verdict per candidate, alongside — never over — the batch evaluation.
 *
 * WHY IT IS A SEPARATE FIELD. `aiEvaluation` is the triage judge's output and the flywheel's
 * training signal; overwriting it would destroy the disagreement that makes an eval set worth
 * having. Both live on the submission so "the cheap judge said borderline, the careful reviewer
 * said reject, the human agreed with X" is answerable later.
 *
 * WHY IT NEVER CHANGES STATUS. A review is an opinion. Advancing or rejecting a real person is a
 * decision with outbound consequences, and it stays behind `advance_recruiter_submission` where a
 * human is accountable for it. A "reject" here means "not worth your attention today" — the
 * candidate remains in the marketplace pool for other roles (v2.0 rule 5).
 */
export async function runRecordCandidateReviews(args: {
  db: Db
  jobId: string
  actor: string
  now: string
  model?: string
  reviews: CandidateReviewInput[]
}): Promise<{
  ok: true
  jobId: string
  written: number
  skipped: Array<{ submissionId: string; reason: string }>
  summary: { advance: number; borderline: number; reject: number; needsAttention: number }
}> {
  const summary = { advance: 0, borderline: 0, reject: 0, needsAttention: 0 }
  const skipped: Array<{ submissionId: string; reason: string }> = []
  let written = 0

  for (const r of args.reviews) {
    const id = str(r.submissionId)
    if (!id) {
      skipped.push({ submissionId: String(r.submissionId), reason: "missing_submission_id" })
      continue
    }
    const ref = args.db.collection(SUBMISSIONS).doc(id)
    const snap = await ref.get()
    if (!snap.exists) {
      skipped.push({ submissionId: id, reason: "submission_not_found" })
      continue
    }
    // Cross-job writes would silently scribble on another role's board.
    const onJob = str((snap.data() ?? {}).jobId)
    if (onJob && onJob !== args.jobId) {
      skipped.push({ submissionId: id, reason: `belongs_to_other_job:${onJob}` })
      continue
    }
    const verdict = r.verdict === "advance" || r.verdict === "reject" ? r.verdict : "borderline"
    const needsAttention = r.needsHumanAttention === true
    summary[verdict] += 1
    if (needsAttention) summary.needsAttention += 1

    await ref.set({
      claudeReview: {
        verdict,
        score: Math.max(0, Math.min(100, Math.round(Number(r.score) || 0))),
        needsHumanAttention: needsAttention,
        ...(str(r.attentionReason) ? { attentionReason: str(r.attentionReason).slice(0, 600) } : {}),
        ...(arr(r.reasons).length ? { reasons: arr(r.reasons).map((x) => str(x).slice(0, 400)).slice(0, 8) } : {}),
        ...(r.dimensions ? { dimensions: r.dimensions } : {}),
        reviewer: args.actor,
        ...(str(args.model) ? { model: str(args.model) } : {}),
        source: "headhunter_mcp",
        reviewedAt: args.now,
      },
    }, { merge: true })
    written += 1
  }

  return { ok: true, jobId: args.jobId, written, skipped, summary }
}

export interface JobMatch {
  jobId: string
  title?: string
  company?: string
  matchedVia: "doc_id" | "public_id" | "url_segment" | "title_company"
  submissions?: number
}

/**
 * Turn whatever a human says into a jobId.
 *
 * Nobody should have to know that a role is `photon-backend-engineer-high-concurrency`. This takes
 * a URL, a doc id, a publicId, or plain words ("photon backend", "the Invoko designer role") and
 * resolves them against the whole `pa-jobs` collection — 39 docs, so a full scan costs nothing and
 * beats maintaining an index.
 *
 * Ambiguity is RETURNED, never guessed: silently picking one of two plausible roles would score a
 * candidate pool against the wrong rubric, which is worse than asking.
 */
export async function runFindJob(args: {
  db: Db
  query: string
  countSubmissions?: boolean
}): Promise<{ query: string; resolved?: JobMatch; matches: JobMatch[]; note?: string }> {
  const query = str(args.query)
  if (!query) return { query, matches: [], note: "empty query" }

  const snap = await args.db.collection(JOBS).get()
  const jobs = snap.docs.map((d) => {
    const j = (d.data() ?? {}) as Rec
    return {
      id: d.id,
      title: str(j.title),
      company: str(j.companyName) || str(j.company) || str(rec(rec(j.recruiterBoard).label).company),
      publicId: str(j.publicId),
    }
  })

  // A pasted link: try every path segment, longest first — the id is rarely the last one.
  const segments = query.includes("/")
    ? query.split(/[/?#]/).map((s) => str(s)).filter(Boolean).sort((a, b) => b.length - a.length)
    : []
  const needles = [query, ...segments]

  for (const n of needles) {
    const byId = jobs.find((j) => j.id === n)
    if (byId) {
      return finish(byId, n === query ? "doc_id" : "url_segment")
    }
    const byPublic = jobs.find((j) => j.publicId && j.publicId === n)
    if (byPublic) return finish(byPublic, "public_id")
  }

  // Word-overlap on title + company. Every word must appear somewhere, so "photon backend" hits
  // the Photon backend role and not every backend role we have.
  const words = query.toLowerCase().split(/[^a-z0-9+#.]+/).filter((w) => w.length > 2)
  const scored = jobs
    .map((j) => {
      const hay = `${j.id} ${j.title} ${j.company}`.toLowerCase()
      const hits = words.filter((w) => hay.includes(w)).length
      return { j, hits }
    })
    .filter((x) => words.length > 0 && x.hits === words.length)
    .sort((a, b) => b.hits - a.hits)

  const matches: JobMatch[] = scored.map(({ j }) => ({
    jobId: j.id,
    ...(j.title ? { title: j.title } : {}),
    ...(j.company ? { company: j.company } : {}),
    matchedVia: "title_company" as const,
  }))

  if (matches.length === 1) return { query, resolved: matches[0], matches }
  if (matches.length === 0) {
    return {
      query,
      matches: [],
      note: `no job matched "${query}". Known jobs: ${jobs.slice(0, 20).map((j) => `${j.title || j.id} @ ${j.company || "?"}`).join("; ")}`,
    }
  }
  return { query, matches, note: `${matches.length} jobs matched — pass a jobId from this list, or narrow the query.` }

  function finish(j: { id: string; title: string; company: string }, via: JobMatch["matchedVia"]) {
    const m: JobMatch = {
      jobId: j.id,
      ...(j.title ? { title: j.title } : {}),
      ...(j.company ? { company: j.company } : {}),
      matchedVia: via,
    }
    return { query, resolved: m, matches: [m] }
  }
}
