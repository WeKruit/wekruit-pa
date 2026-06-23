export const PRESCREEN_TOP_FIVE_PASS_RATIO = 0.95
export const PRESCREEN_TOP_FIVE_MIN_MUST_HAVE_SCORE = 0.95
export const PRESCREEN_TOP_FIVE_MIN_CONFIDENCE = 0.85

export type PrescreenTerminal = "PASS" | "FAIL" | "HARD_STOP" | "PAUSE"
export type ReviewActionTerminal = Exclude<PrescreenTerminal, "PAUSE">
export type StrictReviewBucket = "all" | "batch_reject" | "individual_review" | "hard_stop" | "top_five_pass" | "paused"
export type StrictReviewSort = "strict_priority" | "score_desc" | "oldest" | "newest"
export type StrictReviewQueueFilter = "all" | "pending" | "committed"
export type StrictReviewTerminalFilter = "all" | PrescreenTerminal | "IN_PROGRESS"
export type StrictReviewActionFilter = "all" | ReviewActionTerminal
export type StrictReviewDraftFilter = "all" | "has_decision" | "missing_decision"

export type PrescreenReviewQuestion = {
  qId?: string
  type?: string
  finalS?: number
  finalC?: number
  summary?: string
  scored?: {
    aggregate?: { summary?: string }
    perKeyword?: Array<{ evidence?: string; reasoning?: string }>
  }
}

export type PrescreenReviewRowLike = {
  id?: string
  sessionId?: string
  userId?: string
  candidateName?: string
  jobId?: string
  jobTitle?: string
  jobCompany?: string
  terminal?: string | null
  score?: number
  scoreMax?: number
  createdAt?: string
  updatedAt?: string
  questions?: Record<string, PrescreenReviewQuestion>
  terminalActionPendingReview?: boolean
  review?: {
    finalTerminal?: string
    candidateDecision?: unknown
  }
}

export type PrescreenReviewClassification = {
  recommendation: PrescreenTerminal
  bucket: Exclude<StrictReviewBucket, "all">
  label: string
  tone: "ok" | "warn" | "info" | "muted"
  ratio: number
  minMustHaveScore: number
  minMustHaveConfidence: number
  reasons: string[]
  rank: number
}

export type PrescreenReviewSummary = {
  total: number
  topFivePass: number
  batchReject: number
  individualReview: number
  hardStop: number
  paused: number
}

const OWNERSHIP_RE = /\b(owned|led|drove|built|shipped|launched|created|designed|implemented|managed|founded|ran|authored)\b/i
const TEAM_ONLY_RE = /\b(helped|assisted|supported|contributed|worked with|part of a team|team project)\b/i
const METRIC_RE =
  /(\d+(\.\d+)?\s?%|\$\s?\d|\b\d+\s?(users|leads|customers|pipeline|revenue|conversion|conversions|signups|mrr|arr)\b|\b(increased|decreased|reduced|improved|grew|lifted|converted)\b)/i
const GROWTH_Q_RE = /(growth|marketing|campaign|gtm|business|revenue|acquisition|activation)/i

const BUCKET_RANK: Record<Exclude<StrictReviewBucket, "all">, number> = {
  batch_reject: 0,
  individual_review: 1,
  paused: 2,
  hard_stop: 3,
  top_five_pass: 4,
}

