/**
 * headhunter-mcp/tools.ts — registers every AI-headhunter MCP tool.
 *
 * Each tool is a thin wrapper over an EXISTING pure `run*` runner / lib function
 * (the same core the admin callables use) — zero new business logic. The LLM
 * proposes typed args; the runner is the deterministic reducer that reads/commits.
 *
 * Groups: READ (browse/search) · MATCH (candidate↔job) · WRITE (operator actions,
 * marked destructive + actor-attributed for audit). Passed-candidate PII is
 * redacted server-side for the "employer" scope (Phase 2); the internal operator
 * scope sees dashboard-parity data.
 */
import { getFirestore } from "firebase-admin/firestore"
import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

import { runAdminCandidatePoolCounts } from "../admin-candidate-pool-counts.js"
import { runAdminRecruiterSubmissionsList } from "../admin-recruiter-submissions-list.js"
import {
  runAdminRejectedCandidates,
  type AdminRejectedCandidatesInput,
} from "../admin-rejected-candidates.js"
import { runAdminPrescreenOpsSnapshot } from "../admin-prescreen-ops.js"
import { runAdminOpsMetrics } from "../admin-ops-metrics.js"
import { runAdminJobMatchDebug } from "../admin-match-debug.js"
import { runAdminRecruiterSubmissionAction } from "../admin-recruiter-submission-action.js"
import {
  runAdminPassedCandidatesSnapshot,
  runAdminPassedCandidateIntroDecision,
} from "../admin-passed-candidates.js"
import { reevaluateCandidateTier, setGlobalCandidateTierManual } from "../candidate-tier.js"
import { queryMatchingJobsV16 } from "@pa/job-rec"
import type { HeadhunterPrincipal } from "./auth.js"
import { maybeRedactPassed } from "./redact.js"
import {
  runSearchCandidatePool,
  runRediscoverForJob,
  runSummarizePrescreen,
  runSchedulingStatus,
} from "./extended.js"
import { runDraftOutreach, runSendCandidateMessage } from "./outbound.js"
import { runSendEmail } from "./email.js"
import { runScheduleInterview, runBookInterviewSlot } from "./scheduling.js"
import { runEmailInterviewOffer } from "./email-interview-offer.js"
import { runIntakeJob } from "./job-intake.js"
import {
  runListJobShortlist,
  runGetCandidateEvidence,
  runRecordJobRanking,
  runRecordCandidateReviews,
  runFindJob,
} from "./shortlist.js"
import { runCoresignalAgenticSearch } from "../admin-coresignal-agentic-search.js"

type Db = ReturnType<typeof getFirestore>
type Tier = "tier_1" | "tier_2" | "tier_3"
type ToolResult = { content: Array<{ type: "text"; text: string }> }
type ToolShape = Record<string, unknown>
interface ToolConfig {
  title: string
  description: string
  inputSchema?: ToolShape
  annotations?: Record<string, unknown>
}

export interface HeadhunterToolContext {
  db: Db
  principal: HeadhunterPrincipal
}

const READ_ONLY = { readOnlyHint: true } as const
const MUTATING = { destructiveHint: true, readOnlyHint: false } as const

const MAX_ROWS = 25

/**
 * Cap large arrays so a tool result never blows the model context window. Any
 * array property longer than MAX_ROWS is sliced and annotated with a
 * `<field>_truncated` note so the agent knows to filter for more.
 */
export function capForAgent(value: unknown): unknown {
  if (Array.isArray(value)) {
    const sliced = value.slice(0, MAX_ROWS).map(capForAgent)
    return value.length > MAX_ROWS
      ? { _truncated: { total: value.length, shown: MAX_ROWS, note: "filter/ask for more" }, items: sliced }
      : sliced
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (Array.isArray(v) && v.length > MAX_ROWS) {
        out[k] = v.slice(0, MAX_ROWS).map(capForAgent)
        out[`${k}_truncated`] = { total: v.length, shown: MAX_ROWS, note: "filter/ask for more" }
      } else {
        out[k] = capForAgent(v)
      }
    }
    return out
  }
  return value
}

function jsonContent(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(capForAgent(value), null, 2) }] }
}

/**
 * Emit WITHOUT the 25-row cap, for tools whose whole purpose is to hand over a large set.
 *
 * `capForAgent` is the right default — it stops an unbounded admin list from blowing the context.
 * But applied to the shortlist it silently cut 248 candidates to 25 while the response still said
 * `returned: 248`, which is the worst possible failure: a confident, wrong, complete-looking view.
 *
 * Only safe for tools that bound and report their OWN size. Both callers do: list_job_shortlist
 * hard-caps at 250 (measured ~55k tokens for 248) and enumerates every row it withheld with a
 * reason; get_candidate_evidence is a single candidate (~3k tokens).
 */
