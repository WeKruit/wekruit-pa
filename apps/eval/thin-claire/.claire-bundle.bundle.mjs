import { createRequire as __cr } from 'node:module';
import { fileURLToPath as __fp } from 'node:url';
const require = __cr(import.meta.url);
const __filename = __fp(import.meta.url);
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// ../../functions/src/sendblue/pool.ts
var pool_exports = {};
__export(pool_exports, {
  _resetPoolCache: () => _resetPoolCache,
  computeSendblueCapacitySnapshot: () => computeSendblueCapacitySnapshot,
  findSendbluePoolNumber: () => findSendbluePoolNumber,
  hashStringToUint: () => hashStringToUint,
  isUserAccessibleSendblueNumber: () => isUserAccessibleSendblueNumber,
  loadSendbluePool: () => loadSendbluePool,
  normalizeSendbluePoolGroups: () => normalizeSendbluePoolGroups,
  pickFromNumber: () => pickFromNumber,
  selectCapacityAwareFromNumber: () => selectCapacityAwareFromNumber,
  selectSendblueCapacityGroup: () => selectSendblueCapacityGroup,
  sendblueGroupId: () => sendblueGroupId
});
function hashStringToUint(s) {
  let h = 5381 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h, 33) + s.charCodeAt(i) >>> 0;
  }
  return h;
}
function isUserAccessibleSendblueNumber(number) {
  if (number.adminOnly === true) return false;
  const audience = typeof number.audience === "string" ? number.audience.trim().toLowerCase() : "";
  if (audience === "admin" || audience === "internal" || audience === "developer") return false;
  return true;
}
function hasNewUserCapacity(number) {
  const cap = number.newUserCap;
  if (!Number.isInteger(cap) || cap === void 0 || cap < 0) return true;
  const used = Number.isInteger(number.assignedNewUsers) ? Math.max(0, number.assignedNewUsers ?? 0) : 0;
  return used < cap;
}
function isSelectablePoolNumber(number, options = {}) {
  if (!number.number || number.status !== "active") return false;
  if (!options.includeInternal && !isUserAccessibleSendblueNumber(number)) return false;
  if (options.requireNewUserCapacity && !hasNewUserCapacity(number)) return false;
  return true;
}
function pickFromNumber(pool, userId, options = {}) {
  const active = normalizedPoolNumbers(pool).filter((n) => isSelectablePoolNumber(n, options));
  if (active.length === 0) return null;
  const idx = hashStringToUint(userId) % active.length;
  return active[idx].number;
}
function configuredCapacity(number) {
  return number.dailySendCap ?? number.capacity;
}
function normalizedPoolNumbers(pool) {
  if (!pool) return [];
  const grouped = (Array.isArray(pool.groups) ? pool.groups : []).flatMap((group) => {
    const groupId = group.groupId?.trim();
    if (!groupId) return [];
    return (Array.isArray(group.numbers) ? group.numbers : []).map((entry) => {
      if (typeof entry === "string") {
        const number2 = entry.trim();
        if (!number2) return null;
        return {
          number: number2,
          groupId,
          status: group.status,
          audience: group.audience,
          adminOnly: group.adminOnly,
          newUserCap: group.newUserCap,
          assignedNewUsers: group.assignedNewUsers,
          capacity: group.capacity,
          dailySendCap: group.dailySendCap
        };
      }
      const number = entry.number?.trim();
      if (!number) return null;
      return {
        ...entry,
        number,
        groupId: entry.groupId?.trim() || groupId,
        status: entry.status ?? group.status,
        audience: entry.audience ?? group.audience,
        adminOnly: entry.adminOnly ?? group.adminOnly,
        newUserCap: entry.newUserCap ?? group.newUserCap,
        assignedNewUsers: entry.assignedNewUsers ?? group.assignedNewUsers,
        capacity: entry.capacity ?? group.capacity,
        dailySendCap: entry.dailySendCap ?? group.dailySendCap
      };
    }).filter((entry) => entry !== null);
  });
  const legacy = Array.isArray(pool.numbers) ? pool.numbers : [];
  return [...grouped, ...legacy];
}
function findSendbluePoolNumber(pool, senderNumber) {
  return normalizedPoolNumbers(pool).find((n) => n.number === senderNumber) ?? null;
}
function normalizeSendbluePoolGroups(pool) {
  const groups = /* @__PURE__ */ new Map();
  for (const number of normalizedPoolNumbers(pool)) {
    const groupId = sendblueGroupId(number);
    const existing = groups.get(groupId);
    const cap = configuredCapacity(number);
    const dailySendCap = Number.isInteger(cap) && cap !== void 0 && cap > 0 ? cap : null;
    if (existing) {
      existing.numbers.push(number.number);
      if (existing.dailySendCap === null && dailySendCap !== null) existing.dailySendCap = dailySendCap;
      continue;
    }
    groups.set(groupId, {
      groupId,
      status: number.status,
      dailySendCap,
      numbers: [number.number]
    });
  }
  return [...groups.values()];
}
function sendblueGroupId(number) {
  return (number.groupId?.trim() || number.number.trim()).replace(/\s+/g, "");
}
function capacitySnapshot(number, checkedAt, utilization, reason) {
  const groupId = number ? sendblueGroupId(number) : "unassigned";
  const rawCap = number ? configuredCapacity(number) : void 0;
  const dailyCap = Number.isInteger(rawCap) && rawCap !== void 0 && rawCap >= 0 ? rawCap : 0;
  const usedToday = Math.max(0, Math.trunc(utilization?.usedToday ?? 0));
  return {
    groupId,
    ...number?.number ? { fromNumber: number.number } : {},
    status: number?.status ?? "missing",
    dailyCap,
    usedToday,
    remainingToday: Math.max(0, dailyCap - usedToday),
    ...utilization?.rolling24hUsed !== void 0 ? { rolling24hUsed: Math.max(0, Math.trunc(utilization.rolling24hUsed)) } : {},
    checkedAt,
    ...reason ? { reason } : {}
  };
}
function isCapacityConfigured(number) {
  const capacity = configuredCapacity(number);
  return Number.isInteger(capacity) && capacity !== void 0 && capacity > 0;
}
function isRoutableStatus(number, allowWarmup = false) {
  return number.status === "active" || allowWarmup && number.status === "warmup";
}
function capacityRemaining(number, utilization) {
  const groupId = sendblueGroupId(number);
  const usedToday = Math.max(0, Math.trunc(utilization[groupId]?.usedToday ?? 0));
  return Math.max(0, (configuredCapacity(number) ?? 0) - usedToday);
}
function computeSendblueCapacitySnapshot(input) {
  const dailyCap = input.group.dailySendCap ?? 0;
  const usedToday = Math.max(0, Math.trunc(input.usedToday));
  return {
    groupId: input.group.groupId,
    ...input.fromNumber ? { fromNumber: input.fromNumber } : {},
    status: input.group.status,
    dailyCap,
    usedToday,
    remainingToday: Math.max(0, dailyCap - usedToday),
    checkedAt: (input.checkedAt ?? /* @__PURE__ */ new Date()).toISOString(),
    ...input.reason ? { reason: input.reason } : {}
  };
}
function selectSendblueCapacityGroup(pool, input) {
  const utilization = input.utilization ?? {};
  const poolNumbers = normalizedPoolNumbers(pool);
  if (poolNumbers.length === 0) {
    return {
      ok: false,
      reason: "no_pool",
      capacitySnapshot: capacitySnapshot(null, input.checkedAt, void 0, "no_pool")
    };
  }
  const candidateNumbers = poolNumbers.filter(isUserAccessibleSendblueNumber);
  const byGroup = new Map(candidateNumbers.map((number) => [sendblueGroupId(number), number]));
  if (input.stickyAccountGroupId) {
    const sticky = byGroup.get(input.stickyAccountGroupId);
    if (!sticky || !isRoutableStatus(sticky, Boolean(input.allowWarmup))) {
      return {
        ok: false,
        groupId: input.stickyAccountGroupId,
        fromNumber: sticky?.number,
        reason: sticky?.status === "warmup" ? "warmup_requires_hitl" : "sticky_group_unavailable",
        capacitySnapshot: capacitySnapshot(
          sticky ?? null,
          input.checkedAt,
          sticky ? utilization[sendblueGroupId(sticky)] : void 0,
          sticky?.status === "warmup" ? "warmup_requires_hitl" : "sticky_group_unavailable"
        )
      };
    }
    if (!isCapacityConfigured(sticky)) {
      return {
        ok: false,
        groupId: sendblueGroupId(sticky),
        fromNumber: sticky.number,
        reason: "missing_capacity",
        capacitySnapshot: capacitySnapshot(sticky, input.checkedAt, utilization[sendblueGroupId(sticky)], "missing_capacity")
      };
    }
    if (capacityRemaining(sticky, utilization) <= 0) {
      return {
        ok: false,
        groupId: sendblueGroupId(sticky),
        fromNumber: sticky.number,
        reason: "sticky_group_capacity",
        capacitySnapshot: capacitySnapshot(
          sticky,
          input.checkedAt,
          utilization[sendblueGroupId(sticky)],
          "sticky_group_capacity"
        )
      };
    }
    return {
      ok: true,
      groupId: sendblueGroupId(sticky),
      fromNumber: sticky.number,
      reason: "sticky_selected",
      capacitySnapshot: capacitySnapshot(sticky, input.checkedAt, utilization[sendblueGroupId(sticky)])
    };
  }
  const hasWarmupOnly = candidateNumbers.some((number) => number.status === "warmup") && !candidateNumbers.some((number) => number.status === "active");
  if (hasWarmupOnly && !input.allowWarmup) {
    const warmup = candidateNumbers.find((number) => number.status === "warmup");
    return {
      ok: false,
      groupId: sendblueGroupId(warmup),
      fromNumber: warmup.number,
      reason: "warmup_requires_hitl",
      capacitySnapshot: capacitySnapshot(warmup, input.checkedAt, utilization[sendblueGroupId(warmup)], "warmup_requires_hitl")
    };
  }
  const routable = candidateNumbers.filter((number) => isRoutableStatus(number, Boolean(input.allowWarmup)));
  if (routable.length === 0) {
    return {
      ok: false,
      reason: "no_routable_group",
      capacitySnapshot: capacitySnapshot(null, input.checkedAt, void 0, "no_routable_group")
    };
  }
  const missingCapacity = routable.find((number) => !isCapacityConfigured(number));
  const eligible = routable.filter(
    (number) => isCapacityConfigured(number) && capacityRemaining(number, utilization) > 0
  );
  if (eligible.length === 0) {
    const full = routable.find((number) => isCapacityConfigured(number)) ?? missingCapacity ?? routable[0];
    const reason = missingCapacity && !routable.some((number) => isCapacityConfigured(number)) ? "missing_capacity" : "channel_capacity";
    return {
      ok: false,
      groupId: sendblueGroupId(full),
      fromNumber: full.number,
      reason,
      capacitySnapshot: capacitySnapshot(full, input.checkedAt, utilization[sendblueGroupId(full)], reason)
    };
  }
  const idx = hashStringToUint(input.candidateId) % eligible.length;
  const selected = eligible[idx];
  return {
    ok: true,
    groupId: sendblueGroupId(selected),
    fromNumber: selected.number,
    reason: "selected",
    capacitySnapshot: capacitySnapshot(selected, input.checkedAt, utilization[sendblueGroupId(selected)])
  };
}
function selectCapacityAwareFromNumber(pool, userId, options = {}) {
  const utilization = options.usedTodayByGroupId instanceof Map ? Object.fromEntries([...options.usedTodayByGroupId.entries()].map(([k, usedToday]) => [k, { usedToday }])) : Object.fromEntries(
    Object.entries(options.usedTodayByGroupId ?? {}).map(([k, usedToday]) => [k, { usedToday }])
  );
  return selectSendblueCapacityGroup(pool, {
    candidateId: userId,
    checkedAt: (options.checkedAt ?? /* @__PURE__ */ new Date()).toISOString(),
    stickyAccountGroupId: options.stickyGroupId?.trim() || void 0,
    utilization
  });
}
async function loadSendbluePool(db) {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.config;
  try {
    const snap = await db.collection("pa-config").doc("sendblue-pool").get();
    if (!snap.exists) {
      cached = { config: null, expiresAt: now + POOL_TTL_MS };
      return null;
    }
    const data = snap.data();
    cached = { config: data, expiresAt: now + POOL_TTL_MS };
    return data;
  } catch {
    cached = { config: null, expiresAt: now + POOL_TTL_MS };
    return null;
  }
}
function _resetPoolCache() {
  cached = null;
}
var cached, POOL_TTL_MS;
var init_pool = __esm({
  "../../functions/src/sendblue/pool.ts"() {
    "use strict";
    cached = null;
    POOL_TTL_MS = 60 * 1e3;
  }
});

// ../../functions/src/claire-agent/sdk.ts
import { createRequire } from "node:module";
import OpenAI from "openai";
var baseRequire = createRequire(import.meta.url);
var req;
try {
  req = createRequire(baseRequire.resolve("@pa/agent-runtime/package.json"));
} catch {
  req = baseRequire;
}
var sdk = req("@openai/agents");
var z = req("zod");
var Agent = sdk.Agent;
var run = sdk.run;
var tool = sdk.tool;
var InputGuardrailTripwireTriggered = sdk.InputGuardrailTripwireTriggered;
var MemorySession = sdk.MemorySession;
var configured = false;
function configureClaireSdk() {
  if (configured) return;
  const apiKey = process.env.PA_OPENAI_AGENT_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim() || "";
  const baseURL = process.env.PA_OPENAI_AGENT_BASE_URL?.trim() || "https://api.openai.com/v1";
  try {
    const client = new OpenAI({ apiKey, baseURL });
    sdk.setDefaultOpenAIClient?.(client);
    sdk.setOpenAIAPI?.("responses");
    if (apiKey) sdk.setDefaultOpenAIKey?.(apiKey);
  } catch {
  }
  configured = true;
}

// ../../functions/src/claire-agent/tools/matching-tools.ts
import { ROLE_FUNCTION_VOCAB, JOB_TYPE_VOCAB } from "@wekruit/shared-tags";
import { applyPartialUserTags } from "@pa/pa-orchestrator";
import { mem0Add } from "@pa/memory";
import { parseResumeText } from "@pa/pa-resume-parser";
import { queryMatchingJobsV16, recordRecommendedJobs } from "@pa/job-rec";
import { writeFeedbackEvent } from "@pa/pa-persistence";

