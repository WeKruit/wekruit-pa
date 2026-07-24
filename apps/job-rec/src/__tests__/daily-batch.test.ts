import test from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { MockFirestore, asFirestore } from "./mock-firestore.js"
import {
  formatJobLine,
  formatBatchMessage,
  runDailyJobRecBatch,
} from "../daily-batch.js"
import type { MatchingJob } from "../types.js"

function sessionDocId(userId: string, phoneE164: string): string {
  const h = createHash("sha256").update(`${userId}|imessage|${phoneE164}`).digest("hex")
  return `ses_${h.slice(0, 32)}`
}

async function seedUser(
  mfs: MockFirestore,
  userId: string,
  phoneE164: string,
  extra: Record<string, unknown> = {}
): Promise<void> {
  await mfs.collection("pa-users").doc(userId).set({ phoneE164, ...extra })
  await mfs.collection("pa-sessions").doc(sessionDocId(userId, phoneE164)).set({
    id: sessionDocId(userId, phoneE164),
    userId,
    channel: "imessage",
    externalChatId: phoneE164,
    createdAt: "2026-04-30T00:00:00.000Z",
  })
}

function jobRecRuntimeWrites(mfs: MockFirestore) {
  return mfs.writeLog.filter(
    (w) =>
      w.path === "pa-inbound-events" &&
      (w.data.rawMeta as Record<string, unknown> | undefined)?.runtimeEventSource === "job_rec"
  )
}

function firstJobRecSourceNotes(mfs: MockFirestore): string {
  const row = jobRecRuntimeWrites(mfs)[0]?.data
  const ctx = (row?.rawMeta as Record<string, unknown> | undefined)?.context as
    | Record<string, unknown>
    | undefined
  return JSON.stringify(ctx ?? {})
}

function firstJobRecContext(mfs: MockFirestore): Record<string, unknown> {
  const row = jobRecRuntimeWrites(mfs)[0]?.data
  return ((row?.rawMeta as Record<string, unknown> | undefined)?.context as Record<string, unknown> | undefined) ?? {}
}

test("formatJobLine: bare URL on its own line (Bible v7.5.2)", () => {
  const j: MatchingJob = {
    id: "j1",
    companyName: "Acme",
    jobTitle: "Senior SWE",
    salaryMax: 250000,
    salaryMin: null,
    locationRaw: "San Francisco, CA",
    primaryUrl: "https://jobs.example.com/j1",
    industry: "tech",
    sponsorship: null,
  }
  const line = formatJobLine(j)
  const lines = line.split("\n")
  assert.equal(lines.length, 2)
  // URL must be bare (no markdown, no surrounding chars)
  assert.equal(lines[1], "https://jobs.example.com/j1")
  // Title-co block must mention salary in $k form
  assert.match(lines[0]!, /\$250k/)
})

test("formatJobLine: omits salary when salaryMax is null", () => {
  const j: MatchingJob = {
    id: "j1",
    companyName: "Acme",
    jobTitle: "SWE",
    salaryMax: null,
    salaryMin: null,
    locationRaw: "Remote",
    primaryUrl: "https://x",
    industry: "tech",
    sponsorship: null,
  }
  const line = formatJobLine(j)
  assert.doesNotMatch(line, /\$/)
})

// iter34 sprint A.2 — atsApplyUrl preferred over primaryUrl when present.
test("formatJobLine: atsApplyUrl present → URL line uses ATS link", () => {
  const j: MatchingJob = {
    id: "j1",
    companyName: "Acme",
    jobTitle: "SWE",
    salaryMax: null,
    salaryMin: null,
    locationRaw: "NYC",
    primaryUrl: "https://jobright.ai/m/abc",
    atsApplyUrl: "https://boards.greenhouse.io/acme/jobs/123",
    industry: "tech",
    sponsorship: null,
  }
  const line = formatJobLine(j)
  const lines = line.split("\n")
  assert.equal(lines[1], "https://boards.greenhouse.io/acme/jobs/123")
  // jobright mirror MUST NOT appear when ATS link is available.
  assert.doesNotMatch(line, /jobright/)
})

test("formatJobLine: atsApplyUrl undefined → falls back to primaryUrl", () => {
  const j: MatchingJob = {
    id: "j1",
    companyName: "Acme",
    jobTitle: "SWE",
    salaryMax: null,
    salaryMin: null,
    locationRaw: "NYC",
    primaryUrl: "https://jobright.ai/m/abc",
    atsApplyUrl: undefined,
    industry: "tech",
    sponsorship: null,
  }
  const line = formatJobLine(j)
  const lines = line.split("\n")
  assert.equal(lines[1], "https://jobright.ai/m/abc")
})

test("formatJobLine: atsApplyUrl absent (legacy MatchingJob shape) → primaryUrl wins", () => {
  // Legacy shape — no `atsApplyUrl` field at all (older fixtures, reverse-match
  // synth before iter34 A.2).
  const j: MatchingJob = {
    id: "j1",
    companyName: "Acme",
    jobTitle: "SWE",
    salaryMax: null,
    salaryMin: null,
    locationRaw: "NYC",
    primaryUrl: "https://primary.example.com/x",
    industry: "tech",
    sponsorship: null,
  }
  const line = formatJobLine(j)
  const lines = line.split("\n")
  assert.equal(lines[1], "https://primary.example.com/x")
})

test("formatBatchMessage: empty input -> empty string", () => {
  assert.equal(formatBatchMessage([]), "")
})

test("formatBatchMessage: lead-in adapts to count", () => {
  const j = (id: string): MatchingJob => ({
    id,
    companyName: "X",
    jobTitle: "T",
    salaryMax: null,
    salaryMin: null,
    locationRaw: "",
    primaryUrl: `https://x/${id}`,
    atsApplyUrl: "https://greenhouse.io/co/jobs/3",
    industry: "tech",
    sponsorship: null,
  })
  const one = formatBatchMessage([j("a")])
  const three = formatBatchMessage([j("a"), j("b"), j("c")])
  assert.match(one, /1 个/)
  assert.match(three, /3 个/)
})

test("runDailyJobRecBatch: skips users when feature flag is OFF", async () => {
  const mfs = new MockFirestore()
  await mfs.collection("pa-job-profiles").doc("u1").set({
    userId: "u1",
    profile: { industry: "tech", sponsorship: "none", location: "remote", sizePreference: "either" },
    cvParsedAt: "2026-04-30T00:00:00Z",
    lastJobBatchSentAt: null,
    status: "active",
    createdAt: "2026-04-30T00:00:00Z",
    updatedAt: "2026-04-30T00:00:00Z",
  })
  const out = await runDailyJobRecBatch({
    db: asFirestore(mfs),
    getFlag: async () => false,
    todayYmd: () => "20260430",
  })
  assert.equal(out.skippedFlag, 1)
  assert.equal(out.delivered, 0)
})

test("runDailyJobRecBatch: delivers when flag ON + jobs available + writes lastJobBatchSentAt", async () => {
  const mfs = new MockFirestore()
  await seedUser(mfs, "u1", "+15551112222")
  await mfs.collection("pa-job-profiles").doc("u1").set({
    userId: "u1",
    profile: { industry: "tech", sponsorship: "none", location: "remote", sizePreference: "either" },
    cvParsedAt: "2026-04-30T00:00:00Z",
    lastJobBatchSentAt: null,
    status: "active",
    createdAt: "2026-04-30T00:00:00Z",
    updatedAt: "2026-04-30T00:00:00Z",
  })
  await mfs.collection("matching-jobs").doc("j1").set({
    status: "active",
    industryKey: "tech",
    companyName: "Acme",
    roleTitle: "SWE",
    salaryMax: 200000,
    locationRaw: "Remote",
    primaryUrl: "https://j/1",
    atsApplyUrl: "https://greenhouse.io/co/jobs/4",
    industry: "tech",
    sponsorship: false,
    firstSeenAt: "2026-04-30",
    lastSeenAt: "2026-04-30",
    requiredSkills: ["TypeScript", "React", "Node.js"],
  })
  const out = await runDailyJobRecBatch({
    db: asFirestore(mfs),
    getFlag: async () => true,
    todayYmd: () => "20260430",
    jobsPerUser: 1,
  })
  assert.equal(out.delivered, 1)
  assert.equal(out.skippedFlag, 0)
  // lastJobBatchSentAt should be merged onto the profile
  const profile = (await mfs.collection("pa-job-profiles").doc("u1").get()).data()
  assert.ok(profile?.lastJobBatchSentAt)
  // job-rec hands the candidate-visible message to Claire runtime.
  assert.equal(jobRecRuntimeWrites(mfs).length, 1)
})

// ---------------------------------------------------------------------------
// Send cadence + time-spread (2026-06-02) — due-gate, jitter, pacing, idempotency.
// ---------------------------------------------------------------------------

/** Seed an active profile + a matching job so a flag-on, due user delivers. */
async function seedDeliverableUser(
  mfs: MockFirestore,
  userId: string,
  phone: string,
  lastJobBatchSentAt: string | null,
): Promise<void> {
  await seedUser(mfs, userId, phone)
  await mfs.collection("pa-job-profiles").doc(userId).set({
    userId,
    profile: { industry: "tech", sponsorship: "none", location: "remote", sizePreference: "either" },
    cvParsedAt: "2026-05-01T00:00:00Z",
    lastJobBatchSentAt,
    status: "active",
    createdAt: "2026-05-01T00:00:00Z",
    updatedAt: "2026-05-01T00:00:00Z",
  })
  await mfs.collection("matching-jobs").doc(`job-${userId}`).set({
    status: "active",
    industryKey: "tech",
    companyName: "Acme",
    roleTitle: "SWE",
    salaryMax: 200000,
    locationRaw: "Remote",
    primaryUrl: "https://j/x",
    atsApplyUrl: "https://greenhouse.io/co/jobs/9",
    industry: "tech",
    sponsorship: false,
    firstSeenAt: "2026-06-01",
    lastSeenAt: "2026-06-01",
    requiredSkills: ["TypeScript", "React", "Node.js"],
  })
}

const NOW_MS = Date.parse("2026-06-02T16:00:00.000Z")
const DAY = 24 * 60 * 60 * 1000

