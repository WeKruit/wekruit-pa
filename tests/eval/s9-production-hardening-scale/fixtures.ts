export const generatedAt = "2026-05-14T01:00:00.000Z"

export function privacyRequestFixture(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "privacy_request_delete__abcxyz",
    kind: "delete",
    status: "submitted",
    candidateId: "cand_s9",
    sourceSurface: "me_profile",
    requestedBy: "candidate",
    detailRedacted: {
      requestKind: "delete",
      sourceSurface: "me_profile",
      note: "Candidate asked for operator review of privacy deletion.",
    },
    evidence: [
      {
        source: "system",
        summary: "Candidate submitted privacy request from profile.",
        confidence: 1,
      },
    ],
    createdAt: generatedAt,
    ...overrides,
  }
}

export function launchReadinessSnapshotFixture(overrides: Record<string, unknown> = {}) {
  return {
    snapshotId: "launch_readiness_abcxyz",
    generatedAt,
    status: "yellow",
    counts: {
      privacyTotal: 1,
      privacyOpen: 1,
      stopControls: 1,
      pausedControls: 1,
      globalPaused: 1,
    },
    sections: [
      {
        key: "privacy_requests",
        label: "Privacy requests",
        status: "yellow",
        count: 1,
        summary: "1 open privacy request needs operator review",
        sourceRoute: "/admin/launch-readiness",
        updatedAt: generatedAt,
      },
      {
        key: "delivery_gate",
        label: "Delivery gate",
        status: "red",
        summary: "Marketplace outreach delivery is blocked before delivery calls",
        sourceRoute: "/admin/launch-readiness",
        updatedAt: generatedAt,
      },
    ],
    privacyRequests: [
      {
        requestId: "privacy_request_delete__abcxyz",
        kind: "delete",
        status: "submitted",
        candidateId: "cand_s9",
        sourceSurface: "me_profile",
        createdAt: generatedAt,
        updatedAt: generatedAt,
      },
    ],
    stopControls: [
      {
        controlId: "outreach_stop_global",
        scope: "global",
        paused: true,
        reason: "launch readiness pause",
        updatedAt: generatedAt,
      },
    ],
    evidence: [
      {
        source: "admin",
        summary: "Redacted launch readiness snapshot generated.",
        confidence: 1,
      },
    ],
    ...overrides,
  }
}

export function outreachStopControlFixture(overrides: Record<string, unknown> = {}) {
  return {
    controlId: "outreach_stop_global",
    scope: "global",
    paused: true,
    reason: "launch readiness pause",
    actor: "operator",
    createdAt: generatedAt,
    updatedAt: generatedAt,
    ...overrides,
  }
}

export const noContactCountManifest = {
  approvedLiveSend: false,
  approvedDestructivePrivacyAction: false,
  before: {
    outboundRows: 0,
    privacyRequests: 0,
    launchReadinessSnapshots: 0,
    outreachStopControls: 0,
  },
  after: {
    outboundRows: 0,
    privacyRequests: 0,
    launchReadinessSnapshots: 0,
    outreachStopControls: 0,
  },
}
