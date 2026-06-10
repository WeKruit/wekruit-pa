import test from "node:test"
import assert from "node:assert/strict"
import { connectorRegistry } from "./index.js"
import { resolveToolFamily } from "./tool-family.js"
import { VALET_APPLY_CONNECTOR, VALET_APPLY_STATUS_CONNECTOR } from "./valet-connectors.js"
import type { ConnectorContext } from "./connector-types.js"

const fakeCtx = {
  db: {} as never,
  agent: {} as never,
  turnId: "turn-1",
  userId: "pa_user_1",
  sessionId: "session-1",
} satisfies ConnectorContext

test("valet connectors are registered and mapped to the valet family", () => {
  assert.equal(connectorRegistry["valet-apply"], VALET_APPLY_CONNECTOR)
  assert.equal(connectorRegistry["valet-apply-status"], VALET_APPLY_STATUS_CONNECTOR)
  assert.equal(resolveToolFamily("valet-apply"), "valet")
  assert.equal(resolveToolFamily("valet-apply-status"), "valet")
})

test("valet-apply degrades to ok:false when not configured (never throws)", async () => {
  delete process.env.PA_VALET_API_URL
  delete process.env.PA_VALET_SERVICE_KEY
  const result = await VALET_APPLY_CONNECTOR.execute(
    { jobUrl: "https://boards.greenhouse.io/x/jobs/1" },
    fakeCtx
  )
  assert.equal(result.ok, false)
  assert.equal(result.reason, "valet_not_configured")
  assert.equal(result.source, "valet-apply")
  assert.ok(result.summary.length > 0)
})

test("valet-apply-status degrades to ok:false when not configured", async () => {
  delete process.env.PA_VALET_API_URL
  delete process.env.PA_VALET_SERVICE_KEY
  const result = await VALET_APPLY_STATUS_CONNECTOR.execute({ taskId: "task-1" }, fakeCtx)
  assert.equal(result.ok, false)
  assert.equal(result.reason, "valet_not_configured")
})

test("valet-apply respects PA_VALET_DISABLED kill switch", async () => {
  process.env.PA_VALET_API_URL = "https://valet-api.fly.dev"
  process.env.PA_VALET_SERVICE_KEY = "k"
  process.env.PA_VALET_DISABLED = "true"
  try {
    const result = await VALET_APPLY_CONNECTOR.execute(
      { jobUrl: "https://boards.greenhouse.io/x/jobs/1" },
      fakeCtx
    )
    assert.equal(result.ok, false)
    assert.equal(result.reason, "valet_not_configured")
  } finally {
    delete process.env.PA_VALET_API_URL
    delete process.env.PA_VALET_SERVICE_KEY
    delete process.env.PA_VALET_DISABLED
  }
})

test("valet-apply output conforms to its own schema", async () => {
  const result = await VALET_APPLY_CONNECTOR.execute(
    { jobUrl: "https://boards.greenhouse.io/x/jobs/1" },
    fakeCtx
  )
  const parsed = VALET_APPLY_CONNECTOR.outputSchema.safeParse(result)
  assert.equal(parsed.success, true)
})