test("cadence: user last sent 1d ago is NOT due (cadence 3) — skipped, not stamped", async () => {
  const mfs = new MockFirestore()
  const oneDayAgo = new Date(NOW_MS - 1 * DAY).toISOString()
  await seedDeliverableUser(mfs, "recent", "+15551110001", oneDayAgo)
  const out = await runDailyJobRecBatch({
    db: asFirestore(mfs),
    // cadence flag = 3; rec flag = on. getFlag dispatches by key.
    getFlag: async (_db, key) =>
      key === "recCadenceDays" ? 3 : key === "recSendSpreadWindowMinutes" ? 120 : true,
    todayYmd: () => "20260602",
    nowMs: NOW_MS,
    jobsPerUser: 1,
  })
  assert.equal(out.delivered, 0)
  assert.equal(out.skippedNotDue, 1)
  assert.equal(jobRecRuntimeWrites(mfs).length, 0)
  // lastJobBatchSentAt unchanged (still the old value, NOT re-stamped).
  const prof = (await mfs.collection("pa-job-profiles").doc("recent").get()).data()
  assert.equal(prof?.lastJobBatchSentAt, oneDayAgo)
})

test("cadence: user last sent 4d ago IS due (cadence 3) — delivered + stamped", async () => {
  const mfs = new MockFirestore()
  const fourDaysAgo = new Date(NOW_MS - 4 * DAY).toISOString()
  await seedDeliverableUser(mfs, "stale", "+15551110002", fourDaysAgo)
  const out = await runDailyJobRecBatch({
    db: asFirestore(mfs),
    getFlag: async (_db, key) =>
      key === "recCadenceDays" ? 3 : key === "recSendSpreadWindowMinutes" ? 120 : true,
    todayYmd: () => "20260602",
    nowMs: NOW_MS,
    jobsPerUser: 1,
  })
  assert.equal(out.delivered, 1)
  assert.equal(out.skippedNotDue, 0)
  assert.equal(out.cadenceDays, 3)
  assert.equal(out.spreadWindowMinutes, 120)
  const prof = (await mfs.collection("pa-job-profiles").doc("stale").get()).data()
  assert.notEqual(prof?.lastJobBatchSentAt, fourDaysAgo) // re-stamped to now
})

test("cadence: defaults to 3 days / 120 min when flags unset", async () => {
  const mfs = new MockFirestore()
  const twoDaysAgo = new Date(NOW_MS - 2 * DAY).toISOString()
  await seedDeliverableUser(mfs, "default", "+15551110003", twoDaysAgo)
  // getFlag returns rec-enable=true; cadence/window flags return the passed
  // default (the production getFlag returns `defaultValue` for an absent doc).
  const out = await runDailyJobRecBatch({
    db: asFirestore(mfs),
    getFlag: async (_db, key, _ctx, defaultValue) =>
      key === "paJobRecEnabled" ? true : defaultValue,
    todayYmd: () => "20260602",
    nowMs: NOW_MS,
    jobsPerUser: 1,
  })
  // 2 days < default 3 → NOT due.
  assert.equal(out.cadenceDays, 3)
  assert.equal(out.spreadWindowMinutes, 120)
  assert.equal(out.delivered, 0)
  assert.equal(out.skippedNotDue, 1)
})

// ---------------------------------------------------------------------------
// 2026-06-11 STOP compliance — `pa-users.doNotContact === true` (written by
// the deterministic SMS STOP gate) must make a cadence rec IMPOSSIBLE. The
// batch's send seam (synthetic runtime event → Claire runtime) bypasses the
// inbound stop-gate, so the batch's own per-user gate is the suppression.
// ---------------------------------------------------------------------------

test("doNotContact: opted-out user is NEVER sent — skipped, not stamped, zero runtime writes", async () => {
  const mfs = new MockFirestore()
  // Flag-on, cadence-due, deliverable in every other respect.
  await seedDeliverableUser(mfs, "optedout", "+15551110030", null)
  await mfs.collection("pa-users").doc("optedout").set(
    { doNotContact: true, doNotContactAt: "2026-06-10T00:00:00Z", doNotContactSource: "sms_stop_keyword" },
    { merge: true },
  )
  let scheduled = 0
  const out = await runDailyJobRecBatch({
    db: asFirestore(mfs),
    getFlag: async (_db, key, _ctx, defaultValue) =>
      key === "paJobRecEnabled" ? true : defaultValue,
    todayYmd: () => "20260602",
    nowMs: NOW_MS,
    jobsPerUser: 1,
    scheduleSend: async () => {
      scheduled += 1
      return { ok: true }
    },
  })
  assert.equal(out.skippedDoNotContact, 1)
  assert.equal(out.delivered, 0)
  assert.equal(scheduled, 0, "no send scheduled for an opted-out user")
  assert.equal(jobRecRuntimeWrites(mfs).length, 0, "no runtime handoff for an opted-out user")
  // Cadence stamp untouched — an opt-out skip must not look like a send.
  const prof = (await mfs.collection("pa-job-profiles").doc("optedout").get()).data()
  assert.equal(prof?.lastJobBatchSentAt, null)
})

test("yc people: a YC Startup School user with an active profile is NEVER sent job recs (Adam-LOCKED 2026-07-23)", async () => {
  const mfs = new MockFirestore()
  // Flag-on, cadence-due, deliverable — but source==yc_startup_school (e.g. an existing
  // candidate who later entered YC and kept a pre-existing active pa-job-profiles row).
  await seedDeliverableUser(mfs, "ycperson", "+15551110040", null)
  await mfs.collection("pa-users").doc("ycperson").set({ source: "yc_startup_school" }, { merge: true })
  let scheduled = 0
  const out = await runDailyJobRecBatch({
    db: asFirestore(mfs),
    getFlag: async (_db, key, _ctx, defaultValue) => (key === "paJobRecEnabled" ? true : defaultValue),
    todayYmd: () => "20260602",
    nowMs: NOW_MS,
    jobsPerUser: 1,
    scheduleSend: async () => {
      scheduled += 1
      return { ok: true }
    },
  })
  assert.equal(out.skippedYcPeople, 1)
  assert.equal(out.delivered, 0)
  assert.equal(scheduled, 0, "no job-rec send scheduled for a YC person")
  assert.equal(jobRecRuntimeWrites(mfs).length, 0)
  const prof = (await mfs.collection("pa-job-profiles").doc("ycperson").get()).data()
  assert.equal(prof?.lastJobBatchSentAt, null, "cadence stamp untouched — a yc skip is not a send")
})

test("doNotContact: user who opted back in (doNotContact=false) still delivers", async () => {
  const mfs = new MockFirestore()
  await seedDeliverableUser(mfs, "optedin", "+15551110031", null)
  await mfs.collection("pa-users").doc("optedin").set(
    { doNotContact: false, doNotContactResumedAt: "2026-06-11T00:00:00Z" },
    { merge: true },
  )
  const out = await runDailyJobRecBatch({
    db: asFirestore(mfs),
    getFlag: async (_db, key, _ctx, defaultValue) =>
      key === "paJobRecEnabled" ? true : defaultValue,
    todayYmd: () => "20260602",
    nowMs: NOW_MS,
    jobsPerUser: 1,
  })
  assert.equal(out.skippedDoNotContact, 0)
  assert.equal(out.delivered, 1)
})

// ---------------------------------------------------------------------------
// Cross-system rec cooldown (2026-06-02) — the daily batch must NOT pile recs
// on top of a fresh live find_match send. Both systems stamp the SHARED
// `lastAnyJobRecSentAt` marker; the batch reads it BEFORE compose/send.
// ---------------------------------------------------------------------------

/**
 * Seed a flag-on, CADENCE-due (never-batched) user whose SHARED cross-system
 * marker `lastAnyJobRecSentAt` was stamped `lastAnyRecIso` ago — simulates a
 * live Claire find_match send that just happened. The cadence gate would let
 * this user through (lastJobBatchSentAt=null → due); only the cooldown should
 * stop them.
 */
async function seedLiveRecdUser(
  mfs: MockFirestore,
  userId: string,
  phone: string,
  lastAnyRecIso: string | null,
): Promise<void> {
  await seedDeliverableUser(mfs, userId, phone, null)
  await mfs.collection("pa-job-profiles").doc(userId).set(
    { lastAnyJobRecSentAt: lastAnyRecIso },
    { merge: true },
  )
}

const HOUR = 60 * 60 * 1000

test("cooldown: live rec 2h ago → batch SKIPS (cooldown), sendImessage NOT called", async () => {
  const mfs = new MockFirestore()
  const twoHoursAgo = new Date(NOW_MS - 2 * HOUR).toISOString()
  await seedLiveRecdUser(mfs, "justrecd", "+15551110020", twoHoursAgo)
  let syncSends = 0
  let scheduled = 0
  const out = await runDailyJobRecBatch({
    db: asFirestore(mfs),
    // rec flag on; cadence/spread default; cooldown flag = 22h (default).
    getFlag: async (_db, key, _ctx, defaultValue) =>
      key === "paJobRecEnabled" ? true : defaultValue,
    todayYmd: () => "20260602",
    nowMs: NOW_MS,
    jobsPerUser: 1,
    scheduleSend: async () => {
      scheduled += 1
      return { ok: true }
    },
  })
  assert.equal(out.skippedCooldown, 1)
  assert.equal(out.delivered, 0)
  assert.equal(out.skippedNotDue, 0) // cooldown short-circuits before the cadence gate
  assert.equal(scheduled, 0, "no send scheduled")
  // sendImessage path (runtime write) must NOT fire either.
  assert.equal(jobRecRuntimeWrites(mfs).length, 0)
  void syncSends
  // The live marker is untouched (NOT re-stamped by a skipped run).
  const prof = (await mfs.collection("pa-job-profiles").doc("justrecd").get()).data()
  assert.equal(prof?.lastAnyJobRecSentAt, twoHoursAgo)
})

