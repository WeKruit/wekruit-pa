import { createHash } from "node:crypto"
import type {
  PracticeQuestionBankItem,
  PracticeQuestionDifficulty,
  PracticeQuestionKind,
} from "@pa/core-types"

export type LegacyRecord = Record<string, unknown>

export interface LegacyFirestoreDoc {
  docId: string
  data: LegacyRecord
}

export interface PracticeImportCandidate {
  item: PracticeQuestionBankItem
  sourcePriority: number
}

export interface PracticeResearchSeedRecord {
  slug: string
  sourceKey: string
  sourceTitle: string
  sourceUrl: string
  status?: PracticeQuestionBankItem["status"]
  kind: PracticeQuestionKind
  conversationMode: PracticeQuestionBankItem["conversationMode"]
  title: string
  prompt: string
  context?: string
  difficulty?: PracticeQuestionDifficulty
  estimatedMinutes?: number
  companyStyle?: string[]
  roleFamilies?: string[]
  categories?: string[]
  tags?: string[]
  keyConcepts?: string[]
  evaluation?: PracticeQuestionBankItem["evaluation"]
}

const IMPORT_ACTOR = "practice-question-importer"

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => text(v)).filter((v): v is string => Boolean(v))
  }
  if (typeof value === "string") {
    return value
      .split(/\n|,/)
      .map((v) => v.trim())
      .filter(Boolean)
  }
  return []
}

function objectArray(value: unknown): LegacyRecord[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is LegacyRecord => Boolean(v) && typeof v === "object" && !Array.isArray(v))
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const match = value.match(/\d+/)
    if (match) return Number(match[0])
  }
  return undefined
}

function normalizeDifficulty(value: unknown): PracticeQuestionDifficulty | undefined {
  const raw = text(value)?.toLowerCase()
  if (!raw) return undefined
  if (raw === "easy" || raw === "basic") return "easy"
  if (raw === "medium" || raw === "intermediate") return "medium"
  if (raw === "hard" || raw === "advanced") return "hard"
  return undefined
}