// ../../functions/src/claire-agent/reducers/matching-profile-reducer.ts
function dedup(values) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const v of values) {
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}
function nonEmpty(arr) {
  return Array.isArray(arr) && arr.length > 0;
}
function reduceMatchingPreferences(current, proposal) {
  let positive = dedup(current.targetRoleFunction ?? []);
  let negative = dedup(current.negativeRoleFunction ?? []);
  const changed = {};
  const removedFromPositive = [];
  if (nonEmpty(proposal.onlyRoleFunctions)) {
    const only = dedup(proposal.onlyRoleFunctions);
    positive = only;
    const onlySet = new Set(only);
    negative = negative.filter((r) => !onlySet.has(r));
    changed.targetRoleFunction = [...positive];
  }
  if (nonEmpty(proposal.avoidRoleFunctions)) {
    const avoid = new Set(dedup(proposal.avoidRoleFunctions));
    for (const r of positive) {
      if (avoid.has(r)) removedFromPositive.push(r);
    }
    positive = positive.filter((r) => !avoid.has(r));
    negative = dedup([...negative, ...avoid]);
    changed.targetRoleFunction = [...positive];
    changed.negativeRoleFunction = [...negative];
  }
  if (nonEmpty(proposal.jobType)) {
    changed.targetJobType = dedup(proposal.jobType);
  }
  if (nonEmpty(proposal.locations)) {
    changed.targetLocations = dedup(proposal.locations);
  }
  const next = {
    targetRoleFunction: positive,
    ...negative.length ? { negativeRoleFunction: negative } : {},
    targetJobType: changed.targetJobType ?? current.targetJobType,
    targetLocations: changed.targetLocations ?? current.targetLocations
  };
  return { next, changed, removedFromPositive };
}

// ../../functions/src/production-hardening.ts
import { getFirestore as getFirestore3 } from "firebase-admin/firestore";
import { defineSecret as defineSecret3 } from "firebase-functions/params";
import { HttpsError as HttpsError3, onCall as onCall3 } from "firebase-functions/v2/https";
import { z as z4 } from "zod";
import {
  LaunchReadinessSnapshotSchema,
  OutreachStopControlSchema,
  PA_COLLECTIONS as PA_COLLECTIONS2,
  PrivacyRequestKindSchema,
  PrivacyRequestSchema,
  createLaunchReadinessSnapshotId,
  createPrivacyRequestId
} from "@pa/core-types";
import {
  writeLaunchReadinessSnapshot,
  writeOutreachStopControl,
  writePrivacyRequest
} from "@pa/pa-persistence";

// ../../functions/src/flywheel-eval.ts
import { createHash } from "node:crypto";
import { getFirestore as getFirestore2 } from "firebase-admin/firestore";
import { defineSecret as defineSecret2 } from "firebase-functions/params";
import { HttpsError as HttpsError2, onCall as onCall2 } from "firebase-functions/v2/https";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { z as z3 } from "zod";
import {
  CorrectionEventSchema,
  EvalArtifactSchema,
  FeedbackEventSchema,
  PA_COLLECTIONS,
  createEvalArtifactId
} from "@pa/core-types";
import { writeEvalArtifact } from "@pa/pa-persistence";

// ../../functions/src/promote-sandbox-tag.ts
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { logger } from "firebase-functions/v2";
import { getFirestore } from "firebase-admin/firestore";
import { z as z2 } from "zod";
import {
  validateCanonicalToken,
  INDUSTRY_SECTOR_VOCAB,
  CANONICAL_OVERLAY_COLLECTION,
  overlayDocId
} from "@wekruit/shared-tags";
var PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN");
var AUDIT_COLLECTION = "pa-canonical-tags-audit";
var PromoteSandboxTagInputSchema = z2.object({
  vocab: z2.literal("industry-sector"),
  // only industrySector add-able per D16
  token: z2.string().min(2).max(64),
  action: z2.enum(["promote", "reject"]),
  /** Optional admin-token fallback for non-Firebase-Auth scripted callers. */
  adminToken: z2.string().optional()
});
async function runPromoteSandboxTag(input, actorUid, deps) {
  const { vocab, token, action } = input;
  const validation = validateCanonicalToken(token, vocab);
  if (!validation.ok) {
    throw new HttpsError("invalid-argument", validation.reason ?? "invalid token");
  }
  const staticVocab = deps.staticVocab ?? INDUSTRY_SECTOR_VOCAB;
  const docId = overlayDocId(vocab, token);
  const now = deps.now();
  if (action === "promote") {
    if (staticVocab.includes(token)) {
      deps.log?.("pa.canonical_tags.skip_already_canonical", { vocab, token, by: actorUid });
      return { ok: true, token, status: "already_canonical" };
    }
    await deps.setOverlayDoc(docId, {
      vocab,
      token,
      status: "promoted",
      promotedAt: now,
      promotedBy: actorUid
    });
    await deps.addAuditEvent({
      eventType: "promote",
      vocab,
      token,
      actorUid,
      timestamp: now
    });
    deps.log?.("pa.canonical_tags.promoted", { vocab, token, by: actorUid });
    return { ok: true, token, status: "promoted" };
  }
  await deps.setOverlayDoc(docId, {
    vocab,
    token,
    status: "rejected",
    rejectedAt: now,
    rejectedBy: actorUid
  });
  await deps.addAuditEvent({
    eventType: "reject",
    vocab,
    token,
    actorUid,
    timestamp: now
  });
  deps.log?.("pa.canonical_tags.rejected", { vocab, token, by: actorUid });
  return { ok: true, token, status: "rejected" };
}
function authorizeAdminCallable(req2) {
  const claim = req2.auth?.token?.admin;
  const uid = req2.auth?.uid ?? "";
  if (claim === true || claim === "true") {
    return { uid: uid || "admin-claim" };
  }
  const dataObj = req2.data && typeof req2.data === "object" ? req2.data : {};
  const provided = typeof dataObj.adminToken === "string" ? dataObj.adminToken.trim() : "";
  const expected = (process.env.PA_ADMIN_TOKEN ?? "").trim();
  if (expected && provided && provided === expected) {
    return { uid: uid || "admin-token" };
  }
  throw new HttpsError("permission-denied", "admin only");
}
var paPromoteSandboxTag = onCall(
  {
    region: "us-central1",
    memory: "256MiB",
    secrets: [PA_ADMIN_TOKEN]
  },
  async (req2) => {
    const { uid } = authorizeAdminCallable(
      req2
    );
    const parsed = PromoteSandboxTagInputSchema.safeParse(req2.data);
    if (!parsed.success) {
      throw new HttpsError("invalid-argument", parsed.error.message);
    }
    const db = getFirestore();
    return runPromoteSandboxTag(parsed.data, uid, {
      setOverlayDoc: async (docId, data) => {
        await db.collection(CANONICAL_OVERLAY_COLLECTION).doc(docId).set(data, { merge: true });
      },
      addAuditEvent: async (data) => {
        await db.collection(AUDIT_COLLECTION).add(data);
      },
      now: () => (/* @__PURE__ */ new Date()).toISOString(),
      log: (...args) => logger.info("[promote-sandbox-tag]", ...args)
    });
  }
);

