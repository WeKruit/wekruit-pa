import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  evaluateCandidateLifecycleTrigger,
  runCandidateLifecycleTrigger,
  type CandidateLifecycleSnapshot,
  type CandidateLifecycleTriggerDeps,
  type CandidateLifecycleTriggerInput,
} from "../candidate-lifecycle-trigger.js"

const NOW = "2026-05-16T12:00:00.000Z"

function request(overrides: Partial<CandidateLifecycleTriggerInput> = {}): CandidateLifecycleTriggerInput {
  return {
    candidateId: "cand-1",
    eventType: "laid_off_checkin",
    eventReason: "fresh WeKruit_LAID_OFF signal from the candidate",
    dryRun: true,
    ...overrides,
  }
}

function candidate(overrides: Partial<CandidateLifecycleSnapshot> = {}): CandidateLifecycleSnapshot {
  return {
    candidateId: "cand-1",
    displayName: "Adam Yang",
    source: "WeKruit_Laid_Off",
    phoneE164: "+13054507715",
    candidateLifecycleState: "active_job_seeker",
    layoffContext: { lastCompany: "Rain" },
    ...overrides,
  }
}

function makeDeps(c: CandidateLifecycleSnapshot, opts: { activePrescreen?: boolean } = {}) {
  const events = new Map<string, Record<string, unknown>>()
  const outbound: Array<Record<string, unknown>> = []
  const candidateUpdates: Array<Record<string, unknown>> = []
  const deps: CandidateLifecycleTriggerDeps = {
    readCandidate: async () => c,
    hasActivePrescreenSession: async () => Boolean(opts.activePrescreen),
    writeLifecycleEvent: async (eventId, row) => {
      events.set(eventId, row)
    },
    updateLifecycleEvent: async (eventId, patch) => {
      events.set(eventId, { ...(events.get(eventId) ?? {}), ...patch })
    },
    enqueueRuntimeEvent: async (input) => {
      outbound.push(input)
      return { id: "out-life-1", created: true }
    },
    updateCandidate: async (_candidateId, patch) => {
      candidateUpdates.push(patch)
    },
    now: () => NOW,
  }
  return { deps, events, outbound, candidateUpdates }
}

describe("evaluateCandidateLifecycleTrigger", () => {
  it("allows a laid-off check-in only when it has candidate value and no suppression", () => {
    const decision = evaluateCandidateLifecycleTrigger({
      request: request(),
      candidate: candidate(),
      now: NOW,
    })
    assert.equal(decision.decision, "send")
    if (decision.decision === "send") {
      assert.equal(decision.runtimeContext.eventType, "laid_off_checkin")
      assert.equal(decision.runtimeContext.eventReason, "fresh WeKruit_LAID_OFF signal from the candidate")
      assert.equal((decision.runtimeContext.candidate as Record<string, unknown>)?.displayName, "Adam Yang")
      assert.equal(decision.cooldownKey, "laid_off_checkin")
    }
  })

  it("blocks lifecycle messages during active work sessions", () => {
    const decision = evaluateCandidateLifecycleTrigger({
      request: request({ eventType: "status_followup", eventReason: "status has not been updated recently" }),
      candidate: candidate({ workSession: { kind: "job_prescreen", status: "active" } }),
      now: NOW,
    })
    assert.equal(decision.decision, "do_not_send")
    assert.ok(decision.blockedSignals.includes("active_session"))
  })

  it("blocks repeated lifecycle messages while candidate cooldown is active", () => {
    const decision = evaluateCandidateLifecycleTrigger({
      request: request({ eventType: "profile_freshness_nudge", eventReason: "profile facts are old" }),
      candidate: candidate({ outreach: { lastOutboundAt: "2026-05-15T12:00:00.000Z" } }),
      now: NOW,
    })
    assert.equal(decision.decision, "do_not_send")
    assert.ok(decision.blockedSignals.includes("cooldown_active"))
  })

  it("requires job context for match notifications and passes structured job facts to runtime", () => {
    const missing = evaluateCandidateLifecycleTrigger({
      request: request({ eventType: "match_notification", eventReason: "new matching job landed" }),
      candidate: candidate({ source: "candidate" }),
      now: NOW,
    })
    assert.equal(missing.decision, "do_not_send")
    assert.ok(missing.blockedSignals.includes("missing_job_context"))

    const missingDetails = evaluateCandidateLifecycleTrigger({
      request: request({
        eventType: "match_notification",
        eventReason: "new matching job landed",
        job: {
          jobId: "rain-fullstack-1",
          jobTitle: "Software Engineer - Fullstack",
          companyName: "Rain",
        } as CandidateLifecycleTriggerInput["job"],
      }),
      candidate: candidate({ source: "candidate" }),
      now: NOW,
    })
    assert.equal(missingDetails.decision, "do_not_send")
    assert.ok(missingDetails.blockedSignals.includes("missing_job_link_or_requirements"))

    const ready = evaluateCandidateLifecycleTrigger({
      request: request({
        eventType: "match_notification",
        eventReason: "new high-fit collaborated role landed",
        job: {
          jobId: "rain-fullstack-1",
          jobTitle: "Software Engineer - Fullstack",
          companyName: "Rain",
          jobUrl: "https://wekruit.com/j/rain-fullstack-1",
          requirements: ["React", "Node.js", "SQL"],
          matchReason: "Your dashboard and SQL ownership are relevant here.",
          matchId: "match-1",
        },
      }),
      candidate: candidate({ source: "candidate" }),
      now: NOW,
    })
    assert.equal(ready.decision, "send")
    if (ready.decision === "send") {
      assert.equal((ready.runtimeContext.job as Record<string, unknown>)?.jobTitle, "Software Engineer - Fullstack")
      assert.equal((ready.runtimeContext.job as Record<string, unknown>)?.companyName, "Rain")
      assert.equal(
        (ready.runtimeContext.job as Record<string, unknown>)?.jobUrl,
        "https://wekruit.com/j/rain-fullstack-1",
      )
      assert.deepEqual(
        (ready.runtimeContext.job as Record<string, unknown>)?.requirements,
        ["React", "Node.js", "SQL"],
      )
      assert.equal(
        (ready.runtimeContext.job as Record<string, unknown>)?.matchReason,
        "Your dashboard and SQL ownership are relevant here.",
      )
      assert.equal(ready.cooldownKey, "match_notification:rain-fullstack-1")
    }
  })
})

