import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import test from "node:test"
import type { evaluateOutreachPolicy as evaluateOutreachPolicyType } from "../../../apps/functions/src/outreach/policy.js"
import type {
  planJobOutreach as planJobOutreachType,
  PlanJobOutreachDeps,
} from "../../../apps/functions/src/outreach/service.js"
import { candidate, capacity, defaultCandidateId, defaultJobId, job, match, now, s6Fixtures } from "./fixtures.js"

const repoRoot = new URL("../../../", import.meta.url)
const coreTypesUrl = new URL("packages/core-types/dist/marketplace.js", repoRoot).href
const requireFromFunctions = createRequire(new URL("apps/functions/package.json", repoRoot))
const { transform } = await import(requireFromFunctions.resolve("esbuild"))

type OutreachModules = {
  evaluateOutreachPolicy: typeof evaluateOutreachPolicyType
  planJobOutreach: typeof planJobOutreachType
}

let modulesPromise: Promise<OutreachModules> | undefined

async function loadTsModule(sourcePath: string, replacements: Record<string, string> = {}): Promise<unknown> {
  let source = await readFile(new URL(sourcePath, repoRoot), "utf8")
  for (const [from, to] of Object.entries(replacements)) {
    source = source.replaceAll(from, to)
  }
  const transformed = await transform(source, {
    loader: "ts",
    format: "esm",
    target: "es2022",
    sourcemap: "inline",
  })
  return import(`data:text/javascript;base64,${Buffer.from(transformed.code).toString("base64")}`)
}

async function loadOutreachModules(): Promise<OutreachModules> {
  modulesPromise ??= (async () => {
    const typesShimUrl = `data:text/javascript;base64,${Buffer.from(
      "export const S6_OUTREACH_POLICY_VERSION = 's6-outreach-policy-v1';"
    ).toString("base64")}`
    const policyModule = await loadTsModule("apps/functions/src/outreach/policy.ts", {
      "\"@pa/core-types\"": `"${coreTypesUrl}"`,
      "\"./types.js\"": `"${typesShimUrl}"`,
    }) as { evaluateOutreachPolicy: typeof evaluateOutreachPolicyType }
    ;(globalThis as typeof globalThis & {
      __s6EvaluateOutreachPolicy: typeof evaluateOutreachPolicyType
    }).__s6EvaluateOutreachPolicy = policyModule.evaluateOutreachPolicy
    const policyShimUrl = `data:text/javascript;base64,${Buffer.from(
      "export const evaluateOutreachPolicy = globalThis.__s6EvaluateOutreachPolicy;"
    ).toString("base64")}`
    const serviceModule = await loadTsModule("apps/functions/src/outreach/service.ts", {
      "\"@pa/core-types\"": `"${coreTypesUrl}"`,
      "\"./policy.js\"": `"${policyShimUrl}"`,
      "\"./types.js\"": `"${typesShimUrl}"`,
    }) as { planJobOutreach: typeof planJobOutreachType }
    return {
      evaluateOutreachPolicy: policyModule.evaluateOutreachPolicy,
      planJobOutreach: serviceModule.planJobOutreach,
    }
  })()
  return modulesPromise
}

for (const fixture of s6Fixtures()) {
  test(`S6 policy matrix: ${fixture.name}`, async () => {
    const { planJobOutreach } = await loadOutreachModules()
    const result = await planJobOutreach(fixture.input, {
      writeInviteDecision: async (outboundInvite) => ({
        invite: outboundInvite,
        created: true,
        idempotent: false,
        auditEventId: `audit-${fixture.name}`,
      }),
      enqueueRuntimeInvite: async () => {
        throw new Error(`${fixture.name} must not enqueue in matrix guard`)
      },
    })

    assert.equal(result.rows.length, 1)
    const decision = result.rows[0]!.decision
    assert.equal(decision.policyDecision, fixture.expectedDecision)
    assert.equal(decision.queueEligible, fixture.expectQueueEligible)
    assert.equal(decision.allowQueue, fixture.expectAllowQueue)
    for (const signal of fixture.expectedSignals) {
      assert.ok(decision.blockedSignals.includes(signal), `missing blocked signal ${signal}`)
    }
    assert.equal(result.summary.queued, 0, `${fixture.name} must not enqueue through the service`)
  })
}

