#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { join, resolve } from "node:path"

const FAILURE_TAXONOMY = [
  "wrong_owner",
  "missed_meta_question",
  "bad_memory_order",
  "tool_not_called",
  "bad_transcript_role",
  "forbidden_mutation",
  "weak_outbound",
]

const args = parseArgs(process.argv.slice(2))
const fixtureDir = resolve(args.fixtures ?? "tests/scenarios/conversation-arbitration")
const reportPath = resolve(args.report ?? ".tmp/conversation-arbiter-auto-pr/report.json")
const {
  buildConversationEvidenceWrites,
  decideConversationDeliveryAction,
  decideConversationTurnOwner,
} = await loadArbiter()

const report = await auditFixtures(fixtureDir)
mkdirSync(resolve(reportPath, ".."), { recursive: true })
writeFileSync(reportPath, JSON.stringify(report, null, 2))
console.log(JSON.stringify({
  reportPath,
  failures: report.failures.length,
  clusters: report.clusters,
  dryRun: args.dryRun,
}, null, 2))

if (args.createPr) {
  createAutoPr(report)
}

async function auditFixtures(dir) {
  const failures = []
  const files = (await readdir(dir)).filter((file) => file.endsWith(".json")).sort()
  for (const file of files) {
    const fixture = JSON.parse(await readFile(join(dir, file), "utf8"))
    const context = buildContextFromFixture(fixture)
    const decision = decideConversationTurnOwner(context)
    const action = decideConversationDeliveryAction(context, decision)
    const evidenceWrites = buildConversationEvidenceWrites(context, decision, action)
    if (decision.selectedOwner !== fixture.expected.owner) {
      failures.push({
        fixtureId: fixture.id,
        taxonomy: classifyWrongOwner(fixture, decision),
        expectedOwner: fixture.expected.owner,
        actualOwner: decision.selectedOwner,
        suggestedPatch: "Add or adjust a conversation-turn-arbiter fixture first, then update owner detection with the smallest rule change.",
      })
    }
    if (fixture.expected.action && action.selectedAction !== fixture.expected.action) {
      failures.push({
        fixtureId: fixture.id,
        taxonomy: "weak_outbound",
        expectedAction: fixture.expected.action,
        actualAction: action.selectedAction,
        suggestedPatch: "Adjust conversation-action-arbiter with a fixture-first rule for this delivery behavior.",
      })
    }
    for (const tool of fixture.expected.requiredTools ?? []) {
      if (!decision.requiredTools.includes(tool)) {
        failures.push({
          fixtureId: fixture.id,
          taxonomy: "tool_not_called",
          expectedTool: tool,
          actualTools: decision.requiredTools,
          suggestedPatch: "Add the missing required tool to the owner action contract for this intent.",
        })
      }
    }
    for (const mutation of fixture.expected.forbiddenMutations ?? []) {
      if (!decision.forbiddenMutations.includes(mutation)) {
        failures.push({
          fixtureId: fixture.id,
          taxonomy: "forbidden_mutation",
          expectedForbiddenMutation: mutation,
          actualForbiddenMutations: decision.forbiddenMutations,
          suggestedPatch: "Reject the active workflow owner when the inbound is a meta-question or non-answer.",
        })
      }
    }
    const expectedOrder = fixture.expected.orderedActionKinds
    if (expectedOrder && JSON.stringify(decision.orderedActions.map((action) => action.kind)) !== JSON.stringify(expectedOrder)) {
      failures.push({
        fixtureId: fixture.id,
        taxonomy: "bad_memory_order",
        expectedOrder,
        actualOrder: decision.orderedActions.map((action) => action.kind),
        suggestedPatch: "Preserve explicit answer first, then memory commit, then matching/tool execution.",
      })
    }
    for (const kind of fixture.expected.evidenceWriteKinds ?? []) {
      if (!evidenceWrites.some((write) => write.kind === kind)) {
        failures.push({
          fixtureId: fixture.id,
          taxonomy: "bad_memory_order",
          expectedEvidenceWriteKind: kind,
          actualEvidenceWriteKinds: evidenceWrites.map((write) => write.kind),
          suggestedPatch: "Emit a structured evidence write before composing the final reply.",
        })
      }
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    failureTaxonomy: FAILURE_TAXONOMY,
    fixtureDir: dir,
    failures,
    clusters: failures.reduce((acc, failure) => {
      acc[failure.taxonomy] = (acc[failure.taxonomy] ?? 0) + 1
      return acc
    }, {}),
  }
}

function createAutoPr(report) {
  if (report.failures.length === 0) {
    console.log("No failures; no branch or PR created.")
    return
  }
  const status = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()
  if (status) {
    throw new Error("Refusing --create-pr with a dirty worktree. Commit or stash local changes first.")
  }
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 12)
  const branch = `codex/conversation-arbiter-autopr-${stamp}`
  execFileSync("git", ["switch", "-c", branch], { stdio: "inherit" })
  execFileSync("zsh", ["-lc", "source ~/.zshrc && nvm use 24 >/dev/null && node --import tsx --test tests/scenarios/conversation-arbitration/arbiter-fixtures.test.ts packages/pa-orchestrator/src/conversation-turn-arbiter.test.ts packages/pa-orchestrator/src/conversation-action-arbiter.test.ts"], { stdio: "inherit" })
  execFileSync("git", ["add", reportPath, "tests/scenarios/conversation-arbitration"], { stdio: "inherit" })
  execFileSync("git", ["commit", "-m", "Add conversation arbiter auto-pr failure report"], { stdio: "inherit" })
  execFileSync("gh", [
    "pr",
    "create",
    "--draft",
    "--title",
    "Conversation arbiter self-improvement candidates",
    "--body",
    `Failure clusters:\n\n${JSON.stringify(report.clusters, null, 2)}\n\nThis PR is generated by scripts/conversation-arbiter-auto-pr.mjs and is never merged or deployed automatically.`,
  ], { stdio: "inherit" })
}

