import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import {
  isGateOpen,
  withinGraceWindow,
  checkResumeGate,
  gateKillSwitchOn,
} from "../cv-gate.js"

type DocSnap = { exists: boolean; data: () => Record<string, unknown> | undefined }

function makeFsLike(snapData: Record<string, unknown> | null): {
  collection: (n: string) => {
    doc: (id: string) => { get: () => Promise<DocSnap> }
  }
} {
  return {
    collection: (_: string) => ({
      doc: (_id: string) => ({
        get: async (): Promise<DocSnap> => ({
          exists: snapData !== null,
          data: () => snapData ?? undefined,
        }),
      }),
    }),
  }
}

describe("cv-gate.isGateOpen", () => {
  it("returns true when expiresAt is in the future", () => {
    const flag = { at: "2026-05-01T00:00:00Z", expiresAt: "2026-05-04T00:00:00Z", triggerHash: "x" }
    assert.equal(isGateOpen(flag, "2026-05-03T00:00:00Z"), true)
  })
  it("returns false when expired", () => {
    const flag = { at: "2026-05-01T00:00:00Z", expiresAt: "2026-05-02T00:00:00Z", triggerHash: "x" }
    assert.equal(isGateOpen(flag, "2026-05-03T00:00:00Z"), false)
  })
  it("returns false when null", () => {
    assert.equal(isGateOpen(null, "2026-05-03T00:00:00Z"), false)
  })
})

describe("cv-gate.withinGraceWindow", () => {
  it("returns true when ask flag set and within 5s", () => {
    assert.equal(withinGraceWindow("2026-05-03T12:00:00.000Z", true, "2026-05-03T12:00:03.000Z"), true)
  })
  it("returns false when ask flag is false", () => {
    assert.equal(withinGraceWindow("2026-05-03T12:00:00.000Z", false, "2026-05-03T12:00:03.000Z"), false)
  })
  it("returns false when stale (>5s)", () => {
    assert.equal(withinGraceWindow("2026-05-03T12:00:00.000Z", true, "2026-05-03T12:00:10.000Z"), false)
  })
  it("returns false when lastAt missing", () => {
    assert.equal(withinGraceWindow(null, true, "2026-05-03T12:00:00.000Z"), false)
  })
})

describe("cv-gate.checkResumeGate", () => {
  let originalKillSwitch: string | undefined
  beforeEach(() => {
    originalKillSwitch = process.env.PA_RESUME_GATE_DISABLED
    delete process.env.PA_RESUME_GATE_DISABLED
  })
  afterEach(() => {
    if (originalKillSwitch === undefined) delete process.env.PA_RESUME_GATE_DISABLED
    else process.env.PA_RESUME_GATE_DISABLED = originalKillSwitch
  })

  it("returns kill_switch=open when env disabled", async () => {
    process.env.PA_RESUME_GATE_DISABLED = "true"
    const fs = makeFsLike(null)
    const r = await checkResumeGate(fs as unknown as Parameters<typeof checkResumeGate>[0], "u1", "2026-05-03T00:00:00Z")
    assert.equal(r.open, true)
    assert.equal(r.reason, "kill_switch")
  })

  it("returns gate_open when flag present + future", async () => {
    const fs = makeFsLike({
      resumeAccepted: { at: "2026-05-01T00:00:00Z", expiresAt: "2026-05-04T00:00:00Z", triggerHash: "x" },
    })
    const r = await checkResumeGate(
      fs as unknown as Parameters<typeof checkResumeGate>[0],
      "u1",
      "2026-05-03T00:00:00Z"
    )
    assert.equal(r.open, true)
    assert.equal(r.reason, "gate_open")
  })

  it("returns not_set when no flag and no recent turn", async () => {
    const fs = makeFsLike({})
    const r = await checkResumeGate(
      fs as unknown as Parameters<typeof checkResumeGate>[0],
      "u1",
      "2026-05-03T00:00:00Z"
    )
    assert.equal(r.open, false)
    assert.equal(r.reason, "not_set")
  })

  it("returns expired when flag present but past", async () => {
    const fs = makeFsLike({
      resumeAccepted: { at: "2026-05-01T00:00:00Z", expiresAt: "2026-05-02T00:00:00Z", triggerHash: "x" },
    })
    const r = await checkResumeGate(
      fs as unknown as Parameters<typeof checkResumeGate>[0],
      "u1",
      "2026-05-03T00:00:00Z"
    )
    assert.equal(r.open, false)
    assert.equal(r.reason, "expired")
  })

  it("opens via grace_window when null flag + recent ask-turn", async () => {
    const fs = makeFsLike({
      resumeAccepted: null,
      lastAssistantTurnAt: "2026-05-03T11:59:58Z",
      lastAssistantTurnAskedResume: true,
    })
    const r = await checkResumeGate(
      fs as unknown as Parameters<typeof checkResumeGate>[0],
      "u1",
      "2026-05-03T12:00:00Z"
    )
    assert.equal(r.open, true)
    assert.equal(r.reason, "grace_window")
  })
})

describe("gateKillSwitchOn", () => {
  it("respects truthy values", () => {
    process.env.PA_RESUME_GATE_DISABLED = "true"
    assert.equal(gateKillSwitchOn(), true)
    process.env.PA_RESUME_GATE_DISABLED = "1"
    assert.equal(gateKillSwitchOn(), true)
    process.env.PA_RESUME_GATE_DISABLED = "false"
    assert.equal(gateKillSwitchOn(), false)
    delete process.env.PA_RESUME_GATE_DISABLED
    assert.equal(gateKillSwitchOn(), false)
  })
})