describe("runCandidateLifecycleTrigger", () => {
  it("persists a dry-run send decision without enqueueing outbound", async () => {
    const { deps, events, outbound, candidateUpdates } = makeDeps(candidate())
    const result = await runCandidateLifecycleTrigger(request(), deps, "admin-test")
    assert.equal(result.decision.decision, "send")
    assert.equal(result.dryRun, true)
    assert.equal(outbound.length, 0)
    assert.equal(candidateUpdates.length, 0)
    const row = events.get(result.eventId)
    assert.equal(row?.status, "dry_run_send")
    assert.equal(row?.decision, "send")
    assert.equal(row?.actor, "admin-test")
  })

  it("queues a live match notification and records cooldown state on the candidate", async () => {
    const { deps, events, outbound, candidateUpdates } = makeDeps(candidate({ source: "candidate" }))
    const result = await runCandidateLifecycleTrigger(request({
      eventType: "match_notification",
      eventReason: "new high-fit role became available",
      dryRun: false,
      job: {
        jobId: "rain-fullstack-1",
        jobTitle: "Software Engineer - Fullstack",
        companyName: "Rain",
        jobUrl: "https://wekruit.com/j/rain-fullstack-1",
        requirements: ["React", "Node.js", "SQL"],
        matchReason: "It matches your dashboard and SQL work.",
      },
    }), deps)

    assert.equal(result.decision.decision, "send")
    assert.equal(result.outboundId, "out-life-1")
    assert.equal(outbound.length, 1)
    assert.equal(
      outbound[0]?.idempotencyKey,
      "candidate_lifecycle:cand-1:match_notification:rain-fullstack-1:2026-05-16",
    )
    assert.equal((outbound[0]?.context as Record<string, unknown>)?.eventType, "match_notification")
    assert.equal(
      ((outbound[0]?.context as Record<string, unknown>)?.job as Record<string, unknown>)?.jobUrl,
      "https://wekruit.com/j/rain-fullstack-1",
    )
    assert.deepEqual(
      ((outbound[0]?.context as Record<string, unknown>)?.job as Record<string, unknown>)?.requirements,
      ["React", "Node.js", "SQL"],
    )
    assert.equal("body" in outbound[0]!, false)
    const row = events.get(result.eventId)
    assert.equal(row?.status, "queued")
    assert.equal(row?.outboundId, "out-life-1")
    assert.equal("body" in row!, false)
    assert.equal((row?.runtimeContext as Record<string, unknown>)?.eventType, "match_notification")
    assert.equal(candidateUpdates.length, 1)
    assert.deepEqual(
      (candidateUpdates[0]?.lifecycle as Record<string, unknown>)?.lastTouchType,
      "match_notification",
    )
  })

  it("persists no-send decisions and never enqueues when an active prescreen owns the user", async () => {
    const { deps, events, outbound } = makeDeps(candidate(), { activePrescreen: true })
    const result = await runCandidateLifecycleTrigger(request({
      eventType: "status_followup",
      eventReason: "status has not been updated recently",
    }), deps)

    assert.equal(result.decision.decision, "do_not_send")
    assert.ok(result.decision.blockedSignals.includes("active_session"))
    assert.equal(outbound.length, 0)
    const row = events.get(result.eventId)
    assert.equal(row?.status, "suppressed")
    assert.equal(row?.decision, "do_not_send")
  })
})
