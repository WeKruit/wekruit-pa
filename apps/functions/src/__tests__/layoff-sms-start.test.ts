import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { WEKRUIT_CANDIDATE_SOURCE, WEKRUIT_LAYOFF_SOURCE } from "@pa/pa-orchestrator"
import { isLayoffIntakeActiveDoc, runLayoffSmsStart } from "../layoff-sms-start.js"

type FakeDocState = { exists: boolean; data: Record<string, unknown> }

function mergeFirestoreLike(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    const existing = out[key]
    if (
      existing &&
      typeof existing === "object" &&
      !Array.isArray(existing) &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      out[key] = mergeFirestoreLike(
        existing as Record<string, unknown>,
        value as Record<string, unknown>,
      )
    } else {
      out[key] = value
    }
  }
  return out
}

function makeFakeDb(docs: Map<string, FakeDocState>) {
  const writes: Array<{ path: string; data: Record<string, unknown> }> = []
  function doc(path: string) {
    return {
      async get() {
        const state = docs.get(path) ?? { exists: false, data: {} }
        return {
          exists: state.exists,
          data: () => (state.exists ? state.data : undefined),
        }
      },
      async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
        const state = docs.get(path) ?? { exists: true, data: {} }
        docs.set(path, {
          exists: true,
          data: opts?.merge ? mergeFirestoreLike(state.data, data) : data,
        })
        writes.push({ path, data })
      },
      async create(data: Record<string, unknown>) {
        if (docs.get(path)?.exists) {
          const err = new Error("already exists") as Error & { code?: number }
          err.code = 6
          throw err
        }
        docs.set(path, { exists: true, data })
        writes.push({ path, data })
      },
      async update(data: Record<string, unknown>) {
        const state = docs.get(path) ?? { exists: true, data: {} }
        docs.set(path, {
          exists: true,
          data: { ...state.data, ...data },
        })
        writes.push({ path, data })
      },
    }
  }
  const db = {
    doc,
    collection(coll: string) {
      return {
        doc(id: string) {
          return doc(`${coll}/${id}`)
        },
      }
    },
  }
  return { db: db as never, writes, docs }
}