test("cooldown: last rec 30h ago → batch SENDS (past 22h window) + stamps both markers", async () => {
  const mfs = new MockFirestore()
  const thirtyHoursAgo = new Date(NOW_MS - 30 * HOUR).toISOString()
  await seedLiveRecdUser(mfs, "coldenough", "+15551110021", thirtyHoursAgo)
  const out = await runDailyJobRecBatch({
    db: asFirestore(mfs),
    getFlag: async (_db, key, _ctx, defaultValue) =>
      key === "paJobRecEnabled" ? true : defaultValue,
    todayYmd: () => "20260602",
    nowMs: NOW_MS,
    jobsPerUser: 1,
  })
  assert.equal(out.skippedCooldown, 0)
  assert.equal(out.delivered, 1)
  const prof = (await mfs.collection("pa-job-profiles").doc("coldenough").get()).data()
  // BOTH markers re-stamped to "now" (≠ the 30h-ago value), so the next batch
  // honors the cooldown against THIS send.
  assert.notEqual(prof?.lastAnyJobRecSentAt, thirtyHoursAgo)
  assert.ok(prof?.lastJobBatchSentAt)
  assert.equal(prof?.lastAnyJobRecSentAt, prof?.lastJobBatchSentAt)
})

test("cooldown: dep override cooldownMs=0 disables the gate (2h-ago user delivers)", async () => {
  const mfs = new MockFirestore()
  const twoHoursAgo = new Date(NOW_MS - 2 * HOUR).toISOString()
  await seedLiveRecdUser(mfs, "nocooldown", "+15551110022", twoHoursAgo)
  const out = await runDailyJobRecBatch({
    db: asFirestore(mfs),
    getFlag: async (_db, key, _ctx, defaultValue) =>
      key === "paJobRecEnabled" ? true : defaultValue,
    todayYmd: () => "20260602",
    nowMs: NOW_MS,
    jobsPerUser: 1,
    cooldownMs: 0, // escape hatch
  })
  assert.equal(out.cooldownMs, 0)
  assert.equal(out.skippedCooldown, 0)
  assert.equal(out.delivered, 1)
})

test("time-spread: scheduleSend dep receives a delayMs; sync send NOT used", async () => {
  const mfs = new MockFirestore()
  await seedDeliverableUser(mfs, "spread", "+15551110010", null)
  const calls: Array<{ userId: string; delayMs: number; idempotencyKey: string }> = []
  const out = await runDailyJobRecBatch({
    db: asFirestore(mfs),
    getFlag: async (_db, key) =>
      key === "recCadenceDays" ? 3 : key === "recSendSpreadWindowMinutes" ? 120 : true,
    todayYmd: () => "20260602",
    nowMs: NOW_MS,
    jobsPerUser: 1,
    scheduleSend: async (input) => {
      calls.push({ userId: input.userId, delayMs: input.delayMs, idempotencyKey: input.idempotencyKey })
      return { ok: true }
    },
  })
  assert.equal(out.delivered, 1)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.userId, "spread")
  assert.equal(calls[0]!.idempotencyKey, "spread-20260602-batch")
  assert.ok(calls[0]!.delayMs >= 0 && calls[0]!.delayMs < 120 * 60_000)
  // The synchronous sendImessage path must NOT have been used.
  assert.equal(jobRecRuntimeWrites(mfs).length, 0)
  // Stamped so a re-run is due-gated out (idempotency layer 1).
  const prof = (await mfs.collection("pa-job-profiles").doc("spread").get()).data()
  assert.ok(prof?.lastJobBatchSentAt)
})

test("time-spread: per-number cap respected — number at cap defers its excess users", async () => {
  const mfs = new MockFirestore()
  // 3 due users all routed to number +1A which has only 1 send left this window.
  for (const id of ["capA1", "capA2", "capA3"]) {
    await seedDeliverableUser(mfs, id, `+1555200${id.slice(-1)}000`, null)
  }
  const enqueued: string[] = []
  const out = await runDailyJobRecBatch({
    db: asFirestore(mfs),
    getFlag: async (_db, key) =>
      key === "recCadenceDays" ? 3 : key === "recSendSpreadWindowMinutes" ? 120 : true,
    todayYmd: () => "20260602",
    nowMs: NOW_MS,
    jobsPerUser: 1,
    fromNumberForUser: () => "+1A",
    numberCapacities: { "+1A": { remaining: 1 } },
    scheduleSend: async (input) => {
      enqueued.push(input.userId)
      return { ok: true }
    },
  })
  assert.equal(out.delivered, 1, "only 1 user fits under the cap")
  assert.equal(out.cappedOut, 2, "2 deferred to next run")
  assert.equal(enqueued.length, 1)
  // The 2 capped-out users must NOT be stamped → still due next run (no loss).
  let stampedCount = 0
  for (const id of ["capA1", "capA2", "capA3"]) {
    const prof = (await mfs.collection("pa-job-profiles").doc(id).get()).data()
    if (prof?.lastJobBatchSentAt) stampedCount += 1
  }
  assert.equal(stampedCount, 1, "exactly the 1 enqueued user is stamped")
})

test("time-spread: idempotent — re-running the batch does not double-enqueue (due-gate)", async () => {
  const mfs = new MockFirestore()
  await seedDeliverableUser(mfs, "idem", "+15551110099", null)
  let enqueueCount = 0
  const deps = {
    db: asFirestore(mfs),
    getFlag: async (_db: unknown, key: string) =>
      key === "recCadenceDays" ? 3 : key === "recSendSpreadWindowMinutes" ? 120 : true,
    todayYmd: () => "20260602",
    nowMs: NOW_MS,
    jobsPerUser: 1,
    scheduleSend: async () => {
      enqueueCount += 1
      return { ok: true }
    },
  }
  const first = await runDailyJobRecBatch(deps as Parameters<typeof runDailyJobRecBatch>[0])
  assert.equal(first.delivered, 1)
  assert.equal(enqueueCount, 1)
  // Second run on the SAME day — user was just stamped (lastAnyJobRecSentAt) →
  // caught by the cross-system cooldown gate (stronger than the due-gate) → no re-enqueue.
  const second = await runDailyJobRecBatch(deps as Parameters<typeof runDailyJobRecBatch>[0])
  assert.equal(second.delivered, 0)
  assert.equal(second.skippedCooldown, 1, "re-run caught by cross-system cooldown")
  assert.equal(enqueueCount, 1, "no double-enqueue on re-run")
})

test("runDailyJobRecBatch: active subscribe row can use canonical pa-users tags", async () => {
  const mfs = new MockFirestore()
  await seedUser(mfs, "u_tags", "+15551113333", {
    tags: {
      industrySector: ["tech_software"],
      targetLocations: ["remote_anywhere"],
      targetRoleFunction: ["software_engineering"],
    },
  })
  await mfs.collection("pa-job-profiles").doc("u_tags").set({
    userId: "u_tags",
    status: "active",
    createdAt: "2026-04-30T00:00:00Z",
    updatedAt: "2026-04-30T00:00:00Z",
  })
  await mfs.collection("matching-jobs").doc("j_tags").set({
    status: "active",
    industryKey: "tech",
    companyName: "TagCo",
    roleTitle: "Software Engineer",
    // Canonical job-side tags — V16 queries `roleFunction array-contains-any`
    // + scores on industrySector/locationBuckets. Prod corpus is 100%
    // canonical (audit 2026-05-28); a fixture without these would only ever
    // pass via the legacy rescue this path now (correctly) refuses.
    roleFunction: ["software_engineering"],
    industrySector: ["tech_software"],
    locationBuckets: ["remote_anywhere"],
    salaryMax: 180000,
    locationRaw: "Remote",
    primaryUrl: "https://j/tags",
    atsApplyUrl: "https://greenhouse.io/tagco/jobs/1",
    industry: "tech",
    sponsorship: false,
    firstSeenAt: "2026-04-30",
    lastSeenAt: "2026-04-30",
    requiredSkills: ["TypeScript", "React"],
  })

  const out = await runDailyJobRecBatch({
    db: asFirestore(mfs),
    getFlag: async () => true,
    todayYmd: () => "20260430",
    jobsPerUser: 1,
  })

  assert.equal(out.delivered, 1)
  assert.equal(out.errors, 0)
  assert.equal(jobRecRuntimeWrites(mfs).length, 1)
  assert.match(firstJobRecSourceNotes(mfs), /TagCo/)
})

// Incident 2026-05-28 regression lock — a tagged candidate whose canonical
// V16 match is empty must get NOTHING, never a legacy rescue. Before the fix,
// legacy (matching on industryKey only) sent off-axis roles (e.g. customer
// support to a SWE candidate) and Jobright mirrors, burning candidate trust.
test("runDailyJobRecBatch: tagged user with no V16 match sends nothing (no legacy rescue)", async () => {
  const mfs = new MockFirestore()
  await seedUser(mfs, "u_off", "+15551114444", {
    tags: {
      industrySector: ["tech_software"],
      targetLocations: ["remote_anywhere"],
      targetRoleFunction: ["software_engineering"],
    },
  })
  await mfs.collection("pa-job-profiles").doc("u_off").set({
    userId: "u_off",
    status: "active",
    createdAt: "2026-04-30T00:00:00Z",
    updatedAt: "2026-04-30T00:00:00Z",
  })
  // Off-axis role: legacy's industryKey=tech match WOULD return + send this
  // ("Marketing Manager" is not on the tech-leaning title blacklist), but
  // V16's roleFunction hard filter rejects it (marketing ≠ software eng).
  // This is the yvNS/LF8 incident shape — off-axis role to a SWE candidate.
  await mfs.collection("matching-jobs").doc("j_off").set({
    status: "active",
    industryKey: "tech",
    companyName: "BrandCo",
    roleTitle: "Marketing Manager",
    roleFunction: ["marketing_and_advertising"],
    industrySector: ["tech_software"],
    locationBuckets: ["remote_anywhere"],
    salaryMax: 130000,
    locationRaw: "Remote",
    primaryUrl: "https://j/off",
    atsApplyUrl: "https://greenhouse.io/brandco/jobs/9",
    industry: "tech",
    sponsorship: false,
    firstSeenAt: "2026-04-30",
    lastSeenAt: "2026-04-30",
    requiredSkills: ["SEO", "Content Strategy"],
  })
  const out = await runDailyJobRecBatch({
    db: asFirestore(mfs),
    getFlag: async () => true,
    todayYmd: () => "20260430",
    jobsPerUser: 1,
  })
  assert.equal(out.delivered, 0)
  assert.equal(out.skippedNoJobs, 1)
  assert.equal(out.errors, 0)
  // No candidate-visible send at all — the off-axis role never reaches Claire.
  assert.equal(jobRecRuntimeWrites(mfs).length, 0)
})