// ../../functions/src/flywheel-eval.ts
var PA_ADMIN_TOKEN2 = defineSecret2("PA_ADMIN_TOKEN");
var SAFE_STRUCTURED_KEY_RE = /^[A-Za-z0-9_.:-]{1,80}$/;
var UNSAFE_KEY_RE = /(?:contact|correctiontext|email|freeform|linkedin|message|phone|prompt|raw|resume|storage|transcript)/i;
var EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
var PHONE_RE = /(?:\+?\d[\s().-]*){9,}/;
var LOCATOR_RE = /\b(?:gs:\/\/|https?:\/\/[^\s]*(?:linkedin\.com|storage\.googleapis\.com|firebasestorage\.googleapis\.com|storage\.cloud\.google\.com|resume|cv)[^\s]*)/i;
var UNSAFE_TEXT_TOKEN_RE = /\b(?:prompt|raw|transcript)\b/i;
var FlywheelBehaviorSchema = z3.enum([
  "prescreen_pass",
  "prescreen_not_pass",
  "prescreen_started",
  "candidate_declined",
  "candidate_interested",
  "outbound_delivery",
  "outbound_failure",
  "match_positive",
  "match_negative"
]);
var FlywheelFeedbackInputSchema = z3.object({
  eventId: z3.string().min(1),
  behavior: FlywheelBehaviorSchema,
  candidateId: z3.string().min(1).optional(),
  jobId: z3.string().min(1).optional(),
  candidateJobStateId: z3.string().min(1).optional(),
  outcome: z3.string().min(1).max(200).optional(),
  signals: z3.record(z3.unknown()).default({}),
  createdAt: z3.string().min(1)
});
var FlywheelSimulationInputSchema = z3.object({
  scenarioRef: z3.string().min(1).max(120),
  candidates: z3.array(z3.object({
    candidateId: z3.string().min(1),
    tags: z3.array(z3.string()).default([])
  })).default([]),
  jobs: z3.array(z3.object({
    jobId: z3.string().min(1),
    tags: z3.array(z3.string()).default([]),
    active: z3.boolean().default(true)
  })).default([]),
  events: z3.array(z3.object({
    kind: FlywheelBehaviorSchema,
    candidateId: z3.string().min(1).optional(),
    jobId: z3.string().min(1).optional()
  })).default([])
});
var AdminFlywheelEvalSnapshotInputSchema = z3.object({
  limit: z3.number().int().min(1).max(100).default(25),
  adminToken: z3.string().optional()
});
function isUnsafeString(value) {
  return EMAIL_RE.test(value) || PHONE_RE.test(value) || LOCATOR_RE.test(value) || UNSAFE_TEXT_TOKEN_RE.test(value);
}
function sanitizeEvalPayload(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || isUnsafeString(trimmed)) return void 0;
    return trimmed.slice(0, 500);
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const items = value.map(sanitizeEvalPayload).filter((item) => item !== void 0);
    return items.length > 0 ? items.slice(0, 20) : void 0;
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, nested] of Object.entries(value)) {
      if (!SAFE_STRUCTURED_KEY_RE.test(key) || UNSAFE_KEY_RE.test(key)) continue;
      const safe = sanitizeEvalPayload(nested);
      if (safe !== void 0) out[key] = safe;
    }
    return Object.keys(out).length > 0 ? out : void 0;
  }
  return void 0;
}
function safeRecord(value) {
  const sanitized = sanitizeEvalPayload(value);
  return sanitized && typeof sanitized === "object" && !Array.isArray(sanitized) ? sanitized : {};
}
function safeEvidence(rows) {
  return rows.map((row) => {
    const summary = sanitizeEvalPayload(row.summary);
    const refId = row.refId ? sanitizeEvalPayload(row.refId) : void 0;
    return {
      source: row.source,
      summary: typeof summary === "string" ? summary : "redacted flywheel evidence",
      ...typeof row.confidence === "number" ? { confidence: row.confidence } : {},
      ...typeof refId === "string" ? { refId } : {}
    };
  });
}
function countBy(rows, select) {
  const out = {};
  for (const row of rows) {
    const key = select(row);
    if (!key) continue;
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}
function materializeEvalArtifactForCorrection(input) {
  const correction = CorrectionEventSchema.parse(input.correction);
  const kind = input.kind ?? (correction.actor === "candidate" ? "candidate_profile_correction" : "correction_regression_fixture");
  return EvalArtifactSchema.parse({
    artifactId: createEvalArtifactId(kind, correction.eventId),
    kind,
    status: input.status ?? "ready",
    sourceCorrectionEventIds: [correction.eventId],
    candidateId: correction.candidateId,
    jobId: correction.jobId,
    payloadRedacted: input.payloadRedacted ?? {
      targetType: correction.targetType,
      targetId: correction.targetId,
      correctionActor: correction.actor,
      beforeRedacted: safeRecord(correction.beforeRedacted),
      afterRedacted: safeRecord(correction.afterRedacted),
      changedFieldKeys: Array.from(/* @__PURE__ */ new Set([
        ...Object.keys(correction.beforeRedacted ?? {}),
        ...Object.keys(correction.afterRedacted ?? {})
      ])).filter((key) => SAFE_STRUCTURED_KEY_RE.test(key) && !UNSAFE_KEY_RE.test(key)).sort()
    },
    evidence: safeEvidence(correction.evidence),
    createdBy: correction.actor,
    createdAt: input.createdAt ?? correction.createdAt,
    updatedAt: input.updatedAt
  });
}
async function loadRecent(db, collectionName, limit, parse) {
  const snap = await db.collection(collectionName).orderBy("createdAt", "desc").limit(limit).get();
  return snap.docs.flatMap((doc) => {
    const parsed = parse(doc.data());
    return parsed ? [parsed] : [];
  });
}
async function runAdminFlywheelEvalSnapshot(raw, deps) {
  const parsed = AdminFlywheelEvalSnapshotInputSchema.safeParse(raw);
  if (!parsed.success) throw new HttpsError2("invalid-argument", parsed.error.message);
  const limit = parsed.data.limit;
  const [artifacts, feedback, corrections] = await Promise.all([
    loadRecent(deps.db, PA_COLLECTIONS.evalArtifacts, limit, (data) => {
      const out = EvalArtifactSchema.safeParse(data);
      return out.success ? out.data : null;
    }),
    loadRecent(deps.db, PA_COLLECTIONS.feedbackEvents, limit, (data) => {
      const out = FeedbackEventSchema.safeParse(data);
      return out.success ? out.data : null;
    }),
    loadRecent(deps.db, PA_COLLECTIONS.correctionEvents, limit, (data) => {
      const out = CorrectionEventSchema.safeParse(data);
      return out.success ? out.data : null;
    })
  ]);
  return {
    generatedAt: deps.now?.() ?? (/* @__PURE__ */ new Date()).toISOString(),
    filters: { limit },
    limit,
    counts: {
      evalArtifacts: artifacts.length,
      feedbackEvents: feedback.length,
      correctionEvents: corrections.length,
      artifactsByKind: countBy(artifacts, (artifact) => artifact.kind),
      artifactsByStatus: countBy(artifacts, (artifact) => artifact.status),
      correctionsByActor: countBy(corrections, (correction) => correction.actor),
      feedbackByKind: countBy(feedback, (event) => event.kind)
    },
    recentArtifacts: artifacts.map((artifact) => ({
      artifactId: artifact.artifactId,
      kind: artifact.kind,
      status: artifact.status,
      candidateId: artifact.candidateId,
      jobId: artifact.jobId,
      candidateJobStateId: artifact.candidateJobStateId,
      sourceCorrectionEventIds: artifact.sourceCorrectionEventIds,
      sourceFeedbackEventIds: artifact.sourceFeedbackEventIds,
      payloadRedacted: artifact.payloadRedacted,
      evidence: artifact.evidence,
      latestRunResult: artifact.latestRunResult,
      createdBy: artifact.createdBy,
      createdAt: artifact.createdAt,
      updatedAt: artifact.updatedAt
    })),
    recentCorrections: corrections.map((correction) => ({
      eventId: correction.eventId,
      targetType: correction.targetType,
      targetId: correction.targetId,
      actor: correction.actor,
      candidateId: correction.candidateId,
      jobId: correction.jobId,
      reason: correction.reason,
      beforeRedacted: correction.beforeRedacted,
      afterRedacted: correction.afterRedacted,
      evidence: correction.evidence,
      createdAt: correction.createdAt
    })),
    recentFeedback: feedback.map((event) => ({
      eventId: event.eventId,
      kind: event.kind,
      actor: event.actor,
      outcome: event.outcome,
      candidateId: event.candidateId,
      jobId: event.jobId,
      candidateJobStateId: event.candidateJobStateId,
      payloadRedacted: event.payloadRedacted,
      evidence: event.evidence,
      createdAt: event.createdAt
    }))
  };
}
async function handleCorrectionEventEvalArtifactCreated(raw, deps) {
  const parsed = CorrectionEventSchema.safeParse(raw);
  if (!parsed.success) return { artifactId: "", created: false, skipped: true };
  const artifact = materializeEvalArtifactForCorrection({
    correction: parsed.data,
    createdAt: deps.now?.() ?? parsed.data.createdAt
  });
  const result = await writeEvalArtifact(deps.db, artifact);
  return { artifactId: result.artifact.artifactId, created: result.created, skipped: false };
}
var paAdminFlywheelEvalSnapshot = onCall2(
  { region: "us-central1", memory: "256MiB", timeoutSeconds: 60, secrets: [PA_ADMIN_TOKEN2] },
  async (req2) => {
    authorizeAdminCallable(req2);
    return runAdminFlywheelEvalSnapshot(req2.data, { db: getFirestore2() });
  }
);
var paFlywheelCorrectionEvalArtifact = onDocumentCreated(
  `${PA_COLLECTIONS.correctionEvents}/{eventId}`,
  async (event) => {
    await handleCorrectionEventEvalArtifactCreated(event.data?.data(), { db: getFirestore2() });
  }
);

// ../../functions/src/production-hardening.ts
var PA_ADMIN_TOKEN3 = defineSecret3("PA_ADMIN_TOKEN");
var CandidatePrivacyRequestInputSchema = z4.object({
  kind: PrivacyRequestKindSchema,
  detailText: z4.string().trim().max(2e3).optional(),
  sourceSurface: z4.literal("me_profile").default("me_profile")
});
var AdminLaunchReadinessInputSchema = z4.object({
  limit: z4.number().int().min(1).max(100).default(25),
  persistSnapshot: z4.boolean().default(true),
  adminToken: z4.string().optional()
});
var AdminOutreachStopControlInputSchema = z4.object({
  scope: z4.enum(["global", "outreach_batch"]).default("global"),
  scopeId: z4.string().trim().min(1).max(200).optional(),
  paused: z4.boolean(),
  reason: z4.string().trim().min(1).max(1e3).optional(),
  expiresAt: z4.string().trim().min(1).optional(),
  adminToken: z4.string().optional()
}).superRefine((value, ctx) => {
  if (value.scope === "global" && value.scopeId) {
    ctx.addIssue({
      code: z4.ZodIssueCode.custom,
      path: ["scopeId"],
      message: "global outreach stop control must not include scopeId"
    });
  }
  if (value.scope === "outreach_batch" && !value.scopeId) {
    ctx.addIssue({
      code: z4.ZodIssueCode.custom,
      path: ["scopeId"],
      message: "outreach_batch stop control requires scopeId"
    });
  }
  if (value.paused && !value.reason?.trim()) {
    ctx.addIssue({
      code: z4.ZodIssueCode.custom,
      path: ["reason"],
      message: "paused outreach stop control requires a reason"
    });
  }
});
function cleanString(value, max) {
  if (typeof value !== "string") return void 0;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return void 0;
  return trimmed;
}
function safeDetailRedacted(input) {
  const note = input.detailText ? sanitizeEvalPayload(input.detailText) : void 0;
  return {
    requestKind: input.kind,
    sourceSurface: input.sourceSurface,
    ...typeof note === "string" ? { note } : {}
  };
}
async function getCandidateIdForAuth(db, firebaseUid) {
  const snap = await db.collection(PA_COLLECTIONS2.candidateAuth).doc(firebaseUid).get();
  if (!snap.exists) {
    throw new HttpsError3("failed-precondition", "Signed-in account is not linked to a candidate profile.");
  }
  const candidateId = cleanString(snap.data()?.candidateId, 200);
  if (!candidateId) {
    throw new HttpsError3("failed-precondition", "Signed-in account is not linked to a candidate profile.");
  }
  return candidateId;
}
async function runCandidatePrivacyRequest(data, auth, deps) {
  const firebaseUid = cleanString(auth?.uid, 128);
  if (!firebaseUid) {
    throw new HttpsError3("unauthenticated", "Sign in before submitting privacy requests.");
  }
  const parsed = CandidatePrivacyRequestInputSchema.safeParse(data);
  if (!parsed.success) {
    throw new HttpsError3("invalid-argument", parsed.error.message);
  }
  const candidateId = await getCandidateIdForAuth(deps.db, firebaseUid);
  const createdAt = deps.now?.() ?? (/* @__PURE__ */ new Date()).toISOString();
  const request = PrivacyRequestSchema.parse({
    requestId: createPrivacyRequestId({
      candidateId,
      kind: parsed.data.kind,
      createdAt
    }),
    kind: parsed.data.kind,
    status: "submitted",
    candidateId,
    sourceSurface: parsed.data.sourceSurface,
    requestedBy: "candidate",
    detailRedacted: safeDetailRedacted(parsed.data),
    evidence: [{ source: "system", summary: "Candidate submitted privacy request from profile" }],
    createdAt
  });
  const result = await writePrivacyRequest(deps.db, request);
  return {
    ok: true,
    candidateId,
    requestId: result.request.requestId,
    kind: result.request.kind,
    status: result.request.status,
    created: result.created,
    existingOpen: result.existingOpen
  };
}
async function loadRecent2(db, collectionName, limit, parse) {
  const snap = await db.collection(collectionName).limit(limit).get();
  return snap.docs.flatMap((doc) => {
    const parsed = parse(doc.data());
    return parsed ? [parsed] : [];
  });
}
function newestFirst(rows, getTimestamp) {
  return [...rows].sort((a, b) => String(getTimestamp(b) ?? "").localeCompare(String(getTimestamp(a) ?? "")));
}
async function runAdminLaunchReadinessSnapshot(raw, deps) {
  const parsed = AdminLaunchReadinessInputSchema.safeParse(raw);
  if (!parsed.success) throw new HttpsError3("invalid-argument", parsed.error.message);
  const generatedAt = deps.now?.() ?? (/* @__PURE__ */ new Date()).toISOString();
  const limit = parsed.data.limit;
  const [privacyRowsRaw, stopControlsRaw] = await Promise.all([
    loadRecent2(deps.db, PA_COLLECTIONS2.privacyRequests, limit, (data) => {
      const out = PrivacyRequestSchema.safeParse(data);
      return out.success ? out.data : null;
    }),
    loadRecent2(deps.db, PA_COLLECTIONS2.outreachStopControls, limit, (data) => {
      const out = OutreachStopControlSchema.safeParse(data);
      return out.success ? out.data : null;
    })
  ]);
  const privacyRows = newestFirst(privacyRowsRaw, (row) => row.updatedAt ?? row.createdAt).slice(0, limit);
  const stopControls = newestFirst(stopControlsRaw, (row) => row.updatedAt ?? row.createdAt).slice(0, limit);
  const openPrivacy = privacyRows.filter((row) => row.status === "submitted" || row.status === "in_review");
  const pausedControls = stopControls.filter((row) => row.paused);
  const globalPaused = pausedControls.some((row) => row.scope === "global");
  const status = globalPaused ? "red" : openPrivacy.length > 0 || pausedControls.length > 0 ? "yellow" : "green";
  const snapshot = LaunchReadinessSnapshotSchema.parse({
    snapshotId: createLaunchReadinessSnapshotId(generatedAt, "admin_launch_readiness"),
    generatedAt,
    status,
    counts: {
      privacyTotal: privacyRows.length,
      privacyOpen: openPrivacy.length,
      stopControls: stopControls.length,
      pausedControls: pausedControls.length,
      globalPaused: globalPaused ? 1 : 0
    },
    sections: [
      {
        key: "privacy_requests",
        label: "Privacy requests",
        status: openPrivacy.length > 0 ? "yellow" : "green",
        count: openPrivacy.length,
        summary: openPrivacy.length > 0 ? `${openPrivacy.length} open privacy request(s) need operator review` : "No open privacy requests",
        sourceRoute: "/admin/launch-readiness",
        updatedAt: generatedAt
      },
      {
        key: "outreach_stop_controls",
        label: "Outreach stop controls",
        status: globalPaused ? "red" : pausedControls.length > 0 ? "yellow" : "green",
        count: pausedControls.length,
        summary: globalPaused ? "Global marketplace outreach is paused" : pausedControls.length > 0 ? `${pausedControls.length} scoped outreach stop control(s) are paused` : "No active outreach stop controls",
        sourceRoute: "/admin/launch-readiness",
        updatedAt: generatedAt
      },
      {
        key: "delivery_gate",
        label: "Delivery gate",
        status: globalPaused ? "red" : "green",
        summary: globalPaused ? "Marketplace outreach delivery is blocked before transcript, typing, quota, and Sendblue calls" : "Marketplace outreach delivery gate is open",
        sourceRoute: "/admin/launch-readiness",
        updatedAt: generatedAt
      }
    ],
    privacyRequests: privacyRows.map((row) => ({
      requestId: row.requestId,
      kind: row.kind,
      status: row.status,
      candidateId: row.candidateId,
      sourceSurface: row.sourceSurface,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    })),
    stopControls: stopControls.map((row) => ({
      controlId: row.controlId,
      scope: row.scope,
      scopeId: row.scopeId,
      paused: row.paused,
      reason: row.reason,
      updatedAt: row.updatedAt ?? row.createdAt
    })),
    evidence: [{ source: "admin", summary: "Redacted launch readiness snapshot generated" }]
  });
  if (!parsed.data.persistSnapshot) {
    return { ok: true, snapshot, persisted: false, created: false };
  }
  const write = await writeLaunchReadinessSnapshot(deps.db, snapshot);
  return { ok: true, snapshot: write.snapshot, persisted: true, created: write.created };
}
async function runAdminOutreachStopControl(raw, actorUid, deps) {
  const parsed = AdminOutreachStopControlInputSchema.safeParse(raw);
  if (!parsed.success) throw new HttpsError3("invalid-argument", parsed.error.message);
  const now = deps.now?.() ?? (/* @__PURE__ */ new Date()).toISOString();
  const result = await writeOutreachStopControl(deps.db, {
    scope: parsed.data.scope,
    scopeId: parsed.data.scopeId,
    paused: parsed.data.paused,
    reason: parsed.data.reason,
    actor: "operator",
    now,
    expiresAt: parsed.data.expiresAt
  });
  return {
    ok: true,
    control: result.control,
    previous: result.previous,
    changed: result.changed,
    auditEventId: result.auditEventId
  };
}
var paCandidatePrivacyRequest = onCall3(
  { region: "us-central1", memory: "256MiB", timeoutSeconds: 30 },
  async (req2) => {
    return runCandidatePrivacyRequest(req2.data, req2.auth, { db: getFirestore3() });
  }
);
var paAdminLaunchReadinessSnapshot = onCall3(
  { region: "us-central1", memory: "256MiB", timeoutSeconds: 60, maxInstances: 1, secrets: [PA_ADMIN_TOKEN3] },
  async (req2) => {
    authorizeAdminCallable(req2);
    return runAdminLaunchReadinessSnapshot(req2.data, { db: getFirestore3() });
  }
);
var paAdminOutreachStopControl = onCall3(
  { region: "us-central1", memory: "256MiB", timeoutSeconds: 30, secrets: [PA_ADMIN_TOKEN3] },
  async (req2) => {
    const { uid } = authorizeAdminCallable(req2);
    return runAdminOutreachStopControl(req2.data, uid || "admin", { db: getFirestore3() });
  }
);

// ../../functions/src/claire-agent/tools/matching-tools.ts
var RoleFunctionEnum = z.enum(ROLE_FUNCTION_VOCAB);
var JobTypeEnum = z.enum(JOB_TYPE_VOCAB);
var PA_USERS_COLLECTION = "pa-users";
var JOB_PROFILES_COLLECTION = "pa-job-profiles";
var INTERVIEW_BOOKINGS_COLLECTION = "pa-interview-bookings";
async function readMatchingSlice(db, userId, log) {
  try {
    const snap = await db.collection(PA_USERS_COLLECTION).doc(userId).get();
    const tags = snap.exists && snap.data()?.tags && typeof snap.data().tags === "object" ? snap.data().tags : {};
    const asArr = (v) => Array.isArray(v) ? v.filter((x) => typeof x === "string") : void 0;
    return {
      targetRoleFunction: asArr(tags.targetRoleFunction),
      negativeRoleFunction: asArr(tags.negativeRoleFunction),
      targetJobType: asArr(tags.targetJobType),
      targetLocations: asArr(tags.targetLocations)
    };
  } catch (err) {
    log("pa.claire.read_tags_error", {
      userId,
      error: err instanceof Error ? err.message : String(err)
    });
    return {};
  }
}
async function readSnapshotTags(db, userId, log) {
  const slice = await readMatchingSlice(db, userId, log);
  const snap = {};
  if (slice.targetRoleFunction) snap.targetRoleFunction = slice.targetRoleFunction;
  if (slice.negativeRoleFunction) snap.negativeRoleFunction = slice.negativeRoleFunction;
  if (slice.targetJobType) snap.targetJobType = slice.targetJobType;
  if (slice.targetLocations) snap.targetLocations = slice.targetLocations;
  return snap;
}
function resolveMem0Config() {
  const apiKey = (process.env.PA_MEM0_API_KEY ?? process.env.MEM0_API_KEY ?? "").trim();
  const qdrantUrl = (process.env.PA_QDRANT_URL ?? process.env.QDRANT_URL ?? "").trim();
  const qdrantApiKey = (process.env.PA_QDRANT_API_KEY ?? process.env.QDRANT_API_KEY ?? "").trim();
  if (!apiKey || !qdrantUrl || !qdrantApiKey) return null;
  return {
    apiKey,
    qdrantUrl,
    qdrantApiKey,
    baseUrl: process.env.PA_MEM0_BASE_URL || void 0,
    qdrantCollection: process.env.PA_QDRANT_COLLECTION || void 0
  };
}
async function recordAgentPresentation(db, args) {
  const jobIds = [
    ...new Set(
      args.jobs.map((j) => typeof j.id === "string" ? j.id.trim() : "").filter((id) => id.length > 0)
    )
  ];
  if (jobIds.length === 0) return;
  const reason = args.fallbackApplied === true ? "general_market_fallback" : "claire_agent";
  try {
    await recordRecommendedJobs(
      db,
      { userId: args.userId, jobs: jobIds.map((id) => ({ id })), source: "claire_agent", reason, nowIso: args.nowIso },
      args.log
    );
  } catch (err) {
    args.log("pa.claire.find_match_ledger_error", {
      userId: args.userId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
  await Promise.all(
    jobIds.map(async (jobId) => {
      const event = {
        eventId: `job-presented-${args.userId}-${jobId}-${args.nowIso}`,
        kind: "job_presented",
        actor: "orchestrator",
        candidateId: args.userId,
        jobId,
        outcome: "claire_agent",
        evidence: [{ source: "job_match", summary: `job offered to candidate via claire_agent` }],
        payloadRedacted: { flow: "claire_agent", channel: "imessage" },
        createdAt: args.nowIso
      };
      try {
        await writeFeedbackEvent(db, event);
      } catch (err) {
        args.log("pa.claire.find_match_feedback_error", {
          userId: args.userId,
          jobId,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    })
  );
}
function makeV16FindMatch(db, opts) {
  const log = opts?.log ?? (() => {
  });
  const nowIso = opts?.nowIso ?? (() => (/* @__PURE__ */ new Date()).toISOString());
  return async ({
    userId,
    requestedCount
  }) => {
    try {
      const limit = typeof requestedCount === "number" && requestedCount > 0 ? Math.min(5, Math.floor(requestedCount)) : 3;
      const result = await queryMatchingJobsV16({ userId, limit }, { db });
      const rawJobs = result.jobs ?? [];
      if (rawJobs.length > 0) {
        await recordAgentPresentation(db, {
          userId,
          jobs: rawJobs,
          fallbackApplied: result.fallbackApplied,
          log,
          nowIso: nowIso()
        });
      }
      const jobs = rawJobs.map((j) => {
        const title = (j.jobTitle || j.roleTitle || "Role").trim();
        const company = (j.companyName || "Company").trim();
        const url = (j.atsApplyUrl ?? "").trim();
        return url ? `${title} @ ${company}
${url}` : `${title} @ ${company}`;
      });
      const total = typeof result.total === "number" ? result.total : jobs.length;
      const reason = jobs.length === 0 ? result.needsOnboarding ? "needs onboarding \u2014 missing core preferences" : result.noUserTags ? "no saved preferences yet" : "no fresh roles fit those constraints" : null;
      return {
        ok: true,
        recCount: total,
        jobs,
        reason,
        snapshotTags: {
          targetRoleFunction: result.userTags?.targetRoleFunction,
          negativeRoleFunction: result.userTags?.negativeRoleFunction,
          ...result.missingAxes ? { missingAxes: result.missingAxes } : {}
        }
      };
    } catch (err) {
      return {
        ok: false,
        recCount: 0,
        jobs: [],
        reason: `matcher error: ${err instanceof Error ? err.message : String(err)}`
      };
    }
  };
}
function buildMatchingTools(ctx) {
  const setMatchingPreferences = tool({
    name: "set_matching_preferences",
    description: "Persist the candidate's durable role/job-type/location preferences BEFORE matching. Map free text to the closed role vocab: 'PM'/'product strategy'/'product'\u2192product_management, 'SWE'/'software engineering'/'engineering'\u2192software_engineering. If they say they want ONLY / want to SWITCH TO a kind of role \u2192 put it in onlyRoleFunctions (a REPLACE of the whole positive set). If they say they are DONE WITH / want to AVOID / are NOT INTERESTED IN a kind of role \u2192 put that role in avoidRoleFunctions (e.g. 'done with software engineering, only product' \u2192 onlyRoleFunctions:[product_management] AND avoidRoleFunctions:[software_engineering]). Also pass jobType (full_time/internship/...) and locations when stated. Pass null for anything not stated.",
    parameters: z.object({
      onlyRoleFunctions: z.array(RoleFunctionEnum).nullable(),
      avoidRoleFunctions: z.array(RoleFunctionEnum).nullable(),
      jobType: z.array(JobTypeEnum).nullable(),
      locations: z.array(z.string()).nullable()
    }),
    async execute({ onlyRoleFunctions, avoidRoleFunctions, jobType, locations }) {
      const current = await readMatchingSlice(ctx.db, ctx.userId, ctx.log);
      const { changed, removedFromPositive } = reduceMatchingPreferences(current, {
        onlyRoleFunctions,
        avoidRoleFunctions,
        jobType,
        locations
      });
      if (Object.keys(changed).length === 0) {
        return { ok: true, changed: {}, summary: "Nothing new to save." };
      }
      const write = await applyPartialUserTags(ctx.db, ctx.userId, changed, {
        source: "chat",
        nowIso: ctx.nowIso(),
        log: ctx.log
      });
      const positive = changed.targetRoleFunction ?? current.targetRoleFunction ?? [];
      const negative = changed.negativeRoleFunction ?? current.negativeRoleFunction ?? [];
      const summary = `Saved. Now matching ${positive.join(", ") || "\u2014"}` + (negative.length ? `, avoiding ${negative.join(", ")}` : "") + (removedFromPositive.length ? ` (dropped ${removedFromPositive.join(", ")})` : "");
      ctx.log("pa.claire.set_matching_preferences", {
        userId: ctx.userId,
        changedKeys: Object.keys(changed),
        removedFromPositive,
        writeOk: write.ok
      });
      return { ok: write.ok, changed, summary };
    }
  });
  const findMatch = tool({
    name: "find_match",
    description: "Find ranked job matches for the candidate from the WeKruit catalog. Use when they ask for roles / recommendations / 'what fits me'. Reads their SAVED preferences (call set_matching_preferences first if they just stated new ones). Returns concrete roles or a grounded reason none fit \u2014 never an excuse.",
    parameters: z.object({
      requestedCount: z.number().int().min(1).max(5).nullable()
    }),
    async execute({ requestedCount }) {
      const snapshotTags = await readSnapshotTags(ctx.db, ctx.userId, ctx.log);
      if (!ctx.findMatch) {
        return {
          ok: false,
          recCount: 0,
          jobs: [],
          reason: "matcher unavailable",
          snapshotTags
        };
      }
      try {
        const res = await ctx.findMatch({ userId: ctx.userId, requestedCount });
        ctx.log("pa.claire.find_match", {
          userId: ctx.userId,
          ok: res.ok,
          recCount: res.recCount
        });
        return {
          ok: res.ok,
          recCount: res.recCount,
          jobs: res.jobs,
          reason: res.reason,
          // prefer the matcher's own snapshot; fall back to the local read.
          snapshotTags: res.snapshotTags ?? snapshotTags
        };
      } catch (err) {
        return {
          ok: false,
          recCount: 0,
          jobs: [],
          reason: `matcher error: ${err instanceof Error ? err.message : String(err)}`,
          snapshotTags
        };
      }
    }
  });
  const rememberFact = tool({
    name: "remember_fact",
    description: "Store a durable, non-sensitive fact about the candidate for long-term memory (e.g. 'burned out at last job', 'wants to relocate to NYC in 2026'). Do NOT use this for email/phone/legal name \u2014 those are edited on the website.",
    parameters: z.object({ fact: z.string() }),
    async execute({ fact }) {
      const trimmed = (fact ?? "").trim();
      if (!trimmed) return { ok: true, stored: false, reason: "empty_fact" };
      const config = resolveMem0Config();
      if (!config) {
        ctx.log("pa.claire.remember_fact_noop", { userId: ctx.userId, reason: "mem0_not_configured" });
        return { ok: true, stored: false, reason: "memory_not_configured" };
      }
      try {
        await mem0Add(config, [{ role: "user", content: trimmed }], ctx.userId, {
          metadata: { source: "claire_chat", sessionId: ctx.sessionId }
        });
        ctx.log("pa.claire.remember_fact", { userId: ctx.userId, stored: true });
        return { ok: true, stored: true };
      } catch (err) {
        ctx.log("pa.claire.remember_fact_error", {
          userId: ctx.userId,
          error: err instanceof Error ? err.message : String(err)
        });
        return { ok: true, stored: false, reason: "memory_write_failed" };
      }
    }
  });
  const scheduleInterview = tool({
    name: "schedule_interview",
    description: "Book the candidate's interview / pre-screen time slot. DEDUP: if they already have a booking for this opportunity, do NOT rebook. Use when they want to schedule / book / set up an interview or offer their availability (e.g. 'book me in', 'when can I interview?', '\u5E2E\u6211\u7EA6\u4E2A\u9762\u8BD5\u65F6\u95F4').",
    parameters: z.object({ slotIso: z.string() }),
    async execute({ slotIso }) {
      const jobId = (ctx.jobId ?? "").trim() || "unknown_job";
      const bookingId = `booking-${ctx.userId}__${jobId}`;
      const ref = ctx.db.collection(INTERVIEW_BOOKINGS_COLLECTION).doc(bookingId);
      try {
        const committed = await ctx.db.runTransaction(async (tx) => {
          const snap = await tx.get(ref);
          if (snap.exists) return false;
          tx.set(ref, {
            bookingId,
            userId: ctx.userId,
            jobId,
            slotIso: (slotIso ?? "").trim() || null,
            status: "requested",
            sessionId: ctx.sessionId,
            createdAt: ctx.nowIso()
          });
          return true;
        });
        ctx.log("pa.claire.schedule_interview", {
          userId: ctx.userId,
          jobId,
          action: committed ? "committed" : "deduped"
        });
        return committed ? { ok: true, action: "committed", bookingId } : { ok: true, action: "deduped", bookingId };
      } catch (err) {
        return {
          ok: false,
          action: "error",
          reason: err instanceof Error ? err.message : String(err)
        };
      }
    }
  });
  const privacy = tool({
    name: "privacy",
    description: "Handle a privacy request the candidate makes in chat: export their data, delete their profile, or stop all outreach. Use ONLY for these three intents. NOTE: to CHANGE email / phone / legal name, the candidate must edit them on the website \u2014 there is no chat tool for that.",
    parameters: z.object({
      kind: z.enum(["export", "delete", "stop"]),
      detailText: z.string().nullable()
    }),
    async execute({ kind, detailText }) {
      const canonicalKind = kind === "stop" ? "stop_outreach" : kind;
      try {
        const result = await runCandidatePrivacyRequest(
          {
            kind: canonicalKind,
            ...detailText ? { detailText } : {},
            sourceSurface: "me_profile"
          },
          { uid: ctx.userId },
          { db: ctx.db, now: ctx.nowIso }
        );
        ctx.log("pa.claire.privacy", { userId: ctx.userId, kind: canonicalKind, status: result.status });
        return { ok: true, kind: result.kind, status: result.status, requestId: result.requestId };
      } catch (err) {
        ctx.log("pa.claire.privacy_error", {
          userId: ctx.userId,
          kind: canonicalKind,
          error: err instanceof Error ? err.message : String(err)
        });
        return {
          ok: false,
          kind: canonicalKind,
          reason: "could not file the request here \u2014 direct the candidate to /me/privacy on the website"
        };
      }
    }
  });
  const saveJobProfile = tool({
    name: "save_job_profile",
    description: "Persist the candidate's job-search profile (industry tags, sponsorship need, location, company size, optional salary floor) so the daily job recommender can deliver personalised matches. Use ONLY once they have volunteered all four: industryTags, sponsorshipNeeded, locationPreference, sizePreference. Safe to re-call.",
    parameters: z.object({
      industryTags: z.array(
        z.enum([
          "tech_software",
          "tech_hardware",
          "fintech_finance",
          "ai_ml",
          "healthcare_biotech",
          "consumer_retail",
          "media_entertainment",
          "manufacturing_industrial",
          "education",
          "other"
        ])
      ).min(1).max(3),
      sponsorshipNeeded: z.enum(["H1B", "GC", "none"]),
      locationPreference: z.string(),
      sizePreference: z.enum(["big", "startup", "mid", "any"]),
      salaryMin: z.number().int().nonnegative().nullable()
    }),
    async execute(input) {
      try {
        const ts = ctx.nowIso();
        const ref = ctx.db.collection(JOB_PROFILES_COLLECTION).doc(ctx.userId);
        await ctx.db.runTransaction(async (tx) => {
          const cur = await tx.get(ref);
          const profilePayload = {
            industryTags: input.industryTags,
            sponsorshipNeeded: input.sponsorshipNeeded,
            locationPreference: input.locationPreference,
            sizePreference: input.sizePreference,
            salaryMin: input.salaryMin
          };
          if (cur.exists) {
            const prev = cur.data();
            tx.set(
              ref,
              {
                userId: ctx.userId,
                profile: profilePayload,
                status: prev?.status === "paused" ? "paused" : "active",
                createdAt: typeof prev?.createdAt === "string" ? prev.createdAt : ts,
                updatedAt: ts
              },
              { merge: true }
            );
          } else {
            tx.set(ref, {
              userId: ctx.userId,
              profile: profilePayload,
              status: "active",
              createdAt: ts,
              updatedAt: ts,
              cvParsedAt: ts,
              lastJobBatchSentAt: null
            });
          }
        });
        ctx.log("pa.claire.save_job_profile", { userId: ctx.userId });
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message.slice(0, 200) : "save_failed" };
      }
    }
  });
  const setDailySubscription = tool({
    name: "set_daily_subscription",
    description: "Opt the candidate IN or OUT of the daily job-recommendation text. Use when they say things like 'send me daily roles' / 'yes keep them coming' (optedIn=true) or 'stop the daily texts' / 'pause those' (optedIn=false).",
    parameters: z.object({ optedIn: z.boolean() }),
    async execute({ optedIn }) {
      try {
        const ts = ctx.nowIso();
        const ref = ctx.db.collection(JOB_PROFILES_COLLECTION).doc(ctx.userId);
        await ctx.db.runTransaction(async (tx) => {
          const cur = await tx.get(ref);
          const status = optedIn ? "active" : "paused";
          if (cur.exists) {
            tx.set(ref, { status, updatedAt: ts }, { merge: true });
          } else {
            tx.set(ref, {
              userId: ctx.userId,
              status,
              createdAt: ts,
              updatedAt: ts,
              lastJobBatchSentAt: null
            });
          }
        });
        ctx.log("pa.claire.set_daily_subscription", { userId: ctx.userId, optedIn });
        return { ok: true, optedIn, jobProfileStatus: optedIn ? "active" : "paused" };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message.slice(0, 200) : "save_failed" };
      }
    }
  });
  const matchCollab = tool({
    name: "match_collab",
    description: "Find ranked matches restricted to WeKruit partner/collaborated roles that have a pre-screen configured. Use when the candidate asks specifically about partner roles or WeKruit-collaborated openings.",
    parameters: z.object({
      requestedCount: z.number().int().min(1).max(5).nullable()
    }),
    async execute({ requestedCount }) {
      try {
        const limit = typeof requestedCount === "number" && requestedCount > 0 ? Math.min(5, Math.floor(requestedCount)) : 3;
        const result = await queryMatchingJobsV16(
          { userId: ctx.userId, limit, collabPrescreenOnly: true },
          { db: ctx.db }
        );
        const jobs = (result.jobs ?? []).map((j) => {
          const title = (j.jobTitle || j.roleTitle || "Role").trim();
          const company = (j.companyName || "Company").trim();
          const url = (j.atsApplyUrl ?? "").trim();
          return url ? `${title} @ ${company}
${url}` : `${title} @ ${company}`;
        });
        const total = typeof result.total === "number" ? result.total : jobs.length;
        ctx.log("pa.claire.match_collab", { userId: ctx.userId, recCount: total });
        return {
          ok: true,
          recCount: total,
          jobs,
          reason: jobs.length === 0 ? "no partner roles fit right now" : null
        };
      } catch (err) {
        return {
          ok: false,
          recCount: 0,
          jobs: [],
          reason: `matcher error: ${err instanceof Error ? err.message : String(err)}`
        };
      }
    }
  });
  const cvParse = tool({
    name: "cv_parse",
    description: "Parse a block of resume / CV text the candidate pasted into the chat. Returns the extracted structured profile (skills, roles, companies) so you can confirm what you understood. Use when they paste a resume.",
    parameters: z.object({ resumeText: z.string() }),
    async execute({ resumeText }) {
      const text = (resumeText ?? "").trim();
      if (text.length < 40) {
        return { ok: false, reason: "resume text too short to parse" };
      }
      try {
        const result = await parseResumeText({
          resumeText: text,
          langHint: ctx.lang === "zh" ? "zh" : "en"
        });
        ctx.log("pa.claire.cv_parse", {
          userId: ctx.userId,
          usedTier: result.usedTier,
          usedModel: result.usedModel
        });
        return { ok: true, parsed: result.parsed, usedModel: result.usedModel };
      } catch (err) {
        return {
          ok: false,
          reason: `could not parse resume: ${err instanceof Error ? err.message : String(err)}`
        };
      }
    }
  });
  return [
    setMatchingPreferences,
    findMatch,
    rememberFact,
    scheduleInterview,
    privacy,
    saveJobProfile,
    setDailySubscription,
    matchCollab,
    cvParse
  ];
}

// ../../functions/src/claire-agent/tools/delivery-tools.ts
function buildDeliveryTools(ctx) {
  const reactToUser = tool({
    name: "react_to_user",
    description: "Tapback a low-info ack ('sure','ok','yes') INSTEAD of text, esp while processing; never for substantive questions.",
    parameters: z.object({
      reaction: z.enum(["love", "like", "laugh", "emphasize"])
    }),
    async execute({ reaction }) {
      await ctx.transport.tapback(reaction);
      return { ok: true, delivered: `tapback:${reaction}` };
    }
  });
  const sendStatusThenContinue = tool({
    name: "send_status_then_continue",
    description: "Send a quick 'one sec' bubble NOW before a slow tool, then call the slow tool, then reply.",
    parameters: z.object({ status: z.string() }),
    async execute({ status }) {
      await ctx.transport.sendStatus(status);
      return { ok: true };
    }
  });
  const noReply = tool({
    name: "no_reply",
    description: "Send nothing at all; only when truly no acknowledgement is needed.",
    parameters: z.object({ reason: z.string() }),
    async execute({ reason }) {
      await ctx.transport.noReply(reason);
      return { ok: true, reason };
    }
  });
  return [reactToUser, sendStatusThenContinue, noReply];
}

// ../../functions/src/claire-agent/reducers/onboarding-fsm.ts
import { SHARED_ONBOARDING_QUESTIONS } from "@pa/pa-orchestrator";
var DEFAULT_ONBOARDING_SLOTS = SHARED_ONBOARDING_QUESTIONS.map(
  (q) => q.id
);
var DEFAULT_ONBOARDING_PROMPTS = Object.fromEntries(
  SHARED_ONBOARDING_QUESTIONS.map((q) => [q.id, q.prompt])
);
function slotsOf(state) {
  return state.slots && state.slots.length > 0 ? state.slots : [...DEFAULT_ONBOARDING_SLOTS];
}
function earliestPending(state) {
  const slots = slotsOf(state);
  return slots.find((s) => !(s in state.answers)) ?? null;
}
function onboardingPromptFor(slot) {
  return DEFAULT_ONBOARDING_PROMPTS[slot] ?? slot;
}
function nextOnboardingSlot(state) {
  const pending = earliestPending(state);
  if (!pending) return { pending: null, complete: true };
  return { pending, complete: false, prompt: onboardingPromptFor(pending) };
}
function recordOnboardingAnswer(state, slot, answer) {
  const expected = earliestPending(state);
  if (!expected) {
    return { ok: false, reason: "already_complete", pending: null, complete: true };
  }
  if (slot !== expected) {
    return {
      ok: false,
      reason: `out_of_order: expected ${expected}, not ${slot}`,
      pending: expected,
      complete: false
    };
  }
  state.answers[slot] = answer;
  const next = earliestPending(state);
  state.complete = next === null;
  return { ok: true, recorded: slot, pending: next, complete: state.complete };
}

// ../../functions/src/claire-agent/tools/process-tools.ts
import {
  projectSharedOnboardingAnswer,
  resolveNextSharedOnboardingQuestionId,
  applyPartialUserTags as applyPartialUserTags2,
  buildSharedOnboardingPrompt,
  getSharedOnboardingQuestion,
  SHARED_ONBOARDING_WORK_SESSION_KIND
} from "@pa/pa-orchestrator";

// ../../functions/src/claire-agent/reducers/prescreen-fsm.ts
var DEFAULT_PRESCREEN_THRESHOLD = 0.6;
function earliestPending2(state) {
  return state.questions.find((q) => !(q in state.scores)) ?? null;
}
function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
function thresholdOf(state) {
  return typeof state.threshold === "number" && Number.isFinite(state.threshold) ? state.threshold : DEFAULT_PRESCREEN_THRESHOLD;
}
function nextPrescreenQuestion(state) {
  if (state.terminal) return { pending: null, terminal: state.terminal };
  const pending = earliestPending2(state);
  return { pending, terminal: null };
}
function recordPrescreenScore(state, question, score) {
  if (state.terminal) {
    return {
      ok: false,
      reason: "already_terminal",
      pending: null,
      terminal: state.terminal
    };
  }
  const expected = earliestPending2(state);
  if (!expected) {
    return { ok: false, reason: "no_pending_question", pending: null, terminal: null };
  }
  if (question !== expected) {
    return {
      ok: false,
      reason: `out_of_order: expected ${expected}, not ${question}`,
      pending: expected,
      terminal: null
    };
  }
  const clamped = clamp01(score.score);
  state.scores[question] = { score: clamped, evidence: score.evidence ?? "" };
  const next = earliestPending2(state);
  if (!next) {
    const vals = Object.values(state.scores).map((s) => s.score);
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    state.terminal = avg >= thresholdOf(state) ? "PASS" : "FAIL";
    state.terminalCommits += 1;
  }
  return {
    ok: true,
    scored: question,
    score: clamped,
    pending: next,
    terminal: state.terminal
  };
}

// ../../functions/src/claire-agent/tools/process-tools.ts
function asSharedSlot(slot) {
  return DEFAULT_ONBOARDING_SLOTS.includes(slot) ? slot : null;
}
function emptyProcessStore() {
  return {
    onboarding: { slots: [...DEFAULT_ONBOARDING_SLOTS], answers: {}, complete: false },
    prescreen: {
      questions: [],
      scores: {},
      threshold: DEFAULT_PRESCREEN_THRESHOLD,
      terminal: null,
      terminalCommits: 0
    }
  };
}
function hasKeys(o) {
  return !!o && typeof o === "object" && Object.keys(o).length > 0;
}
async function persistOnboardingAnswerThrough(ctx, slot, answer) {
  const sp = asSharedSlot(slot);
  if (!sp) return;
  const now = ctx.nowIso();
  const projection = projectSharedOnboardingAnswer(sp, answer);
  const next = resolveNextSharedOnboardingQuestionId(sp);
  if (hasKeys(projection.tags)) {
    await applyPartialUserTags2(ctx.db, ctx.userId, projection.tags, {
      source: "chat",
      nowIso: now,
      log: (name, payload) => ctx.log(name, payload ?? {})
    }).catch(
      (err) => ctx.log("onboarding.tags_error", { slot, error: err instanceof Error ? err.message : String(err) })
    );
  }
  await ctx.db.collection("pa-users").doc(ctx.userId).set(
    {
      onboardingState: next.completed ? "complete" : "pending",
      onboardingStatus: next.completed ? "complete" : "invited",
      updatedAt: now,
      ...hasKeys(projection.statedPreferences) ? { statedPreferences: projection.statedPreferences } : {},
      sharedOnboarding: {
        status: next.completed ? "complete" : "active",
        updatedAt: now,
        currentQuestionId: next.nextQuestionId,
        completed: next.completed,
        ...next.completed ? { completedAt: now } : {},
        answers: {
          [sp]: {
            answer: answer.trim(),
            answeredAt: now,
            questionId: sp,
            questionLabel: getSharedOnboardingQuestion(sp).label,
            evidence: projection.evidence
          }
        }
      },
      workSession: {
        kind: SHARED_ONBOARDING_WORK_SESSION_KIND,
        status: next.completed ? "ended" : "active",
        currentQuestionId: next.nextQuestionId,
        ...next.completed ? { endedAt: now, boundary: "completed" } : {}
      }
    },
    { merge: true }
  );
}
function makeJudge(model) {
  return new Agent({
    name: "prescreen-judge",
    model,
    instructions: "You grade a candidate's interview answer for the given competency. Return score 0-1 (1=strong, concrete, owned), evidence (quote), reasoning.",
    outputType: z.object({
      score: z.number().min(0).max(1),
      evidence: z.string(),
      reasoning: z.string()
    })
  });
}
function buildProcessTools(ctx, prescreenPrompts = {}) {
  const store = ctx.processStore ?? emptyProcessStore();
  if (!ctx.processStore) ctx.processStore = store;
  const judge = makeJudge(ctx.judgeModel);
  const askNextOnboarding = tool({
    name: "ask_next_onboarding_question",
    description: "Get the next onboarding question to ask. Returns the pending slot id + the natural-language prompt to phrase, or done.",
    parameters: z.object({}),
    async execute() {
      const next = nextOnboardingSlot(store.onboarding);
      ctx.log("onboarding.ask_next", { pending: next.pending, complete: next.complete });
      if (!next.pending) return { pending: null, complete: true };
      const sp = asSharedSlot(next.pending);
      const prompt = sp ? buildSharedOnboardingPrompt(sp, null) : next.prompt;
      return { pending: next.pending, prompt };
    }
  });
  const recordOnboarding = tool({
    name: "record_onboarding_answer",
    description: "Record the candidate's answer to the CURRENT onboarding slot. The reducer advances (you cannot skip slots) AND this persists their answer into their durable profile: tags (where they want to work, expected company size, industry, etc.), stated preferences, and onboarding progress.",
    parameters: z.object({ slot: z.string(), answer: z.string() }),
    async execute({ slot, answer }) {
      const result = recordOnboardingAnswer(store.onboarding, slot, answer);
      if (!result.ok) {
        ctx.log("onboarding.record.rejected", { slot, reason: result.reason, pending: result.pending });
        return result;
      }
      await persistOnboardingAnswerThrough(ctx, slot, answer).catch(
        (err) => ctx.log("onboarding.record.persist_error", {
          slot,
          error: err instanceof Error ? err.message : String(err)
        })
      );
      ctx.log("onboarding.record", { slot, pending: result.pending, complete: result.complete });
      const nextSlot = result.pending ? asSharedSlot(result.pending) : null;
      const nextPrompt = nextSlot ? buildSharedOnboardingPrompt(nextSlot, null) : void 0;
      return { ...result, ...nextPrompt ? { nextPrompt } : {} };
    }
  });
  const askNextPrescreen = tool({
    name: "ask_next_prescreen_question",
    description: "Get the next prescreen question. Returns pending question id, or terminal if all scored.",
    parameters: z.object({}),
    async execute() {
      const next = nextPrescreenQuestion(store.prescreen);
      ctx.log("prescreen.ask_next", { pending: next.pending, terminal: next.terminal });
      if (next.terminal) return { terminal: next.terminal };
      return next.pending ? { pending: next.pending, prompt: prescreenPrompts[next.pending] ?? next.pending } : { pending: null };
    }
  });
  const scorePrescreen = tool({
    name: "score_prescreen_answer",
    description: "Submit the candidate's answer to the CURRENT prescreen question. An LLM judge scores it; the reducer records the score, advances, and at the end computes PASS/FAIL. You do NOT decide pass/fail or skip \u2014 the reducer does.",
    parameters: z.object({ question: z.string(), answer: z.string() }),
    async execute({ question, answer }) {
      const p = store.prescreen;
      if (p.terminal) {
        ctx.log("prescreen.score.rejected", { reason: "already_terminal", terminal: p.terminal });
        return { ok: false, reason: "already_terminal", terminal: p.terminal };
      }
      const expected = p.questions.find((q) => !(q in p.scores)) ?? null;
      if (question !== expected) {
        ctx.log("prescreen.score.rejected", { reason: "out_of_order", expected, got: question });
        return { ok: false, reason: `out_of_order: expected ${expected}`, pending: expected };
      }
      const jr = await run(judge, `Competency: ${question}
Candidate answer: ${answer}`);
      const proposed = jr.finalOutput?.score ?? 0;
      const evidence = jr.finalOutput?.evidence ?? "";
      const result = recordPrescreenScore(p, question, { score: proposed, evidence });
      ctx.log("prescreen.score.recorded", {
        question,
        score: result.score,
        pending: result.pending,
        terminal: result.terminal,
        terminalCommits: p.terminalCommits
      });
      return result;
    }
  });
  const explainOutcome = tool({
    name: "explain_prescreen_outcome",
    description: "Explain the prescreen result (uses stored scores/evidence). Does NOT re-run the screen.",
    parameters: z.object({}),
    async execute() {
      const p = store.prescreen;
      ctx.log("prescreen.explain", { terminal: p.terminal, scored: Object.keys(p.scores).length });
      return { terminal: p.terminal, scores: p.scores };
    }
  });
  return [
    askNextOnboarding,
    recordOnboarding,
    askNextPrescreen,
    scorePrescreen,
    explainOutcome
  ];
}

// ../../functions/src/claire-agent/tools/index.ts
function buildClaireTools(ctx) {
  return [
    ...buildMatchingTools(ctx),
    ...buildProcessTools(ctx),
    ...buildDeliveryTools(ctx)
  ];
}

// ../../functions/src/claire-agent/prompt.ts
var PERSONA = [
  "You are Claire, a warm, concise recruiter friend texting a candidate on iMessage.",
  "Text like a real friend: short (1-2 sentences), lowercase-ok, contractions, use 2025 slang naturally",
  "(lfg, cooked, lock in, \u5377, \u6446\u70C2) only when it matches their register. Never say you're an AI or a bot.",
  "Mirror their language (English or Mandarin)."
].join(" ");
var VOICE = [
  "VOICE DISCIPLINE (iMessage is plain text \u2014 these are hard rules, not suggestions):",
  "- NEVER use markdown. No *asterisks*, no _underscores_, no `backticks`, no #headers, and no",
  "  '-'/'\u2022'/'1.' bullet lists. They render as literal junk characters on a phone. Write plain prose;",
  "  if you must list 2-3 things, do it inline in a sentence or on separate lines with NO bullet marker.",
  "- Keep every NON-recommendation reply under ~280 characters (roughly 2 short sentences). Recommendation",
  "  lists (job title + link lines) are the only thing allowed to be longer. Do not pad as the chat grows.",
  "- VARY your opener every turn. Do NOT start two replies in the same conversation with the same first",
  "  word/phrase ('got it', 'got you', 'one sec', 'right now'). If you just used one, pick a different",
  "  lead-in or none at all. Repetition reads like a broken bot over a long thread."
].join(" ");
var DELIVERY = [
  "DELIVERY:",
  "- Before a slow tool (find_match): first call send_status_then_continue with a quick 'one sec' bubble,",
  "  THEN call the tool, THEN tell them the concrete result.",
  "- AFTER find_match you MUST reply \u2014 NEVER end the turn silently. If it returns roles, share them.",
  "  If it returns ZERO roles, do NOT just say 'nothing found' and stop. Look at the saved match",
  "  constraints for something that's off or too narrow and ASK ONE warm clarifying question to fix it,",
  "  then offer to re-run. Examples: a pay floor that reads like full-time money on an internship",
  "  ('100k is usually full-time territory \u2014 did you mean full-time, or internships specifically?'); a",
  "  single narrow city with no remote; a very niche industry; a seniority that looks too junior/senior",
  "  for the ask. Pick the MOST LIKELY culprit and ask about just that one thing.",
  "- A low-information ack ('sure'/'ok'/'k'/'yes'/'\u{1F44D}') when there is NOTHING new to answer and you're",
  "  mid-task \u2192 call react_to_user (a tapback) and send NO text.",
  "- A substantive question \u2192 reply in text. NEVER answer a substantive question with a bare tapback.",
  "- Don't assume hard filters (job type, location, salary) from their R\xC9SUM\xC9 history \u2014 r\xE9sum\xE9 = where",
  "  they've been, not what they want next. If a matching constraint is unstated or ambiguous, ASK.",
  "- Don't claim you saved or changed something you didn't."
].join(" ");
var PREFERENCES = [
  "PREFERENCES: persist durable role/job-type/location prefs with set_matching_preferences BEFORE matching.",
  "'only X' / 'just X' / 'switch to X' \u2192 onlyRoleFunctions (a REPLACE).",
  "'done with Y' / 'avoid Y' / 'not interested in Y' / 'scrap Y' / 'take Y back off' / 'remove Y' /",
  "'drop Y' / 'no longer want Y' \u2192 avoidRoleFunctions (this REMOVES Y you previously added). You MUST",
  "call set_matching_preferences for these BEFORE replying \u2014 do not just say you removed it in text.",
  "Never compose an additive sentence ('I'll keep both') from a negative statement \u2014 a 'done with X' means X is REMOVED."
].join(" ");
var FLEXIBILITY = [
  "FLEXIBILITY: the candidate can ask anything mid-flow. Answer it, then steer back to the pending step.",
  "Process state is durable \u2014 you won't lose their place."
].join(" ");
function modeDirective(mode, opts) {
  switch (mode) {
    case "onboarding": {
      const slot = opts?.onboardingSlot ?? "";
      const nextQ = opts?.pendingStep?.trim();
      const turnLine = opts?.awaitingAnswer ? [
        `The candidate's latest message ANSWERS the onboarding slot "${slot}". You MUST first call`,
        `record_onboarding_answer(slot:"${slot}", answer:<their message, verbatim>) \u2014 this SAVES it to their`,
        "durable profile (tags: where they want to work, expected company size, industry, status, etc.).",
        nextQ ? `THEN ask this next question, phrased warmly in your voice (exactly one question): ${nextQ}` : "That was the LAST question \u2014 after recording, wrap up warmly and offer to find matches. Ask nothing more."
      ] : [
        "This is the FIRST onboarding turn (a greeting/kickoff, not an answer) \u2014 do NOT record anything.",
        nextQ ? `Just ask this question, phrased warmly (a short r\xE9sum\xE9-aware lead-in is great): ${nextQ}` : "Ask the first onboarding question warmly."
      ];
      return [
        "MODE = ONBOARDING. You collect the candidate's profile through the onboarding TOOLS \u2014 these write the",
        "SAME canonical profile (pa-users.tags + preferences) the matcher uses. The reducer enforces slot order;",
        "you can never skip, batch, or invent questions.",
        ...turnLine
      ].join(" ");
    }
    case "prescreen":
      return [
        "MODE = PRESCREEN (job interview). On EACH candidate reply you MUST: (1) call ask_next_prescreen_question",
        "to get the pending question, (2) call score_prescreen_answer with that exact question id + their answer",
        "(an LLM judge scores it; the reducer advances). Then ask the next pending question. You do NOT decide",
        "pass/fail and NEVER tell them they passed/failed \u2014 the reducer decides; read it via explain_prescreen_outcome."
      ].join(" ");
    default:
      return [
        "MODE = TRIAGE. Free conversation. Route by tool description: recommendations \u2192 find_match (after a status",
        "bubble); durable prefs \u2192 set_matching_preferences; memory \u2192 remember_fact; scheduling \u2192 schedule_interview;",
        "privacy (export/delete/stop) \u2192 privacy. If nothing fits, just reply warmly."
      ].join(" ");
  }
}
var FEWSHOT = [
  "EXAMPLES (style + behavior, do not quote verbatim):",
  "- user: 'done with pure SWE, only product strategy, full-time, SF or remote' \u2192",
  "  call set_matching_preferences(onlyRoleFunctions:[product_management], avoidRoleFunctions:[software_engineering],",
  "  jobType:[full_time], locations:[...]); reply: 'got it \u2014 switching you to PM, full-time, SF/remote, dropping SWE.'",
  "- user: 'recommend me some roles' \u2192 send_status_then_continue('one sec, pulling matches'); find_match; then the roles.",
  "- user: 'sure' (right after you said you'd ping them) \u2192 react_to_user(like), no text.",
  "- user: 'what preferences do you have saved?' \u2192 read the saved matcher preferences from context and recite THOSE."
].join(" ");
function buildClairePrompt(opts) {
  const langLine = opts.lang === "zh" ? "Reply in natural Mandarin (Claire's voice)." : "Reply in natural English (Claire's voice).";
  return [
    PERSONA,
    langLine,
    VOICE,
    PREFERENCES,
    DELIVERY,
    modeDirective(opts.mode, opts),
    FLEXIBILITY,
    opts.globalContext ? `CONTEXT \u2014 ${opts.globalContext}` : "",
    // onboarding folds pendingStep into its directive (the next question to ask); other modes
    // surface it as a resume-after-tangent reminder.
    opts.pendingStep && opts.mode !== "onboarding" ? `PENDING STEP to resume after any tangent: ${opts.pendingStep}.` : "",
    FEWSHOT
  ].filter(Boolean).join("\n");
}

// ../../functions/src/claire-agent/guardrails.ts
import { checkPromptInjection, detectCrisisInInput } from "@pa/pa-safety";
import { normalizeForIMessage } from "@pa/pa-orchestrator";
var EXTRA_INJECTION_PATTERNS = [
  /\byou are now\b/i,
  /\bsystem prompt\b/i,
  /\bdeveloper (?:prompt|mode)\b/i,
  /\bjailbreak\b/i,
  /\bDAN mode\b/i,
  /\bact as (?:an? )?(?:unrestricted|jailbroken|uncensored)\b/i,
  /\bignore (?:all |the )?(?:your )?(?:previous |prior |above )?(?:instructions|rules|guidelines)\b/i,
  /\bpretend (?:you are|to be) (?:an? )?(?:unrestricted|different|evil)\b/i
];
function detectInjection(text) {
  const decision = checkPromptInjection(text);
  const signals = decision.allow ? [] : [...decision.signals ?? []];
  for (const p of EXTRA_INJECTION_PATTERNS) {
    if (p.test(text)) signals.push(`extra:${p.source}`);
  }
  return signals;
}
function inputText(input) {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}
var VOICE_DRIFT_DEFAULT_MAX_LENGTH = 900;
var VOICE_DRIFT_PATTERNS = [
  // markdown leakage (bold/italic emphasis, headings, fenced/inline code, list markers)
  { id: "markdown_emphasis", re: /(\*\*[^*]+\*\*|__[^_]+__)/ },
  { id: "markdown_heading", re: /^#{1,6}\s/m },
  { id: "code_fence", re: /```/ },
  { id: "inline_code", re: /`[^`]+`/ },
  { id: "markdown_list", re: /^\s*(?:[-*]\s+|\d+[.)]\s+)/m },
  { id: "markdown_link", re: /\[[^\]]+\]\([^)]+\)/ },
  // the self-correction "scratch that," artifact (long-context retraction tic)
  { id: "scratch_that", re: /\bscratch that\b/i },
  // robotic / AI self-disclosure (Claire never says she's an AI)
  { id: "ai_disclosure", re: /\b(?:as an ai|i am an ai|i'?m an ai|language model|as a (?:language|ai) model)\b/i },
  { id: "robotic_assist", re: /\b(?:how (?:may|can) i assist you|is there anything else i can help)\b/i }
];
function detectVoiceDrift(text, opts) {
  const t = typeof text === "string" ? text : "";
  const maxLength = opts?.maxLength ?? VOICE_DRIFT_DEFAULT_MAX_LENGTH;
  const signals = [];
  for (const { id, re } of VOICE_DRIFT_PATTERNS) {
    if (re.test(t)) signals.push(id);
  }
  if (t.length > maxLength) signals.push("excessive_length");
  return { flagged: signals.length > 0, signals, length: t.length };
}
function buildClaireGuardrails() {
  const safety = {
    name: "safety",
    async execute({ input }) {
      const text = inputText(input);
      const crisis = detectCrisisInInput(text);
      const injectionSignals = detectInjection(text);
      const injection = injectionSignals.length > 0;
      const tripwireTriggered = crisis.detected || injection;
      return {
        tripwireTriggered,
        outputInfo: {
          kind: tripwireTriggered ? crisis.detected ? "crisis" : "injection" : "clean",
          crisis: {
            detected: crisis.detected,
            confidence: crisis.confidence,
            language: crisis.language,
            // pattern-source ids only — detectCrisisInInput never returns raw text
            signals: crisis.signals
          },
          injection: { detected: injection, signals: injectionSignals }
        }
      };
    }
  };
  const voiceDrift = {
    name: "voice-drift",
    async execute({ agentOutput }) {
      const text = typeof agentOutput === "string" ? agentOutput : inputText(agentOutput);
      const drift = detectVoiceDrift(text);
      return {
        tripwireTriggered: false,
        outputInfo: { flagged: drift.flagged, signals: drift.signals, length: drift.length }
      };
    }
  };
  return { input: [safety], output: [voiceDrift] };
}
var CLAIRE_REPLY_MAX_LENGTH = 600;
function normalizeReply(text) {
  return normalizeForIMessage(text, {
    maxLength: CLAIRE_REPLY_MAX_LENGTH,
    forceSingleMessage: true
  }).text;
}

// ../../functions/src/claire-agent/delivery.ts
var SLOW_TOOLS = ["find_match", "match_collab", "cv_parse"];
async function markReadReflex(ctx) {
  await ctx.transport.markRead();
}
function wireTypingReflex(agent, ctx) {
  const emitter = agent;
  if (typeof emitter?.on !== "function") return;
  emitter.on("agent_tool_start", (_c, a, t) => {
    const name = t?.name ?? a?.name;
    if (name && SLOW_TOOLS.includes(name)) {
      void ctx.transport.typing();
    }
  });
}
async function deliverFinalText(ctx, finalText, deliveredViaTool = false) {
  const out = String(finalText ?? "").trim();
  if (!out || deliveredViaTool) return false;
  await ctx.transport.sendText(out);
  return true;
}

// ../../functions/src/claire-agent/session.ts
import { FirestoreSession } from "@pa/agent-runtime";
function makeClaireSession(deps) {
  return new FirestoreSession({
    db: deps.db,
    sessionId: deps.sessionId,
    userId: deps.userId
  });
}

// ../../functions/src/claire-agent/agent.ts
import { appendHotlineIfMissing } from "@pa/pa-safety";
var CLAIRE_MODEL = "gpt-5.4-nano";
var RUN_TIMEOUT_MS = 6e4;
function buildClaireAgent(ctx, opts) {
  configureClaireSdk();
  const guardrails = buildClaireGuardrails();
  const agent = new Agent({
    name: "Claire",
    model: CLAIRE_MODEL,
    instructions: buildClairePrompt({
      mode: opts.mode,
      lang: opts.lang,
      pendingStep: opts.pendingStep,
      globalContext: opts.globalContext,
      onboardingSlot: opts.onboardingSlot,
      awaitingAnswer: opts.awaitingAnswer
    }),
    tools: buildClaireTools(ctx),
    inputGuardrails: guardrails.input,
    outputGuardrails: guardrails.output
  });
  wireTypingReflex(agent, ctx);
  return agent;
}
function trackTransport(inner) {
  let viaTool = false;
  const transport = {
    markRead: () => inner.markRead(),
    typing: () => inner.typing(),
    sendStatus: (t) => inner.sendStatus(t),
    sendText: (t) => inner.sendText(t),
    tapback: (r) => {
      viaTool = true;
      return inner.tapback(r);
    },
    noReply: (r) => {
      viaTool = true;
      return inner.noReply(r);
    }
  };
  return { transport, handledViaTool: () => viaTool };
}
async function loadGlobalContext(db, userId) {
  try {
    const snap = await db.collection("pa-users").doc(userId).get();
    const tags = snap.data()?.tags ?? {};
    const arr = (k) => Array.isArray(tags[k]) ? tags[k] : [];
    const roles = arr("targetRoleFunction");
    const avoid = arr("negativeRoleFunction");
    const jobType = arr("targetJobType");
    const locations = arr("targetLocations");
    if (!roles.length && !avoid.length && !jobType.length && !locations.length) {
      return "Saved matcher preferences (canonical pa-users.tags): none set yet.";
    }
    return [
      "Saved matcher preferences \u2014 READ THESE when asked what's saved (this IS the matcher input):",
      roles.length ? `roles: ${roles.join(", ")}` : "",
      avoid.length ? `avoiding: ${avoid.join(", ")}` : "",
      jobType.length ? `job type: ${jobType.join(", ")}` : "",
      locations.length ? `locations: ${locations.join(", ")}` : ""
    ].filter(Boolean).join("; ");
  } catch {
    return "";
  }
}
async function runClaireTurn(input, deps) {
  const log = deps.log ?? (() => {
  });
  const tracked = trackTransport(deps.transport);
  const lang = input.lang ?? "en";
  const ctx = {
    db: deps.db,
    userId: input.userId,
    sessionId: input.sessionId,
    lang,
    transport: tracked.transport,
    judgeModel: deps.judgeModel ?? CLAIRE_MODEL,
    jobId: deps.jobId,
    log,
    nowIso: deps.nowIso ?? (() => (/* @__PURE__ */ new Date()).toISOString()),
    findMatch: deps.findMatch
  };
  if (deps.processStore) ctx.processStore = deps.processStore;
  void markReadReflex(ctx).catch((e) => log("markReadReflex_failed", { err: String(e) }));
  const globalContext = await loadGlobalContext(deps.db, input.userId);
  const agent = buildClaireAgent(ctx, {
    mode: deps.mode ?? "triage",
    lang,
    pendingStep: deps.pendingStep,
    globalContext,
    onboardingSlot: deps.onboardingSlot,
    awaitingAnswer: deps.awaitingAnswer
  });
  const session = makeClaireSession({
    db: deps.db,
    sessionId: input.sessionId,
    userId: input.userId
  });
  let finalText = "";
  let blocked = false;
  try {
    const res = await Promise.race([
      run(agent, input.text, { session }),
      new Promise(
        (_, reject) => setTimeout(() => reject(new Error("claire_run_timeout")), RUN_TIMEOUT_MS)
      )
    ]);
    finalText = String(res?.finalOutput ?? "").trim();
  } catch (e) {
    if (e instanceof InputGuardrailTripwireTriggered) {
      blocked = true;
      log("guardrail_tripwire", { userId: input.userId });
      const info = e?.result?.output?.outputInfo;
      if (info?.kind === "crisis") {
        const base = lang === "zh" ? "\u6211\u5728\u8FD9\u513F\uFF0C\u4F60\u4E0D\u662F\u4E00\u4E2A\u4EBA\u3002" : "i'm here for you \u2014 you're not alone.";
        const safe = appendHotlineIfMissing({ reply: base, language: lang }).text.trim();
        if (safe) await deps.transport.sendText(safe).catch(() => {
        });
      } else {
        await deps.transport.noReply("injection_blocked").catch(() => {
        });
      }
      return { finalText: "", toolCalls: [], deliveredViaTool: true };
    }
    log("claire_run_error", {
      userId: input.userId,
      err: e instanceof Error ? e.message : String(e)
    });
    finalText = lang === "zh" ? "\u62B1\u6B49\uFF0C\u521A\u521A\u5361\u4E86\u4E00\u4E0B \u2014 \u80FD\u518D\u8BF4\u4E00\u904D\u5417\uFF1F" : "sorry, that one hiccupped on my end \u2014 mind sending that again?";
  }
  const deliveredViaTool = tracked.handledViaTool();
  if (finalText && !deliveredViaTool) {
    finalText = normalizeReply(finalText);
  }
  await deliverFinalText(ctx, finalText, deliveredViaTool).catch(
    (e) => log("deliverFinalText_failed", { err: String(e) })
  );
  if (deps.mode === "onboarding" && deps.awaitingAnswer && deps.onboardingSlot) {
    const recorded = !!deps.processStore?.onboarding.answers?.[deps.onboardingSlot];
    if (!recorded && input.text.trim()) {
      await persistOnboardingAnswerThrough(ctx, deps.onboardingSlot, input.text).catch(
        (e) => log("onboarding.net_record_failed", { slot: deps.onboardingSlot, err: String(e) })
      );
      log("onboarding.net_recorded", { slot: deps.onboardingSlot });
    }
  }
  return { finalText, toolCalls: [], deliveredViaTool: deliveredViaTool || blocked };
}

// ../../functions/src/claire-agent/transport.ts
import { createHash as createHash2 } from "node:crypto";

// ../../functions/src/sendblue/circuit-breaker.ts
var FAILURE_THRESHOLD = 5;
var OPEN_DURATION_MS = 6e4;
var states = /* @__PURE__ */ new Map();
function getState(key) {
  let s = states.get(key);
  if (!s) {
    s = { consecutiveFailures: 0, openedAt: null };
    states.set(key, s);
  }
  return s;
}
function getSendblueBreakerState(key = "sendblue", now = Date.now()) {
  const s = states.get(key);
  if (!s || s.openedAt == null) return "CLOSED";
  if (now - s.openedAt < OPEN_DURATION_MS) return "OPEN";
  return "HALF_OPEN";
}
function recordSendblueFailure(key = "sendblue", now = Date.now()) {
  const s = getState(key);
  s.consecutiveFailures += 1;
  if (s.consecutiveFailures >= FAILURE_THRESHOLD && s.openedAt == null) {
    s.openedAt = now;
  }
}
function recordSendblueSuccess(key = "sendblue") {
  const s = getState(key);
  s.consecutiveFailures = 0;
  s.openedAt = null;
}

// ../../functions/src/sendblue/sendblue-client.ts
var SEND_MESSAGE_URL = "https://api.sendblue.co/api/send-message";
var DEFAULT_TIMEOUT_MS = 3e4;
var SendblueClientError = class extends Error {
  status;
  body;
  retryAfter;
  constructor(status, message, body, retryAfter) {
    super(message);
    this.name = "SendblueClientError";
    this.status = status;
    this.body = body;
    this.retryAfter = retryAfter;
  }
};
var SendblueServerError = class extends Error {
  status;
  body;
  retryAfter;
  constructor(status, message, body, retryAfter) {
    super(message);
    this.name = "SendblueServerError";
    this.status = status;
    this.body = body;
    this.retryAfter = retryAfter;
  }
};
function getSendblueCreds() {
  const apiKeyId = process.env.SENDBLUE_API_KEY_ID?.trim() ?? "";
  const apiSecretKey = process.env.SENDBLUE_API_SECRET_KEY?.trim() ?? "";
  if (!apiKeyId || !apiSecretKey) {
    throw new Error("Sendblue credentials missing \u2014 SENDBLUE_API_KEY_ID / SENDBLUE_API_SECRET_KEY not set");
  }
  const fromNumber = process.env.SENDBLUE_FROM_NUMBER?.trim() || void 0;
  return { apiKeyId, apiSecretKey, fromNumber };
}
async function withTimeout(p, ms = DEFAULT_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await p(ctrl.signal);
  } finally {
    clearTimeout(t);
  }
}
async function readJson(resp) {
  const txt = await resp.text();
  if (!txt) return null;
  try {
    return JSON.parse(txt);
  } catch {
    return { raw: txt };
  }
}
async function sendImessage(input, creds = getSendblueCreds()) {
  const breakerState = getSendblueBreakerState();
  if (breakerState === "OPEN") {
    throw new SendblueServerError(
      503,
      "Sendblue circuit OPEN \u2014 fail-fast (5+ consecutive failures, 60s cooldown)",
      null
    );
  }
  const allowEnvFallback = input.allowEnvFromNumberFallback !== false;
  let resolvedFromNumber = input.fromNumber?.trim() || (allowEnvFallback ? creds.fromNumber : void 0);
  if (input.userId) {
    try {
      const { loadSendbluePool: loadSendbluePool2, pickFromNumber: pickFromNumber2 } = await Promise.resolve().then(() => (init_pool(), pool_exports));
      const { getFirestore: getFirestore4 } = await import("firebase-admin/firestore");
      const db = input.db ?? getFirestore4();
      const pool = await loadSendbluePool2(db);
      const picked = pickFromNumber2(pool, input.userId);
      if (picked) {
        resolvedFromNumber = picked;
      }
    } catch (err) {
    }
  }
  const body = {
    number: input.to,
    content: input.content,
    ...resolvedFromNumber ? { from_number: resolvedFromNumber } : {},
    ...input.statusCallback ? { status_callback: input.statusCallback } : {}
  };
  let resp;
  try {
    resp = await withTimeout(
      (signal) => fetch(SEND_MESSAGE_URL, {
        method: "POST",
        headers: {
          "sb-api-key-id": creds.apiKeyId,
          "sb-api-secret-key": creds.apiSecretKey,
          "content-type": "application/json"
        },
        body: JSON.stringify(body),
        signal
      })
    );
  } catch (err) {
    recordSendblueFailure();
    throw new SendblueServerError(
      0,
      `Sendblue send-message network error: ${err instanceof Error ? err.message : String(err)}`,
      null
    );
  }
  const parsed = await readJson(resp);
  const retryAfter = resp.headers.get("retry-after") ?? void 0;
  if (resp.status >= 200 && resp.status < 300) {
    recordSendblueSuccess();
    return parsed ?? {};
  }
  const message = (parsed && typeof parsed === "object" && "error_message" in parsed ? String(parsed.error_message ?? "") : "") || (parsed && typeof parsed === "object" && "message" in parsed ? String(parsed.message ?? "") : "") || `Sendblue send-message HTTP ${resp.status}`;
  if (resp.status >= 500 || resp.status === 429) {
    recordSendblueFailure();
    throw new SendblueServerError(resp.status, message, parsed, retryAfter ?? void 0);
  }
  throw new SendblueClientError(resp.status, message, parsed, retryAfter ?? void 0);
}

// ../../functions/src/sendblue/typing-indicator.ts
var TYPING_URL = "https://api.sendblue.co/api/send-typing-indicator";
var TYPING_TIMEOUT_MS = 5e3;
async function sendTypingIndicator(input, creds = getSendblueCreds(), log = console.log) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TYPING_TIMEOUT_MS);
  try {
    const resp = await fetch(TYPING_URL, {
      method: "POST",
      headers: {
        "sb-api-key-id": creds.apiKeyId,
        "sb-api-secret-key": creds.apiSecretKey,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        number: input.to,
        ...input.fromNumber?.trim() || creds.fromNumber ? { from_number: input.fromNumber?.trim() || creds.fromNumber } : {}
      }),
      signal: ctrl.signal
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      log("[sendblue][typing] non-2xx", resp.status, txt.slice(0, 200));
    }
  } catch (err) {
    log(
      "[sendblue][typing] swallow error",
      err instanceof Error ? err.message : String(err)
    );
  } finally {
    clearTimeout(t);
  }
}

// ../../functions/src/sendblue/read-receipt.ts
var MARK_READ_URLS = [
  "https://api.sendblue.com/api/mark-read",
  "https://api.sendblue.co/api/mark-read"
];
var MARK_READ_TIMEOUT_MS = 3e3;
async function sendReadReceipt(input, creds = getSendblueCreds(), log = console.log) {
  const fromNumber = input.fromNumber?.trim() || creds.fromNumber;
  const body = JSON.stringify({
    number: input.to,
    ...fromNumber ? { from_number: fromNumber } : {}
  });
  await Promise.allSettled(
    MARK_READ_URLS.map(async (url) => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), MARK_READ_TIMEOUT_MS);
      try {
        const resp = await fetch(url, {
          method: "POST",
          headers: {
            "sb-api-key-id": creds.apiKeyId,
            "sb-api-secret-key": creds.apiSecretKey,
            "content-type": "application/json"
          },
          body,
          signal: ctrl.signal
        });
        const txt = resp.ok ? "" : await resp.text().catch(() => "");
        log(`[sendblue][mark-read] ${resp.ok ? "ok" : "non-2xx"}`, url, resp.status, txt.slice(0, 160));
      } catch (err) {
        log("[sendblue][mark-read] error", url, err instanceof Error ? err.message : String(err));
      } finally {
        clearTimeout(t);
      }
    })
  );
}