describe("runLayoffSmsStart", () => {
  it("treats source as provenance, not an active SMS onboarding switch", () => {
    assert.equal(
      isLayoffIntakeActiveDoc({
        source: WEKRUIT_LAYOFF_SOURCE,
        onboardingState: "pending",
      }),
      false,
    )
    assert.equal(
      isLayoffIntakeActiveDoc({
        source: WEKRUIT_LAYOFF_SOURCE,
        onboardingState: "pending",
        workSession: {
          kind: "shared_onboarding",
          status: "active",
        },
      }),
      true,
    )
  })

  it("starts the shared website SMS onboarding flow for laid-off candidates", async () => {
    const docs = new Map<string, FakeDocState>([
      [
        "pa-users/u1",
        {
          exists: true,
          data: {
            displayName: "Ada Lovelace",
            phoneE164: "+13054507715",
            layoffContext: { lastCompany: "Rain", noticeType: "WARN" },
            workSession: {
              kind: "layoff_onboarding",
              status: "ended",
              endedAt: "old-ended-at",
              currentState: "complete",
            },
          },
        },
      ],
    ])
    const { db, writes } = makeFakeDb(docs)
    const runtimeKicks: Array<Record<string, unknown>> = []

    const result = await runLayoffSmsStart({
      db,
      userId: "u1",
      toE164: "+13054507715",
      runRuntimeKickoff: async (input) => {
        runtimeKicks.push(input)
        return { eventId: "layoff_runtime_test", outboundId: "out_runtime_layoff" }
      },
    })

    assert.deepEqual(result, {
      ok: true,
      kickoffOutboundId: "out_runtime_layoff",
      kickoffCreated: true,
      sourceTag: WEKRUIT_LAYOFF_SOURCE,
    })
    assert.equal(runtimeKicks[0].userId, "u1")
    assert.equal(runtimeKicks[0].toE164, "+13054507715")
    assert.equal(runtimeKicks[0].source, WEKRUIT_LAYOFF_SOURCE)
    assert.deepEqual(runtimeKicks[0].promptContext, {
      firstName: "Ada",
      recentCompanies: ["Rain"],
    })
    assert.match(String(runtimeKicks[0].startedAt), /^\d{4}-\d{2}-\d{2}T/)
    assert.equal(writes[0].path, "pa-users/u1")
    assert.equal(writes[0].data.source, WEKRUIT_LAYOFF_SOURCE)
    const user = docs.get("pa-users/u1")!.data
    const layoffContext = user.layoffContext as Record<string, unknown>
    assert.equal(layoffContext.lastCompany, "Rain")
    assert.equal(layoffContext.noticeType, "WARN")
    assert.equal((layoffContext.sms as Record<string, unknown>).phoneE164, "+13054507715")
    assert.deepEqual(user.workSession, {
      kind: "shared_onboarding",
      status: "active",
      startedAt: (user.workSession as Record<string, unknown>).startedAt,
      boundary: "website_sms_onboarding",
      currentQuestionId: "main_goal",
    })
    assert.equal("endedAt" in (user.workSession as Record<string, unknown>), false)
    assert.equal("currentState" in (user.workSession as Record<string, unknown>), false)
    const shared = user.sharedOnboarding as Record<string, unknown>
    assert.equal(shared.currentQuestionId, "main_goal")
    assert.equal(shared.completed, false)
    const phoneIndex = docs.get("layoff_phone_index/p_1juq7qe")?.data
    assert.equal(phoneIndex?.candidateId, "u1")
    assert.equal(phoneIndex?.phoneHash, "p_1juq7qe")
  })

  it("starts the exact same shared website SMS onboarding flow for normal candidates", async () => {
    const docs = new Map<string, FakeDocState>([
      [
        "pa-users/u2",
        {
          exists: true,
          data: {
            displayName: "Grace Hopper",
            phoneE164: "+14243201960",
            candidateContext: { sourcePage: "candidate.wekruit.com" },
          },
        },
      ],
    ])
    const { db } = makeFakeDb(docs)
    const runtimeKicks: Array<Record<string, unknown>> = []

    const result = await runLayoffSmsStart({
      db,
      userId: "u2",
      toE164: "+14243201960",
      source: WEKRUIT_CANDIDATE_SOURCE,
      runRuntimeKickoff: async (input) => {
        runtimeKicks.push(input)
        return { eventId: "candidate_runtime_test", outboundId: "out_runtime_candidate" }
      },
    })

    assert.deepEqual(result, {
      ok: true,
      kickoffOutboundId: "out_runtime_candidate",
      kickoffCreated: true,
      sourceTag: WEKRUIT_CANDIDATE_SOURCE,
    })
    assert.equal(runtimeKicks[0].source, WEKRUIT_CANDIDATE_SOURCE)
    const user = docs.get("pa-users/u2")!.data
    assert.equal(user.source, WEKRUIT_CANDIDATE_SOURCE)
    assert.deepEqual(user.workSession, {
      kind: "shared_onboarding",
      status: "active",
      startedAt: (user.workSession as Record<string, unknown>).startedAt,
      boundary: "website_sms_onboarding",
      currentQuestionId: "main_goal",
    })
    assert.equal((user.sharedOnboarding as Record<string, unknown>).currentQuestionId, "main_goal")
    assert.equal((user.candidateContext as Record<string, unknown>).sourcePage, "candidate.wekruit.com")
    assert.equal(((user.candidateContext as Record<string, unknown>).sms as Record<string, unknown>).phoneE164, "+14243201960")
    assert.equal(docs.has("layoff_phone_index/p_1hgmqn0"), false)
  })

  it("grounds the shared Q1 opener from the user's latest resume artifact pointer", async () => {
    const docs = new Map<string, FakeDocState>([
      [
        "pa-users/u3",
        {
          exists: true,
          data: {
            displayName: "Adam Yang",
            phoneE164: "+14243201960",
            latestResumeArtifactId: "artifact-u3-latest",
            candidateContext: { sourcePage: "candidate.wekruit.com" },
          },
        },
      ],
      [
        "pa-resume-artifacts/artifact-u3-latest",
        {
          exists: true,
          data: {
            candidateId: "u3",
            parsedCandidateResumeId: "parsed-u3-latest",
          },
        },
      ],
      [
        "parsedCandidateResumes/parsed-u3-latest",
        {
          exists: true,
          data: {
            userId: "old-import-id",
            candidateProfile: { name: "Adam Yang", skills: ["TypeScript", "React"] },
            experiences: [
              { company: "Rain", title: "Software Engineer - Fullstack", location: "New York" },
            ],
            industryTags: ["financial_technology"],
          },
        },
      ],
    ])
    const { db } = makeFakeDb(docs)
    const runtimeKicks: Array<Record<string, unknown>> = []

    const result = await runLayoffSmsStart({
      db,
      userId: "u3",
      toE164: "+14243201960",
      source: WEKRUIT_CANDIDATE_SOURCE,
      runRuntimeKickoff: async (input) => {
        runtimeKicks.push(input)
        return { eventId: "candidate_runtime_resume_test", outboundId: "out_runtime_candidate_resume" }
      },
    })

    assert.equal(result.ok, true)
    assert.deepEqual(runtimeKicks[0].promptContext, {
      firstName: "Adam",
      recentCompanies: ["Rain"],
      recentTitles: ["Software Engineer - Fullstack"],
      recentLocations: ["New York"],
      skills: ["TypeScript", "React"],
      industryTags: ["financial_technology"],
    })
    assert.match(JSON.stringify(runtimeKicks[0].promptContext), /Rain/)
    const user = docs.get("pa-users/u3")!.data
    const shared = user.sharedOnboarding as Record<string, unknown>
    assert.deepEqual(shared.promptContext, runtimeKicks[0].promptContext)
  })

  it("grounds the shared Q1 opener from artifact summary when the parsed resume pointer is stale", async () => {
    const docs = new Map<string, FakeDocState>([
      [
        "pa-users/u4",
        {
          exists: true,
          data: {
            displayName: "Adam Yang",
            phoneE164: "+14243201960",
            latestResumeArtifactId: "artifact-u4-stale",
            candidateContext: { sourcePage: "candidate.wekruit.com" },
          },
        },
      ],
      [
        "pa-resume-artifacts/artifact-u4-stale",
        {
          exists: true,
          data: {
            candidateId: "u4",
            parsedCandidateResumeId: "missing-parsed-u4",
            status: "parsed",
            candidateProfileSummary:
              "User resume summary: Adam Yang — currently/last Software Engineer Intern at Tesla Inc. (May 2024-present). Skills: C++, JavaScript, Python.",
          },
        },
      ],
    ])
    const { db } = makeFakeDb(docs)
    const runtimeKicks: Array<Record<string, unknown>> = []

    const result = await runLayoffSmsStart({
      db,
      userId: "u4",
      toE164: "+14243201960",
      source: WEKRUIT_CANDIDATE_SOURCE,
      runRuntimeKickoff: async (input) => {
        runtimeKicks.push(input)
        return { eventId: "candidate_runtime_resume_summary_test", outboundId: "out_runtime_candidate_summary" }
      },
    })

    assert.equal(result.ok, true)
    assert.deepEqual(runtimeKicks[0].promptContext, {
      firstName: "Adam",
      recentCompanies: ["Tesla Inc"],
      recentTitles: ["Software Engineer Intern"],
      skills: ["C++", "JavaScript", "Python"],
      resumeSummary:
        "Adam Yang — currently/last Software Engineer Intern at Tesla Inc. (May 2024-present). Skills: C++, JavaScript, Python.",
    })
    const user = docs.get("pa-users/u4")!.data
    const shared = user.sharedOnboarding as Record<string, unknown>
    assert.deepEqual(shared.promptContext, runtimeKicks[0].promptContext)
  })

  it("does not create a user when no pa-user exists for the phone-resolved id", async () => {
    const { db, writes } = makeFakeDb(new Map())
    const result = await runLayoffSmsStart({
      db,
      userId: "missing",
      toE164: "+13054507715",
      runRuntimeKickoff: async () => {
        throw new Error("must not run runtime kickoff")
      },
    })

    assert.deepEqual(result, { ok: false, reason: "user_not_found" })
    assert.equal(writes.length, 0)
  })

  it("default kickoff enqueues the shared Q1 runtime event instead of replaying trigger text", async () => {
    const docs = new Map<string, FakeDocState>([
      [
        "pa-users/u1",
        {
          exists: true,
          data: {
            displayName: "Ada Lovelace",
            phoneE164: "+13054507715",
          },
        },
      ],
    ])
    const { db } = makeFakeDb(docs)

    const result = await runLayoffSmsStart({
      db,
      userId: "u1",
      toE164: "+13054507715",
    })

    assert.equal(result.ok, true)
    assert.match(result.ok ? result.kickoffOutboundId : "", /^runtime_/)

    const inboundRows = [...docs.entries()].filter(([path]) => path.startsWith("pa-inbound-events/"))
    assert.equal(inboundRows.length, 1)
    const [path, row] = inboundRows[0]
    assert.match(path, /^pa-inbound-events\/runtime_/)
    assert.equal(row.data.userId, "u1")
    assert.notEqual(row.data.body, "WeKruit_LAID_OFF")
    assert.match(String(row.data.body), /^\[system-event:shared_onboarding:onboarding_started\]/)
    assert.match(String(row.data.body), /Beta candidate-visible iMessage output is English-only/)
    assert.match(String(row.data.body), /software engineering, product, design/)
    assert.equal(row.data.status, "pending")
    const rawMeta = row.data.rawMeta as Record<string, unknown>
    assert.equal(rawMeta.source, "runtime_event_handoff")
    assert.equal(rawMeta.runtimeEvent, true)
    assert.equal(rawMeta.runtimeEventSource, "shared_onboarding")
    assert.equal(rawMeta.runtimeEventKind, "onboarding_started")
    assert.equal(rawMeta.preferredLanguage, "en")
    const context = rawMeta.context as Record<string, unknown>
    assert.equal(context.signupSource, WEKRUIT_LAYOFF_SOURCE)
    assert.equal(context.workSessionKind, "shared_onboarding")
    assert.equal(context.questionId, "main_goal")
    assert.match(String(context.questionText), /Hey Ada/i)
    assert.match(String(context.questionText), /software engineering, product, design/)
    assert.match(String(context.startedAt), /^\d{4}-\d{2}-\d{2}T/)
  })
})