test("runDailyJobRecBatch: skips candidate-visible send when jobs lack concrete requirements", async () => {
  const mfs = new MockFirestore()
  await seedUser(mfs, "u1", "+15551112222")
  await mfs.collection("pa-job-profiles").doc("u1").set({
    userId: "u1",
    profile: { industry: "tech", sponsorship: "none", location: "remote", sizePreference: "either" },
    cvParsedAt: "2026-04-30T00:00:00Z",
    lastJobBatchSentAt: null,
    status: "active",
    createdAt: "2026-04-30T00:00:00Z",
    updatedAt: "2026-04-30T00:00:00Z",
  })
  await mfs.collection("matching-jobs").doc("j1").set({
    status: "active",
    industryKey: "tech",
    companyName: "Acme",
    roleTitle: "SWE",
    salaryMax: 200000,
    locationRaw: "Remote",
    primaryUrl: "https://j/1",
    atsApplyUrl: "https://greenhouse.io/co/jobs/no-skills",
    industry: "tech",
    sponsorship: false,
    firstSeenAt: "2026-04-30",
    lastSeenAt: "2026-04-30",
  })
  const out = await runDailyJobRecBatch({
    db: asFirestore(mfs),
    getFlag: async () => true,
    todayYmd: () => "20260430",
    jobsPerUser: 1,
  })
  assert.equal(out.delivered, 0)
  assert.equal(out.skippedNoJobs, 1)
  assert.equal(jobRecRuntimeWrites(mfs).length, 0)
})

test("runDailyJobRecBatch: skipped_no_jobs when corpus empty for filters", async () => {
  const mfs = new MockFirestore()
  await seedUser(mfs, "u1", "+15551112222")
  await mfs.collection("pa-job-profiles").doc("u1").set({
    userId: "u1",
    profile: { industry: "fintech", sponsorship: "none", location: "Mars", sizePreference: "either" },
    cvParsedAt: "2026-04-30T00:00:00Z",
    lastJobBatchSentAt: null,
    status: "active",
    createdAt: "2026-04-30T00:00:00Z",
    updatedAt: "2026-04-30T00:00:00Z",
  })
  const out = await runDailyJobRecBatch({
    db: asFirestore(mfs),
    getFlag: async () => true,
    todayYmd: () => "20260430",
  })
  assert.equal(out.skippedNoJobs, 1)
  assert.equal(out.delivered, 0)
})

test("runDailyJobRecBatch: idempotency key includes YYYYMMDD", async () => {
  const mfs = new MockFirestore()
  await seedUser(mfs, "u1", "+15551112222")
  await mfs.collection("pa-job-profiles").doc("u1").set({
    userId: "u1",
    profile: { industry: "tech", sponsorship: "none", location: "Remote", sizePreference: "either" },
    cvParsedAt: "2026-04-30T00:00:00Z",
    lastJobBatchSentAt: null,
    status: "active",
    createdAt: "2026-04-30T00:00:00Z",
    updatedAt: "2026-04-30T00:00:00Z",
  })
  await mfs.collection("matching-jobs").doc("j1").set({
    status: "active",
    industryKey: "tech",
    companyName: "Co",
    roleTitle: "SWE",
    salaryMax: null,
    locationRaw: "Remote",
    primaryUrl: "https://j/1",
    atsApplyUrl: "https://greenhouse.io/co/jobs/5",
    industry: "tech",
    sponsorship: false,
    firstSeenAt: "2026-04-30",
    lastSeenAt: "2026-04-30",
    requiredSkills: ["TypeScript", "React"],
  })
  await runDailyJobRecBatch({
    db: asFirestore(mfs),
    getFlag: async () => true,
    todayYmd: () => "20260430",
    jobsPerUser: 1,
  })
  const w = jobRecRuntimeWrites(mfs)[0]
  assert.equal(w?.data.idempotencyKey, "runtime-event:job-rec:u1-20260430-batch")
})

test("runDailyJobRecBatch: filters out non-active profile statuses", async () => {
  const mfs = new MockFirestore()
  await mfs.collection("pa-job-profiles").doc("u1").set({
    userId: "u1",
    profile: { industry: "tech", sponsorship: "none", location: "Remote", sizePreference: "either" },
    cvParsedAt: "2026-04-30T00:00:00Z",
    lastJobBatchSentAt: null,
    status: "paused",
    createdAt: "2026-04-30T00:00:00Z",
    updatedAt: "2026-04-30T00:00:00Z",
  })
  const out = await runDailyJobRecBatch({
    db: asFirestore(mfs),
    getFlag: async () => true,
    todayYmd: () => "20260430",
  })
  assert.equal(out.total, 0)
  assert.equal(out.delivered, 0)
})

// ---------------- Stream F5 — new-shape profile + cosine + rerank ----------------

import { normalizeJobProfile, cosineSimilarity } from "../daily-batch.js"

test("Stream F5: normalizeJobProfile accepts legacy shape verbatim", () => {
  const out = normalizeJobProfile({
    industry: "tech",
    sponsorship: "h1b",
    location: "SF",
    sizePreference: "either",
    salaryMin: 150000,
  })
  assert.ok(out)
  assert.equal(out!.industry, "tech")
  assert.equal(out!.sponsorship, "h1b")
  assert.equal(out!.location, "SF")
  assert.equal(out!.sizePreference, "either")
  assert.equal(out!.salaryMin, 150000)
  assert.deepEqual(out!.industryTags, ["tech"])
})

test("Stream F5: normalizeJobProfile maps new shape (industryTags + sponsorshipNeeded) to legacy filters", () => {
  const out = normalizeJobProfile({
    industryTags: ["fintech_finance", "ai_ml"],
    sponsorshipNeeded: "H1B",
    locationPreference: "湾区",
    sizePreference: "startup",
    salaryMin: 200000,
  })
  assert.ok(out)
  assert.equal(out!.industry, "fintech")
  assert.equal(out!.sponsorship, "h1b")
  assert.equal(out!.location, "湾区")
  assert.equal(out!.sizePreference, "startup")
  assert.equal(out!.salaryMin, 200000)
  assert.deepEqual(out!.industryTags, ["fintech_finance", "ai_ml"])
})

test("Stream F5: normalizeJobProfile returns null on garbage input", () => {
  assert.equal(normalizeJobProfile(null), null)
  assert.equal(normalizeJobProfile(undefined), null)
  assert.equal(normalizeJobProfile({}), null)
  assert.equal(normalizeJobProfile({ industryTags: [] }), null)
  assert.equal(normalizeJobProfile("tech"), null)
})

test("Stream F5: cosineSimilarity is 1.0 for identical vectors and 0 for orthogonal", () => {
  assert.equal(cosineSimilarity([1, 0, 0], [1, 0, 0]), 1)
  assert.equal(cosineSimilarity([1, 0, 0], [0, 1, 0]), 0)
  // Empty / mismatched dims → 0
  assert.equal(cosineSimilarity([], [1]), 0)
  assert.equal(cosineSimilarity([1, 2], [1, 2, 3]), 0)
  // Magnitude doesn't affect direction
  const c = cosineSimilarity([2, 0, 0], [4, 0, 0])
  assert.ok(Math.abs(c - 1) < 1e-9)
})

test("Stream F5: runDailyJobRecBatch handles new-shape profile end-to-end (delivers)", async () => {
  const mfs = new MockFirestore()
  await seedUser(mfs, "u_new", "+15553334444")
  await mfs.collection("pa-job-profiles").doc("u_new").set({
    userId: "u_new",
    profile: {
      industryTags: ["fintech_finance"],
      sponsorshipNeeded: "H1B",
      locationPreference: "Remote",
      sizePreference: "startup",
      salaryMin: null,
    },
    status: "active",
    createdAt: "2026-04-30T00:00:00Z",
    updatedAt: "2026-04-30T00:00:00Z",
    cvParsedAt: "2026-04-30T00:00:00Z",
    lastJobBatchSentAt: null,
  })
  await mfs.collection("matching-jobs").doc("j_fin").set({
    status: "active",
    industryKey: "fintech",
    companyName: "FinCo",
    roleTitle: "Quant Eng",
    salaryMax: 350000,
    locationRaw: "Remote",
    primaryUrl: "https://j/fin",
    atsApplyUrl: "https://greenhouse.io/co/jobs/6",
    industry: "fintech",
    sponsorship: true,
    firstSeenAt: "2026-04-30",
    lastSeenAt: "2026-04-30",
    requiredSkills: ["Python", "SQL"],
  })
  const out = await runDailyJobRecBatch({
    db: asFirestore(mfs),
    getFlag: async () => true,
    todayYmd: () => "20260430",
    jobsPerUser: 1,
  })
  assert.equal(out.delivered, 1)
  const body = firstJobRecSourceNotes(mfs)
  assert.match(body, /FinCo/)
  // Bare URL on its own line (Bible v7.5.2). atsApplyUrl is preferred over primaryUrl
  // post-iter34-A.2, so we match the greenhouse ATS link rather than primaryUrl.
  assert.match(body, /https:\/\/greenhouse\.io\/co\/jobs\/6/)
})

import { rerankByCosine } from "../daily-batch.js"

test("Stream F5: rerankByCosine sorts by cosine similarity, jobs without embedding sink to back", () => {
  const userEmbed = [1, 0, 0]
  const jobs = [
    {
      id: "j_far",
      companyName: "Far",
      jobTitle: "Far Role",
      salaryMax: null,
      salaryMin: null,
      locationRaw: "",
      primaryUrl: "https://x/far",
      atsApplyUrl: "https://greenhouse.io/co/jobs/7",
      industry: "tech",
      sponsorship: null,
      embedding: [0, 1, 0], // orthogonal to user → score 0
    },
    {
      id: "j_close",
      companyName: "Close",
      jobTitle: "Close Role",
      salaryMax: null,
      salaryMin: null,
      locationRaw: "",
      primaryUrl: "https://x/close",
      atsApplyUrl: "https://greenhouse.io/co/jobs/8",
      industry: "tech",
      sponsorship: null,
      embedding: [1, 0, 0], // identical to user → score 1
    },
    {
      id: "j_noemb",
      companyName: "NoEmb",
      jobTitle: "NoEmb Role",
      salaryMax: null,
      salaryMin: null,
      locationRaw: "",
      primaryUrl: "https://x/noemb",
      atsApplyUrl: "https://greenhouse.io/co/jobs/9",
      industry: "tech",
      sponsorship: null,
      // no embedding field
    },
  ]
  const out = rerankByCosine(jobs, userEmbed, 3)
  assert.equal(out[0]!.id, "j_close")
  // far (orthogonal score 0) and noemb (also score 0) tie, but close is on top
  assert.notEqual(out[2]!.id, "j_close")
})

