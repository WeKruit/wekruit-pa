const OWNERSHIP_RE = /\b(owned|led|drove|built|shipped|launched|created|designed|implemented|managed|founded|ran|authored)\b/i
const TEAM_ONLY_RE = /\b(helped|assisted|supported|contributed|worked with|part of a team|team project)\b/i
const METRIC_RE =
  /(\d+(\.\d+)?\s?%|\$\s?\d|\b\d+\s?(users|leads|customers|pipeline|revenue|conversion|conversions|signups|mrr|arr)\b|\b(increased|decreased|reduced|improved|grew|lifted|converted)\b)/i
const GROWTH_Q_RE = /(growth|marketing|campaign|gtm|business|revenue|acquisition|activation)/i

export function gradePrescreenSessionForCalibration(session) {
  const currentTerminal = cleanTerminal(session.terminal) ?? "UNKNOWN"
  const ratio = finiteNumber(session.scoreMax) && session.scoreMax > 0 ? finiteNumber(session.score) / session.scoreMax : 0
  const questions = Object.entries(session.questions ?? {}).map(([qId, q]) => normalizeQuestion(qId, q))
  const mustHave = questions.filter((q) => q.type === "MUST_HAVE")
  const required = mustHave.length > 0 ? mustHave : questions
  const reasons = []

  if (currentTerminal === "HARD_STOP") {
    return {
      sessionId: session.id ?? session.sessionId ?? "",
      jobId: session.jobId ?? session.matchingJobId ?? "",
      userId: session.userId ?? "",
      currentTerminal,
      rubricRecommendation: "HARD_STOP",
      band: "hard_stop",
      ratio,
      minMustHaveScore: minNumber(required.map((q) => q.finalS)),
      minMustHaveConfidence: minNumber(required.map((q) => q.finalC)),
      reasons: ["current system found a hard-stop mismatch"],
    }
  }

  const minMustHaveScore = minNumber(required.map((q) => q.finalS))
  const minMustHaveConfidence = minNumber(required.map((q) => q.finalC))
  if (minMustHaveScore < 0.95) reasons.push(`must-have score below top-5 floor (${minMustHaveScore.toFixed(2)})`)
  if (minMustHaveConfidence < 0.85) reasons.push(`must-have confidence below strict floor (${minMustHaveConfidence.toFixed(2)})`)

  for (const q of required) {
    const evidence = q.evidenceText
    const hasOwnership = OWNERSHIP_RE.test(evidence)
    const teamOnly = TEAM_ONLY_RE.test(evidence) && !hasOwnership
    const growthQuestion = GROWTH_Q_RE.test(q.qId)
    const hasMetric = METRIC_RE.test(evidence)

    if (!hasOwnership && q.finalS < 0.95) reasons.push(`${q.qId}: missing direct ownership`)
    if (teamOnly) reasons.push(`${q.qId}: team-only evidence`)
    if (growthQuestion && !hasMetric) reasons.push(`${q.qId}: missing measurable growth/business result`)
  }

  if (ratio < 0.95) reasons.push(`ratio below top-5 threshold (${ratio.toFixed(2)})`)

  const strong =
    currentTerminal === "PASS" &&
    ratio >= 0.95 &&
    minMustHaveScore >= 0.95 &&
    minMustHaveConfidence >= 0.85 &&
    reasons.length === 0

  if (strong) {
    return {
      sessionId: session.id ?? session.sessionId ?? "",
      jobId: session.jobId ?? session.matchingJobId ?? "",
      userId: session.userId ?? "",
      currentTerminal,
      rubricRecommendation: "PASS",
      band: "top_five_pass",
      ratio,
      minMustHaveScore,
      minMustHaveConfidence,
      reasons: ["direct, specific, measured evidence clears top-5 rubric"],
    }
  }

  const weak = reasons.some((r) => /below top-5|below strict floor|team-only|missing direct ownership|missing measurable/.test(r))
  return {
    sessionId: session.id ?? session.sessionId ?? "",
    jobId: session.jobId ?? session.matchingJobId ?? "",
    userId: session.userId ?? "",
    currentTerminal,
    rubricRecommendation: "FAIL",
    band: weak ? "weak_reject" : "borderline_reject",
    ratio,
    minMustHaveScore,
    minMustHaveConfidence,
    reasons: reasons.length > 0 ? dedupe(reasons) : ["does not clear strict PASS bar"],
  }
}

export function summarizeCalibrationRows(rows) {
  const currentTerminalCounts = {}
  const rubricRecommendationCounts = {}
  const bandCounts = {}
  let aiPassDowngradedToFail = 0
  for (const row of rows) {
    bump(currentTerminalCounts, row.currentTerminal)
    bump(rubricRecommendationCounts, row.rubricRecommendation)
    bump(bandCounts, row.band)
    if (row.currentTerminal === "PASS" && row.rubricRecommendation === "FAIL") aiPassDowngradedToFail += 1
  }
  return {
    total: rows.length,
    currentTerminalCounts,
    rubricRecommendationCounts,
    bandCounts,
    aiPassDowngradedToFail,
  }
}

function normalizeQuestion(qId, raw) {
  const aggregate = raw?.scored?.aggregate ?? {}
  const perKeyword = Array.isArray(raw?.scored?.perKeyword) ? raw.scored.perKeyword : []
  const evidenceParts = [
    aggregate.summary,
    raw?.summary,
    ...perKeyword.flatMap((cell) => [cell.evidence, cell.reasoning]),
  ].filter((v) => typeof v === "string" && v.trim())

  return {
    qId,
    type: typeof raw?.type === "string" ? raw.type : "",
    finalS: finiteNumber(raw?.finalS),
    finalC: finiteNumber(raw?.finalC),
    evidenceText: evidenceParts.join(" "),
  }
}

function cleanTerminal(value) {
  return value === "PASS" || value === "FAIL" || value === "HARD_STOP" || value === "PAUSE" ? value : null
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function minNumber(values) {
  const nums = values.filter((value) => Number.isFinite(value))
  if (nums.length === 0) return 0
  return Math.min(...nums)
}

function bump(target, key) {
  const normalized = key || "UNKNOWN"
  target[normalized] = (target[normalized] ?? 0) + 1
}

function dedupe(values) {
  return [...new Set(values)]
}