export function classifyPrescreenReviewRow(row: PrescreenReviewRowLike): PrescreenReviewClassification {
  const terminal = cleanTerminal(row.terminal)
  const ratio = safeRatio(row.score, row.scoreMax)
  const questions = Object.entries(row.questions ?? {}).map(([qId, q]) => normalizeQuestion(qId, q))
  const mustHave = questions.filter((q) => q.type === "MUST_HAVE")
  const required = mustHave.length > 0 ? mustHave : questions
  const minMustHaveScore = minNumber(required.map((q) => q.finalS))
  const minMustHaveConfidence = minNumber(required.map((q) => q.finalC))
  const reasons: string[] = []

  if (terminal === "HARD_STOP") {
    return buildClassification({
      recommendation: "HARD_STOP",
      bucket: "hard_stop",
      label: "HARD STOP",
      tone: "warn",
      ratio,
      minMustHaveScore,
      minMustHaveConfidence,
      reasons: ["AI found a hard-stop mismatch; human should verify and close."],
    })
  }

  if (terminal === "PAUSE") {
    return buildClassification({
      recommendation: "PAUSE",
      bucket: "paused",
      label: "Paused - low confidence",
      tone: "muted",
      ratio,
      minMustHaveScore,
      minMustHaveConfidence,
      reasons: ["Claire paused because confidence stayed too low to proceed for this role."],
    })
  }

  if (required.length === 0) reasons.push("missing scored prescreen evidence")
  if (terminal !== "PASS") reasons.push("AI did not propose PASS")
  if (ratio < PRESCREEN_TOP_FIVE_PASS_RATIO) {
    reasons.push(`overall score below top-5 bar (${percent(ratio)})`)
  }
  if (minMustHaveScore < PRESCREEN_TOP_FIVE_MIN_MUST_HAVE_SCORE) {
    reasons.push(`must-have score below top-5 floor (${minMustHaveScore.toFixed(2)})`)
  }
  if (minMustHaveConfidence < PRESCREEN_TOP_FIVE_MIN_CONFIDENCE) {
    reasons.push(`must-have confidence below review floor (${minMustHaveConfidence.toFixed(2)})`)
  }

  for (const q of required) {
    const hasOwnership = OWNERSHIP_RE.test(q.evidenceText)
    const teamOnly = TEAM_ONLY_RE.test(q.evidenceText) && !hasOwnership
    const growthQuestion = GROWTH_Q_RE.test(q.qId)
    const hasMetric = METRIC_RE.test(q.evidenceText)

    if (!hasOwnership && q.finalS < PRESCREEN_TOP_FIVE_MIN_MUST_HAVE_SCORE) {
      reasons.push(`${q.qId}: missing direct ownership`)
    }
    if (teamOnly) reasons.push(`${q.qId}: team-only evidence`)
    if (growthQuestion && !hasMetric) reasons.push(`${q.qId}: missing measurable growth/business result`)
  }

  if (
    terminal === "PASS" &&
    ratio >= PRESCREEN_TOP_FIVE_PASS_RATIO &&
    minMustHaveScore >= PRESCREEN_TOP_FIVE_MIN_MUST_HAVE_SCORE &&
    minMustHaveConfidence >= PRESCREEN_TOP_FIVE_MIN_CONFIDENCE &&
    reasons.length === 0
  ) {
    return buildClassification({
      recommendation: "PASS",
      bucket: "top_five_pass",
      label: "Top 5% pass",
      tone: "ok",
      ratio,
      minMustHaveScore,
      minMustHaveConfidence,
      reasons: ["direct, specific, measured evidence clears top-5 prescreen bar"],
    })
  }

  const majorReject = reasons.some((reason) =>
    /missing scored|below top-5|team-only|missing direct ownership|missing measurable/i.test(reason),
  )
  return buildClassification({
    recommendation: "FAIL",
    bucket: majorReject ? "batch_reject" : "individual_review",
    label: majorReject ? "Likely reject" : "Review closely",
    tone: majorReject ? "warn" : "info",
    ratio,
    minMustHaveScore,
    minMustHaveConfidence,
    reasons: dedupe(reasons.length > 0 ? reasons : ["does not clear top-5 prescreen bar"]),
  })
}