test("Stream F5: runDailyJobRecBatch with rerank deps applies cosine + still delivers", async () => {
  const mfs = new MockFirestore()
  await seedUser(mfs, "u_re", "+15554445555")
  await mfs.collection("pa-job-profiles").doc("u_re").set({
    userId: "u_re",
    profile: {
      industryTags: ["tech_software"],
      sponsorshipNeeded: "none",
      locationPreference: "Remote",
      sizePreference: "any",
      salaryMin: null,
    },
    status: "active",
    createdAt: "2026-04-30T00:00:00Z",
    updatedAt: "2026-04-30T00:00:00Z",
    cvParsedAt: "2026-04-30T00:00:00Z",
    lastJobBatchSentAt: null,
  })
  await mfs.collection("matching-jobs").doc("j_high").set({
    status: "active",
    industryKey: "tech",
    companyName: "HighCo",
    roleTitle: "Senior",
    salaryMax: 300000,
    locationRaw: "Remote",
    primaryUrl: "https://j/high",
    atsApplyUrl: "https://greenhouse.io/co/jobs/10",
    industry: "tech",
    sponsorship: false,
    firstSeenAt: "2026-04-30",
    lastSeenAt: "2026-04-30",
    embedding: [1, 0, 0],
    requiredSkills: ["React", "Node.js"],
  })
  await mfs.collection("matching-jobs").doc("j_low").set({
    status: "active",
    industryKey: "tech",
    companyName: "LowCo",
    roleTitle: "Junior",
    salaryMax: 80000,
    locationRaw: "Remote",
    primaryUrl: "https://j/low",
    atsApplyUrl: "https://greenhouse.io/co/jobs/11",
    industry: "tech",
    sponsorship: false,
    firstSeenAt: "2026-04-30",
    lastSeenAt: "2026-04-30",
    embedding: [0, 1, 0], // orthogonal to user
    requiredSkills: ["React"],
  })
  const out = await runDailyJobRecBatch({
    db: asFirestore(mfs),
    getFlag: async () => true,
    todayYmd: () => "20260430",
    jobsPerUser: 1,
    userEmbedFetcher: async () => ({
      embedding: [1, 0, 0],
      resumeId: "rsm_x",
    }),
    candidatePoolSize: 50,
  })
  assert.equal(out.delivered, 1)
  const body = firstJobRecSourceNotes(mfs)
  // HighCo wins because its embedding is identical to user
  assert.match(body, /HighCo/)
  assert.doesNotMatch(body, /LowCo/)
})

test("Stream H10: cross-encoder reranker reorders cosine-ranked jobs by relevance", async () => {
  const mfs = new MockFirestore()
  await seedUser(mfs, "u_x", "+15553336666")
  await mfs.collection("pa-job-profiles").doc("u_x").set({
    userId: "u_x",
    profile: {
      industryTags: ["tech_software"],
      sponsorshipNeeded: "none",
      locationPreference: "Remote",
      sizePreference: "any",
      salaryMin: null,
    },
    status: "active",
    createdAt: "2026-04-30T00:00:00Z",
    updatedAt: "2026-04-30T00:00:00Z",
    cvParsedAt: "2026-04-30T00:00:00Z",
    lastJobBatchSentAt: null,
  })
  // Two jobs with identical cosine score — only the cross-encoder should
  // distinguish them. j_real_fit has a clear "data scientist" title, j_qc
  // has a "QC analyst" title — cross-encoder should pick the former.
  await mfs.collection("matching-jobs").doc("j_qc").set({
    status: "active",
    industryKey: "engineering",
    companyName: "LabCo",
    jobTitle: "QC Analyst",
    roleTitle: "QC Analyst",
    salaryMax: 60000,
    locationRaw: "Remote",
    primaryUrl: "https://j/qc",
    atsApplyUrl: "https://greenhouse.io/co/jobs/12",
    industry: "tech",
    sponsorship: false,
    firstSeenAt: "2026-04-30",
    lastSeenAt: "2026-04-30",
    embedding: [1, 0, 0],
    requiredSkills: ["Python"],
  })
  await mfs.collection("matching-jobs").doc("j_real_fit").set({
    status: "active",
    industryKey: "tech",
    companyName: "DataCo",
    jobTitle: "Senior Data Scientist",
    roleTitle: "Senior Data Scientist",
    salaryMax: 250000,
    locationRaw: "Remote",
    primaryUrl: "https://j/data",
    atsApplyUrl: "https://greenhouse.io/co/jobs/13",
    industry: "tech",
    sponsorship: false,
    firstSeenAt: "2026-04-30",
    lastSeenAt: "2026-04-30",
    embedding: [1, 0, 0], // identical cosine to j_qc
    requiredSkills: ["Python", "PyTorch"],
  })

  // Stub cross-encoder: rank j_real_fit > j_qc.
  const reranker = async (
    _q: string,
    cands: Array<{ id: string; text: string }>
  ) => {
    return cands
      .map((c) => ({
        id: c.id,
        score: c.id === "j_real_fit" ? 0.85 : 0.001,
      }))
      .sort((a, b) => b.score - a.score)
  }

  const out = await runDailyJobRecBatch({
    db: asFirestore(mfs),
    getFlag: async () => true,
    todayYmd: () => "20260430",
    jobsPerUser: 1,
    userEmbedFetcher: async () => ({ embedding: [1, 0, 0], resumeId: null }),
    crossEncoderReranker: reranker,
    crossEncoderPoolSize: 10,
  })
  assert.equal(out.delivered, 1)
  const body = firstJobRecSourceNotes(mfs)
  assert.match(body, /DataCo/, "cross-encoder picks Data Scientist over QC Analyst")
  assert.doesNotMatch(body, /LabCo/)
})

test("Stream H10: cross-encoder fail-open (all-null scores) preserves cosine order", async () => {
  const mfs = new MockFirestore()
  await seedUser(mfs, "u_fo", "+15557778888")
  await mfs.collection("pa-job-profiles").doc("u_fo").set({
    userId: "u_fo",
    profile: {
      industryTags: ["tech_software"],
      sponsorshipNeeded: "none",
      locationPreference: "Remote",
      sizePreference: "any",
      salaryMin: null,
    },
    status: "active",
    createdAt: "2026-04-30T00:00:00Z",
    updatedAt: "2026-04-30T00:00:00Z",
    cvParsedAt: "2026-04-30T00:00:00Z",
    lastJobBatchSentAt: null,
  })
  await mfs.collection("matching-jobs").doc("j_top").set({
    status: "active",
    industryKey: "tech",
    companyName: "TopCo",
    jobTitle: "Senior Engineer",
    roleTitle: "Senior Engineer",
    salaryMax: 250000,
    locationRaw: "Remote",
    primaryUrl: "https://j/top",
    atsApplyUrl: "https://greenhouse.io/co/jobs/14",
    industry: "tech",
    sponsorship: false,
    firstSeenAt: "2026-04-30",
    lastSeenAt: "2026-04-30",
    embedding: [1, 0, 0],
    requiredSkills: ["React", "Node.js"],
  })
  await mfs.collection("matching-jobs").doc("j_bot").set({
    status: "active",
    industryKey: "tech",
    companyName: "BotCo",
    jobTitle: "Junior Engineer",
    roleTitle: "Junior Engineer",
    salaryMax: 80000,
    locationRaw: "Remote",
    primaryUrl: "https://j/bot",
    atsApplyUrl: "https://greenhouse.io/co/jobs/15",
    industry: "tech",
    sponsorship: false,
    firstSeenAt: "2026-04-30",
    lastSeenAt: "2026-04-30",
    embedding: [0, 1, 0], // orthogonal — sinks via cosine
    requiredSkills: ["React"],
  })

  // Reranker simulates network failure — returns input order with null scores.
  const reranker = async (
    _q: string,
    cands: Array<{ id: string; text: string }>
  ) => cands.map((c) => ({ id: c.id, score: null }))

  const out = await runDailyJobRecBatch({
    db: asFirestore(mfs),
    getFlag: async () => true,
    todayYmd: () => "20260430",
    jobsPerUser: 1,
    userEmbedFetcher: async () => ({ embedding: [1, 0, 0], resumeId: null }),
    crossEncoderReranker: reranker,
  })
  assert.equal(out.delivered, 1)
  const body = firstJobRecSourceNotes(mfs)
  // Cosine still ranks TopCo > BotCo despite reranker fail-open.
  assert.match(body, /TopCo/)
  assert.doesNotMatch(body, /BotCo/)
})