// ../../functions/src/sendblue/send-reaction.ts
var SEND_REACTION_URL = "https://api.sendblue.com/api/send-reaction";
var REACTION_BREAKER_KEY = "sendblue-reaction";
var DEFAULT_TIMEOUT_MS2 = 3e4;
async function withTimeout2(p, ms = DEFAULT_TIMEOUT_MS2) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await p(ctrl.signal);
  } finally {
    clearTimeout(t);
  }
}
async function readJson2(resp) {
  const txt = await resp.text();
  if (!txt) return null;
  try {
    return JSON.parse(txt);
  } catch {
    return { raw: txt };
  }
}
async function sendReaction(input, creds = getSendblueCreds()) {
  const breakerState = getSendblueBreakerState(REACTION_BREAKER_KEY);
  if (breakerState === "OPEN") {
    throw new SendblueServerError(
      503,
      "Sendblue reaction circuit OPEN \u2014 fail-fast (5+ consecutive failures, 60s cooldown)",
      null
    );
  }
  if (!input.messageHandle) {
    throw new SendblueClientError(400, "send-reaction: messageHandle required", null);
  }
  if (!input.to) {
    throw new SendblueClientError(400, "send-reaction: to (recipient number) required", null);
  }
  const resolvedFromNumber = await resolveReactionFromNumber(input, creds);
  const body = {
    number: input.to,
    message_handle: input.messageHandle,
    reaction: input.reaction,
    ...resolvedFromNumber ? { from_number: resolvedFromNumber } : {}
  };
  let resp;
  try {
    resp = await withTimeout2(
      (signal) => fetch(SEND_REACTION_URL, {
        method: "POST",
        headers: {
          "sb-api-key-id": creds.apiKeyId,
          "sb-api-secret-key": creds.apiSecretKey,
          "content-type": "application/json"
        },
        body: JSON.stringify(body),
        signal
      })
    );
  } catch (err) {
    recordSendblueFailure(REACTION_BREAKER_KEY);
    throw new SendblueServerError(
      0,
      `Sendblue send-reaction network error: ${err instanceof Error ? err.message : String(err)}`,
      null
    );
  }
  const parsed = await readJson2(resp);
  const retryAfter = resp.headers.get("retry-after") ?? void 0;
  if (resp.status >= 200 && resp.status < 300) {
    recordSendblueSuccess(REACTION_BREAKER_KEY);
    return parsed ?? {};
  }
  const message = (parsed && typeof parsed === "object" && "error_message" in parsed ? String(parsed.error_message ?? "") : "") || (parsed && typeof parsed === "object" && "message" in parsed ? String(parsed.message ?? "") : "") || `Sendblue send-reaction HTTP ${resp.status}`;
  if (resp.status >= 500 || resp.status === 429) {
    recordSendblueFailure(REACTION_BREAKER_KEY);
    throw new SendblueServerError(resp.status, message, parsed, retryAfter ?? void 0);
  }
  throw new SendblueClientError(resp.status, message, parsed, retryAfter ?? void 0);
}
async function resolveReactionFromNumber(input, creds) {
  const explicit = input.fromNumber?.trim();
  if (explicit) return explicit;
  if (input.userId) {
    try {
      const { loadSendbluePool: loadSendbluePool2, pickFromNumber: pickFromNumber2 } = await Promise.resolve().then(() => (init_pool(), pool_exports));
      const { getFirestore: getFirestore4 } = await import("firebase-admin/firestore");
      const db = input.db ?? getFirestore4();
      const picked = pickFromNumber2(await loadSendbluePool2(db), input.userId);
      if (picked) return picked;
    } catch {
    }
  }
  return input.allowEnvFromNumberFallback === false ? void 0 : creds.fromNumber;
}

