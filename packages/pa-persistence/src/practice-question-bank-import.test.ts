import assert from "node:assert/strict"
import test from "node:test"
import {
  dedupeImportCandidates,
  mapAlgoliaQuestion,
  mapDataCaseProblem,
  mapObjectDesignProblem,
  mapResearchSeedQuestion,
  mapSystemDesignProblem,
} from "./practice-question-bank-import.js"

const NOW = "2026-05-19T12:00:00.000Z"

test("practice import maps system design problem and solution", () => {
  const candidate = mapSystemDesignProblem(
    {
      docId: "SD_Q_001",
      data: {
        title: "Design a CDN Network",
        description: "Design a globally distributed CDN",
        difficulty: "Hard",
        estimatedTime: "60-90 minutes",
        categories: ["web_systems"],
        tags: ["CDN", "Edge caching"],
        requirements: ["Serve global traffic"],
      },
    },
    {
      docId: "SD_S_001",
      data: {
        questionPrimaryKey: "SD_Q_001",
        architecture: "Use regional edge caches and origin shielding.",
      },
    },
    NOW,
  )
  assert.equal(candidate.item.kind, "system_design")
  assert.equal(candidate.item.conversationMode, "system_design_discussion")
  assert.equal(candidate.item.status, "active")
  assert.equal(candidate.item.difficulty, "hard")
  assert.equal(candidate.item.estimatedMinutes, 60)
  assert.deepEqual(candidate.item.sourceRefs, [
    "firestore:systemDesignProblems/SD_Q_001",
    "firestore:systemDesignSolutions/SD_S_001",
  ])
  assert.match(candidate.item.evaluation.solutionSummary ?? "", /regional edge caches/)
})

test("practice import maps object oriented design problem and solution", () => {
  const candidate = mapObjectDesignProblem(
    {
      docId: "OOD_Q_001",
      data: {
        title: "Design Chess",
        description: "Design a chess game",
        difficulty: "Advanced",
        keyConcepts: ["Move validation"],
        tags: ["Chess"],
        requirements: ["Validate legal moves"],
      },
    },
    {
      docId: "OOD_S_001",
      data: {
        classDesign: "Board, Piece, Move, Game classes.",
      },
    },
    NOW,
  )
  assert.equal(candidate.item.kind, "object_oriented_design")
  assert.equal(candidate.item.conversationMode, "object_design_discussion")
  assert.equal(candidate.item.difficulty, "hard")
  assert.deepEqual(candidate.item.keyConcepts, ["Move validation"])
  assert.match(candidate.item.context ?? "", /Validate legal moves/)
})

test("practice import maps data case problem", () => {
  const candidate = mapDataCaseProblem(
    {
      docId: "DC_001",
      data: {
        title: "Conversion Funnel Analysis",
        main_question: "Conversion dropped by 15%. How would you investigate?",
        problem_statement: "The checkout funnel changed last week.",
        estimated_duration_minutes: 45,
        category: "product_analytics",
        learning_objectives: ["Funnel segmentation"],
        assessment_criteria: [
          {
            dimension: "Problem framing",
            weight: 2,
            excellent_indicators: ["Clarifies denominator and time window"],
          },
        ],
        follow_up_questions: [{ question: "What segments would you inspect first?" }],
        common_mistakes: ["Only looking at aggregate conversion"],
      },
    },
    NOW,
  )
  assert.equal(candidate.item.kind, "data_case")
  assert.equal(candidate.item.conversationMode, "data_case_discussion")
  assert.equal(candidate.item.estimatedMinutes, 45)
  assert.equal(candidate.item.evaluation.rubric[0]?.criterion, "Problem framing")
  assert.deepEqual(candidate.item.evaluation.followUps, ["What segments would you inspect first?"])
  assert.deepEqual(candidate.item.evaluation.redFlags, ["Only looking at aggregate conversion"])
})

test("practice import maps behavioral Algolia as active", () => {
  const candidate = mapAlgoliaQuestion(
    {
      objectID: "b1",
      question: "Tell me about a time you handled conflict.",
      answer: "Use STAR and show ownership.",
      category: "Behavioral",
      difficulty: "Basic",
      company: "Generic",
      behavioral_tags: ["conflict"],
    },
    "wekruit-interview-question-bank-behavior-question",
    NOW,
  )
  assert.equal(candidate.item.kind, "behavioral")
  assert.equal(candidate.item.status, "active")
  assert.equal(candidate.item.conversationMode, "behavioral_screen")
  assert.deepEqual(candidate.item.tags, ["conflict"])
})