test("Stream H12: dedupe by (jobTitle|companyName) drops near-identical JDs", async () => {
  const mfs = new MockFirestore()
  await seedUser(mfs, "u1", "+15551112222")
  await mfs.collection("pa-job-profiles").doc("u1").set({
    userId: "u1",
    profile: { industry: "tech", sponsorship: "none", location: "remote", sizePreference: "either" },
    cvParsedAt: "2026-04-30T00:00:00Z",
    lastJobBatchSentAt: null,
    status: "active",
    createdAt: "2026-04-30T00:00:00Z",
    updatedAt: "2026-04-30T00:00:00Z",
  })
  // 4 jobs: 2 are exact title+company duplicates across cities, 2 are unique.
  await mfs.collection("matching-jobs").doc("j1").set({
    status: "active", industryKey: "tech", companyName: "Mastercard",
    roleTitle: "Tax Consultant", salaryMax: 120000, locationRaw: "Princeton, NJ",
    primaryUrl: "https://j/1", atsApplyUrl: "https://greenhouse.io/co/jobs/h12-1",
    industry: "tech", sponsorship: false, firstSeenAt: "2026-04-30",
 lastSeenAt: "2026-04-30",
    requiredSkills: ["Tax", "SQL"],
  })
  await mfs.collection("matching-jobs").doc("j2").set({
    status: "active", industryKey: "tech", companyName: "Mastercard",
    roleTitle: "Tax Consultant", salaryMax: 120000, locationRaw: "Richmond, VA",
    primaryUrl: "https://j/2", atsApplyUrl: "https://greenhouse.io/co/jobs/h12-2",
    industry: "tech", sponsorship: false, firstSeenAt: "2026-04-29",
 lastSeenAt: "2026-04-29",
    requiredSkills: ["Tax", "SQL"],
  })
  await mfs.collection("matching-jobs").doc("j3").set({
    status: "active", industryKey: "tech", companyName: "Stripe",
    roleTitle: "Software Engineer", salaryMax: 200000, locationRaw: "Remote",
    primaryUrl: "https://j/3", atsApplyUrl: "https://greenhouse.io/co/jobs/h12-3",
    industry: "tech", sponsorship: false, firstSeenAt: "2026-04-28",
 lastSeenAt: "2026-04-28",
    requiredSkills: ["React", "TypeScript"],
  })
  await mfs.collection("matching-jobs").doc("j4").set({
    status: "active", industryKey: "tech", companyName: "Stripe",
    roleTitle: "Software Engineer", salaryMax: 200000, locationRaw: "San Francisco, CA",
    primaryUrl: "https://j/4", atsApplyUrl: "https://greenhouse.io/co/jobs/h12-4",
    industry: "tech", sponsorship: false, firstSeenAt: "2026-04-27",
 lastSeenAt: "2026-04-27",
    requiredSkills: ["React", "TypeScript"],
  })
  const out = await runDailyJobRecBatch({
    db: asFirestore(mfs),
    getFlag: async () => true,
    todayYmd: () => "20260430",
    jobsPerUser: 4,  // request 4 — dedupe should still leave 2 unique
  })
  assert.equal(out.delivered, 1)
  const body = firstJobRecSourceNotes(mfs)
  // Both unique title-company pairs should appear, but only ONCE each
  assert.match(body, /Tax Consultant/)
  assert.match(body, /Software Engineer/)
  const jobs = firstJobRecContext(mfs).jobs as Array<Record<string, unknown>>
  const companyNames = jobs.map((job) => String(job.companyName ?? ""))
  // Mastercard appears exactly once (not twice)
  const mastercardCount = companyNames.filter((name) => name === "Mastercard").length
  assert.equal(mastercardCount, 1, `Mastercard should appear once, got ${mastercardCount}`)
  // Stripe appears exactly once
  const stripeCount = companyNames.filter((name) => name === "Stripe").length
  assert.equal(stripeCount, 1, `Stripe should appear once, got ${stripeCount}`)
})


// =============================================================================
// Stream H13 — friend-tone CV-aware daily-push opener (D4: 6 tests + edges)
// =============================================================================
import {
  formatDailyPushBody,
  formatJobLineWithReason,
  buildJobReason,
  type DailyPushContext,
} from "../daily-batch.js"

const h13Job = (over: Partial<MatchingJob> = {}): MatchingJob => ({
  id: over.id ?? "j1",
  companyName: over.companyName ?? "Stripe",
  jobTitle: over.jobTitle ?? "Senior PM",
  salaryMax: over.salaryMax ?? null,
  salaryMin: null,
  locationRaw: over.locationRaw ?? "San Francisco, CA",
  // 2026-06-10 trust audit: "https://j/1" (dot-less host) now fails the URL
  // plausibility gate by design — use a real-shaped URL in the H13 fixtures.
  primaryUrl: over.primaryUrl ?? "https://jobs.example.com/1",
  // iter34 sprint A.2 — forward atsApplyUrl override so URL-fallback tests
  // can exercise both paths. Default undefined matches legacy fixtures.
  atsApplyUrl: over.atsApplyUrl,
  industry: over.industry ?? "tech",
  industryKey: over.industryKey ?? "tech_software",
  sponsorship: null,
  requiredSkills: over.requiredSkills ?? ["Python", "ML"],
})

test("H13 variant B (CV-known, prefs-unknown) zh: opener names recentCompany + topSkill[0]", () => {
  const ctx: DailyPushContext = {
    recentCompany: "NEUROVA",
    recentRoleTitle: "Data Analyst",
    topSkills: ["Python", "ML", "SQL"],
    industryTags: ["tech_software", "ai_ml"],
    hasUserStatedPreferences: false,
    language: "zh",
  }
  const body = formatDailyPushBody([h13Job()], ctx)
  // Variant B opener: should reference NEUROVA + Python + the friend-tone phrase
  assert.match(body, /NEUROVA/)
  assert.match(body, /Python/)
  assert.match(body, /没具体问过你想找啥|没问过/)
  // Per-job line still has bare URL on its own line
  assert.match(body, /\nhttps:\/\/jobs\.example\.com\/1$/)
  // Per-job reason injected (skill exact match Python)
  assert.match(body, /Python 经验直接对得上/)
})