test("S6 dry-run high match is eligible evidence but never queueable", async () => {
  const { planJobOutreach } = await loadOutreachModules()
  const enqueued: unknown[] = []
  const result = await planJobOutreach(
    {
      job: job(),
      matches: [match()],
      candidatesById: { [defaultCandidateId]: candidate() },
      capacityByCandidateId: { [defaultCandidateId]: capacity() },
      now,
      dryRun: true,
      approvalMode: "approved",
      persistDecisions: true,
    },
    {
      writeInviteDecision: async (outboundInvite) => ({
        invite: outboundInvite,
        created: true,
        idempotent: false,
        auditEventId: "audit-dry-run",
      }),
      enqueueRuntimeInvite: async (input) => {
        enqueued.push(input)
        return { id: "runtime-should-not-exist", created: true }
      },
    }
  )

  assert.equal(result.rows[0]!.decision.policyDecision, "auto_outbound")
  assert.equal(result.rows[0]!.decision.queueEligible, true)
  assert.equal(result.rows[0]!.decision.allowQueue, false)
  assert.equal(result.summary.dryRun, 1)
  assert.equal(result.summary.queued, 0)
  assert.equal(enqueued.length, 0)
})

test("S6 live-approved high match hands candidate copy to runtime exactly once", async () => {
  const { planJobOutreach } = await loadOutreachModules()
  const enqueued: unknown[] = []
  const deps: PlanJobOutreachDeps = {
    reserveCapacity: async (input) => {
      assert.equal(input.reservationKey.length > 0, true)
      return {
        ok: true,
        groupId: input.groupId,
        fromNumber: input.fromNumber ?? "+15555550100",
        reason: "selected",
        capacitySnapshot: {
          groupId: input.groupId,
          ...(input.fromNumber ? { fromNumber: input.fromNumber } : {}),
          status: input.status,
          dailyCap: input.dailyCap,
          usedToday: 2,
          remainingToday: input.dailyCap - 2,
          checkedAt: input.checkedAt,
        },
      }
    },
    writeInviteDecision: async (outboundInvite) => ({
      invite: outboundInvite,
      created: true,
      idempotent: false,
      auditEventId: "audit-live",
    }),
    enqueueRuntimeInvite: async (input) => {
      enqueued.push(input)
      assert.equal(input.userId, defaultCandidateId)
      assert.equal(input.toE164, "+15555550123")
      assert.equal(input.imessageChatId, `chat-${defaultCandidateId}`)
      assert.match(input.proposedMessage, /Product Designer/)
      assert.match(input.proposedMessage, new RegExp(`https://candidate\\.wekruit\\.com/j/${defaultJobId}`))
      assert.equal(input.context.jobUrl, `https://candidate.wekruit.com/j/${defaultJobId}`)
      return { id: "runtime-live-1", created: true }
    },
  }

  const result = await planJobOutreach(
    {
      job: job(),
      matches: [match()],
      candidatesById: { [defaultCandidateId]: candidate() },
      capacityByCandidateId: { [defaultCandidateId]: capacity() },
      now,
      dryRun: false,
      approvalMode: "approved",
      persistDecisions: true,
    },
    deps
  )

  assert.equal(result.rows[0]!.decision.allowQueue, true)
  assert.equal(result.summary.queued, 1)
  assert.equal(enqueued.length, 1)
  assert.equal(result.rows[0]!.queuedRuntimeEventId, "runtime-live-1")
})

test("S6 policy direct import keeps approval boundary explicit", async () => {
  const { evaluateOutreachPolicy } = await loadOutreachModules()
  const dryRunDecision = evaluateOutreachPolicy({
    match: match(),
    candidate: candidate(),
    job: job(),
    capacity: capacity(),
    now,
    dryRun: true,
    approvalMode: "approved",
  })
  const approvedDecision = evaluateOutreachPolicy({
    match: match(),
    candidate: candidate(),
    job: job(),
    capacity: capacity(),
    now,
    dryRun: false,
    approvalMode: "approved",
  })

  assert.equal(dryRunDecision.queueEligible, true)
  assert.equal(dryRunDecision.allowQueue, false)
  assert.equal(approvedDecision.allowQueue, true)
})