test("practice import archives non-behavioral main Algolia records", () => {
  const candidate = mapAlgoliaQuestion(
    {
      objectID: "t1",
      question: "Explain how leverage could reduce IRR.",
      answer: "Debt service can reduce cash flows.",
      category: "Technical",
      technical_tags: ["finance"],
    },
    "wekruit-interview-question-bank",
    NOW,
  )
  assert.equal(candidate.item.status, "archived")
  assert.equal(candidate.item.conversationMode, "resume_deep_dive")
  assert.deepEqual(candidate.item.sourceRefs, ["algolia:wekruit-interview-question-bank/t1"])
})

test("practice import dedupe prefers behavioral Algolia over main index", () => {
  const main = mapAlgoliaQuestion(
    {
      objectID: "main1",
      question: "Tell me about a relevant internship or project.",
      answer: "Main index answer.",
      category: "Behavioral",
    },
    "wekruit-interview-question-bank",
    NOW,
  )
  const behavior = mapAlgoliaQuestion(
    {
      objectID: "behavior1",
      question: "Tell me about a relevant internship or project.",
      answer: "Behavior index answer.",
      category: "Behavioral",
      tags: ["project"],
    },
    "wekruit-interview-question-bank-behavior-question",
    NOW,
  )
  const deduped = dedupeImportCandidates([main, behavior])
  assert.equal(deduped.length, 1)
  assert.equal(deduped[0]?.item.evaluation.solutionSummary, "Behavior index answer.")
  assert.deepEqual(deduped[0]?.item.sourceRefs.sort(), [
    "algolia:wekruit-interview-question-bank-behavior-question/behavior1",
    "algolia:wekruit-interview-question-bank/main1",
  ])
  assert.deepEqual(deduped[0]?.item.tags, ["project"])
})

test("practice import maps web research seed for Claire practice", () => {
  const candidate = mapResearchSeedQuestion(
    {
      slug: "openai-eval-regression-debug",
      sourceKey: "openai-interview-guide",
      sourceTitle: "OpenAI interview guide",
      sourceUrl: "https://openai.com/interview-guide/",
      kind: "behavioral",
      conversationMode: "behavioral_screen",
      title: "Debugging an evaluation regression under ambiguity",
      prompt:
        "Tell me about a time a metric or evaluation result moved in the wrong direction and the root cause was unclear. How did you investigate, communicate uncertainty, and decide what to ship?",
      difficulty: "medium",
      estimatedMinutes: 12,
      companyStyle: ["OpenAI", "Anthropic"],
      roleFamilies: ["software_engineering", "machine_learning", "data_science"],
      categories: ["behavioral", "ai_evaluation"],
      tags: ["practice", "prescreen", "eval", "ambiguity", "communication"],
      keyConcepts: ["evaluation debugging", "uncertainty", "stakeholder communication"],
      evaluation: {
        rubric: [
          {
            criterion: "Investigation quality",
            guidance: "Explains the hypotheses, evidence checked, and decision criteria.",
          },
        ],
        followUps: ["What signal would make you rollback immediately?"],
        expectedSignals: ["Uses evidence before conclusions"],
        redFlags: ["Claims certainty without validation"],
      },
    },
    NOW,
  )

  assert.equal(candidate.item.status, "active")
  assert.equal(candidate.item.kind, "behavioral")
  assert.equal(candidate.item.conversationMode, "behavioral_screen")
  assert.equal(candidate.item.difficulty, "medium")
  assert.equal(candidate.item.estimatedMinutes, 12)
  assert.deepEqual(candidate.item.companyStyle, ["OpenAI", "Anthropic"])
  assert.ok(candidate.item.tags.includes("prescreen"))
  assert.ok(candidate.item.tags.includes("eval"))
  assert.ok(candidate.item.tags.includes("practice"))
  assert.deepEqual(candidate.item.sourceRefs, [
    "web-research:openai-interview-guide/openai-eval-regression-debug",
    "web-research-url:https://openai.com/interview-guide/",
  ])
  assert.match(candidate.item.context ?? "", /OpenAI interview guide/)
  assert.equal(candidate.sourcePriority, 25)
})