// ../../functions/src/claire-agent/transport.ts
import { enqueueOutbound as defaultEnqueueOutbound } from "@pa/pa-broker";
var noopLog = (_event, _payload) => {
};
function textIdempotencyKey(deps, body) {
  const seed = deps.inboundEventId?.trim() || `${deps.sessionId}:${createHash2("sha256").update(body, "utf8").digest("hex").slice(0, 16)}`;
  return `claire-reply-${seed}`;
}
function createSendblueTransport(deps) {
  const log = deps.log ?? noopLog;
  const recordedEvents = [];
  const dryRun = deps.dryRun === true;
  const sendImessage2 = deps.sendImessage ?? sendImessage;
  const sendTypingIndicator2 = deps.sendTypingIndicator ?? sendTypingIndicator;
  const sendReadReceipt2 = deps.sendReadReceipt ?? sendReadReceipt;
  const sendReaction2 = deps.sendReaction ?? sendReaction;
  const enqueueOutbound = deps.enqueueOutbound ?? defaultEnqueueOutbound;
  const record = (kind, value) => {
    recordedEvents.push(value === void 0 ? { kind } : { kind, value });
  };
  let fromNumberCache = "unresolved";
  const resolveFromNumber = async () => {
    if (fromNumberCache !== "unresolved") return fromNumberCache;
    try {
      const { loadSendbluePool: loadSendbluePool2, pickFromNumber: pickFromNumber2 } = await Promise.resolve().then(() => (init_pool(), pool_exports));
      fromNumberCache = pickFromNumber2(await loadSendbluePool2(deps.db), deps.userId) ?? void 0;
    } catch {
      fromNumberCache = void 0;
    }
    return fromNumberCache;
  };
  return {
    recordedEvents,
    // Sendblue DOES support read receipts (POST /api/mark-read). Fire the REAL receipt (blue
    // "Read" label) AND the typing bubble in PARALLEL — both are best-effort UX, and the caller
    // runs this fire-and-forget so it never sits on the reply's critical path.
    async markRead() {
      record("mark_read");
      if (dryRun) return;
      const fromNumber = await resolveFromNumber();
      await Promise.allSettled([
        sendReadReceipt2({ to: deps.toE164, fromNumber }).catch(
          (err) => log("claire.transport.markRead.error", {
            message: err instanceof Error ? err.message : String(err)
          })
        ),
        sendTypingIndicator2({ to: deps.toE164, fromNumber }).catch(() => {
        })
      ]);
    },
    async typing() {
      record("typing");
      if (dryRun) return;
      try {
        await sendTypingIndicator2({ to: deps.toE164, fromNumber: await resolveFromNumber() });
      } catch (err) {
        log("claire.transport.typing.error", {
          message: err instanceof Error ? err.message : String(err)
        });
      }
    },
    // Transient "one sec" bubble — immediate, best-effort, no durable row.
    async sendStatus(text) {
      record("status", text);
      if (dryRun) return;
      try {
        await sendImessage2({
          to: deps.toE164,
          content: text,
          userId: deps.userId,
          db: deps.db,
          allowEnvFromNumberFallback: false
        });
      } catch (err) {
        log("claire.transport.sendStatus.error", {
          message: err instanceof Error ? err.message : String(err)
        });
      }
    },
    // User-facing reply — durable, idempotent, retried via the pa-outbound outbox.
    async sendText(text) {
      record("text", text);
      if (dryRun) return;
      const body = String(text ?? "").trim();
      if (!body) return;
      try {
        await enqueueOutbound(deps.db, {
          userId: deps.userId,
          toE164: deps.toE164,
          body,
          idempotencyKey: textIdempotencyKey(deps, body),
          runtimeApproved: true,
          runtimeSource: "pa_orchestrator"
        });
      } catch (err) {
        log("claire.transport.sendText.error", {
          message: err instanceof Error ? err.message : String(err)
        });
      }
    },
    async tapback(reaction) {
      record("tapback", reaction);
      if (dryRun) return;
      if (!deps.inboundMessageHandle) {
        log("claire.transport.tapback.skip_no_handle", { reaction });
        return;
      }
      try {
        await sendReaction2({
          to: deps.toE164,
          messageHandle: deps.inboundMessageHandle,
          reaction,
          userId: deps.userId,
          db: deps.db,
          allowEnvFromNumberFallback: false
        });
      } catch (err) {
        log("claire.transport.tapback.error", {
          message: err instanceof Error ? err.message : String(err)
        });
      }
    },
    async noReply(reason) {
      record("no_reply", reason);
      log("claire.transport.noReply", { reason });
    }
  };
}