test("H13 variant B en: opener uses friend-tone English with recentCompany + topSkill", () => {
  const ctx: DailyPushContext = {
    recentCompany: "NEUROVA",
    topSkills: ["Python"],
    industryTags: ["tech_software"],
    hasUserStatedPreferences: false,
    language: "en",
  }
  const body = formatDailyPushBody([h13Job()], ctx)
  assert.match(body, /NEUROVA/)
  assert.match(body, /Python/)
  assert.match(body, /haven't asked|Hey/)
  // English reason
  assert.match(body, /your Python experience lines up directly/)
})

test("H13 variant A (CV + prefs) zh: opener references stated targetRole, no 'haven't asked' phrase", () => {
  const ctx: DailyPushContext = {
    recentCompany: "NEUROVA",
    topSkills: ["Python"],
    industryTags: ["fintech_finance"],
    hasUserStatedPreferences: true,
    statedPreferences: { targetRole: ["支付"] },
    language: "zh",
  }
  const body = formatDailyPushBody([h13Job()], ctx)
  assert.match(body, /支付/)
  assert.doesNotMatch(body, /没问过|没具体问过/)
  // Should not nudge for CV (we have it)
  assert.doesNotMatch(body, /发我看看简历/)
})

test("H13 variant A en: opener uses stated targetRole in English", () => {
  const ctx: DailyPushContext = {
    recentCompany: "NEUROVA",
    topSkills: ["Python"],
    industryTags: ["fintech_finance"],
    hasUserStatedPreferences: true,
    statedPreferences: { targetRole: ["payments"] },
    language: "en",
  }
  const body = formatDailyPushBody([h13Job()], ctx)
  assert.match(body, /payments/)
  assert.doesNotMatch(body, /haven't asked/)
})

test("H13 variant C (no CV) zh: keeps legacy lead + appends gentle CV nudge", () => {
  const ctx: DailyPushContext = {
    industryTags: ["tech_software"],
    hasUserStatedPreferences: false,
    language: "zh",
  }
  const body = formatDailyPushBody(
    [h13Job(), h13Job({ id: "j2", companyName: "Acme", primaryUrl: "https://j/2" })],
    ctx
  )
  assert.match(body, /今日给你挑了 2 个/)
  assert.match(body, /顺便发我看看简历/)
})

test("H13 variant C en: legacy lead + CV nudge in English", () => {
  const ctx: DailyPushContext = {
    industryTags: ["tech_software"],
    hasUserStatedPreferences: false,
    language: "en",
  }
  const body = formatDailyPushBody([h13Job()], ctx)
  assert.match(body, /Picked 1/)
  assert.match(body, /send me your CV/)
})

test("H13 edge: CV with no recentCompany (only skills) → falls to variant C (no nudge needed if recentCompany absent)", () => {
  // recentCompany undefined → variant C even if topSkills present
  const ctx: DailyPushContext = {
    topSkills: ["Python", "Tableau"],
    industryTags: ["tech_software"],
    hasUserStatedPreferences: false,
    language: "zh",
  }
  const body = formatDailyPushBody([h13Job()], ctx)
  // No recentCompany → the friend-tone "看你简历那段 X" branch must NOT fire
  assert.doesNotMatch(body, /看你简历那段/)
  // Variant C does fire — legacy lead + nudge
  assert.match(body, /今日给你挑了/)
  assert.match(body, /顺便发我看看简历/)
})

test("H13 cap: variant B lead-in is ≤ 250 chars even with long company + long skill", () => {
  const ctx: DailyPushContext = {
    recentCompany: "A".repeat(200),
    topSkills: ["B".repeat(100)],
    industryTags: ["tech_software"],
    hasUserStatedPreferences: false,
    language: "zh",
  }
  const body = formatDailyPushBody([h13Job()], ctx)
  const leadIn = body.split("\n\n")[0]!
  assert.ok(leadIn.length <= 250, `lead-in ${leadIn.length} chars exceeds 250`)
})

test("H13 buildJobReason: skill exact-match wins over industry-match", () => {
  const ctx: DailyPushContext = {
    recentCompany: "NEUROVA",
    topSkills: ["Python"],
    industryTags: ["tech_software"],
    hasUserStatedPreferences: false,
    language: "zh",
  }
  const job = h13Job({ requiredSkills: ["Python"], industryKey: "tech_software" })
  // Skill match should take precedence
  assert.equal(buildJobReason(job, ctx), "你 Python 经验直接对得上")
})

test("H13 buildJobReason: returns empty string when no signal — clean line beats forced reason", () => {
  const ctx: DailyPushContext = {
    recentCompany: "NEUROVA",
    topSkills: ["Cobol"],
    industryTags: ["healthcare_biotech"],
    hasUserStatedPreferences: false,
    language: "zh",
  }
  const job = h13Job({ requiredSkills: ["JavaScript"], industryKey: "tech_software" })
  // No skill overlap, no industry overlap → empty
  assert.equal(buildJobReason(job, ctx), "")
})

test("H13 formatJobLineWithReason: when reason empty, falls back to plain title-line + URL (no trailing dash)", () => {
  const ctx: DailyPushContext = {
    industryTags: [],
    hasUserStatedPreferences: false,
    language: "zh",
  }
  const job = h13Job({ requiredSkills: [], salaryMax: 250000 })
  const out = formatJobLineWithReason(job, ctx)
  // Should have title-line then bare URL on next line, no " — " trailing
  assert.match(out, /\$250k\nhttps/)
  assert.doesNotMatch(out, / — \nhttps/)
})

// iter34 sprint A.2 — atsApplyUrl preferred in H13 path too.
test("H13 formatJobLineWithReason: atsApplyUrl wins over primaryUrl", () => {
  const ctx: DailyPushContext = {
    industryTags: [],
    hasUserStatedPreferences: false,
    language: "zh",
  }
  const job = h13Job({
    requiredSkills: [],
    primaryUrl: "https://jobright.ai/m/x",
    atsApplyUrl: "https://lever.co/co/jobs/1",
  })
  const out = formatJobLineWithReason(job, ctx)
  const lines = out.split("\n")
  assert.equal(lines[1], "https://lever.co/co/jobs/1")
})

test("H13 formatJobLineWithReason: atsApplyUrl undefined → falls back to primaryUrl", () => {
  const ctx: DailyPushContext = {
    industryTags: [],
    hasUserStatedPreferences: false,
    language: "zh",
  }
  const job = h13Job({
    requiredSkills: [],
    primaryUrl: "https://primary.example.com/x",
    atsApplyUrl: undefined,
  })
  const out = formatJobLineWithReason(job, ctx)
  const lines = out.split("\n")
  assert.equal(lines[1], "https://primary.example.com/x")
})

test("H13 runDailyJobRecBatch wires friend-tone variant B end-to-end (default flag on)", async () => {
  const mfs = new MockFirestore()
  await seedUser(mfs, "u1", "+15551112222", { preferredLanguage: "zh" })
  // Resume doc with NEUROVA + Python — exercises variant B path
  await mfs.collection("parsedCandidateResumes").doc("r1").set({
    userId: "u1",
    createdAt: "2026-04-30T00:00:00Z",
    candidateProfile: { name: "Adam", skills: ["Python", "ML", "SQL"] },
    experiences: [
      { title: "Data Analyst", company: "NEUROVA", startDate: "2024", endDate: "present" },
    ],
  })
  await mfs.collection("pa-job-profiles").doc("u1").set({
    userId: "u1",
    profile: {
      industry: "tech",
      industryTags: ["tech_software"],
      sponsorshipNeeded: "none",
      locationPreference: "Remote",
      sizePreference: "any",
      salaryMin: null,
    },
    cvParsedAt: "2026-04-30T00:00:00Z",
    lastJobBatchSentAt: null,
    status: "active",
    createdAt: "2026-04-30T00:00:00Z",
    updatedAt: "2026-04-30T00:00:00Z",
  })
  await mfs.collection("matching-jobs").doc("j1").set({
    status: "active",
    industryKey: "tech",
    industryEnum: ["tech_software"],
    companyName: "Stripe",
    roleTitle: "Senior PM",
    salaryMax: 250000,
    locationRaw: "Remote",
    primaryUrl: "https://j/1",
    atsApplyUrl: "https://greenhouse.io/co/jobs/16",
    industry: "tech",
    sponsorship: false,
    firstSeenAt: "2026-04-30",
    lastSeenAt: "2026-04-30",
    requiredSkills: ["Python"],
  })
  const out = await runDailyJobRecBatch({
    db: asFirestore(mfs),
    // Selective flag: paJobRecEnabled / paFriendToneOpenerEnabled true; matchingIndustryEnumPopulated also true (industryEnum populated above for H8 path).
    getFlag: async (_db, key) => {
      if (key === "paJobRecEnabled") return true
      if (key === "paFriendToneOpenerEnabled") return true
      if (key === "matchingIndustryEnumPopulated") return true
      return false
    },
    todayYmd: () => "20260430",
    jobsPerUser: 1,
  })
  assert.equal(out.delivered, 1)
  const body = firstJobRecSourceNotes(mfs)
  // Friend-tone B applied: NEUROVA + Python referenced in lead-in
  assert.match(body, /NEUROVA/)
  assert.match(body, /Python/)
  assert.match(body, /"preferredLanguage":"en"/)
})

// =============================================================================
// Stream F (Phase 42) — match-explainer wiring tests
// =============================================================================
import type { ChatImpl } from "../match-explainer.js"

test("Phase 42 regression: explainer flag OFF → body bytewise matches H13 (no LLM call)", async () => {
  const mfs = new MockFirestore()
  await seedUser(mfs, "u1", "+15551112222")
  await mfs.collection("parsedCandidateResumes").doc("r1").set({
    userId: "u1",
    createdAt: "2026-04-30T00:00:00Z",
    experiences: [{ title: "Data Analyst", company: "NEUROVA" }],
    candidateProfile: { name: "Adam", skills: ["Python", "ML", "SQL"] },
  })
  await mfs.collection("pa-job-profiles").doc("u1").set({
    userId: "u1",
    profile: {
      industry: "tech",
      industryTags: ["tech_software"],
      sponsorshipNeeded: "none",
      locationPreference: "Remote",
      sizePreference: "any",
      salaryMin: null,
    },
    cvParsedAt: "2026-04-30T00:00:00Z",
    lastJobBatchSentAt: null,
    status: "active",
    createdAt: "2026-04-30T00:00:00Z",
    updatedAt: "2026-04-30T00:00:00Z",
  })
  await mfs.collection("matching-jobs").doc("j1").set({
    status: "active",
    industryKey: "tech",
    industryEnum: ["tech_software"],
    companyName: "Stripe",
    roleTitle: "Senior PM",
    salaryMax: 250000,
    locationRaw: "Remote",
    primaryUrl: "https://j/1",
    atsApplyUrl: "https://greenhouse.io/co/jobs/17",
    industry: "tech",
    sponsorship: false,
    firstSeenAt: "2026-04-30",
    lastSeenAt: "2026-04-30",
    requiredSkills: ["Python"],
  })

  let chatCallCount = 0
  const stubChat: ChatImpl = async () => {
    chatCallCount += 1
    return { text: "SHOULD NOT BE CALLED", usage: { inputTokens: 0, outputTokens: 0 } }
  }

  const out = await runDailyJobRecBatch({
    db: asFirestore(mfs),
    // paMatchExplainerEnabled returns FALSE → explainer path skipped entirely.
    getFlag: async (_db, key) => {
      if (key === "paJobRecEnabled") return true
      if (key === "paFriendToneOpenerEnabled") return true
      if (key === "matchingIndustryEnumPopulated") return true
      if (key === "paMatchExplainerEnabled") return false
      return false
    },
    todayYmd: () => "20260430",
    jobsPerUser: 1,
    matchExplainerChatImpl: stubChat,
  })
  assert.equal(out.delivered, 1)
  assert.equal(chatCallCount, 0, "explainer must NOT run when flag is off")
  const body = firstJobRecSourceNotes(mfs)
  // H13 heuristic still fires (Python skill overlap) — bytewise compatible
  // with pre-Phase-42 because no ctx.reasons map was populated.
  assert.match(body, /Python|python/)
  // Pa-job-rec-explanations must be untouched.
  assert.equal(mfs.writeLog.some((w) => w.path === "pa-job-rec-explanations"), false)
})

test("Phase 42: explainer flag ON → LLM reason injected into body + cached", async () => {
  const mfs = new MockFirestore()
  await seedUser(mfs, "u1", "+15551112222")
  await mfs.collection("parsedCandidateResumes").doc("r1").set({
    userId: "u1",
    createdAt: "2026-04-30T00:00:00Z",
    experiences: [{ title: "Senior PM", company: "NEUROVA" }],
    candidateProfile: { name: "Adam", skills: ["payments", "product strategy"] },
  })
  await mfs.collection("pa-job-profiles").doc("u1").set({
    userId: "u1",
    profile: {
      industry: "fintech",
      industryTags: ["fintech_finance"],
      sponsorshipNeeded: "none",
      locationPreference: "Remote",
      sizePreference: "any",
      salaryMin: null,
    },
    cvParsedAt: "2026-04-30T00:00:00Z",
    lastJobBatchSentAt: null,
    status: "active",
    createdAt: "2026-04-30T00:00:00Z",
    updatedAt: "2026-04-30T00:00:00Z",
  })
  await mfs.collection("matching-jobs").doc("j1").set({
    status: "active",
    industryKey: "fintech",
    industryEnum: ["fintech_finance"],
    companyName: "Stripe",
    roleTitle: "Senior Product Manager",
    salaryMax: 280000,
    locationRaw: "Remote",
    primaryUrl: "https://j/1",
    atsApplyUrl: "https://greenhouse.io/co/jobs/18",
    industry: "fintech",
    sponsorship: false,
    firstSeenAt: "2026-04-30",
    lastSeenAt: "2026-04-30",
    requiredSkills: ["payments"],
  })

  let chatCallCount = 0
  const stubChat: ChatImpl = async () => {
    chatCallCount += 1
    return {
      text: "NEUROVA payments experience lines up with Stripe",
      usage: { inputTokens: 200, outputTokens: 30 },
    }
  }

  const out = await runDailyJobRecBatch({
    db: asFirestore(mfs),
    getFlag: async (_db, key) => {
      if (key === "paJobRecEnabled") return true
      if (key === "paFriendToneOpenerEnabled") return true
      if (key === "matchingIndustryEnumPopulated") return true
      if (key === "paMatchExplainerEnabled") return true
      return false
    },
    todayYmd: () => "20260430",
    jobsPerUser: 1,
    matchExplainerChatImpl: stubChat,
  })
  assert.equal(out.delivered, 1)
  assert.equal(chatCallCount, 1, "explainer must run exactly once")
  const body = firstJobRecSourceNotes(mfs)
  // LLM-grounded reason replaces the heuristic reason (Stripe job skill
  // overlap on "payments" would have produced a heuristic reason;
  // explainer's grounded reason wins).
  assert.match(body, /NEUROVA payments experience lines up with Stripe/)
  // Cache write happened in pa-job-rec-explanations.
  assert.ok(
    mfs.writeLog.some(
      (w) => w.path === "pa-job-rec-explanations" && w.id === "u1__j1__en"
    ),
    "cache write expected"
  )
  // Cost-ledger increment.
  assert.ok(
    mfs.writeLog.some(
      (w) => w.path === "pa-cost-ledger" && w.id === "match-explainer__20260430"
    ),
    "ledger write expected"
  )
})

test("Phase 42: explainer flag ON + LLM throws → fail-open keeps H13 heuristic line", async () => {
  const mfs = new MockFirestore()
  await seedUser(mfs, "u1", "+15551112222")
  await mfs.collection("parsedCandidateResumes").doc("r1").set({
    userId: "u1",
    createdAt: "2026-04-30T00:00:00Z",
    experiences: [{ title: "Data Analyst", company: "NEUROVA" }],
    candidateProfile: { name: "Adam", skills: ["Python", "ML"] },
  })
  await mfs.collection("pa-job-profiles").doc("u1").set({
    userId: "u1",
    profile: {
      industry: "tech",
      industryTags: ["tech_software"],
      sponsorshipNeeded: "none",
      locationPreference: "Remote",
      sizePreference: "any",
      salaryMin: null,
    },
    cvParsedAt: "2026-04-30T00:00:00Z",
    lastJobBatchSentAt: null,
    status: "active",
    createdAt: "2026-04-30T00:00:00Z",
    updatedAt: "2026-04-30T00:00:00Z",
  })
  await mfs.collection("matching-jobs").doc("j1").set({
    status: "active",
    industryKey: "tech",
    industryEnum: ["tech_software"],
    companyName: "Stripe",
    roleTitle: "Senior PM",
    salaryMax: 250000,
    locationRaw: "Remote",
    primaryUrl: "https://j/1",
    atsApplyUrl: "https://greenhouse.io/co/jobs/19",
    industry: "tech",
    sponsorship: false,
    firstSeenAt: "2026-04-30",
    lastSeenAt: "2026-04-30",
    requiredSkills: ["Python"],
  })

  const stubChat: ChatImpl = async () => {
    throw new Error("match-explainer: HTTP 503 upstream")
  }

  const out = await runDailyJobRecBatch({
    db: asFirestore(mfs),
    getFlag: async (_db, key) => {
      if (key === "paJobRecEnabled") return true
      if (key === "paFriendToneOpenerEnabled") return true
      if (key === "matchingIndustryEnumPopulated") return true
      if (key === "paMatchExplainerEnabled") return true
      return false
    },
    todayYmd: () => "20260430",
    jobsPerUser: 1,
    matchExplainerChatImpl: stubChat,
  })
  assert.equal(out.delivered, 1)
  const body = firstJobRecSourceNotes(mfs)
  // Heuristic reason still appears (Python skill overlap) — fail-open
  // means we degrade to H13 behavior, never break the user.
  assert.match(body, /Python|python/)
  // No cache poisoned with empty string.
  assert.equal(
    mfs.writeLog.some((w) => w.path === "pa-job-rec-explanations"),
    false,
    "no cache write on LLM failure"
  )
})

// ---------------------------------------------------------------------------
// 2026-06-10 trust audit — fix 12 (daily repeat guard) + fix 8 (prescreen owns
// the thread) at the batch-driver level.
// ---------------------------------------------------------------------------

test("trust-audit fix 12: a job recommended yesterday is HARD-excluded from today's batch", async () => {
  const mfs = new MockFirestore()
  await seedUser(mfs, "u1", "+15551112222")
  await mfs.collection("pa-job-profiles").doc("u1").set({
    userId: "u1",
    profile: { industry: "tech", sponsorship: "none", location: "remote", sizePreference: "either" },
    cvParsedAt: "2026-04-30T00:00:00Z",
    lastJobBatchSentAt: null,
    status: "active",
    createdAt: "2026-04-30T00:00:00Z",
    updatedAt: "2026-04-30T00:00:00Z",
  })
  await mfs.collection("matching-jobs").doc("j1").set({
    status: "active",
    industryKey: "tech",
    companyName: "Acme",
    roleTitle: "SWE",
    salaryMax: 200000,
    locationRaw: "Remote",
    primaryUrl: "https://jobs.example.com/1",
    atsApplyUrl: "https://greenhouse.io/co/jobs/4",
    industry: "tech",
    sponsorship: false,
    firstSeenAt: "2026-04-30",
    lastSeenAt: "2026-04-30",
    requiredSkills: ["TypeScript", "React", "Node.js"],
  })
  // Ledger: j1 was recommended YESTERDAY (the same-job-3-days-running bug).
  await mfs
    .collection("pa-user-job-recommendations")
    .doc("u1")
    .collection("jobs")
    .doc("j1")
    .set({
      userId: "u1",
      jobId: "j1",
      recommendationCount: 1,
      lastRecommendedAt: "2026-04-30T00:00:00Z",
    })
  const out = await runDailyJobRecBatch({
    db: asFirestore(mfs),
    getFlag: async () => true,
    todayYmd: () => "20260430",
    jobsPerUser: 1,
  })
  assert.equal(out.delivered, 0, "the only candidate job is a 1-day-old repeat → no send")
  assert.equal(out.repeatJobsExcluded, 1)
  assert.equal(out.skippedNoJobs, 1)
  assert.equal(jobRecRuntimeWrites(mfs).length, 0, "no runtime handoff written")
})

test("trust-audit fix 12: a job recommended >14d ago is NOT excluded (window respected)", async () => {
  const mfs = new MockFirestore()
  await seedUser(mfs, "u1", "+15551112222")
  await mfs.collection("pa-job-profiles").doc("u1").set({
    userId: "u1",
    profile: { industry: "tech", sponsorship: "none", location: "remote", sizePreference: "either" },
    cvParsedAt: "2026-04-30T00:00:00Z",
    lastJobBatchSentAt: null,
    status: "active",
    createdAt: "2026-04-30T00:00:00Z",
    updatedAt: "2026-04-30T00:00:00Z",
  })
  await mfs.collection("matching-jobs").doc("j1").set({
    status: "active",
    industryKey: "tech",
    companyName: "Acme",
    roleTitle: "SWE",
    salaryMax: 200000,
    locationRaw: "Remote",
    primaryUrl: "https://jobs.example.com/1",
    atsApplyUrl: "https://greenhouse.io/co/jobs/4",
    industry: "tech",
    sponsorship: false,
    firstSeenAt: "2026-04-30",
    lastSeenAt: "2026-04-30",
    requiredSkills: ["TypeScript", "React", "Node.js"],
  })
  await mfs
    .collection("pa-user-job-recommendations")
    .doc("u1")
    .collection("jobs")
    .doc("j1")
    .set({
      userId: "u1",
      jobId: "j1",
      recommendationCount: 1,
      lastRecommendedAt: "2026-04-01T00:00:00Z", // ~30d before the batch clock
    })
  const out = await runDailyJobRecBatch({
    db: asFirestore(mfs),
    getFlag: async () => true,
    todayYmd: () => "20260430",
    jobsPerUser: 1,
  })
  assert.equal(out.delivered, 1, "a >14d-old prior rec does not block")
  assert.equal(out.repeatJobsExcluded, 0)
})

test("trust-audit fix 8: an OPEN prescreen work session suppresses the daily batch for that user", async () => {
  const mfs = new MockFirestore()
  await seedUser(mfs, "u1", "+15551112222", {
    workSession: {
      kind: "job_prescreen",
      status: "active",
      startedAt: "2026-04-30T20:00:00Z", // ~4h before the end-of-day batch clock
      sessionId: "ps_1",
      jobId: "job-x",
    },
  })
  await mfs.collection("pa-job-profiles").doc("u1").set({
    userId: "u1",
    profile: { industry: "tech", sponsorship: "none", location: "remote", sizePreference: "either" },
    cvParsedAt: "2026-04-30T00:00:00Z",
    lastJobBatchSentAt: null,
    status: "active",
    createdAt: "2026-04-30T00:00:00Z",
    updatedAt: "2026-04-30T00:00:00Z",
  })
  await mfs.collection("matching-jobs").doc("j1").set({
    status: "active",
    industryKey: "tech",
    companyName: "Acme",
    roleTitle: "SWE",
    salaryMax: 200000,
    locationRaw: "Remote",
    primaryUrl: "https://jobs.example.com/1",
    atsApplyUrl: "https://greenhouse.io/co/jobs/4",
    industry: "tech",
    sponsorship: false,
    firstSeenAt: "2026-04-30",
    lastSeenAt: "2026-04-30",
    requiredSkills: ["TypeScript", "React", "Node.js"],
  })
  const out = await runDailyJobRecBatch({
    db: asFirestore(mfs),
    getFlag: async () => true,
    todayYmd: () => "20260430",
    jobsPerUser: 1,
  })
  assert.equal(out.delivered, 0)
  assert.equal(out.skippedActivePrescreen, 1)
  assert.equal(jobRecRuntimeWrites(mfs).length, 0, "no rec batch buries the open screen")
})

test("trust-audit fix 8: an ENDED prescreen work session does NOT suppress the batch", async () => {
  const mfs = new MockFirestore()
  await seedUser(mfs, "u1", "+15551112222", {
    workSession: {
      kind: "job_prescreen",
      status: "ended",
      boundary: "terminal",
      endedAt: "2026-04-30T20:00:00Z",
    },
  })
  await mfs.collection("pa-job-profiles").doc("u1").set({
    userId: "u1",
    profile: { industry: "tech", sponsorship: "none", location: "remote", sizePreference: "either" },
    cvParsedAt: "2026-04-30T00:00:00Z",
    lastJobBatchSentAt: null,
    status: "active",
    createdAt: "2026-04-30T00:00:00Z",
    updatedAt: "2026-04-30T00:00:00Z",
  })
  await mfs.collection("matching-jobs").doc("j1").set({
    status: "active",
    industryKey: "tech",
    companyName: "Acme",
    roleTitle: "SWE",
    salaryMax: 200000,
    locationRaw: "Remote",
    primaryUrl: "https://jobs.example.com/1",
    atsApplyUrl: "https://greenhouse.io/co/jobs/4",
    industry: "tech",
    sponsorship: false,
    firstSeenAt: "2026-04-30",
    lastSeenAt: "2026-04-30",
    requiredSkills: ["TypeScript", "React", "Node.js"],
  })
  const out = await runDailyJobRecBatch({
    db: asFirestore(mfs),
    getFlag: async () => true,
    todayYmd: () => "20260430",
    jobsPerUser: 1,
  })
  assert.equal(out.delivered, 1)
  assert.equal(out.skippedActivePrescreen, 0)
})