function compactJson(value: unknown): string | undefined {
  if (value == null) return undefined
  if (typeof value === "string") return text(value)
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

function joinSections(sections: Array<[string, unknown]>): string | undefined {
  const parts = sections
    .map(([label, value]) => {
      if (Array.isArray(value)) {
        const arr = stringArray(value)
        return arr.length ? `${label}:\n${arr.map((v) => `- ${v}`).join("\n")}` : ""
      }
      const body = compactJson(value)
      return body ? `${label}:\n${body}` : ""
    })
    .filter(Boolean)
  return parts.length ? parts.join("\n\n") : undefined
}

function normalizeForFingerprint(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim()
}

export function contentFingerprint(
  kind: PracticeQuestionKind,
  title: string,
  prompt: string,
): string {
  return createHash("sha256")
    .update(`${kind}|${normalizeForFingerprint(title)}|${normalizeForFingerprint(prompt)}`)
    .digest("hex")
}

function canonicalId(fingerprint: string): string {
  return `pq_${fingerprint.slice(0, 28)}`
}

function baseItem(args: {
  kind: PracticeQuestionKind
  conversationMode: PracticeQuestionBankItem["conversationMode"]
  title: string
  prompt: string
  context?: string
  status?: PracticeQuestionBankItem["status"]
  difficulty?: PracticeQuestionDifficulty
  estimatedMinutes?: number
  categories?: string[]
  tags?: string[]
  keyConcepts?: string[]
  companyStyle?: string[]
  roleFamilies?: string[]
  evaluation?: PracticeQuestionBankItem["evaluation"]
  sourceRefs: string[]
  nowIso: string
}): PracticeQuestionBankItem {
  const fp = contentFingerprint(args.kind, args.title, args.prompt)
  return {
    schemaVersion: 1,
    id: canonicalId(fp),
    status: args.status ?? "active",
    kind: args.kind,
    conversationMode: args.conversationMode,
    title: args.title,
    prompt: args.prompt,
    ...(args.context ? { context: args.context } : {}),
    ...(args.difficulty ? { difficulty: args.difficulty } : {}),
    ...(args.estimatedMinutes ? { estimatedMinutes: args.estimatedMinutes } : {}),
    companyStyle: args.companyStyle ?? [],
    roleFamilies: args.roleFamilies ?? [],
    categories: args.categories ?? [],
    tags: args.tags ?? [],
    keyConcepts: args.keyConcepts ?? [],
    evaluation: args.evaluation ?? {
      rubric: [],
      followUps: [],
      expectedSignals: [],
      redFlags: [],
    },
    sourceRefs: args.sourceRefs,
    contentFingerprint: fp,
    createdAt: args.nowIso,
    updatedAt: args.nowIso,
    createdBy: IMPORT_ACTOR,
    updatedBy: IMPORT_ACTOR,
  }
}

function solutionSummary(solution?: LegacyRecord): string | undefined {
  if (!solution) return undefined
  return joinSections([
    ["Architecture", solution.architecture],
    ["Class design", solution.classDesign],
    ["Key components", solution.keyComponents],
    ["Tradeoffs", solution.tradeoffs],
    ["Scalability", solution.scalability],
    ["Complexity", solution.complexity],
    ["Implementation", solution.implementation],
    ["Diagram", solution.diagramCode],
  ])
}

export function mapSystemDesignProblem(
  problem: LegacyFirestoreDoc,
  solution: LegacyFirestoreDoc | null,
  nowIso: string,
): PracticeImportCandidate {
  const data = problem.data
  const title = text(data.title) ?? problem.docId
  const prompt = text(data.description) ?? text(data.problem_statement) ?? title
  const item = baseItem({
    kind: "system_design",
    conversationMode: "system_design_discussion",
    title,
    prompt,
    context: joinSections([
      ["Requirements", data.requirements],
      ["Constraints", data.constraints],
      ["Design aspects", data.designAspects],
      ["Diagram requirements", data.diagramRequirements],
    ]),
    difficulty: normalizeDifficulty(data.difficulty),
    estimatedMinutes: numberValue(data.estimatedTime),
    categories: stringArray(data.categories),
    tags: stringArray(data.tags),
    keyConcepts: stringArray(data.topics),
    sourceRefs: [
      `firestore:systemDesignProblems/${problem.docId}`,
      ...(solution ? [`firestore:systemDesignSolutions/${solution.docId}`] : []),
    ],
    evaluation: {
      rubric: [
        { criterion: "Requirements and constraints", guidance: "Clarifies functional and non-functional requirements before proposing architecture." },
        { criterion: "Architecture and tradeoffs", guidance: "Explains core components, data flow, bottlenecks, and tradeoffs." },
        { criterion: "Reliability and scale", guidance: "Covers failure modes, scaling choices, and future improvements." },
      ],
      followUps: [],
      expectedSignals: stringArray(data.tags),
      redFlags: [],
      ...(solutionSummary(solution?.data) ? { solutionSummary: solutionSummary(solution?.data) } : {}),
    },
    nowIso,
  })
  return { item, sourcePriority: 20 }
}

export function mapObjectDesignProblem(
  problem: LegacyFirestoreDoc,
  solution: LegacyFirestoreDoc | null,
  nowIso: string,
): PracticeImportCandidate {
  const data = problem.data
  const title = text(data.title) ?? problem.docId
  const prompt = text(data.description) ?? text(data.problem_statement) ?? title
  const item = baseItem({
    kind: "object_oriented_design",
    conversationMode: "object_design_discussion",
    title,
    prompt,
    context: joinSections([
      ["Requirements", data.requirements],
      ["Design aspects", data.designAspects],
      ["Diagram requirements", data.diagramRequirements],
    ]),
    difficulty: normalizeDifficulty(data.difficulty),
    estimatedMinutes: numberValue(data.estimatedTime),
    categories: stringArray(data.categories),
    tags: stringArray(data.tags),
    keyConcepts: stringArray(data.keyConcepts),
    sourceRefs: [
      `firestore:objectOrientedDesignProblems/${problem.docId}`,
      ...(solution ? [`firestore:objectOrientedDesignSolutions/${solution.docId}`] : []),
    ],
    evaluation: {
      rubric: [
        { criterion: "Core objects", guidance: "Identifies domain objects, responsibilities, and relationships." },
        { criterion: "Design quality", guidance: "Uses encapsulation, interfaces, composition/inheritance, and relevant patterns." },
        { criterion: "Extensibility", guidance: "Explains SOLID tradeoffs, edge cases, and how the design evolves." },
      ],
      followUps: [],
      expectedSignals: stringArray(data.keyConcepts),
      redFlags: [],
      ...(solutionSummary(solution?.data) ? { solutionSummary: solutionSummary(solution?.data) } : {}),
    },
    nowIso,
  })
  return { item, sourcePriority: 20 }
}

function rubricFromAssessmentCriteria(value: unknown) {
  return objectArray(value).map((row) => ({
    criterion: text(row.dimension) ?? text(row.name) ?? "Assessment criterion",
    ...(numberValue(row.weight) ? { weight: numberValue(row.weight) } : {}),
    guidance: joinSections([
      ["Excellent", row.excellent_indicators],
      ["Good", row.good_indicators],
      ["Satisfactory", row.satisfactory_indicators],
      ["Poor", row.poor_indicators],
      ["Red flags", row.specific_red_flags],
    ]),
  }))
}

function questionsFromFollowUps(value: unknown): string[] {
  return objectArray(value)
    .map((row) => text(row.question) ?? text(row.follow_up_if_correct) ?? text(row.follow_up_if_incorrect))
    .filter((v): v is string => Boolean(v))
}

export function mapDataCaseProblem(
  problem: LegacyFirestoreDoc,
  nowIso: string,
): PracticeImportCandidate {
  const data = problem.data
  const title = text(data.title) ?? problem.docId
  const prompt = text(data.main_question) ?? text(data.problem_statement) ?? title
  const item = baseItem({
    kind: "data_case",
    conversationMode: "data_case_discussion",
    title,
    prompt,
    context: joinSections([
      ["Problem statement", data.problem_statement],
      ["Background", data.background_context],
      ["Business context", data.business_context],
      ["Available data", data.available_data_sources],
      ["Modeling details", data.modeling_details],
      ["Prerequisites", data.prerequisites],
    ]),
    estimatedMinutes: numberValue(data.estimated_duration_minutes),
    categories: stringArray(data.category),
    tags: stringArray(data.tags),
    keyConcepts: stringArray(data.learning_objectives),
    sourceRefs: [`firestore:dataCaseProblems/${problem.docId}`],
    evaluation: {
      rubric: rubricFromAssessmentCriteria(data.assessment_criteria),
      followUps: questionsFromFollowUps(data.follow_up_questions),
      expectedSignals: stringArray(data.learning_objectives),
      redFlags: stringArray(data.common_mistakes),
      ...(text(data.optimal_solution) ? { solutionSummary: text(data.optimal_solution) } : {}),
    },
    nowIso,
  })
  return { item, sourcePriority: 20 }
}

function isBehavioralAlgoliaRecord(hit: LegacyRecord, indexName: string): boolean {
  if (indexName === "wekruit-interview-question-bank-behavior-question") return true
  const category = text(hit.category)?.toLowerCase()
  const tags = [
    ...stringArray(hit.tags),
    ...stringArray(hit.behavioral_tags),
    ...stringArray(hit.technical_tags),
    ...stringArray(hit.industry_tags),
  ].map((t) => t.toLowerCase())
  return category === "behavioral" || tags.some((t) => t.includes("behavior"))
}

export function mapAlgoliaQuestion(
  hit: LegacyRecord,
  indexName: string,
  nowIso: string,
): PracticeImportCandidate {
  const objectId = text(hit.objectID) ?? text(hit.id) ?? "unknown"
  const title = text(hit.question) ?? text(hit.title) ?? objectId
  const answer = text(hit.answer)
  const behavioral = isBehavioralAlgoliaRecord(hit, indexName)
  const item = baseItem({
    kind: "behavioral",
    conversationMode: behavioral ? "behavioral_screen" : "resume_deep_dive",
    title,
    prompt: title,
    context: answer ? `Reference answer:\n${answer}` : undefined,
    status: behavioral ? "active" : "archived",
    difficulty: normalizeDifficulty(hit.difficulty),
    companyStyle: text(hit.company) && text(hit.company) !== "Generic" ? [text(hit.company)!] : [],
    roleFamilies: stringArray(hit.job_title),
    categories: stringArray(hit.category),
    tags: [
      ...stringArray(hit.tags),
      ...stringArray(hit.behavioral_tags),
      ...stringArray(hit.technical_tags),
      ...stringArray(hit.industry_tags),
    ],
    sourceRefs: [`algolia:${indexName}/${objectId}`],
    evaluation: {
      rubric: answer ? [{ criterion: "Answer quality", guidance: answer }] : [],
      followUps: [],
      expectedSignals: stringArray(hit.tags),
      redFlags: [],
      ...(answer ? { solutionSummary: answer } : {}),
    },
    nowIso,
  })
  return { item, sourcePriority: indexName === "wekruit-interview-question-bank-behavior-question" ? 30 : 10 }
}

function defaultResearchEvaluation(seed: PracticeResearchSeedRecord): PracticeQuestionBankItem["evaluation"] {
  if (seed.kind === "system_design") {
    return {
      rubric: [
        { criterion: "Requirement framing", guidance: "Clarifies users, scale, latency, reliability, privacy, and scope before architecture." },
        { criterion: "Tradeoff reasoning", guidance: "Explains component choices, data flow, bottlenecks, failure modes, and alternatives." },
      ],
      followUps: [
        "What would you simplify for an MVP?",
        "What is the first reliability bottleneck you would expect?",
      ],
      expectedSignals: ["states assumptions", "balances scale and correctness", "discusses tradeoffs"],
      redFlags: ["jumps to tools before requirements", "ignores failure modes"],
    }
  }
  if (seed.kind === "object_oriented_design") {
    return {
      rubric: [
        { criterion: "Domain modeling", guidance: "Identifies core entities, responsibilities, relationships, and state transitions." },
        { criterion: "Extensibility", guidance: "Explains interfaces, invariants, edge cases, and how the design changes with new requirements." },
      ],
      followUps: [
        "Which class owns the most important invariant?",
        "How would the design change if the system became multi-tenant?",
      ],
      expectedSignals: ["clear ownership", "encapsulation", "edge case handling"],
      redFlags: ["god object design", "unclear state ownership"],
    }
  }
  if (seed.kind === "data_case") {
    return {
      rubric: [
        { criterion: "Problem decomposition", guidance: "Defines the metric, denominator, time window, cohorts, and competing hypotheses." },
        { criterion: "Decision quality", guidance: "Connects analysis or experiment design to a concrete product or business decision." },
      ],
      followUps: [
        "What is your primary metric and what guardrail would stop the launch?",
        "How would you distinguish product behavior from instrumentation noise?",
      ],
      expectedSignals: ["metric clarity", "segmentation", "causal thinking", "decision framing"],
      redFlags: ["only checks aggregate metrics", "does not define actionability"],
    }
  }
  return {
    rubric: [
      { criterion: "Specific evidence", guidance: "Uses a concrete story with role, constraints, actions, and measurable outcome." },
      { criterion: "Reflection", guidance: "Explains tradeoffs, what changed after the event, and what the candidate would do differently." },
    ],
    followUps: [
      "What was your personal contribution versus the team's contribution?",
      "What would a skeptical teammate say about your approach?",
    ],
    expectedSignals: ["specific example", "ownership", "communication", "learning"],
    redFlags: ["generic answer", "no measurable outcome", "blames others"],
  }
}

export function mapResearchSeedQuestion(
  seed: PracticeResearchSeedRecord,
  nowIso: string,
): PracticeImportCandidate {
  const sourceRef = `web-research:${seed.sourceKey}/${seed.slug}`
  const sourceUrlRef = `web-research-url:${seed.sourceUrl}`
  const sourceContext = joinSections([
    ["Research source", `${seed.sourceTitle}\n${seed.sourceUrl}`],
    ["Practice context", seed.context],
  ])
  const item = baseItem({
    kind: seed.kind,
    conversationMode: seed.conversationMode,
    title: seed.title,
    prompt: seed.prompt,
    context: sourceContext,
    status: seed.status ?? "active",
    difficulty: normalizeDifficulty(seed.difficulty),
    estimatedMinutes: seed.estimatedMinutes,
    companyStyle: seed.companyStyle ?? [],
    roleFamilies: seed.roleFamilies ?? [],
    categories: seed.categories ?? [],
    tags: unique(["practice", ...(seed.tags ?? [])]),
    keyConcepts: seed.keyConcepts ?? [],
    sourceRefs: unique([sourceRef, sourceUrlRef]),
    evaluation: seed.evaluation ?? defaultResearchEvaluation(seed),
    nowIso,
  })
  return { item, sourcePriority: 25 }
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

export function dedupeImportCandidates(
  candidates: PracticeImportCandidate[],
): PracticeImportCandidate[] {
  const byFingerprint = new Map<string, PracticeImportCandidate>()
  for (const candidate of candidates) {
    const existing = byFingerprint.get(candidate.item.contentFingerprint)
    if (!existing) {
      byFingerprint.set(candidate.item.contentFingerprint, candidate)
      continue
    }
    const winner = candidate.sourcePriority > existing.sourcePriority ? candidate : existing
    const loser = winner === candidate ? existing : candidate
    byFingerprint.set(candidate.item.contentFingerprint, {
      sourcePriority: winner.sourcePriority,
      item: {
        ...winner.item,
        sourceRefs: unique([...winner.item.sourceRefs, ...loser.item.sourceRefs]),
        tags: unique([...winner.item.tags, ...loser.item.tags]),
        categories: unique([...winner.item.categories, ...loser.item.categories]),
        keyConcepts: unique([...winner.item.keyConcepts, ...loser.item.keyConcepts]),
      },
    })
  }
  return Array.from(byFingerprint.values())
}