// ../../functions/src/claire-agent/cutover.ts
import { PA_COLLECTIONS as PA_COLLECTIONS3 } from "@pa/core-types";

// ../../functions/src/claire-agent/flags.ts
import { getFlag } from "@pa/pa-persistence";
var THIN_CLAIRE_FLAG_KEY = "paThinClaireEnabled";
var THIN_CLAIRE_CANARY_UIDS = [
  "8fEwIduUrzxZsblHHsNz",
  "LF8blURXyFBaeF7bhupu"
];
var THIN_CLAIRE_FLAG_SEED = {
  key: THIN_CLAIRE_FLAG_KEY,
  value: false,
  type: "bool",
  scope: "perUser",
  allowlist: [...THIN_CLAIRE_CANARY_UIDS],
  blocklist: []
};
async function isThinClaireEnabled(db, userId) {
  const value = await getFlag(db, THIN_CLAIRE_FLAG_KEY, { userId }, false);
  return value === true;
}

// ../../functions/src/claire-agent/mode-selector.ts
import {
  isSharedOnboardingActiveUser,
  currentSharedOnboardingQuestionId,
  resolveNextSharedOnboardingQuestionId as resolveNextSharedOnboardingQuestionId2,
  buildSharedOnboardingPrompt as buildSharedOnboardingPrompt2,
  SHARED_ONBOARDING_WORK_SESSION_KIND as SHARED_ONBOARDING_WORK_SESSION_KIND2
} from "@pa/pa-orchestrator";
var USERS = "pa-users";
var PRESCREEN_SESSIONS = "pa-prescreen-sessions";
async function hasActivePrescreen(db, userId) {
  try {
    const snap = await db.collection(PRESCREEN_SESSIONS).where("userId", "==", userId).where("terminal", "==", null).limit(1).get();
    if (snap.empty) return { active: false };
    const d = snap.docs[0].data();
    return { active: true, jobId: typeof d.jobId === "string" ? d.jobId : void 0 };
  } catch {
    return { active: false };
  }
}
async function bootstrapOnboarding(db, userId, now) {
  await db.collection(USERS).doc(userId).set(
    {
      onboardingState: "pending",
      onboardingStatus: "invited",
      updatedAt: now,
      sharedOnboarding: {
        status: "active",
        startedAt: now,
        updatedAt: now,
        currentQuestionId: "main_goal",
        questionOrder: [...DEFAULT_ONBOARDING_SLOTS],
        answers: {},
        completed: false
      },
      workSession: {
        kind: SHARED_ONBOARDING_WORK_SESSION_KIND2,
        status: "active",
        startedAt: now,
        currentQuestionId: "main_goal",
        boundary: "shared_onboarding"
      }
    },
    { merge: true }
  );
}
function seedStore(answeredSlots) {
  const store = emptyProcessStore();
  store.onboarding = {
    slots: [...DEFAULT_ONBOARDING_SLOTS],
    answers: Object.fromEntries(answeredSlots.map((s) => [s, "recorded"])),
    complete: false
  };
  return store;
}
async function selectClaireMode(args) {
  const log = args.log ?? (() => {
  });
  const now = (args.nowIso ?? (() => (/* @__PURE__ */ new Date()).toISOString()))();
  const ps = await hasActivePrescreen(args.db, args.userId);
  if (ps.active) {
    log("mode.prescreen_defer_legacy", { userId: args.userId, jobId: ps.jobId });
    return { mode: "prescreen", deferToLegacy: true, jobId: ps.jobId };
  }
  let user = {};
  try {
    const snap = await args.db.collection(USERS).doc(args.userId).get();
    user = (snap.exists ? snap.data() : {}) ?? {};
  } catch {
    return { mode: "triage" };
  }
  const shared = user.sharedOnboarding ?? null;
  const onboardingComplete = shared?.completed === true || user.onboardingState === "complete";
  if (!onboardingComplete) {
    try {
      if (!isSharedOnboardingActiveUser(user)) {
        await bootstrapOnboarding(args.db, args.userId, now);
        log("mode.onboarding_bootstrap", { userId: args.userId });
        return {
          mode: "onboarding",
          awaitingAnswer: false,
          onboardingSlot: "main_goal",
          pendingStep: buildSharedOnboardingPrompt2("main_goal", null),
          processStore: seedStore([])
        };
      }
      const cur = currentSharedOnboardingQuestionId(user);
      const answeredSlots = Object.keys(shared?.answers ?? {});
      const next = resolveNextSharedOnboardingQuestionId2(cur);
      log("mode.onboarding_active", { userId: args.userId, currentSlot: cur, next: next.nextQuestionId, answered: answeredSlots.length });
      return {
        mode: "onboarding",
        awaitingAnswer: true,
        onboardingSlot: cur,
        ...next.nextQuestionId ? { pendingStep: buildSharedOnboardingPrompt2(next.nextQuestionId, null) } : {},
        processStore: seedStore(answeredSlots)
      };
    } catch (err) {
      log("mode.onboarding_error", {
        userId: args.userId,
        error: err instanceof Error ? err.message : String(err)
      });
      return { mode: "triage" };
    }
  }
  return { mode: "triage" };
}