function classifyWrongOwner(fixture, decision) {
  const text = String(fixture.inbound?.text ?? "").toLowerCase()
  if (decision.selectedOwner === "shared_onboarding" && decision.forbiddenMutations.length > 0) return "forbidden_mutation"
  if (/\b(why|how|help me understand|explain)\b/.test(text)) return "missed_meta_question"
  return "wrong_owner"
}

function buildContextFromFixture(fixture) {
  const user = fixture.initialFirestoreState[`pa-users/${fixture.inbound.userId}`] ?? {}
  const workSession = readObject(user.workSession)
  const shared = readObject(user.sharedOnboarding)
  const sessionId = typeof workSession?.sessionId === "string" ? workSession.sessionId : null
  const memory = sessionId ? fixture.initialFirestoreState[`pa-prescreen-memory-events/${sessionId}`] : null
  const sharedActive = shared?.status === "active" && shared.completed !== true
  const sharedQuestionId = typeof shared?.currentQuestionId === "string"
    ? shared.currentQuestionId
    : typeof workSession?.currentQuestionId === "string"
      ? workSession.currentQuestionId
      : null
  return {
    turnId: fixture.id,
    userId: fixture.inbound.userId,
    inbound: {
      text: fixture.inbound.text,
      createdAt: fixture.inbound.createdAt,
      channel: fixture.inbound.channel,
    },
    activeWorkflow: workSession?.kind === "job_prescreen" && workSession.status === "active"
      ? { kind: "job_prescreen", status: "active", currentQuestionId: workSession.currentQuestionId ?? null }
      : null,
    recentMessages: [],
    recentOutbound: Array.isArray(fixture.recentOutbound) ? fixture.recentOutbound : [],
    prescreenEvidence: sessionId && memory
      ? {
          sessionId,
          ...(typeof memory.jobId === "string" ? { jobId: memory.jobId } : {}),
          ...(typeof memory.terminal === "string" ? { terminal: memory.terminal } : {}),
          ...(typeof memory.summary === "string" ? { summary: memory.summary } : {}),
          ...(Array.isArray(memory.evidenceTags) ? { evidenceTags: memory.evidenceTags.filter((tag) => typeof tag === "string") } : {}),
        }
      : null,
    sharedOnboarding: {
      active: Boolean(sharedActive),
      currentQuestionId: sharedQuestionId,
    },
    preferenceState: readObject(user.statedPreferences),
    toolResults: Array.isArray(fixture.toolResults) ? fixture.toolResults : undefined,
  }
}

async function loadArbiter() {
  try {
    const turn = await import("../packages/pa-orchestrator/dist/conversation-turn-arbiter.js")
    const action = await import("../packages/pa-orchestrator/dist/conversation-action-arbiter.js")
    return { ...turn, ...action }
  } catch (err) {
    throw new Error(
      `Cannot load built arbiter. Run "npm run build --workspace=@pa/pa-orchestrator" first. ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

function parseArgs(argv) {
  const out = { dryRun: true, createPr: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "--fixtures") out.fixtures = argv[++i]
    else if (arg === "--report") out.report = argv[++i]
    else if (arg === "--dry-run") out.dryRun = true
    else if (arg === "--create-pr") {
      out.createPr = true
      out.dryRun = false
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return out
}

function readObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null
}