function jsonContentFull(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] }
}

/**
 * `registerTool`'s input-shape generic is typed against the SDK's OWN zod copy
 * (hoisted zod@4.3.6); apps/functions pins zod@3.25.76, so a shape built here is a
 * different TS *brand* though a valid validator at runtime (the SDK normalizes
 * structurally via `_def`/`_zod`). Register through ONE explicit `any` boundary
 * and keep arg types on the handler so call sites stay type-safe.
 */
function register<A>(
  server: McpServer,
  name: string,
  config: ToolConfig,
  handler: (args: A) => Promise<ToolResult>,
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(server.registerTool as any)(name, config, handler)
}

export function registerHeadhunterTools(server: McpServer, ctx: HeadhunterToolContext): void {
  const { db, principal } = ctx
  const actor = `headhunter-mcp:${principal.uid}`

  // ───────────────────────── READ ─────────────────────────
  register<Record<string, never>>(server, "list_candidate_pool_summary", {
    title: "Candidate pool summary",
    description:
      "Whole-pool counts: total candidates, breakdown by lifecycle state, by source, and by identity/class. Internal operators.",
    inputSchema: {},
    annotations: READ_ONLY,
  }, async () => jsonContent(await runAdminCandidatePoolCounts({ db })))

  register<Record<string, never>>(server, "list_recruiter_submissions", {
    title: "List recruiter submissions",
    description:
      "Every recruiter submission (candidate, submitter, job, status, score), trimmed. Internal operators.",
    inputSchema: {},
    annotations: READ_ONLY,
  }, async () => jsonContent(await runAdminRecruiterSubmissionsList({ db })))

  register<{ tier?: Tier; reusableOnly?: boolean; includeTest?: boolean; limit?: number }>(
    server, "list_rejected_candidates", {
    title: "List rejected candidates",
    description:
      "Rejected candidates with global tier (tier_1 = strongest, re-reviewable … tier_3 = hard no), reusability and rejection count. Optionally filter by tier or reusable-only.",
    inputSchema: {
      tier: z.enum(["tier_1", "tier_2", "tier_3"]).optional(),
      reusableOnly: z.boolean().optional(),
      includeTest: z.boolean().optional(),
      limit: z.number().int().min(1).max(1000).optional(),
    },
    annotations: READ_ONLY,
  }, async (a) => {
    const input: AdminRejectedCandidatesInput = {
      tier: a.tier ?? null,
      reusableOnly: a.reusableOnly ?? false,
      includeTest: a.includeTest ?? false,
      limit: a.limit ?? 200,
      adminToken: null,
    }
    return jsonContent(await runAdminRejectedCandidates(input, { db }))
  })

  register<{ jobId: string; limit?: number }>(server, "list_passed_candidates_for_job", {
    title: "List passed candidates for a job",
    description:
      "Passed, employer-visible candidate snapshots for one job. PII is redacted server-side for the employer scope unless the candidate granted consent.",
    inputSchema: {
      jobId: z.string().min(1).describe("matching-jobs / collab job id"),
      limit: z.number().int().positive().max(200).optional(),
    },
    annotations: READ_ONLY,
  }, async ({ jobId, limit }) => {
    const snapshot = await runAdminPassedCandidatesSnapshot({ jobId, limit }, { db })
    return jsonContent(maybeRedactPassed(snapshot, principal))
  })

  register<{ mode: "ops" | "sessions"; jobId?: string; queue?: "pending" | "committed"; bucket?: string; sort?: "strict_priority" | "score_desc"; limit?: number; cursor?: string }>(
    server, "get_prescreen_ops_snapshot", {
    title: "Prescreen ops snapshot",
    description:
      "Prescreen pipeline. mode='ops' → totals (pending review, committed, by terminal/bucket). mode='sessions' → paginated sessions with score/terminal/review. Internal operators.",
    inputSchema: {
      mode: z.enum(["ops", "sessions"]),
      jobId: z.string().optional(),
      queue: z.enum(["pending", "committed"]).optional(),
      bucket: z.string().optional(),
      sort: z.enum(["strict_priority", "score_desc"]).optional(),
      limit: z.number().int().positive().max(500).optional(),
      cursor: z.string().optional(),
    },
    annotations: READ_ONLY,
  }, async (a) => jsonContent(await runAdminPrescreenOpsSnapshot(a, { db })))

  register<{ rangeDays?: number; includeTest?: boolean }>(server, "get_ops_metrics", {
    title: "Operations metrics",
    description:
      "Daily time-series: new users (by channel), interviews conducted, prescreens, candidates moved to client. Internal operators.",
    inputSchema: {
      rangeDays: z.number().int().min(7).max(400).optional(),
      includeTest: z.boolean().optional(),
    },
    annotations: READ_ONLY,
  }, async (a) => jsonContent(await runAdminOpsMetrics(
    { rangeDays: a.rangeDays ?? 120, includeTest: a.includeTest ?? false }, { db })))

  // ───────────────────────── MATCH ─────────────────────────
  register<{ userId: string; limit?: number }>(server, "find_matching_jobs_for_candidate", {
    title: "Find matching jobs for a candidate",
    description:
      "Run the V16 matcher for a candidate userId → ranked jobs with score breakdown (llmMatch, skills, industry, embedding, salary) and reasons.",
    inputSchema: {
      userId: z.string().min(8),
      limit: z.number().int().positive().max(50).optional(),
    },
    annotations: READ_ONLY,
  }, async ({ userId, limit }) =>
    jsonContent(await queryMatchingJobsV16({ userId, limit }, { db, log: () => undefined })))

  register<{ jobId: string; limit?: number }>(server, "find_candidates_for_job", {
    title: "Find candidates for a job",
    description:
      "Reverse match: given a jobId (matching-jobs / scraped catalog), rank retained candidates with hard-filter result + V16 score breakdown + per-candidate tag snapshot. The core headhunting action.",
    inputSchema: {
      jobId: z.string().min(1),
      limit: z.number().int().positive().max(50).optional(),
    },
    annotations: READ_ONLY,
  }, async (a) => jsonContent(await runAdminJobMatchDebug(a, { db })))

  // Free-text candidate search with NO jobId: YOU parse the hiring brief into
  // these canonical filters, the V16 candidate scorer ranks the retained pool.
  register<{ roleFunction?: string[]; skills?: string[]; locations?: string[]; industrySector?: string[]; seniorityLevel?: string; jobType?: string; sponsorshipAvailable?: boolean; limit?: number }>(
    server, "search_candidate_pool", {
    title: "Search the candidate pool (free-text brief)",
    description:
      "Find candidates from a hiring brief WITHOUT a jobId. Parse the brief into canonical filters and pass them: roleFunction[] (e.g. software_engineering), skills[], locations[] (e.g. new_york, remote_united_states), industrySector[], seniorityLevel (e.g. senior), jobType, sponsorshipAvailable. Ranks the retained pool with the V16 scorer; role/visa/location/careerStage/jobType are hard filters.",
    inputSchema: {
      roleFunction: z.array(z.string()).max(17).optional(),
      skills: z.array(z.string()).max(40).optional(),
      locations: z.array(z.string()).max(20).optional(),
      industrySector: z.array(z.string()).max(20).optional(),
      seniorityLevel: z.string().optional(),
      jobType: z.string().optional(),
      sponsorshipAvailable: z.boolean().optional().describe("set false to exclude candidates who need sponsorship"),
      limit: z.number().int().positive().max(50).optional(),
    },
    annotations: READ_ONLY,
  }, async (a) => jsonContent(await runSearchCandidatePool(a, { db })))

  // Silver-medalist / retained-pool reactivation by global tier.
  register<{ jobId: string; tiers?: Tier[]; limit?: number }>(server, "rediscover_for_job", {
    title: "Rediscover candidates for a job (silver medalists)",
    description:
      "Re-activate the retained pool for a (matching-jobs) jobId: rank candidates who already carry a global tier (tier_1 strongest from a prior rejection elsewhere) against this job. Surfaces 'strong candidate, wrong role — try them here'. Defaults to tier_1+tier_2.",
    inputSchema: {
      jobId: z.string().min(1),
      tiers: z.array(z.enum(["tier_1", "tier_2", "tier_3"])).max(3).optional(),
      limit: z.number().int().positive().max(50).optional(),
    },
    annotations: READ_ONLY,
  }, async (a) => jsonContent(await runRediscoverForJob(a, { db })))

  // ───────────────────────── PRESCREEN / SCHEDULING (read) ─────────────────────────
  register<{ sessionId?: string; jobId?: string; userId?: string }>(server, "summarize_prescreen", {
    title: "Summarize a candidate's prescreen",
    description:
      "TL;DR of a prescreen: terminal + reason, overall score/ratio vs threshold, per-question score+confidence with one-line summaries, and red flags (must-have misses, terminal causes, engagement). Pass sessionId, or jobId+userId. Reuses already-scored judge output (no re-run).",
    inputSchema: {
      sessionId: z.string().optional(),
      jobId: z.string().optional(),
      userId: z.string().optional(),
    },
    annotations: READ_ONLY,
  }, async (a) => jsonContent(await runSummarizePrescreen(a, { db })))

  register<{ userId: string; jobId?: string }>(server, "get_scheduling_status", {
    title: "Get interview scheduling status",
    description:
      "Read a candidate's Cal.com interview booking state (offered / booked / confirmed / failed), selected slot, meeting URL, and any error. Pass userId (and optionally jobId).",
    inputSchema: {
      userId: z.string().min(1),
      jobId: z.string().optional(),
    },
    annotations: READ_ONLY,
  }, async (a) => jsonContent(await runSchedulingStatus(a, { db })))

  register<{ userId: string; jobId?: string; timeZone?: string; partOfDay?: "morning" | "afternoon" | "evening" | "any" }>(
    server, "schedule_interview", {
    title: "Offer interview slots to a candidate",
    description:
      "Pull the interviewer's REAL open Cal.com times for a candidate and record the offer (so their later pick books against it). Returns numbered slots in the candidate's timezone — present them and/or send via send_candidate_message. Gated to the scheduling dev cohort (Adam/Noah) until paSchedulingEnabled. Sends no SMS and books nothing by itself.",
    inputSchema: {
      userId: z.string().min(1),
      jobId: z.string().optional().describe("the job to schedule for; omit to let it resolve the candidate's passed/active job"),
      timeZone: z.string().optional().describe("IANA tz, e.g. America/New_York"),
      partOfDay: z.enum(["morning", "afternoon", "evening", "any"]).optional(),
    },
    annotations: READ_ONLY,
  }, async (a) => jsonContent(await runScheduleInterview(a, { db })))

  // Book-on-behalf: the WRITE half of scheduling. Creates a REAL Cal.com booking
  // for the candidate's chosen slot + sends a WeKruit confirmation email. SIDE
  // EFFECTS the candidate didn't request this turn, so confirm-first + dev-gated.
  register<{ userId: string; confirm?: boolean; jobId?: string; slotNumber?: number; slotIso?: string; candidateEmail?: string; candidateName?: string; timeZone?: string }>(
    server, "confirm_interview_booking", {
    title: "Book an interview slot on a candidate's behalf",
    description:
      "Create a REAL Cal.com interview booking for the slot a candidate picked (from schedule_interview's offered list) AND email them a WeKruit confirmation. Pass slotNumber (1-based, exactly as schedule_interview listed) OR the exact slotIso. SAFETY: this is a candidate-facing side effect (calendar invite + email). It is confirm-first — call once WITHOUT confirm (or confirm:false) to dry-run; the tool returns not_confirmed and books nothing. ALWAYS restate the exact userId + the chosen slot to the operator and get confirmation, THEN call again with confirm:true. Gated to the scheduling dev cohort (Adam/Noah) until paSchedulingEnabled — a real candidate returns scheduling_not_enabled and books nothing. v1 has NO reschedule: if the candidate already has a live booking on a different slot it returns already_booked_other_slot.",
    inputSchema: {
      userId: z.string().min(1),
      confirm: z.boolean().optional().describe("must be true to actually book; omit/false = dry-run, no write"),
      jobId: z.string().optional().describe("omit to recover the candidate's live offered job"),
      slotNumber: z.number().int().min(1).max(10).optional().describe("1-based, exactly as schedule_interview listed the slots"),
      slotIso: z.string().optional().describe("exact ISO from the offered list (alternative to slotNumber)"),
      candidateEmail: z.string().optional().describe("override the candidate's stored email for the booking"),
      candidateName: z.string().optional(),
      timeZone: z.string().optional().describe("IANA tz; defaults to the tz the slots were offered in"),
    },
    annotations: MUTATING,
  }, async (a) => jsonContent(await runBookInterviewSlot(a, { db })))

  // Email the candidate their interview slots as one-click "Book <time>" links
  // (each link → the public token-gated paBookInterviewViaLink CF). NEW
  // candidate-outreach channel, so confirm-first + dev-gated.
  register<{ userId: string; candidateEmail: string; jobId?: string; confirm?: boolean }>(
    server, "email_interview_offer", {
    title: "Email a candidate their interview times (booking links)",
    description:
      "Email a CANDIDATE their REAL Cal.com interview times as one-click 'Book <time>' links (each link books that exact slot via a token-gated public page). Pulls + persists the offer (same path as schedule_interview) and reuses its offerToken so the links resolve to the candidate's booking doc. SAFETY: this is a candidate-facing email (a real outbound message). It is confirm-first — call once WITHOUT confirm (or confirm:false) to dry-run; it returns not_confirmed and sends nothing, restating the recipient + slot count. ALWAYS restate the candidate's email + that we're about to email them, get operator confirmation, THEN call again with confirm:true. Gated to the scheduling dev cohort (Adam/Noah) until paSchedulingEnabled — a real candidate returns scheduling_not_enabled and sends nothing. The operator supplies candidateEmail explicitly. Audited to pa-headhunter-emails.",
    inputSchema: {
      userId: z.string().min(1),
      candidateEmail: z.string().min(3).describe("the candidate's email to send the booking links to (operator-supplied)"),
      jobId: z.string().optional().describe("omit to resolve the candidate's passed/active job"),
      confirm: z.boolean().optional().describe("must be true to actually email; omit/false = dry-run preview (no send)"),
    },
    annotations: MUTATING,
  }, async (a) => jsonContent(await runEmailInterviewOffer(a, { db })))

  // ───────────────────────── JOB INTAKE (demand side) ─────────────────────────
  register<{ title: string; jobDescription: string; companyName?: string; locationRaw?: string; salaryMin?: number; salaryMax?: number; currency?: string }>(
    server, "intake_job", {
    title: "Process a job description (enrich + clarify)",
    description:
      "Take a raw JD a client/recruiter sent and enrich it into canonical tags (roleFunction, industrySector, skills, seniorityLevel, locationBuckets, sponsorship, jobType), hard filters, auto-generated prescreen questions, a per-field confidence, and clarifyingQuestions for the gaps. Extract the title from the JD if not given. When clarifyingQuestions come back, ASK the client those, then call intake_job again with the answers folded in to re-enrich.",
    inputSchema: {
      title: z.string().min(1).describe("role title (extract from the JD if needed)"),
      jobDescription: z.string().min(1).describe("the raw JD text the client sent"),
      companyName: z.string().optional(),
      locationRaw: z.string().optional(),
      salaryMin: z.number().optional(),
      salaryMax: z.number().optional(),
      currency: z.string().optional(),
    },
    annotations: READ_ONLY,
  }, async (a) => jsonContent(await runIntakeJob(a)))

  // ───────────────────────── EXTERNAL SOURCING / OUTREACH PREP ─────────────────────────
  register<{ prompt: string; limit?: number }>(server, "search_external_candidates", {
    title: "Search external candidates (Coresignal)",
    description:
      "Search the external talent index via Coresignal agentic search — natural-language prompt (title, skills, location, seniority) → candidate profiles NOT yet in our pool. Read-only discovery; importing/merging into pa-users is a separate operator step.",
    inputSchema: {
      prompt: z.string().min(1).max(4000).describe("natural-language sourcing brief"),
      limit: z.number().int().min(1).max(100).optional(),
    },
    annotations: READ_ONLY,
  }, async (a) => {
    const apiKey = process.env.CORESIGNAL_API_KEY?.trim()
    if (!apiKey) return jsonContent({ error: "coresignal_not_configured", note: "CORESIGNAL_API_KEY secret not bound" })
    return jsonContent(await runCoresignalAgenticSearch(
      { prompt: a.prompt, returnData: true, allowClarification: false, limit: a.limit ?? 10 },
      { db, apiKey, actorUid: principal.uid },
    ))
  })

  register<{ userId: string; jobId?: string }>(server, "draft_outreach", {
    title: "Draft outreach grounding (read-only)",
    description:
      "Gather the candidate + job facts to compose a personalized outreach SMS (first name, top skills, career stage, locations, job title/company, and whether they're sendable). Does NOT send and does NOT write the copy — YOU compose, then call send_candidate_message after the operator confirms.",
    inputSchema: {
      userId: z.string().min(1),
      jobId: z.string().optional(),
    },
    annotations: READ_ONLY,
  }, async (a) => jsonContent(await runDraftOutreach(a, { db })))

  // ───────────────────────── WRITE (operator actions) ─────────────────────────
  // Outbound SMS — LOCKED safety: dev-phone-gated (ramp flag), suppression +
  // prior-inbound + dedup checked before enqueue. Confirm-first per persona.
  register<{ userId: string; text: string }>(server, "send_candidate_message", {
    title: "Send a candidate an SMS",
    description:
      "Send one SMS to a candidate (via Sendblue, runtimeSource headhunter_mcp). SAFETY: dev-phone-only unless ramped; refuses if the candidate opted out / is suppressed, or never texted us first (no cold opens). Idempotent + audited. ALWAYS restate the exact userId + message and get operator confirmation before calling this.",
    inputSchema: {
      userId: z.string().min(1),
      text: z.string().min(1).max(1200).describe("the exact message body to send"),
    },
    annotations: MUTATING,
  }, async (a) => jsonContent(await runSendCandidateMessage(a, { db })))
  // Email channel — CLIENT / hiring-manager / internal recipients only (candidate
  // outreach stays SMS). Operator supplies the recipient; Mailgun-backed; audited.
  register<{ to: string; subject: string; body: string; confirm?: boolean }>(server, "send_email", {
    title: "Email a client / hiring manager",
    description:
      "Send ONE email (via Mailgun, from claire@mg.wekruit.com) to a CLIENT, hiring manager, or internal recipient — e.g. a candidate brief or prescreen summary you compose. NOT for candidate outreach: candidates are SMS-only via send_candidate_message (one channel per candidate + consent). The operator supplies the recipient address. Audited to pa-headhunter-emails. CONFIRM-FIRST: call once WITHOUT confirm (or confirm:false) to preview — it sends nothing and returns reason:not_confirmed; restate the recipient + subject to the operator, and only after they reply yes call again with confirm:true to actually send.",
    inputSchema: {
      to: z.string().min(3).describe("recipient email (client / hiring manager / internal — never a candidate)"),
      subject: z.string().min(1).max(200),
      body: z.string().min(1).max(8000).describe("the full email body text you composed"),
      confirm: z.boolean().optional().describe("must be true to actually send; omit/false = dry-run preview (no send)"),
    },
    annotations: MUTATING,
  }, async (a) => jsonContent(await runSendEmail(a, { db })))
  // Status transitions go through the canonical action runner (audit + statusHistory).
  register<{ submissionId: string; stage: "advance" | "wekruit_interview" | "client_review" | "hired" | "reviewing"; note?: string }>(
    server, "advance_recruiter_submission", {
    title: "Advance a recruiter submission",
    description:
      "Move a submission forward in the pipeline (advanced → wekruit_interview → client_review → hired). Operator decision; writes statusHistory.",
    inputSchema: {
      submissionId: z.string().min(1),
      stage: z.enum(["advance", "wekruit_interview", "client_review", "hired", "reviewing"]),
      note: z.string().max(4000).optional(),
    },
    annotations: MUTATING,
  }, async (a) => jsonContent(await runAdminRecruiterSubmissionAction(
    { submissionId: a.submissionId, action: a.stage, note: a.note }, { db, actorEmail: actor })))

  register<{ submissionId: string; category: string; candidateTier: Tier; reason?: string; reasons?: string[] }>(
    server, "reject_recruiter_submission", {
    title: "Reject a recruiter submission",
    description:
      "Reject a submission. Stamps a candidate tier (tier_1 strongest … tier_3 hard no) that persists globally best-wins. category = quality | role_fit. Operator decision.",
    inputSchema: {
      submissionId: z.string().min(1),
      category: z.string().describe("rejection category, e.g. quality | role_fit"),
      candidateTier: z.enum(["tier_1", "tier_2", "tier_3"]),
      reason: z.string().max(4000).optional(),
      reasons: z.array(z.string().max(80)).max(24).optional(),
    },
    annotations: MUTATING,
  }, async (a) => jsonContent(await runAdminRecruiterSubmissionAction(
    {
      submissionId: a.submissionId,
      action: "reject",
      rejection: { category: a.category, candidateTier: a.candidateTier, reason: a.reason, reasons: a.reasons },
    },
    { db, actorEmail: actor })))

  register<{ submissionId: string; requestMessage: string }>(server, "request_info_on_submission", {
    title: "Request info on a submission",
    description: "Ask the recruiter for more info on a submission (moves it to reviewing). Operator decision.",
    inputSchema: {
      submissionId: z.string().min(1),
      requestMessage: z.string().min(1).max(4000),
    },
    annotations: MUTATING,
  }, async (a) => jsonContent(await runAdminRecruiterSubmissionAction(
    { submissionId: a.submissionId, action: "request_info", requestMessage: a.requestMessage },
    { db, actorEmail: actor })))

  register<{ submissionId: string; message: string }>(server, "comment_on_submission", {
    title: "Comment on a submission",
    description: "Add an operator-only comment to a submission's thread (emails the recruiter). Does not change status.",
    inputSchema: {
      submissionId: z.string().min(1),
      message: z.string().min(1).max(4000),
    },
    annotations: MUTATING,
  }, async (a) => jsonContent(await runAdminRecruiterSubmissionAction(
    { submissionId: a.submissionId, action: "comment", message: a.message },
    { db, actorEmail: actor })))

  register<{ snapshotId: string; decision: "accepted" | "rejected"; reason: string }>(
    server, "decide_employer_intro", {
    title: "Decide an employer intro",
    description:
      "Record the employer's accept/reject decision on a passed candidate snapshot. Writes a feedback event; moves the candidate-job state to intro_accepted / intro_rejected.",
    inputSchema: {
      snapshotId: z.string().min(1),
      decision: z.enum(["accepted", "rejected"]),
      reason: z.string().min(1).max(2000),
    },
    annotations: MUTATING,
  }, async (a) => jsonContent(await runAdminPassedCandidateIntroDecision(a, { db, actorEmail: actor })))

  register<{ candidateId: string; apply?: boolean; tier?: Tier }>(server, "reevaluate_candidate_tier", {
    title: "Re-evaluate a candidate's global tier",
    description:
      "Re-derive the AI-suggested global tier from the candidate's per-role rejection evidence. With apply=true, set the tier (operator authority overrides best-wins) — uses `tier` if given, else the suggestion.",
    inputSchema: {
      candidateId: z.string().min(1),
      apply: z.boolean().optional(),
      tier: z.enum(["tier_1", "tier_2", "tier_3"]).optional(),
    },
    annotations: MUTATING,
  }, async (a) => {
    const evaluation = await reevaluateCandidateTier(a.candidateId, { db })
    if (!a.apply) return jsonContent({ ...evaluation, applied: false })
    const target: Tier | null | undefined = a.tier ?? evaluation.suggestedTier
    if (!target) {
      return jsonContent({ ...evaluation, applied: false, error: "no_tier_to_apply" })
    }
    await setGlobalCandidateTierManual(
      { candidateId: a.candidateId, tier: target, actor, reason: "re-evaluated for new roles (headhunter mcp)" },
      { db },
    )
    return jsonContent({ ...evaluation, applied: true, appliedTier: target })
  })

  // ─────────────── RANK-IT-YOURSELF (client does the judging) ───────────────
  // Our batch judge is a TRIAGE pass: cheap, unattended, auditable, and it grades implementation
  // specifics only. These three let a stronger model do the comparison the checklist cannot —
  // a compact list it can hold in one context, detail on demand, and a written-back ranking.

  register<{ query: string }>(server, "find_job", {
    title: "Find a job by link, name, or company",
    description:
      "Resolve a pasted job URL, a job id, or plain words (\"photon backend\", \"the invoko designer role\") to a jobId. Returns the single match when it is unambiguous, or the shortlist of candidates when it is not — it never guesses, because scoring a candidate pool against the wrong rubric is worse than asking. You usually do NOT need to call this: list_job_shortlist accepts the same free text directly.",
    inputSchema: { query: z.string().min(1) },
    annotations: READ_ONLY,
  }, async (a) => jsonContent(await runFindJob({ db, query: a.query })))

  register<{
    jobId: string
    limit?: number
    requireEngineering?: boolean
    filter?: "all" | "unreviewed" | "needs_attention"
    includeJd?: boolean
  }>(server, "list_job_shortlist", {
    title: "List a job's candidates for ranking",
    description:
      "Accepts a jobId, a pasted job URL, or plain words (\"photon backend\") in `jobId` — it resolves them, and returns jobCandidates instead of guessing when the query is ambiguous. Returns the JOB (title, company, comp, full JD, and the hard/fit/bonus/anti checklist) plus a COMPACT row per candidate (~220 tokens each) — current role, best-calibre employer in their verified history WITH the role that earned it (internships are flagged), school strength, GPA/degree/company pillars, seniority, stack signals found in DESCRIBED work, the batch checklist tally, and what evidence that judge actually had. Built for YOU to judge against the JD: the tally grades implementation specifics only and does NOT grade school, employer calibre, GPA, seniority or corroboration — weigh those yourself. ~250 candidates fit in ~55k tokens. Drops only extreme mismatches and reports every drop with its reason; nothing is silently truncated. filter='unreviewed' to resume a partial pass, 'needs_attention' to re-read only what you flagged. Call get_candidate_evidence before penalising anyone whose evidence looks thin.",
    inputSchema: {
      jobId: z.string().min(1).describe("A jobId, a pasted job URL, or plain words like \"photon backend\" — resolved automatically."),
      limit: z.number().int().min(1).max(250).optional(),
      requireEngineering: z.boolean().optional(),
      filter: z.enum(["all", "unreviewed", "needs_attention"]).optional(),
      includeJd: z.boolean().optional(),
    },
    annotations: READ_ONLY,
  }, async (a) => jsonContentFull(await runListJobShortlist({
    db, jobId: a.jobId, limit: a.limit, requireEngineering: a.requireEngineering,
    filter: a.filter, includeJd: a.includeJd,
  })))

  register<{ submissionId: string }>(server, "get_candidate_evidence", {
    title: "Full evidence for one candidate",
    description:
      "Everything we hold on one submission: every role with its description (newest first), the independent LinkedIn research, recruiter notes, résumé link, and the AI evaluation with its reasons and background pillars. Use after list_job_shortlist on the candidates you want to judge closely.",
    inputSchema: { submissionId: z.string().min(1) },
    annotations: READ_ONLY,
  }, async (a) => jsonContentFull(await runGetCandidateEvidence({ db, submissionId: a.submissionId })))

  register<{
    jobId: string
    model?: string
    reviews: Array<{
      submissionId: string
      verdict: "advance" | "borderline" | "reject"
      score: number
      needsHumanAttention: boolean
      attentionReason?: string
      reasons?: string[]
      dimensions?: Record<string, "strong" | "adequate" | "weak" | "unknown">
    }>
  }>(server, "record_candidate_reviews", {
    title: "Record your own review of candidates",
    description:
      "Write YOUR verdict, 0-100 score, per-dimension grades (experience, companies, school, gpa, skills) and a needsHumanAttention flag for many candidates in ONE call. Be harsh and comparative: most candidates on a senior role should be 'reject', and needsHumanAttention=true is reserved for the few genuinely worth an operator's time — a flag on everyone is the same as a flag on no one. Judge recruiter-submitted candidates by the same bar as sourced ones; a self-authored résumé asserting the right keywords is WEAKER evidence than a corroborated role, not stronger. Stored as `claudeReview` ALONGSIDE the batch `aiEvaluation`, never over it, so the disagreement between the two becomes eval data. Does NOT change submission status or contact anyone — a 'reject' here means 'not worth attention today', and the candidate stays in the pool for other roles. Re-read your flagged set with list_job_shortlist(filter='needs_attention').",
    inputSchema: {
      jobId: z.string().min(1),
      model: z.string().optional(),
      reviews: z.array(z.object({
        submissionId: z.string().min(1),
        verdict: z.enum(["advance", "borderline", "reject"]),
        score: z.number().min(0).max(100),
        needsHumanAttention: z.boolean(),
        attentionReason: z.string().optional(),
        reasons: z.array(z.string()).optional(),
        dimensions: z.object({
          experience: z.enum(["strong", "adequate", "weak", "unknown"]).optional(),
          companies: z.enum(["strong", "adequate", "weak", "unknown"]).optional(),
          school: z.enum(["strong", "adequate", "weak", "unknown"]).optional(),
          gpa: z.enum(["strong", "adequate", "weak", "unknown"]).optional(),
          skills: z.enum(["strong", "adequate", "weak", "unknown"]).optional(),
        }).optional(),
      })).min(1).max(120),
    },
    annotations: MUTATING,
  }, async (a) => jsonContent(await runRecordCandidateReviews({
    db, jobId: a.jobId, actor, now: new Date().toISOString(),
    ...(a.model ? { model: a.model } : {}),
    reviews: a.reviews as never,
  })))

  register<{ jobId: string; ranking: Array<{ submissionId: string; rank: number; note?: string }>; rationale?: string }>(
    server, "record_job_ranking", {
    title: "Record your ranking for a job",
    description:
      "Persist your ordering of a job's candidates as an auditable artifact, with an optional per-candidate note and an overall rationale. Does NOT change any submission status — ranking is an opinion, advancing is a separate decision. Recording it is what lets your judgement become eval data instead of a lost chat message.",
    inputSchema: {
      jobId: z.string().min(1),
      ranking: z.array(z.object({
        submissionId: z.string().min(1),
        rank: z.number().int().min(1),
        note: z.string().optional(),
      })).min(1),
      rationale: z.string().optional(),
    },
    annotations: MUTATING,
  }, async (a) => jsonContent(await runRecordJobRanking({
    db, jobId: a.jobId, actor, now: new Date().toISOString(),
    ranking: a.ranking, ...(a.rationale ? { rationale: a.rationale } : {}),
  })))
}