// ../../functions/src/claire-agent/cutover.ts
async function maybeRunThinClaire(db, eventId, deps = {}) {
  const log = deps.log ?? (() => {
  });
  let data;
  try {
    const snap = await db.collection(PA_COLLECTIONS3.inboundEvents).doc(eventId).get();
    if (!snap.exists) return false;
    data = snap.data() ?? {};
  } catch {
    return false;
  }
  const userId = typeof data.userId === "string" ? data.userId : void 0;
  const sessionId = typeof data.sessionId === "string" ? data.sessionId : void 0;
  const text = typeof data.body === "string" ? data.body : typeof data.text === "string" ? data.text : "";
  if (!userId || !sessionId || !text.trim()) return false;
  let enabled = false;
  try {
    enabled = await isThinClaireEnabled(db, userId);
  } catch {
    return false;
  }
  if (!enabled) return false;
  const rawMeta = data.rawMeta ?? {};
  const toE164 = typeof data.fromNumber === "string" && data.fromNumber || typeof data.externalChatId === "string" && data.externalChatId || typeof data.from === "string" && data.from || "";
  const inboundMessageHandle = typeof rawMeta.messageHandle === "string" ? rawMeta.messageHandle : void 0;
  const lang = data.lang === "zh" ? "zh" : "en";
  const decision = await selectClaireMode({ db, userId, inboundText: text, log });
  if (decision.deferToLegacy) {
    log("thin_claire_defer_legacy", { eventId, userId, mode: decision.mode, jobId: decision.jobId });
    return false;
  }
  try {
    const transport = createSendblueTransport({
      db,
      toE164: String(toE164),
      inboundMessageHandle,
      userId,
      sessionId,
      log,
      ...deps.dryRun ? { dryRun: true } : {}
    });
    await runClaireTurn(
      {
        userId,
        sessionId,
        text,
        toE164: toE164 ? String(toE164) : void 0,
        inboundMessageHandle,
        inboundEventId: eventId,
        lang
      },
      {
        db,
        transport,
        findMatch: makeV16FindMatch(db),
        log,
        mode: decision.mode,
        ...decision.pendingStep ? { pendingStep: decision.pendingStep } : {},
        ...decision.processStore ? { processStore: decision.processStore } : {},
        ...decision.onboardingSlot ? { onboardingSlot: decision.onboardingSlot } : {},
        ...decision.awaitingAnswer !== void 0 ? { awaitingAnswer: decision.awaitingAnswer } : {}
      }
    );
    await db.collection(PA_COLLECTIONS3.inboundEvents).doc(eventId).set({ status: "completed", handledBy: "thin_claire" }, { merge: true });
    log("thin_claire_handled", { eventId, userId });
    return true;
  } catch (e) {
    log("thin_claire_failed_fallthrough", {
      eventId,
      userId,
      err: e instanceof Error ? e.message : String(e)
    });
    return false;
  }
}
export {
  Agent,
  CLAIRE_MODEL,
  InputGuardrailTripwireTriggered,
  MemorySession,
  SLOW_TOOLS,
  buildClaireAgent,
  buildClaireGuardrails,
  buildDeliveryTools,
  buildMatchingTools,
  buildProcessTools,
  createSendblueTransport,
  deliverFinalText,
  makeV16FindMatch,
  markReadReflex,
  maybeRunThinClaire,
  normalizeReply,
  run,
  runClaireTurn,
  selectClaireMode,
  tool,
  wireTypingReflex,
  z
};