export function filterAndSortPrescreenRows<T extends PrescreenReviewRowLike>(
  rows: T[],
  controls: {
    bucket: StrictReviewBucket
    sort: StrictReviewSort
    search: string
    queue?: StrictReviewQueueFilter
    terminal?: StrictReviewTerminalFilter
    action?: StrictReviewActionFilter
    draft?: StrictReviewDraftFilter
  },
): T[] {
  const search = controls.search.trim().toLowerCase()
  const withClassification = rows
    .map((row) => ({ row, classification: classifyPrescreenReviewRow(row) }))
    .filter(({ row, classification }) => {
      if (controls.queue === "pending" && row.terminalActionPendingReview !== true) return false
      if (controls.queue === "committed" && row.terminalActionPendingReview === true) return false
      if (controls.terminal && controls.terminal !== "all" && effectiveTerminal(row.terminal) !== controls.terminal) return false
      if (controls.action && controls.action !== "all" && classification.recommendation !== controls.action) return false
      if (controls.draft === "has_decision" && !hasCandidateDecision(row)) return false
      if (controls.draft === "missing_decision" && hasCandidateDecision(row)) return false
      if (controls.bucket !== "all" && classification.bucket !== controls.bucket) return false
      if (!search) return true
      return [
        row.id,
        row.sessionId,
        row.userId,
        row.candidateName,
        row.jobId,
        row.jobTitle,
        row.jobCompany,
        row.terminal,
        classification.label,
        classification.recommendation,
        ...classification.reasons,
      ]
        .filter((value): value is string => typeof value === "string")
        .some((value) => value.toLowerCase().includes(search))
    })

  withClassification.sort((a, b) => {
    if (controls.sort === "score_desc") return b.classification.ratio - a.classification.ratio
    if (controls.sort === "oldest") return timeValue(a.row.createdAt) - timeValue(b.row.createdAt)
    if (controls.sort === "newest") return timeValue(b.row.createdAt) - timeValue(a.row.createdAt)
    const rankDelta = a.classification.rank - b.classification.rank
    if (rankDelta !== 0) return rankDelta
    return b.classification.ratio - a.classification.ratio
  })

  return withClassification.map((item) => item.row)
}

export function summarizePrescreenReviewRows(rows: PrescreenReviewRowLike[]): PrescreenReviewSummary {
  const summary: PrescreenReviewSummary = {
    total: rows.length,
    topFivePass: 0,
    batchReject: 0,
    individualReview: 0,
    hardStop: 0,
    paused: 0,
  }
  for (const row of rows) {
    const classification = classifyPrescreenReviewRow(row)
    if (classification.bucket === "top_five_pass") summary.topFivePass += 1
    if (classification.bucket === "batch_reject") summary.batchReject += 1
    if (classification.bucket === "individual_review") summary.individualReview += 1
    if (classification.bucket === "hard_stop") summary.hardStop += 1
    if (classification.bucket === "paused") summary.paused += 1
  }
  return summary
}

function buildClassification(args: Omit<PrescreenReviewClassification, "rank">): PrescreenReviewClassification {
  return {
    ...args,
    reasons: dedupe(args.reasons),
    rank: BUCKET_RANK[args.bucket],
  }
}

function normalizeQuestion(qId: string, raw: PrescreenReviewQuestion) {
  const aggregate = raw.scored?.aggregate
  const perKeyword = raw.scored?.perKeyword ?? []
  const evidenceText = [
    aggregate?.summary,
    raw.summary,
    ...perKeyword.flatMap((cell) => [cell.evidence, cell.reasoning]),
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")

  return {
    qId: raw.qId ?? qId,
    type: raw.type ?? "",
    finalS: finiteNumber(raw.finalS),
    finalC: finiteNumber(raw.finalC),
    evidenceText,
  }
}

function cleanTerminal(value: unknown): PrescreenTerminal | null {
  return value === "PASS" || value === "FAIL" || value === "HARD_STOP" || value === "PAUSE" ? value : null
}

function effectiveTerminal(value: unknown): StrictReviewTerminalFilter {
  return cleanTerminal(value) ?? "IN_PROGRESS"
}

function hasCandidateDecision(row: PrescreenReviewRowLike): boolean {
  const decision = row.review?.candidateDecision
  if (!decision || typeof decision !== "object") return false
  const record = decision as Record<string, unknown>
  return typeof record.candidateMessageBody === "string" || typeof record.decisionReason === "string"
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function minNumber(values: number[]): number {
  const nums = values.filter((value) => Number.isFinite(value))
  if (nums.length === 0) return 0
  return Math.min(...nums)
}

function safeRatio(score: unknown, scoreMax: unknown): number {
  const max = finiteNumber(scoreMax)
  if (max <= 0) return 0
  return finiteNumber(score) / max
}

function timeValue(iso: string | undefined): number {
  if (!iso) return 0
  const parsed = Date.parse(iso)
  return Number.isFinite(parsed) ? parsed : 0
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)]
}
