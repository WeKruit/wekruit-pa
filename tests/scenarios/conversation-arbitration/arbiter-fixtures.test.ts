import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"

import {
  decideConversationTurnOwner,
  summarizeConversationTurnTrace,
  type PrescreenEvidence,
  type TurnContext,
} from "../../../packages/pa-orchestrator/src/conversation-turn-arbiter.js"
import {
  buildConversationEvidenceWrites,
  decideConversationDeliveryAction,
} from "../../../packages/pa-orchestrator/src/conversation-action-arbiter.js"

type Fixture = {
  id: string
  initialFirestoreState: Record<string, Record<string, unknown>>
  inbound: {
    userId: string
    text: string
    createdAt?: string
    channel?: string
  }
  recentOutbound?: Array<{ role?: "assistant" | "user" | "system"; body: string; createdAt?: string }>
  toolResults?: TurnContext["toolResults"]
  expected: {
    owner: string
    action?: string
    requiredTools?: string[]
    forbiddenMutations?: string[]
    orderedActionKinds?: string[]
    evidenceWriteKinds?: string[]
    trace?: { selectedOwner?: string }
  }
}

const fixtureDir = new URL(".", import.meta.url)

test("conversation arbitration scenario fixtures match expected owners and traces", async () => {
  const files = (await readdir(fixtureDir))
    .filter((file) => file.endsWith(".json"))
    .sort()
  assert.ok(files.length >= 5, "expected conversation arbitration fixtures")

  for (const file of files) {
    const fixture = JSON.parse(await readFile(join(fixtureDir.pathname, file), "utf8")) as Fixture
    const context = buildContextFromFixture(fixture)
    const decision = decideConversationTurnOwner(context)
    const action = decideConversationDeliveryAction(context, decision)
    const evidenceWrites = buildConversationEvidenceWrites(context, decision, action)
    const trace = summarizeConversationTurnTrace(context, decision, action, evidenceWrites)

    assert.equal(decision.selectedOwner, fixture.expected.owner, fixture.id)
    if (fixture.expected.action) {
      assert.equal(action.selectedAction, fixture.expected.action, fixture.id)
    }
    for (const tool of fixture.expected.requiredTools ?? []) {
      assert.ok(decision.requiredTools.includes(tool as never), `${fixture.id}: missing tool ${tool}`)
    }
    for (const mutation of fixture.expected.forbiddenMutations ?? []) {
      assert.ok(decision.forbiddenMutations.includes(mutation), `${fixture.id}: missing forbidden mutation ${mutation}`)
    }
    if (fixture.expected.orderedActionKinds) {
      assert.deepEqual(decision.orderedActions.map((action) => action.kind), fixture.expected.orderedActionKinds, fixture.id)
    }
    for (const kind of fixture.expected.evidenceWriteKinds ?? []) {
      assert.ok(evidenceWrites.some((write) => write.kind === kind), `${fixture.id}: missing evidence write ${kind}`)
    }
    if (fixture.expected.trace?.selectedOwner) {
      assert.equal(trace.decision.selectedOwner, fixture.expected.trace.selectedOwner, fixture.id)
    }
    if (fixture.expected.action) {
      assert.equal(trace.actionDecision?.selectedAction, fixture.expected.action, fixture.id)
    }
    assert.deepEqual(trace.states, [
      "received",
      "context_loaded",
      "intent_framed",
      "owner_arbitrated",
      "action_planned",
      "tools_executed",
      "memory_committed",
      "outbound_composed",
      "completed",
    ], fixture.id)
  }
})

function buildContextFromFixture(fixture: Fixture): TurnContext {
  const user = fixture.initialFirestoreState[`pa-users/${fixture.inbound.userId}`] ?? {}
  const shared = readObject(user.sharedOnboarding)
  const workSession = readObject(user.workSession)
  const sharedActive = shared?.status === "active" && shared.completed !== true
  const sharedQuestionId = typeof shared?.currentQuestionId === "string"
    ? shared.currentQuestionId
    : typeof workSession?.currentQuestionId === "string"
      ? workSession.currentQuestionId
      : null
  const activeWorkflow = workSession?.kind === "job_prescreen" && workSession.status === "active"
    ? {
        kind: "job_prescreen" as const,
        status: "active",
        currentQuestionId: typeof workSession.currentQuestionId === "string" ? workSession.currentQuestionId : null,
      }
    : null
  const sessionId = typeof workSession?.sessionId === "string" ? workSession.sessionId : null
  const memory = sessionId ? fixture.initialFirestoreState[`pa-prescreen-memory-events/${sessionId}`] : null
  const prescreenEvidence: PrescreenEvidence | null = sessionId && memory
    ? {
        sessionId,
        ...(typeof memory.jobId === "string" ? { jobId: memory.jobId } : {}),
        ...(typeof memory.terminal === "string" ? { terminal: memory.terminal } : {}),
        ...(typeof memory.summary === "string" ? { summary: memory.summary } : {}),
        ...(Array.isArray(memory.evidenceTags) ? { evidenceTags: memory.evidenceTags.filter((tag): tag is string => typeof tag === "string") } : {}),
      }
    : null

  return {
    turnId: fixture.id,
    userId: fixture.inbound.userId,
    inbound: {
      text: fixture.inbound.text,
      createdAt: fixture.inbound.createdAt,
      channel: fixture.inbound.channel,
    },
    activeWorkflow,
    prescreenEvidence,
    sharedOnboarding: {
      active: sharedActive,
      currentQuestionId: sharedQuestionId,
    },
    recentMessages: [],
    recentOutbound: fixture.recentOutbound ?? [],
    preferenceState: readObject(user.statedPreferences),
    toolResults: fixture.toolResults,
  }
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}
